import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../db/knex';
import { AuthUser, can, me, requirePerm } from '../auth/middleware';
import { loadVisibleProject, loadVisibleTask, scopeUsers } from '../auth/scope';
import { audit, diff } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { idParam, paginate, parse, zDate, zId, zOptId, zOptStr, zPage, zTime, patchOf } from '../lib/http';
import { pushRealtime } from '../lib/realtime';
import { describeRule, isValidTimezone, localToUtc, occurrencesBetween, RecurrenceRule } from '../lib/recurrence';
import { CHANNELS, channelStatus } from '../notifications/channels';
import { EVENT_TYPES, RECIPIENT_ROLES } from '../notifications/events';
import { armSchedule, cancelSchedule, computeNextRun, loadRule, notify } from '../notifications/service';

export const router = Router();
const zChannels = z.array(z.enum(CHANNELS as [string, ...string[]])).min(1);

// ===================================================================== in-app inbox
router.get('/inbox', async (req, res) => {
  const f = parse(z.object({ ...zPage, unread: z.enum(['true', 'false']).optional(), category: z.string().optional() }), req.query);
  const q = db('notification_logs').where({ user_id: me(req).id, channel: 'in_app' }).whereNotIn('status', ['scheduled', 'cancelled', 'skipped', 'failed'])
    .orderBy('created_at', 'desc').select('id', 'title', 'body', 'link', 'category', 'status', 'created_at', 'read_at');
  if (f.unread === 'true') q.whereNull('read_at');
  if (f.category) q.where('category', f.category);
  res.json(await paginate(q, f.page, f.pageSize));
});

router.get('/inbox/unread-count', async (req, res) => {
  const r = await db('notification_logs').where({ user_id: me(req).id, channel: 'in_app' }).whereIn('status', ['delivered', 'sent']).whereNull('read_at').count({ c: '*' }).first();
  res.json({ count: Number(r?.c ?? 0) });
});

router.post('/inbox/:id/read', async (req, res) => {
  await db('notification_logs').where({ id: idParam(req), user_id: me(req).id, channel: 'in_app' }).whereNull('read_at').update({ read_at: db.fn.now(), status: 'read', updated_at: db.fn.now() });
  res.json({ ok: true });
});

router.post('/inbox/read-all', async (req, res) => {
  const n = await db('notification_logs').where({ user_id: me(req).id, channel: 'in_app' }).whereIn('status', ['delivered', 'sent']).whereNull('read_at')
    .update({ read_at: db.fn.now(), status: 'read', updated_at: db.fn.now() });
  await pushRealtime([me(req).id], 'notification:read-all', {});
  res.json({ updated: n });
});

