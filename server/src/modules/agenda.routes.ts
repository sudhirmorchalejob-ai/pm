import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { db } from '../db/knex';
import { me, requirePerm } from '../auth/middleware';
import { audit, diff } from '../lib/audit';
import { badRequest, notFound } from '../lib/errors';
import { idParam, parse, zDate, zOptId, zOptStr, zPriority, zTime, patchOf } from '../lib/http';
import { isValidTimezone, localToUtc } from '../lib/recurrence';
import { cancelSchedule } from '../notifications/service';
import { createSchedule } from './notifications.routes';

/**
 * Personal management agenda: private follow-ups (not formal tasks) with reminders.
 * Reminders are regular notification_schedules (source = 'agenda'), so they are
 * persistent and fire server-side even when the user is offline.
 * One-time items remind `reminder_minutes_before` the due time; recurring items remind at each occurrence.
 */
export const router = Router();

const schema = z.object({
  title: z.string().trim().min(2).max(200),
  description: zOptStr,
  date: zDate,
  time: zTime,
  timezone: z.string().max(64),
  priority: zPriority.default('medium'),
  notes: zOptStr,
  reminder_minutes_before: z.number().int().min(0).max(60 * 24 * 14).nullable().optional(),
  channels: z.array(z.enum(['in_app', 'email', 'browser_push', 'mobile_push', 'whatsapp'])).default(['in_app']),
  related_department_id: zOptId,
  related_project_id: zOptId,
  recurrence: z.object({
    freq: z.enum(['daily', 'weekly', 'monthly']), interval: z.number().int().min(1).max(365).default(1),
    by_weekday: z.array(z.number().int().min(1).max(7)).optional(), ends_on: zDate.nullable().optional(),
  }).nullable().optional(),
});

async function attachReminder(u: any, item: any, b: z.infer<typeof schema>) {
  if (b.reminder_minutes_before == null && !b.recurrence) return null;
  if (b.recurrence) {
    return createSchedule(u, {
      title: `Agenda: ${item.title}`, description: item.description, message: item.notes ?? item.description, schedule_type: 'recurring',
      date: b.date, time: b.time, timezone: b.timezone, recurrence: { ...b.recurrence, interval: b.recurrence.interval ?? 1 },
      channels: b.channels, recipient_ids: [u.id], active: true, project_id: b.related_project_id ?? null,
    } as any, 'agenda', item.id);
  }
  const remindAt = DateTime.fromJSDate(new Date(item.due_at)).minus({ minutes: b.reminder_minutes_before! }).setZone(b.timezone);
  if (remindAt.toMillis() < Date.now()) return null;
  return createSchedule(u, {
    title: `Agenda: ${item.title}`, description: item.description, message: `${item.title} at ${b.time} (${b.timezone})`, schedule_type: 'one_time',
    date: remindAt.toISODate()!, time: remindAt.toFormat('HH:mm'), timezone: b.timezone, channels: b.channels, recipient_ids: [u.id], active: true,
    project_id: b.related_project_id ?? null,
  } as any, 'agenda', item.id);
}

router.get('/', requirePerm('agenda.use'), async (req, res) => {
  const f = parse(z.object({ status: z.string().optional(), from: zDate.optional(), to: zDate.optional() }), req.query);
  const q = db('management_agenda as a').leftJoin('departments as d', 'd.id', 'a.related_department_id').leftJoin('projects as p', 'p.id', 'a.related_project_id')
    .leftJoin('recurring_schedules as r', 'r.id', 'a.recurring_schedule_id')
    .where('a.owner_id', me(req).id).orderBy('a.due_at')
    .select('a.*', 'd.name as department_name', 'p.name as project_name', db.raw('row_to_json(r.*) AS recurrence'),
      db.raw(`(SELECT json_build_object('id', s.id, 'next_run_at', s.next_run_at, 'status', s.status) FROM notification_schedules s WHERE s.agenda_id = a.id AND s.status IN ('active','paused') ORDER BY s.id DESC LIMIT 1) AS reminder`));
  if (f.status) q.whereIn('a.status', f.status.split(','));
  if (f.from) q.where('a.due_at', '>=', f.from);
  if (f.to) q.where('a.due_at', '<', db.raw(`?::date + 1`, [f.to]));
  res.json(await q);
});

