import { db, Tx } from '../db/knex';
import { logger } from '../lib/logger';
import { nextOccurrence, RecurrenceRule } from '../lib/recurrence';
import { getSetting } from '../lib/settings';
import { Channel, channelHandlers, PermanentDeliveryError } from './channels';
import { DELIVERY_ATTEMPTS, enqueueDeliveries, enqueueScheduleFire, removeScheduleJob } from './queues';

// ===========================================================================
// Creating notification log rows (one per recipient × channel) + delivery jobs
// ===========================================================================
export interface NotifyInput {
  userIds: number[];
  channels: Channel[];
  title: string;
  body: string;
  link?: string | null;
  category?: 'reminder' | 'event' | 'escalation' | 'system';
  dedupePrefix: string;       // stable key for this occurrence/event → duplicate prevention
  occurrenceAt?: Date;
  scheduleId?: number | null;
  ruleId?: number | null;
  escalationId?: number | null;
}

/** Inserts logs idempotently. Returns ids of newly created rows (existing duplicates are skipped). */
export async function createNotificationLogs(n: NotifyInput, trx: Tx = db): Promise<number[]> {
  const users = [...new Set(n.userIds)].filter(Boolean);
  const channels = [...new Set(n.channels)];
  if (!users.length || !channels.length) return [];
  const rows = users.flatMap((uid) => channels.map((ch) => ({
    dedupe_key: `${n.dedupePrefix}:${uid}:${ch}`,
    schedule_id: n.scheduleId ?? null,
    rule_id: n.ruleId ?? null,
    escalation_id: n.escalationId ?? null,
    user_id: uid,
    channel: ch,
    category: n.category ?? 'reminder',
    title: n.title.slice(0, 300),
    body: n.body.slice(0, 4000),
    link: n.link ?? null,
    status: 'scheduled',
    occurrence_at: n.occurrenceAt ?? new Date(),
  })));
  const inserted = await trx('notification_logs').insert(rows).onConflict('dedupe_key').ignore().returning('id');
  return inserted.map((r: any) => r.id);
}

/** Create + enqueue (outside a transaction). */
export async function notify(n: NotifyInput): Promise<number[]> {
  const ids = await createNotificationLogs(n);
  await enqueueDeliveries(ids);
  return ids;
}

// ===========================================================================
// Delivery (called by the deliveries worker)
// ===========================================================================
const PREF_COLUMN: Record<Channel, string> = {
  in_app: 'in_app', email: 'email', browser_push: 'browser_push', mobile_push: 'mobile_push', whatsapp: 'whatsapp',
};

export async function deliverLog(logId: number, attempt: number) {
  const log = await db('notification_logs').where({ id: logId }).first();
  if (!log) return 'missing';
  if (['sent', 'delivered', 'read', 'cancelled', 'skipped'].includes(log.status)) return 'already-final';

  const pref = await db('user_notification_preferences').where({ user_id: log.user_id }).first();
  // In-app is always recorded for escalations/system alerts so nothing critical is silently lost.
  const forced = log.channel === 'in_app' && ['escalation', 'system'].includes(log.category);
  if (pref && pref[PREF_COLUMN[log.channel as Channel]] === false && !forced) {
    await db('notification_logs').where({ id: logId }).update({ status: 'skipped', last_error: 'Disabled in user preferences', updated_at: db.fn.now() });
    return 'skipped';
  }

  try {
    const r = await channelHandlers[log.channel as Channel](log);
    await db('notification_logs').where({ id: logId }).update({
      status: r.status,
      attempts: attempt,
      provider_ref: r.providerRef ?? null,
      last_error: r.status === 'skipped' ? r.note ?? null : null,
      sent_at: r.status !== 'skipped' ? db.fn.now() : null,
      delivered_at: r.status === 'delivered' ? db.fn.now() : null,
      updated_at: db.fn.now(),
    });
    return r.status;
  } catch (e: any) {
    const permanent = e instanceof PermanentDeliveryError;
    const final = permanent || attempt >= DELIVERY_ATTEMPTS;
    await db('notification_logs').where({ id: logId }).update({
      status: final ? 'failed' : 'retried', attempts: attempt, last_error: String(e?.message ?? e).slice(0, 1000), updated_at: db.fn.now(),
    });
    if (final) {
      await alertDeliveryFailure(log, String(e?.message ?? e));
      if (permanent) return 'failed';
    }
    throw e; // let BullMQ apply backoff & retry
  }
}