// ===================================================================== preferences & push registration
router.get('/preferences', async (req, res) => {
  await db('user_notification_preferences').insert({ user_id: me(req).id }).onConflict('user_id').ignore();
  const p = await db('user_notification_preferences').where({ user_id: me(req).id }).first();
  const subs = await db('push_subscriptions').where({ user_id: me(req).id }).count({ c: '*' }).first();
  res.json({ ...p, push_subscriptions: Number(subs?.c ?? 0), channels: channelStatus() });
});
router.put('/preferences', async (req, res) => {
  const b = parse(z.object({
    in_app: z.boolean().optional(), email: z.boolean().optional(), browser_push: z.boolean().optional(), mobile_push: z.boolean().optional(),
    whatsapp: z.boolean().optional(), whatsapp_number: z.string().regex(/^\+?[\d\s-]{8,20}$/).nullable().optional(),
    quiet_hours_start: zTime.nullable().optional(), quiet_hours_end: zTime.nullable().optional(),
  }), req.body);
  if (b.whatsapp && !b.whatsapp_number) {
    const cur = await db('user_notification_preferences').where({ user_id: me(req).id }).first('whatsapp_number');
    if (!cur?.whatsapp_number) throw badRequest('Provide a WhatsApp number to opt in');
  }
  await db('user_notification_preferences').insert({ user_id: me(req).id, ...b }).onConflict('user_id').merge({ ...b, updated_at: db.fn.now() });
  await audit(req, { action: 'notification.preferences_updated', entityType: 'user', entityId: me(req).id, after: b });
  res.json({ ok: true });
});
router.get('/push/public-key', (_req, res) => res.json({ key: config.VAPID_PUBLIC_KEY || null }));
router.post('/push/subscribe', async (req, res) => {
  const b = parse(z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(500), auth: z.string().max(200) }) }), req.body);
  await db('push_subscriptions').insert({ user_id: me(req).id, endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth, user_agent: String(req.headers['user-agent'] ?? '').slice(0, 300) })
    .onConflict('endpoint').merge(['user_id', 'p256dh', 'auth']);
  res.status(201).json({ ok: true });
});
router.post('/push/unsubscribe', async (req, res) => {
  const { endpoint } = parse(z.object({ endpoint: z.string() }), req.body);
  await db('push_subscriptions').where({ endpoint, user_id: me(req).id }).del();
  res.json({ ok: true });
});
router.post('/devices', async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10).max(4096), platform: z.enum(['android', 'ios', 'web']) }), req.body);
  await db('device_tokens').insert({ user_id: me(req).id, ...b }).onConflict('token').merge(['user_id', 'platform']);
  res.status(201).json({ ok: true });
});
router.get('/channels', (_req, res) => res.json(channelStatus()));
router.get('/meta', (_req, res) => res.json({ event_types: EVENT_TYPES, recipient_roles: RECIPIENT_ROLES, channels: CHANNELS }));

// ===================================================================== custom schedules (reminders)
const scheduleSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: zOptStr,
  message: zOptStr,
  task_id: zOptId,
  project_id: zOptId,
  department_id: zOptId,
  schedule_type: z.enum(['one_time', 'recurring', 'deadline_offset']),
  date: zDate.optional(),        // local date (one_time / recurring start)
  time: zTime.optional(),        // local time
  timezone: z.string().max(64),
  offset_minutes: z.number().int().min(0).max(60 * 24 * 90).optional(),
  recurrence: z.object({
    freq: z.enum(['minutely', 'hourly', 'daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().min(1).max(1000).default(1),
    by_weekday: z.array(z.number().int().min(1).max(7)).optional(),
    by_month_day: z.number().int().min(1).max(31).optional(),
    ends_on: zDate.nullable().optional(),
    max_count: z.number().int().min(1).max(100000).optional(),
  }).optional(),
  recipient_ids: z.array(zId).default([]),
  channels: zChannels.default(['in_app']),
  active: z.boolean().default(true),
});

async function validateRecipients(u: AuthUser, ids: number[]) {
  const others = ids.filter((i) => i !== u.id);
  if (!others.length) return;
  if (!can(u, 'notifications.schedule_others')) throw forbidden('You can only schedule reminders for yourself');
  if (u.scope !== 'organization') {
    const visible: number[] = await scopeUsers(db('users as u').whereIn('u.id', others), u).pluck('u.id');
    const projectPeers: number[] = u.scope === 'project'
      ? await db('project_members as pm').join('projects as p', 'p.id', 'pm.project_id').where('p.manager_id', u.id).whereIn('pm.user_id', others).pluck('pm.user_id') : [];
    const bad = others.filter((i) => !visible.includes(i) && !projectPeers.includes(i));
    if (bad.length) throw forbidden('Some recipients are outside your scope');
  }
}

