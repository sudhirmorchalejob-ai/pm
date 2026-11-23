import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { db } from '../db/knex';
import { can, me, requirePerm } from '../auth/middleware';
import { loadVisibleProject, scopeUsers, supervisedUserIds } from '../auth/scope';
import { audit } from '../lib/audit';
import { badRequest, conflict, notFound } from '../lib/errors';
import { idParam, paginate, parse, zDate, zId, zPage, zPriority, zTime, patchOf } from '../lib/http';
import { getSetting } from '../lib/settings';
import { localDateIn } from '../questionnaire/engine';
import { Frequency, validateFrequency, describeFrequency } from '../questionnaire/schedule';
import { buildPersonalEodData, personalEodText } from '../daily-work/personal-eod';
import { dueFields, materializeSeries } from '../daily-work/personal-tasks';
import { activityQuery, canSeeActivitiesOf } from './activities.routes';

/** "My Daily Work & Activities": today view, personal tasks, reminders and the personal EOD report. */
export const router = Router();
const logPerm = requirePerm('activities.log');

const todayFor = (tz: string) => localDateIn(tz);

// ===================================================================== today
router.get('/today', logPerm, async (req, res) => {
  const u = me(req);
  const date = parse(z.object({ date: zDate.optional() }), req.query).date ?? todayFor(u.timezone);
  await materializeSeries({ userIds: [u.id] });
  const now = new Date();
  const in24 = new Date(now.getTime() + 24 * 3600_000);
  const taskCols = ['t.*', 'p.name as project_name', 's.frequency as series_frequency'];
  const tasks = () => db('personal_tasks as t').leftJoin('projects as p', 'p.id', 't.project_id').leftJoin('personal_task_series as s', 's.id', 't.series_id')
    .where('t.user_id', u.id).whereNull('t.deleted_at');
  const prio = db.raw(`array_position(ARRAY['critical','high','medium','low'], t.priority)`);
  const [timeline, dueToday, overdue, undated, doneToday, reminders, schedules, followUps, checklist, eod] = await Promise.all([
    activityQuery().where('a.user_id', u.id).where('a.activity_date', date).orderBy('a.occurred_at', 'asc'),
    tasks().where('t.status', 'pending').where('t.due_date', date).orderBy([{ column: prio as any }, { column: 't.due_at' }]).select(taskCols),
    tasks().where('t.status', 'pending').where('t.due_date', '<', date).orderBy('t.due_date').limit(20).select(taskCols),
    tasks().where('t.status', 'pending').whereNull('t.due_date').orderBy([{ column: prio as any }, { column: 't.created_at', order: 'desc' }]).limit(20).select(taskCols),
    tasks().where('t.status', 'completed').where('t.completed_at', '>=', DateTime.fromISO(date, { zone: u.timezone }).startOf('day').toJSDate())
      .where('t.completed_at', '<', DateTime.fromISO(date, { zone: u.timezone }).plus({ days: 1 }).startOf('day').toJSDate()).orderBy('t.completed_at', 'desc').select(taskCols),
    tasks().where('t.status', 'pending').whereNotNull('t.remind_at').whereBetween('t.remind_at', [new Date(now.getTime() - 3600_000), in24]).orderBy('t.remind_at').select(taskCols),
    db('notification_schedules as s').join('notification_recipients as r', 'r.schedule_id', 's.id').where('r.user_id', u.id)
      .where('s.status', 'active').whereNotNull('s.next_run_at').whereBetween('s.next_run_at', [now, in24]).orderBy('s.next_run_at').limit(10)
      .select('s.id', 's.title', 's.message', 's.next_run_at', 's.task_id'),
    activityQuery().where('a.user_id', u.id).where('a.follow_up_required', true).whereNull('a.follow_up_done_at').orderByRaw('a.follow_up_due ASC NULLS LAST, a.occurred_at ASC').limit(15),
    db('checklists').where({ user_id: u.id, checklist_date: date }).first('id', 'status', 'answered_items', 'total_items', 'required_items', 'required_answered', 'completion_percent', 'due_at'),
    db('personal_eod_reports').where({ user_id: u.id, report_date: date }).first('id', 'status', 'updated_at', 'finalized_at', 'revision'),
  ]);
  res.json({
    date, timezone: u.timezone,
    timeline,
    tasks: { due_today: dueToday, overdue, undated, completed_today: doneToday },
    reminders: [
      ...reminders.map((t: any) => ({ kind: 'task', id: t.id, title: t.title, at: t.remind_at, due_at: t.due_at })),
      ...schedules.map((s: any) => ({ kind: 'reminder', id: s.id, title: s.title, at: s.next_run_at, body: s.message, task_id: s.task_id })),
      ...(checklist && checklist.status !== 'submitted' && checklist.total_items > 0 && checklist.due_at ? [{ kind: 'checklist', id: checklist.id, title: 'Daily checklist deadline', at: checklist.due_at }] : []),
    ].sort((a: any, b: any) => +new Date(a.at) - +new Date(b.at)),
    follow_ups: followUps,
    checklist: checklist ?? null,
    eod: eod ?? null,
  });
});