router.post('/', requirePerm('agenda.use'), async (req, res) => {
  const u = me(req);
  const b = parse(schema, req.body);
  if (!isValidTimezone(b.timezone)) throw badRequest('Unknown timezone');
  const due_at = localToUtc(b.date, b.time, b.timezone);
  let recurring_schedule_id = null;
  if (b.recurrence) {
    const [rs] = await db('recurring_schedules').insert({ freq: b.recurrence.freq, interval: b.recurrence.interval, by_weekday: b.recurrence.by_weekday?.length ? b.recurrence.by_weekday : null,
      time_of_day: b.time, timezone: b.timezone, starts_on: b.date, ends_on: b.recurrence.ends_on ?? null }).returning('id');
    recurring_schedule_id = rs.id;
  }
  const [item] = await db('management_agenda').insert({
    owner_id: u.id, title: b.title, description: b.description, due_at, timezone: b.timezone, priority: b.priority, notes: b.notes,
    reminder_minutes_before: b.reminder_minutes_before ?? null, recurring_schedule_id, related_department_id: b.related_department_id, related_project_id: b.related_project_id,
  }).returning('*');
  const s = await attachReminder(u, item, b);
  await audit(req, { action: 'agenda.created', entityType: 'agenda', entityId: item.id, summary: item.title, after: { reminder_schedule_id: s?.id } });
  res.status(201).json({ ...item, reminder: s ? { id: s.id, next_run_at: s.next_run_at } : null });
});

router.patch('/:id', requirePerm('agenda.use'), async (req, res) => {
  const u = me(req);
  const item = await db('management_agenda').where({ id: idParam(req), owner_id: u.id }).first();
  if (!item) throw notFound();
  const b = parse(patchOf(schema).extend({ status: z.enum(['open', 'done', 'cancelled']).optional() }), req.body);
  const patch: any = { updated_at: db.fn.now() };
  for (const k of ['title', 'description', 'priority', 'notes', 'reminder_minutes_before', 'related_department_id', 'related_project_id', 'status'] as const) if (b[k] !== undefined) patch[k] = b[k];
  const tz = b.timezone ?? item.timezone;
  if (b.date || b.time || b.timezone) {
    const local = DateTime.fromJSDate(new Date(item.due_at)).setZone(item.timezone);
    patch.due_at = localToUtc(b.date ?? local.toISODate()!, b.time ?? local.toFormat('HH:mm'), tz);
    patch.timezone = tz;
  }
  if (b.status === 'done') patch.completed_at = db.fn.now();
  const [row] = await db('management_agenda').where({ id: item.id }).update(patch).returning('*');
  const timingChanged = patch.due_at || b.reminder_minutes_before !== undefined || b.channels;
  const scheds: number[] = await db('notification_schedules').where({ agenda_id: item.id }).whereIn('status', ['active', 'paused']).pluck('id');
  if (b.status && b.status !== 'open') {
    for (const sid of scheds) await cancelSchedule(sid, u.id, `Agenda item ${b.status}`);
  } else if (timingChanged && !item.recurring_schedule_id) {
    for (const sid of scheds) await cancelSchedule(sid, u.id, 'Agenda item rescheduled');
    const local = DateTime.fromJSDate(new Date(row.due_at)).setZone(tz);
    await attachReminder(u, row, { ...(b as any), date: local.toISODate()!, time: local.toFormat('HH:mm'), timezone: tz, channels: b.channels ?? ['in_app'],
      reminder_minutes_before: b.reminder_minutes_before !== undefined ? b.reminder_minutes_before : item.reminder_minutes_before, recurrence: null });
  }
  const d = diff(item, patch);
  await audit(req, { action: b.status === 'done' ? 'agenda.completed' : 'agenda.updated', entityType: 'agenda', entityId: item.id, before: d.before, after: d.after });
  res.json(row);
});

router.delete('/:id', requirePerm('agenda.use'), async (req, res) => {
  const u = me(req);
  const item = await db('management_agenda').where({ id: idParam(req), owner_id: u.id }).first();
  if (!item) throw notFound();
  const scheds: number[] = await db('notification_schedules').where({ agenda_id: item.id }).whereIn('status', ['active', 'paused']).pluck('id');
  for (const sid of scheds) await cancelSchedule(sid, u.id, 'Agenda item deleted');
  await db('management_agenda').where({ id: item.id }).update({ status: 'cancelled', updated_at: db.fn.now() });
  await audit(req, { action: 'agenda.cancelled', entityType: 'agenda', entityId: item.id, summary: item.title });
  res.json({ ok: true });
});