export async function createSchedule(u: AuthUser, b: z.infer<typeof scheduleSchema>, source: 'user' | 'agenda' = 'user', agendaId?: number) {
  if (!isValidTimezone(b.timezone)) throw badRequest('Unknown timezone');
  if (b.task_id) await loadVisibleTask(u, b.task_id);
  if (b.project_id) await loadVisibleProject(u, b.project_id);
  const recipients = b.recipient_ids.length ? [...new Set(b.recipient_ids)] : [u.id];
  await validateRecipients(u, recipients);
  const row: any = {
    title: b.title, description: b.description, message: b.message, created_by: u.id, task_id: b.task_id, project_id: b.project_id,
    department_id: b.department_id, schedule_type: b.schedule_type, timezone: b.timezone, channels: b.channels,
    status: b.active ? 'active' : 'paused', source, agenda_id: agendaId ?? null,
  };
  if (b.schedule_type === 'one_time') {
    if (!b.date || !b.time) throw badRequest('Date and time are required');
    row.run_at = localToUtc(b.date, b.time, b.timezone);
    if (row.run_at.getTime() < Date.now() - 60_000) throw badRequest('Reminder time is in the past');
  } else if (b.schedule_type === 'deadline_offset') {
    if (!b.task_id || b.offset_minutes === undefined) throw badRequest('Task and minutes-before-deadline are required');
    const t = await db('tasks').where({ id: b.task_id }).first('deadline');
    if (!t?.deadline) throw badRequest('The task has no deadline');
    row.offset_minutes = b.offset_minutes;
  } else {
    if (!b.date || !b.time || !b.recurrence) throw badRequest('Start date, time and recurrence are required');
    if (b.recurrence.ends_on && b.recurrence.ends_on < b.date) throw badRequest('End date must be after the start date');
    const [rs] = await db('recurring_schedules').insert({
      freq: b.recurrence.freq, interval: b.recurrence.interval, by_weekday: b.recurrence.by_weekday?.length ? b.recurrence.by_weekday : null,
      by_month_day: b.recurrence.by_month_day ?? null, time_of_day: b.time, timezone: b.timezone, starts_on: b.date,
      ends_on: b.recurrence.ends_on ?? null, max_count: b.recurrence.max_count ?? null,
    }).returning('id');
    row.recurring_schedule_id = rs.id;
  }
  const next = await computeNextRun({ ...row, run_count: 0 });
  if (!next) throw badRequest('This schedule has no future occurrence');
  const [s] = await db('notification_schedules').insert({ ...row, next_run_at: next }).returning('*');
  await db('notification_recipients').insert(recipients.map((id) => ({ schedule_id: s.id, user_id: id })));
  if (s.status === 'active') await armSchedule(s.id);
  return s;
}

function schedulesQuery(u: AuthUser, all: boolean) {
  const q = db('notification_schedules as s').leftJoin('users as c', 'c.id', 's.created_by').leftJoin('tasks as t', 't.id', 's.task_id')
    .leftJoin('projects as p', 'p.id', 's.project_id').leftJoin('recurring_schedules as r', 'r.id', 's.recurring_schedule_id')
    .select('s.*', 'c.name as created_by_name', 't.task_key', 't.title as task_title', 'p.name as project_name',
      db.raw('row_to_json(r.*) AS recurrence'),
      db.raw(`coalesce((SELECT json_agg(json_build_object('id', u.id, 'name', u.name)) FROM notification_recipients nr JOIN users u ON u.id = nr.user_id WHERE nr.schedule_id = s.id), '[]') AS recipients`));
  if (!all) q.where((w) => w.where('s.created_by', u.id).orWhereExists(db('notification_recipients as nr').whereRaw('nr.schedule_id = s.id').andWhere('nr.user_id', u.id)));
  return q;
}

const withDescription = (rows: any[]) => rows.map((r) => ({ ...r, recurrence_text: r.recurrence ? describeRule({ ...r.recurrence, time_of_day: String(r.recurrence.time_of_day) }) : null }));

router.get('/schedules', requirePerm('notifications.schedule'), async (req, res) => {
  const u = me(req);
  const f = parse(z.object({ ...zPage, status: z.string().optional(), type: z.string().optional(), all: z.enum(['true', 'false']).optional(), task_id: zId.optional(), q: z.string().optional() }), req.query);
  const q = schedulesQuery(u, f.all === 'true' && can(u, 'notifications.logs.view_all')).orderByRaw('s.next_run_at ASC NULLS LAST, s.id DESC');
  if (f.status) q.whereIn('s.status', f.status.split(','));
  if (f.type) q.where('s.schedule_type', f.type);
  if (f.task_id) q.where('s.task_id', f.task_id);
  if (f.q) q.whereILike('s.title', `%${f.q}%`);
  const page = await paginate(q, f.page, f.pageSize);
  res.json({ ...page, items: withDescription(page.items) });
});