/** Team widgets for supervisors: today's updates, pending checklists, department progress. */
router.get('/team', requirePerm('checklists.monitor', 'activities.view_team'), async (req, res) => {
  const u = me(req);
  const tz: string = await getSetting('default_timezone');
  const date = parse(z.object({ date: zDate.optional() }), req.query).date ?? todayFor(tz);
  const ids = await supervisedUserIds(u); // null = whole organization
  const inScope = (qb: any, col: string) => (ids ? qb.whereIn(col, ids) : qb);
  const start = DateTime.fromISO(date, { zone: tz }).startOf('day').toJSDate();
  const end = DateTime.fromISO(date, { zone: tz }).plus({ days: 1 }).startOf('day').toJSDate();

  const [submissions, reports, acts, pending] = await Promise.all([
    inScope(db('checklists as c').join('users as e', 'e.id', 'c.user_id').leftJoin('departments as d', 'd.id', 'c.department_id'), 'c.user_id')
      .where('c.checklist_date', date).whereNotNull('c.submitted_at').whereNot('c.user_id', u.id).orderBy('c.submitted_at', 'desc').limit(20)
      .select('c.id', 'c.user_id', 'e.name', 'd.name as department_name', 'c.submitted_at as at', 'c.answered_items', 'c.total_items', 'c.is_late'),
    inScope(db('daily_reports as r').join('users as e', 'e.id', 'r.user_id'), 'r.user_id').where('r.report_date', date).whereNot('r.user_id', u.id)
      .orderBy('r.submitted_at', 'desc').limit(20).select('r.id', 'r.user_id', 'e.name', 'r.submitted_at as at', 'r.work_completed'),
    can(u, 'activities.view_team')
      ? inScope(activityQuery(), 'a.user_id').where('a.activity_date', date).whereNot('a.user_id', u.id).orderBy('a.occurred_at', 'desc').limit(20)
      : Promise.resolve([]),
    can(u, 'checklists.monitor')
      ? inScope(db('checklists as c').join('users as e', 'e.id', 'c.user_id').leftJoin('departments as d', 'd.id', 'c.department_id'), 'c.user_id')
        .where('c.checklist_date', date).where('c.total_items', '>', 0).whereNot('c.status', 'submitted').where('e.is_active', true)
        .orderByRaw('c.due_at ASC NULLS LAST, e.name')
        .select('c.id', 'c.user_id', 'e.name', 'd.name as department_name', 'c.status', 'c.answered_items', 'c.total_items', 'c.required_items', 'c.required_answered', 'c.due_at')
      : Promise.resolve([]),
  ]);
  const updates = [
    ...submissions.map((s: any) => ({ kind: 'checklist', id: s.id, user_id: s.user_id, name: s.name, at: s.at, text: `Submitted daily checklist (${s.answered_items}/${s.total_items} answered)${s.is_late ? ' — late' : ''}`, department_name: s.department_name })),
    ...reports.map((r: any) => ({ kind: 'daily_report', id: r.id, user_id: r.user_id, name: r.name, at: r.at, text: String(r.work_completed).slice(0, 240) })),
    ...acts.map((a: any) => ({ kind: 'activity', id: a.id, user_id: a.user_id, name: a.user_name, at: a.occurred_at, text: `${a.category_name}: ${String(a.description).slice(0, 200)}` })),
  ].sort((a, b) => +new Date(b.at) - +new Date(a.at)).slice(0, 25);

  // Department progress (today): checklist completion + task flow
  const deptQ = db('departments as d').where('d.is_active', true).whereNull('d.deleted_at').orderBy('d.name').select('d.id', 'd.name',
    db.raw(`(SELECT count(*) FROM users e WHERE e.department_id = d.id AND e.is_active AND e.deleted_at IS NULL ${ids ? 'AND e.id = ANY(?)' : ''})::int AS employees`, ids ? [ids] : []),
    db.raw(`(SELECT count(*) FROM checklists c WHERE c.department_id = d.id AND c.checklist_date = ? AND c.total_items > 0 ${ids ? 'AND c.user_id = ANY(?)' : ''})::int AS expected`, ids ? [date, ids] : [date]),
    db.raw(`(SELECT count(*) FROM checklists c WHERE c.department_id = d.id AND c.checklist_date = ? AND c.status = 'submitted' ${ids ? 'AND c.user_id = ANY(?)' : ''})::int AS submitted`, ids ? [date, ids] : [date]),
    db.raw(`(SELECT round(avg(c.completion_percent))::int FROM checklists c WHERE c.department_id = d.id AND c.checklist_date = ? AND c.total_items > 0 ${ids ? 'AND c.user_id = ANY(?)' : ''}) AS avg_completion`, ids ? [date, ids] : [date]),
    db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.deleted_at IS NULL AND NOT t.is_recurring_template AND t.status NOT IN ('completed','cancelled'))::int AS open_tasks`),
    db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.deleted_at IS NULL AND t.is_overdue AND t.status NOT IN ('completed','cancelled'))::int AS overdue_tasks`),
    db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.status = 'completed' AND t.completed_at >= ? AND t.completed_at < ?)::int AS completed_today`, [start, end]));
  if (u.scope === 'department' && u.departmentId) deptQ.where('d.id', u.departmentId);
  const departments = (await deptQ).filter((d: any) => d.employees > 0 || d.expected > 0);
  res.json({ date, updates, pending_checklists: pending.map((p: any) => ({ ...p, overdue: !!p.due_at && new Date(p.due_at) < new Date() })), departments });
});

// ===================================================================== personal tasks
const recurrenceSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'specific_dates', 'custom']),
  frequency_config: z.record(z.string(), z.any()).default({}),
  start_date: zDate.optional(),
  end_date: zDate.nullable().optional(),
});
const taskSchema = z.object({
  title: z.string().trim().min(2).max(300),
  description: z.string().trim().max(5000).nullable().optional(),
  priority: zPriority.default('medium'),
  project_id: zId.nullable().optional(),
  due_date: zDate.nullable().optional(),
  due_time: zTime.nullable().optional(),
  remind_at: z.string().datetime({ offset: true }).nullable().optional(),       // one-off tasks
  reminder_offset_minutes: z.number().int().min(0).max(1440).nullable().optional(), // minutes before the due time
  recurrence: recurrenceSchema.nullable().optional(),
});

async function ownTask(req: any) {
  const t = await db('personal_tasks').where({ id: idParam(req) }).whereNull('deleted_at').first();
  if (!t || t.user_id !== me(req).id) throw notFound('Task not found');
  return t;
}

router.get('/tasks', logPerm, async (req, res) => {
  const u = me(req);
  const f = parse(z.object({ ...zPage, status: z.enum(['pending', 'completed', 'cancelled', 'overdue']).optional(), from: zDate.optional(), to: zDate.optional(), q: z.string().max(200).optional(), series_id: zId.optional() }), req.query);
  await materializeSeries({ userIds: [u.id] });
  const today = todayFor(u.timezone);
  const q = db('personal_tasks as t').leftJoin('projects as p', 'p.id', 't.project_id').leftJoin('personal_task_series as s', 's.id', 't.series_id')
    .where('t.user_id', u.id).whereNull('t.deleted_at').select('t.*', 'p.name as project_name', 's.frequency as series_frequency');
  if (f.status === 'overdue') q.where('t.status', 'pending').where('t.due_date', '<', today);
  else if (f.status) q.where('t.status', f.status);
  if (f.from) q.where('t.due_date', '>=', f.from);
  if (f.to) q.where('t.due_date', '<=', f.to);
  if (f.series_id) q.where('t.series_id', f.series_id);
  if (f.q) q.where((w) => w.whereILike('t.title', `%${f.q}%`).orWhereILike('t.description', `%${f.q}%`).orWhereILike('t.completion_note', `%${f.q}%`));
  q.orderByRaw(`(t.status = 'pending') DESC, t.due_date DESC NULLS LAST, t.id DESC`);
  res.json(await paginate(q, f.page, f.pageSize));
});

router.post('/tasks', logPerm, async (req, res) => {
  const u = me(req);
  const b = parse(taskSchema, req.body);
  if (b.project_id) await loadVisibleProject(u, b.project_id);
  if (b.recurrence) {
    const v = validateFrequency(b.recurrence.frequency as Frequency, b.recurrence.frequency_config);
    if (!v.ok) throw badRequest(v.error);
    const start = b.recurrence.start_date ?? todayFor(u.timezone);
    if (b.recurrence.end_date && b.recurrence.end_date < start) throw badRequest('End date must be on or after the start date');
    const [series] = await db('personal_task_series').insert({
      user_id: u.id, title: b.title, description: b.description ?? null, priority: b.priority, project_id: b.project_id ?? null,
      frequency: b.recurrence.frequency, frequency_config: JSON.stringify(v.config), start_date: start, end_date: b.recurrence.end_date ?? null,
      due_time: b.due_time ?? null, reminder_offset_minutes: b.due_time ? b.reminder_offset_minutes ?? null : null,
    }).returning('*');
    await materializeSeries({ userIds: [u.id] });
    await audit(req, { action: 'personal_task.series_created', entityType: 'personal_task_series', entityId: series.id, summary: `${b.title} (${describeFrequency(series)})` });
    return res.status(201).json({ series });
  }
  const { due_at, remind_at: offsetRemind } = dueFields(b.due_date ?? null, b.due_time ?? null, u.timezone, b.reminder_offset_minutes ?? null);
  const [task] = await db('personal_tasks').insert({
    user_id: u.id, title: b.title, description: b.description ?? null, priority: b.priority, project_id: b.project_id ?? null,
    due_date: b.due_date ?? null, due_at, remind_at: b.remind_at ? new Date(b.remind_at) : offsetRemind,
  }).returning('*');
  await audit(req, { action: 'personal_task.created', entityType: 'personal_task', entityId: task.id, summary: b.title });
  res.status(201).json({ task });
});

router.patch('/tasks/:id', logPerm, async (req, res) => {
  const u = me(req);
  const before = await ownTask(req);
  const b = parse(patchOf(taskSchema.omit({ recurrence: true })).extend({
    status: z.enum(['pending', 'completed', 'cancelled']).optional(), completion_note: z.string().trim().max(5000).nullable().optional(),
  }), req.body);
  if (b.project_id) await loadVisibleProject(u, b.project_id);
  const patch: any = { updated_at: db.fn.now() };
  for (const k of ['title', 'description', 'priority', 'project_id', 'completion_note'] as const) if (b[k] !== undefined) patch[k] = b[k];
  if (b.due_date !== undefined || b.due_time !== undefined || b.reminder_offset_minutes !== undefined) {
    const date = b.due_date !== undefined ? b.due_date : before.due_date;
    const time = b.due_time !== undefined ? b.due_time : (before.due_at ? DateTime.fromJSDate(new Date(before.due_at)).setZone(u.timezone).toFormat('HH:mm') : null);
    const f = dueFields(date ?? null, time ?? null, u.timezone, b.reminder_offset_minutes ?? null);
    patch.due_date = date ?? null; patch.due_at = f.due_at;
    if (b.reminder_offset_minutes !== undefined) patch.remind_at = f.remind_at;
  }
  if (b.remind_at !== undefined) patch.remind_at = b.remind_at ? new Date(b.remind_at) : null;
  if (b.status && b.status !== before.status) {
    patch.status = b.status;
    patch.completed_at = b.status === 'completed' ? new Date() : null;
  }
  await db('personal_tasks').where({ id: before.id }).update(patch);
  const action = b.status === 'completed' ? 'personal_task.completed' : b.status === 'pending' && before.status !== 'pending' ? 'personal_task.reopened' : b.status === 'cancelled' ? 'personal_task.cancelled' : 'personal_task.updated';
  await audit(req, { action, entityType: 'personal_task', entityId: before.id, summary: before.title, after: b });
  res.json(await db('personal_tasks').where({ id: before.id }).first());
});

router.delete('/tasks/:id', logPerm, async (req, res) => {
  const t = await ownTask(req);
  await db('personal_tasks').where({ id: t.id }).update({ deleted_at: db.fn.now() });
  await audit(req, { action: 'personal_task.deleted', entityType: 'personal_task', entityId: t.id, summary: t.title });
  res.json({ ok: true });
});

router.get('/series', logPerm, async (req, res) => {
  const rows = await db('personal_task_series as s').leftJoin('projects as p', 'p.id', 's.project_id').where('s.user_id', me(req).id).whereNull('s.deleted_at')
    .orderBy([{ column: 's.is_active', order: 'desc' }, { column: 's.title' }]).select('s.*', 'p.name as project_name',
      db.raw(`(SELECT count(*) FROM personal_tasks t WHERE t.series_id = s.id AND t.status = 'completed' AND t.deleted_at IS NULL)::int AS completed`),
      db.raw(`(SELECT count(*) FROM personal_tasks t WHERE t.series_id = s.id AND t.deleted_at IS NULL)::int AS occurrences`));
  res.json(rows.map((s: any) => ({ ...s, schedule: describeFrequency(s) })));
});

router.patch('/series/:id', logPerm, async (req, res) => {
  const u = me(req);
  const s = await db('personal_task_series').where({ id: idParam(req), user_id: u.id }).whereNull('deleted_at').first();
  if (!s) throw notFound();
  const b = parse(z.object({
    title: z.string().trim().min(2).max(300).optional(), description: z.string().trim().max(5000).nullable().optional(), priority: zPriority.optional(),
    is_active: z.boolean().optional(), end_date: zDate.nullable().optional(), due_time: zTime.nullable().optional(),
    reminder_offset_minutes: z.number().int().min(0).max(1440).nullable().optional(),
    frequency: z.enum(['daily', 'weekly', 'monthly', 'specific_dates', 'custom']).optional(), frequency_config: z.record(z.string(), z.any()).optional(),
  }), req.body);
  const patch: any = { ...b, updated_at: db.fn.now() };
  if (b.frequency || b.frequency_config) {
    const v = validateFrequency((b.frequency ?? s.frequency) as Frequency, b.frequency_config ?? s.frequency_config);
    if (!v.ok) throw badRequest(v.error);
    patch.frequency_config = JSON.stringify(v.config);
  }
  await db('personal_task_series').where({ id: s.id }).update(patch);
  await audit(req, { action: b.is_active === false ? 'personal_task.series_paused' : 'personal_task.series_updated', entityType: 'personal_task_series', entityId: s.id, summary: s.title, after: b });
  if (b.is_active !== false) await materializeSeries({ userIds: [u.id] });
  res.json(await db('personal_task_series').where({ id: s.id }).first());
});

router.delete('/series/:id', logPerm, async (req, res) => {
  const s = await db('personal_task_series').where({ id: idParam(req), user_id: me(req).id }).whereNull('deleted_at').first();
  if (!s) throw notFound();
  // Past occurrences (and their completion history) are kept; only future generation stops.
  await db('personal_task_series').where({ id: s.id }).update({ deleted_at: db.fn.now(), is_active: false });
  await audit(req, { action: 'personal_task.series_deleted', entityType: 'personal_task_series', entityId: s.id, summary: s.title });
  res.json({ ok: true });
});

// ===================================================================== personal EOD
async function loadEod(userId: number, date: string) {
  const [report, data] = await Promise.all([db('personal_eod_reports').where({ user_id: userId, report_date: date }).first(), buildPersonalEodData(userId, date)]);
  const generated = personalEodText(data, report?.next_day_priorities ?? null);
  return { report: report ?? null, data, generated, stale: !!report && report.status === 'draft' && report.generated_content !== generated };
}

router.get('/eod', logPerm, async (req, res) => {
  const u = me(req);
  const date = parse(z.object({ date: zDate.optional() }), req.query).date ?? todayFor(u.timezone);
  res.json({ date, ...(await loadEod(u.id, date)) });
});

const eodDate = z.object({ date: zDate });

/** (Re)generate the draft from recorded entries. A finalized report must be reopened first. */
router.post('/eod/generate', logPerm, async (req, res) => {
  const u = me(req);
  const b = parse(eodDate.extend({ next_day_priorities: z.string().max(5000).nullable().optional() }), req.body);
  const existing = await db('personal_eod_reports').where({ user_id: u.id, report_date: b.date }).first();
  if (existing?.status === 'final') throw conflict('This report is finalized. Reopen it to regenerate.');
  const priorities = b.next_day_priorities !== undefined ? b.next_day_priorities : existing?.next_day_priorities ?? null;
  const data = await buildPersonalEodData(u.id, b.date);
  const text = personalEodText(data, priorities);
  if (existing) {
    await db('personal_eod_reports').where({ id: existing.id }).update({ content: text, generated_content: text, next_day_priorities: priorities, data: JSON.stringify(data), revision: existing.revision + 1, updated_at: db.fn.now() });
  } else {
    await db('personal_eod_reports').insert({ user_id: u.id, report_date: b.date, content: text, generated_content: text, next_day_priorities: priorities, data: JSON.stringify(data) });
  }
  await audit(req, { action: 'personal_eod.generated', entityType: 'personal_eod', summary: b.date });
  res.json({ date: b.date, ...(await loadEod(u.id, b.date)) });
});

router.put('/eod', logPerm, async (req, res) => {
  const u = me(req);
  const b = parse(eodDate.extend({ content: z.string().trim().min(1).max(50000), next_day_priorities: z.string().max(5000).nullable().optional(), expected_revision: z.number().int().optional() }), req.body);
  const existing = await db('personal_eod_reports').where({ user_id: u.id, report_date: b.date }).first();
  if (existing?.status === 'final') throw conflict('This report is finalized. Reopen it to edit.');
  if (existing && b.expected_revision !== undefined && b.expected_revision !== existing.revision) throw conflict('This report was changed elsewhere. Reload it and try again.');
  if (existing) {
    await db('personal_eod_reports').where({ id: existing.id }).update({ content: b.content, next_day_priorities: b.next_day_priorities !== undefined ? b.next_day_priorities : existing.next_day_priorities, revision: existing.revision + 1, updated_at: db.fn.now() });
  } else {
    const data = await buildPersonalEodData(u.id, b.date);
    await db('personal_eod_reports').insert({ user_id: u.id, report_date: b.date, content: b.content, generated_content: personalEodText(data, b.next_day_priorities ?? null), next_day_priorities: b.next_day_priorities ?? null, data: JSON.stringify(data) });
  }
  await audit(req, { action: 'personal_eod.saved', entityType: 'personal_eod', summary: b.date });
  res.json({ date: b.date, ...(await loadEod(u.id, b.date)) });
});

router.post('/eod/finalize', logPerm, async (req, res) => {
  const u = me(req);
  const b = parse(eodDate.extend({ content: z.string().trim().min(1).max(50000).optional() }), req.body);
  const existing = await db('personal_eod_reports').where({ user_id: u.id, report_date: b.date }).first();
  if (!existing && !b.content) throw badRequest('Generate or write the report before finalizing it');
  if (existing?.status === 'final') throw conflict('Already finalized');
  const data = await buildPersonalEodData(u.id, b.date);
  if (existing) {
    await db('personal_eod_reports').where({ id: existing.id }).update({ status: 'final', content: b.content ?? existing.content, data: JSON.stringify(data), finalized_at: new Date(), revision: existing.revision + 1, updated_at: db.fn.now() });
  } else {
    await db('personal_eod_reports').insert({ user_id: u.id, report_date: b.date, status: 'final', content: b.content, generated_content: personalEodText(data, null), data: JSON.stringify(data), finalized_at: new Date() });
  }
  await audit(req, { action: 'personal_eod.finalized', entityType: 'personal_eod', summary: b.date });
  res.json({ date: b.date, ...(await loadEod(u.id, b.date)) });
});

router.post('/eod/reopen', logPerm, async (req, res) => {
  const u = me(req);
  const b = parse(eodDate, req.body);
  const existing = await db('personal_eod_reports').where({ user_id: u.id, report_date: b.date, status: 'final' }).first();
  if (!existing) throw notFound('No finalized report for this date');
  await db('personal_eod_reports').where({ id: existing.id }).update({ status: 'draft', finalized_at: null, revision: existing.revision + 1, updated_at: db.fn.now() });
  await audit(req, { action: 'personal_eod.reopened', entityType: 'personal_eod', summary: b.date });
  res.json({ date: b.date, ...(await loadEod(u.id, b.date)) });
});

router.get('/eod/history', logPerm, async (req, res) => {
  const u = me(req);
  const f = parse(z.object({ ...zPage, user_id: zId.optional() }), req.query);
  const userId = f.user_id ?? u.id;
  if (userId !== u.id && !(await canSeeActivitiesOf(u, userId))) throw notFound();
  const q = db('personal_eod_reports').where({ user_id: userId }).orderBy('report_date', 'desc')
    .select('id', 'report_date', 'status', 'finalized_at', 'updated_at', 'revision', db.raw(`(data->'summary') AS summary`));
  res.json(await paginate(q, f.page, f.pageSize));
});

/** A supervisor reading someone's personal report (finalized or draft) for a date. */
router.get('/eod/users/:userId', requirePerm('activities.view_team', 'eod.view'), async (req, res) => {
  const u = me(req);
  const userId = idParam(req, 'userId');
  if (!(await scopeUsers(db('users as u').where('u.id', userId), u).first('u.id'))) throw notFound();
  const date = parse(z.object({ date: zDate }), req.query).date;
  const report = await db('personal_eod_reports').where({ user_id: userId, report_date: date }).first();
  res.json({ date, report: report ?? null });
});