/** Failure alert: tell administrators (in-app) when a non-in-app delivery permanently fails. */
async function alertDeliveryFailure(log: any, error: string) {
  if (log.channel === 'in_app' || log.category === 'system') return;
  const admins = await db('users as u').join('roles as r', 'r.id', 'u.role_id').where('r.key', 'super_admin').andWhere('u.is_active', true).pluck('u.id');
  await notify({
    userIds: admins, channels: ['in_app'], category: 'system',
    title: `Notification delivery failed (${log.channel})`,
    body: `"${log.title}" to user #${log.user_id} failed: ${error}`.slice(0, 500),
    link: '/notifications/logs?status=failed', dedupePrefix: `fail:${log.id}`,
  }).catch((e) => logger.error(e, 'failure alert failed'));
}

// ===========================================================================
// Custom schedules (reminders)
// ===========================================================================
export async function loadRule(id: number | null, trx: Tx = db): Promise<RecurrenceRule | null> {
  if (!id) return null;
  const r = await trx('recurring_schedules').where({ id }).first();
  if (!r) return null;
  return { ...r, time_of_day: String(r.time_of_day) };
}

/** Compute the next fire time for a schedule from its definition. */
export async function computeNextRun(s: any, trx: Tx = db, after = new Date()): Promise<Date | null> {
  if (s.schedule_type === 'one_time') return new Date(s.run_at) > after || s.run_count === 0 ? new Date(s.run_at) : null;
  if (s.schedule_type === 'deadline_offset') {
    const t = await trx('tasks').where({ id: s.task_id }).first('deadline', 'status');
    if (!t?.deadline || ['completed', 'cancelled'].includes(t.status)) return null;
    const at = new Date(new Date(t.deadline).getTime() - s.offset_minutes * 60_000);
    return at > after ? at : null;
  }
  const rule = await loadRule(s.recurring_schedule_id, trx);
  return rule ? nextOccurrence(rule, after, s.run_count) : null;
}

/** (Re)arm a schedule: recompute next_run_at and enqueue its job. Safe to call repeatedly. */
export async function armSchedule(scheduleId: number) {
  const s = await db('notification_schedules').where({ id: scheduleId }).first();
  if (!s || s.status !== 'active') return null;
  const prev = s.next_run_at ? new Date(s.next_run_at) : null;
  let next = await computeNextRun(s);
  // A one-time reminder set slightly in the past (clock skew) still fires once.
  if (s.schedule_type === 'one_time' && s.run_count > 0) next = null;
  if (!next) {
    await db('notification_schedules').where({ id: s.id }).update({ next_run_at: null, status: s.run_count > 0 ? 'completed' : s.status, updated_at: db.fn.now() });
    await removeScheduleJob(s.id, prev);
    return null;
  }
  if (!prev || prev.getTime() !== next.getTime()) {
    await db('notification_schedules').where({ id: s.id }).update({ next_run_at: next, updated_at: db.fn.now() });
    await removeScheduleJob(s.id, prev);
  }
  await enqueueScheduleFire(s.id, next);
  return next;
}

async function scheduleLink(s: any) {
  if (s.task_id) return `/tasks/${s.task_id}`;
  if (s.project_id) return `/projects/${s.project_id}`;
  if (s.agenda_id) return '/agenda';
  return '/notifications';
}

/**
 * Fire a schedule occurrence. Runs in a transaction holding a row lock so that two
 * workers (or the sweeper + a delayed job) cannot both fire the same occurrence;
 * notification_logs.dedupe_key is a second line of defence.
 */