router.post('/schedules', requirePerm('notifications.schedule'), async (req, res) => {
  const u = me(req);
  const s = await createSchedule(u, parse(scheduleSchema, req.body));
  await audit(req, { action: 'notification.scheduled', entityType: 'notification_schedule', entityId: s.id, summary: `${s.title} (${s.schedule_type}) next ${s.next_run_at?.toISOString?.() ?? s.next_run_at}`, after: s });
  res.status(201).json(s);
});

async function loadOwnSchedule(u: AuthUser, id: number) {
  const s = await db('notification_schedules').where({ id }).first();
  if (!s) throw notFound();
  if (s.created_by !== u.id && !can(u, 'notifications.rules.manage')) throw forbidden('Only the creator can change this reminder');
  return s;
}

router.get('/schedules/:id', requirePerm('notifications.schedule'), async (req, res) => {
  const u = me(req);
  const [s] = withDescription(await schedulesQuery(u, can(u, 'notifications.logs.view_all')).where('s.id', idParam(req)));
  if (!s) throw notFound();
  const logs = await db('notification_logs as l').join('users as u', 'u.id', 'l.user_id').where('l.schedule_id', s.id).orderBy('l.created_at', 'desc').limit(200)
    .select('l.id', 'l.channel', 'l.status', 'l.occurrence_at', 'l.attempts', 'l.last_error', 'l.sent_at', 'l.delivered_at', 'l.read_at', 'u.name as user_name');
  let upcoming: Date[] = [];
  if (s.status === 'active' && s.recurrence) {
    const rule: RecurrenceRule = { ...s.recurrence, time_of_day: String(s.recurrence.time_of_day) };
    upcoming = occurrencesBetween(rule, new Date(), new Date(Date.now() + 366 * 86400_000), 10);
  } else if (s.next_run_at) upcoming = [s.next_run_at];
  res.json({ ...s, logs, upcoming });
});

/** Reschedule / edit. Changing timing re-arms the job; the old job becomes stale and is ignored. */
router.patch('/schedules/:id', requirePerm('notifications.schedule'), async (req, res) => {
  const u = me(req);
  const s = await loadOwnSchedule(u, idParam(req));
  if (['cancelled', 'completed'].includes(s.status)) throw badRequest('Reminder is no longer active');
  const b = parse(patchOf(scheduleSchema).omit({ schedule_type: true }), req.body);
  const patch: any = { updated_at: db.fn.now() };
  for (const k of ['title', 'description', 'message', 'channels'] as const) if (b[k] !== undefined) patch[k] = b[k];
  const tz = b.timezone ?? s.timezone;
  if (b.timezone && !isValidTimezone(b.timezone)) throw badRequest('Unknown timezone');
  patch.timezone = tz;
  if (s.schedule_type === 'one_time' && (b.date || b.time || b.timezone)) {
    const cur = s.run_at ? new Date(s.run_at) : new Date();
    const { DateTime } = await import('luxon');
    const local = DateTime.fromJSDate(cur).setZone(s.timezone);
    patch.run_at = localToUtc(b.date ?? local.toISODate()!, b.time ?? local.toFormat('HH:mm'), tz);
    if (patch.run_at.getTime() < Date.now() - 60_000) throw badRequest('Reminder time is in the past');
    patch.run_count = 0;
  }
  if (s.schedule_type === 'deadline_offset' && b.offset_minutes !== undefined) { patch.offset_minutes = b.offset_minutes; patch.run_count = 0; }
  if (s.schedule_type === 'recurring' && (b.recurrence || b.date || b.time || b.timezone)) {
    const old = await loadRule(s.recurring_schedule_id);
    const r = { ...old!, ...(b.recurrence ?? {}) } as any;
    await db('recurring_schedules').where({ id: s.recurring_schedule_id }).update({
      freq: r.freq, interval: r.interval, by_weekday: r.by_weekday?.length ? r.by_weekday : null, by_month_day: r.by_month_day ?? null,
      ends_on: r.ends_on ?? null, max_count: r.max_count ?? null, time_of_day: b.time ?? old!.time_of_day, timezone: tz, starts_on: b.date ?? old!.starts_on,
    });
  }
  if (b.recipient_ids) {
    await validateRecipients(u, b.recipient_ids);
    await db('notification_recipients').where({ schedule_id: s.id }).del();
    await db('notification_recipients').insert((b.recipient_ids.length ? b.recipient_ids : [u.id]).map((id) => ({ schedule_id: s.id, user_id: id })));
  }
  await db('notification_schedules').where({ id: s.id }).update(patch);
  const next = s.status === 'active' ? await armSchedule(s.id) : null;
  const d = diff(s, { ...b });
  await audit(req, { action: 'notification.rescheduled', entityType: 'notification_schedule', entityId: s.id, before: d.before, after: { ...d.after, next_run_at: next } });
  res.json({ ok: true, next_run_at: next });
});

