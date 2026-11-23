import { Worker } from 'bullmq';
import { DateTime } from 'luxon';
import { db } from '../db/knex';
import { logger } from '../lib/logger';
import { config } from '../config';
import { createRedis } from '../lib/redis';
import { getSetting } from '../lib/settings';
import { forEachOrg, generateRecurringTasks, markOverdue, runEscalations } from './escalation';
import { runInOrg } from '../db/knex';
import { generateChecklistsInOrg, runChecklistEscalationsInOrg, runChecklistRemindersInOrg } from '../questionnaire/engine';
import { autoGenerateEodInOrg } from '../questionnaire/eod';
import { getQueues, QUEUE } from './queues';
import { deliverLog, fireSchedule, notify, sweepSchedules } from './service';

/** Remind users in the configured roles who haven't submitted today's daily report. */
export const dailyReportReminder = (now = new Date()) => forEachOrg(() => dailyReportReminderInOrg(now));
async function dailyReportReminderInOrg(now: Date) {
  const time: string = await getSetting('daily_report_reminder_time');
  if (!time) return 0;
  const tz: string = await getSetting('default_timezone');
  const days: number[] = await getSetting('working_days');
  const local = DateTime.fromJSDate(now).setZone(tz);
  if (!days.includes(local.weekday)) return 0;
  const [h, m] = time.split(':').map(Number);
  const target = local.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  // Only inside the hour after the configured time (job runs every minute; dedupe keys prevent repeats).
  if (local < target || local > target.plus({ hours: 1 })) return 0;
  const roles: string[] = await getSetting('daily_report_roles');
  const date = local.toISODate()!;
  const missing: number[] = await db('users as u').join('roles as r', 'r.id', 'u.role_id').whereIn('r.key', roles)
    .where('u.is_active', true).whereNull('u.deleted_at').where('u.employment_status', 'active')
    .whereNotExists(db('daily_reports as d').whereRaw('d.user_id = u.id').andWhere('d.report_date', date)).pluck('u.id');
  if (!missing.length) return 0;
  await notify({
    userIds: missing, channels: ['in_app', 'email'], title: 'Daily report pending',
    body: `Please submit your daily work report for ${date}.`, link: '/daily-reports', dedupePrefix: `drr:${date}`,
  });
  return missing.length;
}

export async function startWorkers() {
  const connection = createRedis();
  const workers = [
    new Worker(QUEUE.schedules, async (job) => fireSchedule(job.data.scheduleId, new Date(job.data.runAt)), { connection, prefix: config.QUEUE_PREFIX, concurrency: 10 }),
    new Worker(QUEUE.deliveries, async (job) => deliverLog(job.data.logId, job.attemptsMade + 1), {
      connection, prefix: config.QUEUE_PREFIX, concurrency: 20, limiter: { max: 100, duration: 1000 },
    }),
    new Worker(QUEUE.maintenance, async (job) => {
      switch (job.name) {
        case 'sweep': return sweepSchedules();
        case 'escalations': await markOverdue(); return runEscalations();
        case 'recurring-tasks': return generateRecurringTasks();
        case 'daily-report-reminder': return dailyReportReminder();
        case 'checklists': return forEachOrg(() => generateChecklistsInOrg());
        case 'generate-checklists': return runInOrg(job.data.orgId, () => generateChecklistsInOrg());
        case 'checklist-reminders': return (await forEachOrg(runChecklistRemindersInOrg)) + (await forEachOrg(runChecklistEscalationsInOrg));
        case 'eod-auto': return forEachOrg(() => autoGenerateEodInOrg());
      }
    }, { connection, prefix: config.QUEUE_PREFIX, concurrency: 1 }),
  ];
  for (const w of workers) {
    w.on('failed', (job, err) => logger.warn({ queue: w.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'));
    w.on('error', (err) => logger.error({ err }, 'worker error'));
  }
  const { maintenance } = getQueues();
  await maintenance.upsertJobScheduler('sweep', { every: 60_000 }, { name: 'sweep' });
  await maintenance.upsertJobScheduler('escalations', { every: 60_000 }, { name: 'escalations' });
  await maintenance.upsertJobScheduler('recurring-tasks', { every: 5 * 60_000 }, { name: 'recurring-tasks' });
  await maintenance.upsertJobScheduler('daily-report-reminder', { every: 60_000 }, { name: 'daily-report-reminder' });
  // Daily questionnaire: checklist generation (idempotent), reminders + escalations, automatic EOD reports
  await maintenance.upsertJobScheduler('checklists', { every: 5 * 60_000 }, { name: 'checklists' });
  await maintenance.upsertJobScheduler('checklist-reminders', { every: 60_000 }, { name: 'checklist-reminders' });
  await maintenance.upsertJobScheduler('eod-auto', { every: 60_000 }, { name: 'eod-auto' });
  logger.info('background workers started');
  return workers;
}