export async function fireSchedule(scheduleId: number, expectedRunAt?: Date) {
  let newLogIds: number[] = [];
  let nextRun: Date | null = null;
  const fired = await db.transaction(async (trx) => {
    const s = await trx('notification_schedules').where({ id: scheduleId }).forUpdate().first();
    if (!s || s.status !== 'active' || !s.next_run_at) return false;
    const due = new Date(s.next_run_at);
    if (expectedRunAt && Math.abs(due.getTime() - expectedRunAt.getTime()) > 1000) return false; // stale job (rescheduled)
    if (due.getTime() > Date.now() + 2000) return false; // not yet due

    let recipients: number[] = await trx('notification_recipients').where({ schedule_id: s.id }).pluck('user_id');
    if (!recipients.length) recipients = [s.created_by];
    const active: number[] = await trx('users').whereIn('id', recipients).andWhere('is_active', true).whereNull('deleted_at').pluck('id');

    let body = s.message || s.description || s.title;
    if (s.task_id) {
      const t = await trx('tasks').where({ id: s.task_id }).first('task_key', 'title', 'deadline', 'status');
      if (t) body += `\nTask ${t.task_key}: ${t.title}${t.deadline ? ` — due ${new Date(t.deadline).toISOString()}` : ''} (${t.status.replace(/_/g, ' ')})`;
    }
    newLogIds = await createNotificationLogs({
      userIds: active, channels: s.channels, title: s.title, body, link: await scheduleLink(s), category: 'reminder',
      dedupePrefix: `sch:${s.id}:${due.getTime()}`, occurrenceAt: due, scheduleId: s.id,
    }, trx);

    const runCount = s.run_count + 1;
    if (s.schedule_type === 'recurring') {
      const rule = await loadRule(s.recurring_schedule_id, trx);
      // Skip occurrences missed during downtime instead of flooding: next strictly after now.
      nextRun = rule ? nextOccurrence(rule, new Date(Math.max(due.getTime(), Date.now())), runCount) : null;
    }
    await trx('notification_schedules').where({ id: s.id }).update({
      run_count: runCount, last_run_at: due, next_run_at: nextRun, status: nextRun ? 'active' : 'completed', updated_at: trx.fn.now(),
    });
    return true;
  });
  if (fired) {
    await enqueueDeliveries(newLogIds);
    if (nextRun) await enqueueScheduleFire(scheduleId, nextRun);
  }
  return { fired, logs: newLogIds.length, nextRun };
}

/** Cancel a schedule and any of its not-yet-delivered logs. */
export async function cancelSchedule(scheduleId: number, actorId: number | null, reason: string) {
  const s = await db('notification_schedules').where({ id: scheduleId }).first();
  if (!s || ['cancelled', 'completed'].includes(s.status)) return false;
  await db('notification_schedules').where({ id: scheduleId }).update({
    status: 'cancelled', cancelled_at: db.fn.now(), cancelled_by: actorId, cancel_reason: reason, next_run_at: null, updated_at: db.fn.now(),
  });
  await db('notification_logs').where({ schedule_id: scheduleId }).whereIn('status', ['scheduled', 'retried'])
    .update({ status: 'cancelled', last_error: reason, updated_at: db.fn.now() });
  await removeScheduleJob(scheduleId, s.next_run_at);
  return true;
}

/** Apply the configured rule for pending reminders when a task closes. */
export async function onTaskClosed(taskId: number, actorId: number, outcome: 'completed' | 'cancelled') {
  const policy = await getSetting('reminders_on_task_close');
  if (policy === 'keep') return 0;
  const ids: number[] = await db('notification_schedules').where({ task_id: taskId }).whereIn('status', ['active', 'paused']).pluck('id');
  for (const id of ids) await cancelSchedule(id, actorId, `Task ${outcome}`);
  return ids.length;
}

/** Re-arm deadline-relative reminders after a deadline change. */
export async function onTaskDeadlineChanged(taskId: number) {
  const rows = await db('notification_schedules').where({ task_id: taskId, schedule_type: 'deadline_offset' })
    .whereIn('status', ['active', 'completed']).select('id', 'status');
  for (const r of rows) {
    if (r.status === 'completed') await db('notification_schedules').where({ id: r.id }).update({ status: 'active', run_count: 0 });
    await armSchedule(r.id);
  }
}

/**
 * Safety net (runs every minute): fires any active schedule whose time has passed
 * (e.g. Redis data lost, worker was down) and makes sure upcoming jobs exist.
 */
export async function sweepSchedules() {
  const due: number[] = await db('notification_schedules').where('status', 'active').whereNotNull('next_run_at')
    .where('next_run_at', '<=', new Date(Date.now() - 30_000)).limit(500).pluck('id');
  for (const id of due) await fireSchedule(id).catch((e) => logger.error({ e, id }, 'sweep fire failed'));
  const upcoming = await db('notification_schedules').where('status', 'active').whereNotNull('next_run_at')
    .where('next_run_at', '<=', new Date(Date.now() + 15 * 60_000)).limit(2000).select('id', 'next_run_at');
  for (const s of upcoming) await enqueueScheduleFire(s.id, new Date(s.next_run_at));
  const stuck: number[] = await db('notification_logs').whereIn('status', ['scheduled'])
    .where('created_at', '<', new Date(Date.now() - 10 * 60_000)).limit(500).pluck('id');
  await enqueueDeliveries(stuck);
  return { fired: due.length, armed: upcoming.length, requeued: stuck.length };
}