router.post('/schedules/:id/pause', requirePerm('notifications.schedule'), async (req, res) => {
  const u = me(req);
  const s = await loadOwnSchedule(u, idParam(req));
  if (s.status !== 'active') throw badRequest('Reminder is not active');
  await db('notification_schedules').where({ id: s.id }).update({ status: 'paused', updated_at: db.fn.now() });
  await audit(req, { action: 'notification.paused', entityType: 'notification_schedule', entityId: s.id });
  res.json({ ok: true });
});
router.post('/schedules/:id/resume', requirePerm('notifications.schedule'), async (req, res) => {
  const u = me(req);
  const s = await loadOwnSchedule(u, idParam(req));
  if (s.status !== 'paused') throw badRequest('Reminder is not paused');
  await db('notification_schedules').where({ id: s.id }).update({ status: 'active', updated_at: db.fn.now() });
  const next = await armSchedule(s.id);
  await audit(req, { action: 'notification.resumed', entityType: 'notification_schedule', entityId: s.id, after: { next_run_at: next } });
  res.json({ ok: true, next_run_at: next });
});
router.post('/schedules/:id/cancel', requirePerm('notifications.schedule'), async (req, res) => {
  const u = me(req);
  const s = await loadOwnSchedule(u, idParam(req));
  const { reason } = parse(z.object({ reason: z.string().max(500).default('Cancelled by user') }), req.body ?? {});
  if (!(await cancelSchedule(s.id, u.id, reason))) throw badRequest('Reminder is already finished');
  await audit(req, { action: 'notification.cancelled', entityType: 'notification_schedule', entityId: s.id, summary: `${s.title}: ${reason}` });
  res.json({ ok: true });
});
/** Send one immediate test notification for this reminder to its recipients. */
router.post('/schedules/:id/test', requirePerm('notifications.schedule'), async (req, res) => {
  const u = me(req);
  const s = await loadOwnSchedule(u, idParam(req));
  const recipients: number[] = await db('notification_recipients').where({ schedule_id: s.id }).pluck('user_id');
  const ids = await notify({ userIds: recipients.length ? recipients : [u.id], channels: s.channels, title: `[Test] ${s.title}`, body: s.message || s.description || s.title,
    link: s.task_id ? `/tasks/${s.task_id}` : '/notifications', dedupePrefix: `test:${s.id}:${Date.now()}`, scheduleId: s.id });
  await audit(req, { action: 'notification.test_sent', entityType: 'notification_schedule', entityId: s.id });
  res.json({ ok: true, logs: ids.length });
});

