import { DateTime } from 'luxon';
import { db, withSavepoint } from '../db/knex';
import { logger } from '../lib/logger';
import { getSetting } from '../lib/settings';
import { notify } from '../notifications/service';
import { localDateIn } from '../questionnaire/engine';
import { dueAtFor, occursOn } from '../questionnaire/schedule';

/**
 * Personal tasks: one-off tasks a person creates for themself, and recurring series.
 * Each day a series occurs gets its own personal_tasks row (UNIQUE series_id + due_date),
 * so every occurrence has its own completion status. Nothing is ever marked done automatically.
 */

export function dueFields(date: string | null, time: string | null, tz: string, reminderOffset: number | null) {
  if (!date) return { due_at: null, remind_at: null };
  const due_at = dueAtFor(date, time ? String(time).slice(0, 5) : '23:59', tz);
  const remind_at = reminderOffset != null && time ? new Date(due_at.getTime() - reminderOffset * 60_000) : null;
  return { due_at, remind_at };
}

/** Creates today's occurrence (owner-local date) of every active series. Idempotent. */
export async function materializeSeries(opts: { userIds?: number[]; now?: Date; date?: string } = {}): Promise<number> {
  const q = db('personal_task_series as s').join('users as u', 'u.id', 's.user_id')
    .whereNull('s.deleted_at').where('s.is_active', true).where('u.is_active', true).whereNull('u.deleted_at')
    .select('s.*', 'u.timezone');
  if (opts.userIds) q.whereIn('s.user_id', opts.userIds);
  const series = await q;
  if (!series.length) return 0;
  const workingDays: number[] = await getSetting('working_days');
  let n = 0;
  for (const s of series) {
    const date = opts.date ?? localDateIn(s.timezone, opts.now ?? new Date());
    const spec = { ...s, start_date: iso(s.start_date), end_date: s.end_date ? iso(s.end_date) : null };
    if (!occursOn(spec, date, workingDays)) continue;
    try {
      await withSavepoint(async () => {
        const { due_at, remind_at } = dueFields(date, s.due_time, s.timezone, s.reminder_offset_minutes);
        const r = await db('personal_tasks').insert({
          user_id: s.user_id, series_id: s.id, title: s.title, description: s.description, priority: s.priority, project_id: s.project_id,
          due_date: date, due_at, remind_at,
        }).onConflict(db.raw('(series_id, due_date) WHERE series_id IS NOT NULL')).ignore().returning('id');
        n += r.length;
      });
    } catch (e) { logger.error({ e, seriesId: s.id }, 'personal task occurrence failed'); }
  }
  return n;
}

/** Reminders for pending personal tasks whose reminder time passed within the last 30 minutes. */
export async function runPersonalTaskRemindersInOrg(now = new Date()): Promise<number> {
  const rows = await db('personal_tasks as t').join('users as u', 'u.id', 't.user_id')
    .where('t.status', 'pending').whereNull('t.deleted_at').whereNotNull('t.remind_at')
    .where('t.remind_at', '<=', now).where('t.remind_at', '>', new Date(now.getTime() - 30 * 60_000))
    .where('u.is_active', true)
    .select('t.id', 't.user_id', 't.title', 't.due_at', 't.remind_at', 'u.timezone');
  let sent = 0;
  for (const r of rows) {
    const due = r.due_at ? DateTime.fromJSDate(new Date(r.due_at)).setZone(r.timezone || 'UTC').toFormat('HH:mm') : null;
    const ids = await notify({
      userIds: [r.user_id], channels: ['in_app', 'browser_push'], category: 'reminder',
      title: `Reminder: ${r.title}`, body: due ? `Due at ${due} today.` : 'Personal task reminder.',
      link: '/my-work?tab=tasks', dedupePrefix: `ptrem:${r.id}:${new Date(r.remind_at).getTime()}`,
    });
    if (ids.length) sent++;
  }
  return sent;
}

const iso = (v: any) => (v instanceof Date ? DateTime.fromJSDate(v).toISODate()! : String(v).slice(0, 10));