// ===================================================================== delivery logs
router.get('/logs', async (req, res) => {
  const u = me(req);
  const f = parse(z.object({ ...zPage, status: z.string().optional(), channel: z.string().optional(), user_id: zId.optional(), schedule_id: zId.optional(), category: z.string().optional(), from: zDate.optional(), to: zDate.optional() }), req.query);
  const q = db('notification_logs as l').join('users as u', 'u.id', 'l.user_id').leftJoin('notification_schedules as s', 's.id', 'l.schedule_id')
    .orderBy('l.created_at', 'desc')
    .select('l.id', 'l.title', 'l.channel', 'l.category', 'l.status', 'l.occurrence_at', 'l.attempts', 'l.last_error', 'l.sent_at', 'l.delivered_at', 'l.read_at', 'l.created_at',
      'l.schedule_id', 'u.name as user_name', 's.title as schedule_title');
  if (!can(u, 'notifications.logs.view_all')) q.where((w) => w.where('l.user_id', u.id).orWhere('s.created_by', u.id));
  if (f.status) q.whereIn('l.status', f.status.split(','));
  if (f.channel) q.where('l.channel', f.channel);
  if (f.user_id) q.where('l.user_id', f.user_id);
  if (f.schedule_id) q.where('l.schedule_id', f.schedule_id);
  if (f.category) q.where('l.category', f.category);
  if (f.from) q.where('l.created_at', '>=', f.from);
  if (f.to) q.where('l.created_at', '<', db.raw(`?::date + 1`, [f.to]));
  const stats = await q.clone().clearSelect().clearOrder().groupBy('l.status').select('l.status', db.raw('count(*)::int AS count'));
  const page = await paginate(q, f.page, f.pageSize);
  res.json({ ...page, stats: Object.fromEntries(stats.map((s: any) => [s.status, s.count])) });
});

router.post('/logs/:id/retry', requirePerm('notifications.logs.view_all'), async (req, res) => {
  const log = await db('notification_logs').where({ id: idParam(req) }).first();
  if (!log) throw notFound();
  if (log.status !== 'failed') throw badRequest('Only failed deliveries can be retried');
  await db('notification_logs').where({ id: log.id }).update({ status: 'retried', updated_at: db.fn.now() });
  const { getQueues } = await import('../notifications/queues');
  await getQueues().deliveries.add('deliver', { logId: log.id }, { jobId: `d-${log.id}-r${Date.now()}` });
  await audit(req, { action: 'notification.retry', entityType: 'notification_log', entityId: log.id });
  res.json({ ok: true });
});

// ===================================================================== event rules
const ruleSchema = z.object({
  name: z.string().trim().min(2).max(200),
  event_type: z.enum(Object.keys(EVENT_TYPES) as [string, ...string[]]),
  channels: zChannels,
  recipient_roles: z.array(z.enum(RECIPIENT_ROLES)).min(1),
  title_template: z.string().min(1).max(300),
  message_template: z.string().min(1).max(2000),
  priority_filter: z.array(z.enum(['low', 'medium', 'high', 'critical'])).nullable().optional(),
  department_id: zOptId,
  project_id: zOptId,
  is_active: z.boolean().default(true),
});
router.get('/rules', requirePerm('notifications.rules.manage'), async (_req, res) => {
  res.json(await db('notification_rules as r').leftJoin('departments as d', 'd.id', 'r.department_id').leftJoin('projects as p', 'p.id', 'r.project_id')
    .select('r.*', 'd.name as department_name', 'p.name as project_name').orderBy(['r.event_type', 'r.id']));
});
router.post('/rules', requirePerm('notifications.rules.manage'), async (req, res) => {
  const [row] = await db('notification_rules').insert({ ...parse(ruleSchema, req.body), created_by: me(req).id }).returning('*');
  await audit(req, { action: 'notification_rule.created', entityType: 'notification_rule', entityId: row.id, after: row });
  res.status(201).json(row);
});
router.patch('/rules/:id', requirePerm('notifications.rules.manage'), async (req, res) => {
  const before = await db('notification_rules').where({ id: idParam(req) }).first();
  if (!before) throw notFound();
  const b = parse(patchOf(ruleSchema), req.body);
  const [row] = await db('notification_rules').where({ id: before.id }).update({ ...b, updated_at: db.fn.now() }).returning('*');
  const d = diff(before, b);
  await audit(req, { action: 'notification_rule.updated', entityType: 'notification_rule', entityId: before.id, before: d.before, after: d.after });
  res.json(row);
});
router.delete('/rules/:id', requirePerm('notifications.rules.manage'), async (req, res) => {
  await db('notification_rules').where({ id: idParam(req) }).del();
  await audit(req, { action: 'notification_rule.deleted', entityType: 'notification_rule', entityId: idParam(req) });
  res.json({ ok: true });
});

// ===================================================================== escalation rules
const escSchema = z.object({
  name: z.string().trim().min(2).max(200),
  level: z.number().int().min(1).max(10),
  offset_minutes: z.number().int().min(-60 * 24 * 30).max(60 * 24 * 90),
  notify_roles: z.array(z.enum(['assignee', 'assigner', 'hod', 'team_leader', 'project_manager', 'admin', 'director'])).min(1),
  channels: zChannels,
  priority_filter: z.array(z.enum(['low', 'medium', 'high', 'critical'])).nullable().optional(),
  department_id: zOptId,
  project_id: zOptId,
  task_type: z.string().max(60).nullable().optional(),
  message_template: zOptStr,
  is_active: z.boolean().default(true),
});
router.get('/escalation-rules', requirePerm('escalations.manage', 'notifications.logs.view_all'), async (_req, res) => {
  res.json(await db('escalation_rules as r').leftJoin('departments as d', 'd.id', 'r.department_id').leftJoin('projects as p', 'p.id', 'r.project_id')
    .select('r.*', 'd.name as department_name', 'p.name as project_name').orderBy(['r.offset_minutes', 'r.level']));
});
router.post('/escalation-rules', requirePerm('escalations.manage'), async (req, res) => {
  const [row] = await db('escalation_rules').insert({ ...parse(escSchema, req.body), created_by: me(req).id }).returning('*');
  await audit(req, { action: 'escalation_rule.created', entityType: 'escalation_rule', entityId: row.id, after: row });
  res.status(201).json(row);
});
router.patch('/escalation-rules/:id', requirePerm('escalations.manage'), async (req, res) => {
  const before = await db('escalation_rules').where({ id: idParam(req) }).first();
  if (!before) throw notFound();
  const b = parse(patchOf(escSchema), req.body);
  const [row] = await db('escalation_rules').where({ id: before.id }).update({ ...b, updated_at: db.fn.now() }).returning('*');
  const d = diff(before, b);
  await audit(req, { action: 'escalation_rule.updated', entityType: 'escalation_rule', entityId: before.id, before: d.before, after: d.after });
  res.json(row);
});
router.delete('/escalation-rules/:id', requirePerm('escalations.manage'), async (req, res) => {
  await db('escalation_rules').where({ id: idParam(req) }).update({ is_active: false });
  await audit(req, { action: 'escalation_rule.deactivated', entityType: 'escalation_rule', entityId: idParam(req) });
  res.json({ ok: true });
});
router.get('/escalations', async (req, res) => {
  const u = me(req);
  const f = parse(z.object({ ...zPage, task_id: zId.optional() }), req.query);
  const q = db('escalation_history as h').join('tasks as t', 't.id', 'h.task_id').leftJoin('escalation_rules as r', 'r.id', 'h.rule_id')
    .orderBy('h.escalated_at', 'desc').select('h.*', 't.task_key', 't.title', 't.priority', 't.status', 'r.name as rule_name');
  if (f.task_id) q.where('h.task_id', f.task_id);
  if (!can(u, 'notifications.logs.view_all') && !can(u, 'escalations.manage')) q.whereRaw('? = ANY(h.notified_user_ids)', [u.id]);
  res.json(await paginate(q, f.page, f.pageSize));
});
