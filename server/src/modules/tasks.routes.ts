import { Router, Request } from 'express';
import { z } from 'zod';
import { db, Tx } from '../db/knex';
import { AuthUser, can, me, requirePerm } from '../auth/middleware';
import { assertCanManageTask, canManageTask, canReviewTask, loadVisibleProject, loadVisibleTask, scopeTasks } from '../auth/scope';
import { audit, diff } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { applySort, idParam, paginate, parse, zBoolQ, zCsv, zCsvIds, zDate, zId, zOptId, zOptStr, zPage, zPriority, zTime } from '../lib/http';
import { firstOccurrence, isValidTimezone, localToUtc } from '../lib/recurrence';
import { emitEvent } from '../notifications/events';
import { armSchedule, onTaskClosed, onTaskDeadlineChanged } from '../notifications/service';
import { registerFile, upload } from './files';
import { recomputeProjectProgress } from './projects.routes';

export const router = Router();

export const TASK_STATUSES = ['not_started', 'in_progress', 'on_hold', 'blocked', 'submitted', 'under_review', 'revision_required', 'completed', 'cancelled'] as const;
const OPEN = ['not_started', 'in_progress', 'on_hold', 'blocked', 'revision_required'];

const assigneesAgg = db.raw(`coalesce((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'is_primary', ta.is_primary) ORDER BY ta.is_primary DESC, u.name)
  FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id = t.id), '[]') AS assignees`);

// ===================================================================== list
const listQ = z.object({
  ...zPage,
  q: z.string().max(100).optional(),
  status: zCsv,
  priority: zCsv,
  project_id: zId.optional(),
  department_id: zId.optional(),
  assignee_id: zId.optional(),
  assigned_by: zId.optional(),
  milestone_id: zId.optional(),
  due: z.enum(['today', 'overdue', 'week', 'upcoming', 'no_deadline']).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  mine: zBoolQ,
  archived: zBoolQ,
  templates: zBoolQ,
  ids: zCsvIds,
  sort: z.string().optional(),
});

export function taskListQuery(u: AuthUser, f: z.infer<typeof listQ>) {
  const q = scopeTasks(db('tasks as t'), u).whereNull('t.deleted_at')
    .leftJoin('projects as p', 'p.id', 't.project_id').leftJoin('departments as d', 'd.id', 't.department_id')
    .leftJoin('users as ab', 'ab.id', 't.assigned_by')
    .select('t.id', 't.task_key', 't.title', 't.status', 't.priority', 't.progress', 't.deadline', 't.start_date', 't.estimated_hours', 't.actual_hours',
      't.is_overdue', 't.complexity', 't.task_type', 't.project_id', 'p.name as project_name', 'p.code as project_code', 't.department_id', 'd.name as department_name',
      't.assigned_by', 'ab.name as assigned_by_name', 't.created_at', 't.updated_at', 't.submitted_at', 't.completed_at', 't.is_recurring_template', 't.milestone_id',
      assigneesAgg,
      db.raw(`(SELECT count(*) FROM subtasks s WHERE s.task_id = t.id)::int AS subtask_count`),
      db.raw(`(SELECT count(*) FROM subtasks s WHERE s.task_id = t.id AND s.is_done)::int AS subtask_done`),
      db.raw(`(SELECT count(*) FROM task_comments c WHERE c.task_id = t.id AND c.deleted_at IS NULL)::int AS comment_count`));
  q.where('t.is_archived', !!f.archived);
  q.where('t.is_recurring_template', !!f.templates);
  if (f.q) q.where((w) => w.whereILike('t.title', `%${f.q}%`).orWhereILike('t.task_key', `%${f.q}%`));
  if (f.status) q.whereIn('t.status', f.status);
  if (f.priority) q.whereIn('t.priority', f.priority);
  if (f.project_id) q.where('t.project_id', f.project_id);
  if (f.milestone_id) q.where('t.milestone_id', f.milestone_id);
  if (f.department_id) q.where('t.department_id', f.department_id);
  if (f.assigned_by) q.where('t.assigned_by', f.assigned_by);
  if (f.ids) q.whereIn('t.id', f.ids);
  const assignee = f.mine ? u.id : f.assignee_id;
  if (assignee) q.whereExists(db('task_assignees as x').whereRaw('x.task_id = t.id').andWhere('x.user_id', assignee));
  const now = new Date();
  if (f.due === 'overdue') q.where('t.is_overdue', true).whereIn('t.status', OPEN);
  if (f.due === 'today') q.whereRaw(`(t.deadline AT TIME ZONE ?)::date = (now() AT TIME ZONE ?)::date`, [u.timezone, u.timezone]);
  if (f.due === 'week') q.whereBetween('t.deadline', [now, new Date(now.getTime() + 7 * 86400_000)]);
  if (f.due === 'upcoming') q.where('t.deadline', '>', now).whereNotIn('t.status', ['completed', 'cancelled']);
  if (f.due === 'no_deadline') q.whereNull('t.deadline');
  if (f.from) q.where('t.deadline', '>=', f.from);
  if (f.to) q.where('t.deadline', '<', db.raw(`?::date + 1`, [f.to]));
  return q;
}

router.get('/', requirePerm('tasks.view'), async (req, res) => {
  const f = parse(listQ, req.query);
  const q = taskListQuery(me(req), f);
  if (!f.sort || f.sort.startsWith('deadline')) q.orderByRaw(`(t.status IN ('completed','cancelled')) ASC`);
  applySort(q, f.sort, { deadline: 't.deadline', priority: db.raw(`array_position(ARRAY['low','medium','high','critical'], t.priority)`) as any, created: 't.created_at', updated: 't.updated_at', title: 't.title', status: 't.status', progress: 't.progress', key: 't.id' }, 'deadline:asc');
  if (!f.sort || f.sort.startsWith('deadline')) q.orderBy('t.id', 'desc');
  res.json(await paginate(q, f.page, f.pageSize));
});

// ===================================================================== create
const reminderSchema = z.object({ offset_minutes: z.number().int().min(0).max(60 * 24 * 60), channels: z.array(z.enum(['in_app', 'email', 'browser_push', 'mobile_push', 'whatsapp'])).default(['in_app']) });
const recurrenceSchema = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly']), interval: z.number().int().min(1).max(365).default(1),
  by_weekday: z.array(z.number().int().min(1).max(7)).optional(), by_month_day: z.number().int().min(1).max(31).optional(),
  time_of_day: zTime, timezone: z.string(), starts_on: zDate, ends_on: zDate.nullable().optional(), max_count: z.number().int().min(1).optional(),
});

const taskSchema = z.object({
  title: z.string().trim().min(2).max(300),
  description: zOptStr,
  department_id: zOptId,
  project_id: zOptId,
  milestone_id: zOptId,
  priority: zPriority.default('medium'),
  complexity: z.number().int().min(1).max(5).default(3),
  task_type: z.string().trim().max(60).default('general'),
  start_date: zDate.nullable().optional(),
  deadline: z.string().datetime({ offset: true }).nullable().optional(),
  estimated_hours: z.number().min(0).max(10000).nullable().optional(),
  remarks: zOptStr,
  assignee_ids: z.array(zId).default([]),
  primary_assignee_id: zOptId,
  subtasks: z.array(z.string().trim().min(1).max(300)).default([]),
  checklist: z.array(z.string().trim().min(1).max(300)).default([]),
  depends_on: z.array(zId).default([]),
  reminders: z.array(reminderSchema).default([]),
  recurrence: recurrenceSchema.nullable().optional(),
});

async function validateAssignment(u: AuthUser, assigneeIds: number[]) {
  if (!assigneeIds.length) return;
  const others = assigneeIds.filter((id) => id !== u.id);
  if (others.length && !can(u, 'tasks.assign')) throw forbidden('You can only create tasks for yourself');
  const valid = await db('users').whereIn('id', assigneeIds).where('is_active', true).whereNull('deleted_at').pluck('id');
  if (valid.length !== new Set(assigneeIds).size) throw badRequest('One or more assignees are invalid or inactive');
  // Scoped managers may only assign inside their scope (HOD → own department, TL → own team).
  if (others.length && u.scope === 'department' && u.departmentId && !can(u, 'tasks.manage_all')) {
    const outside = await db('users').whereIn('id', others).whereNot('department_id', u.departmentId).pluck('name');
    if (outside.length) throw forbidden(`Cannot assign outside your department: ${outside.join(', ')}`);
  }
  if (others.length && u.scope === 'team' && !can(u, 'tasks.manage_all')) {
    const outside = await db('users').whereIn('id', others).where((w) => w.whereNot('team_id', u.teamId ?? 0).orWhereNull('team_id')).pluck('name');
    if (outside.length) throw forbidden(`Cannot assign outside your team: ${outside.join(', ')}`);
  }
}

async function wouldCreateCycle(taskId: number, dependsOn: number, trx: Tx = db) {
  if (taskId === dependsOn) return true;
  const r = await trx.raw(`WITH RECURSIVE chain(id) AS (
      SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?
      UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN chain c ON d.task_id = c.id)
    SELECT 1 FROM chain WHERE id = ? LIMIT 1`, [dependsOn, taskId]);
  return r.rows.length > 0;
}

router.post('/', requirePerm('tasks.create', 'tasks.update_own'), async (req, res) => {
  const u = me(req);
  const b = parse(taskSchema, req.body);
  if (!can(u, 'tasks.create')) { // employees may log personal tasks for themselves only
    b.assignee_ids = [u.id];
  }
  if (!b.assignee_ids.length) b.assignee_ids = [u.id];
  await validateAssignment(u, b.assignee_ids);
  if (b.project_id) await loadVisibleProject(u, b.project_id);
  if (b.milestone_id && !(await db('project_milestones').where({ id: b.milestone_id, project_id: b.project_id ?? 0 }).first())) throw badRequest('Milestone does not belong to the project');
  if (b.recurrence && !isValidTimezone(b.recurrence.timezone)) throw badRequest('Unknown timezone');
  let department_id = b.department_id;
  if (!department_id) {
    const first = await db('users').where({ id: b.primary_assignee_id ?? b.assignee_ids[0] }).first('department_id');
    department_id = first?.department_id ?? u.departmentId;
  }
  const task = await db.transaction(async (trx) => {
    let recurring_schedule_id = null; let recurrence_next_at = null;
    if (b.recurrence) {
      const [rs] = await trx('recurring_schedules').insert({ ...b.recurrence, by_weekday: b.recurrence.by_weekday ?? null }).returning('*');
      recurring_schedule_id = rs.id;
      recurrence_next_at = firstOccurrence({ ...rs, time_of_day: String(rs.time_of_day) });
    }
    const [t] = await trx('tasks').insert({
      title: b.title, description: b.description, department_id, project_id: b.project_id, milestone_id: b.milestone_id, assigned_by: u.id,
      priority: b.priority, complexity: b.complexity, task_type: b.task_type, start_date: b.start_date, deadline: b.recurrence ? null : b.deadline,
      estimated_hours: b.estimated_hours, remarks: b.remarks, is_recurring_template: !!b.recurrence, recurring_schedule_id, recurrence_next_at,
    }).returning('*');
    const primary = b.primary_assignee_id ?? b.assignee_ids[0];
    await trx('task_assignees').insert([...new Set(b.assignee_ids)].map((id) => ({ task_id: t.id, user_id: id, is_primary: id === primary, assigned_by: u.id })));
    if (b.subtasks.length) await trx('subtasks').insert(b.subtasks.map((title, i) => ({ task_id: t.id, title, sort_order: i })));
    if (b.checklist.length) await trx('task_checklist_items').insert(b.checklist.map((label, i) => ({ task_id: t.id, label, sort_order: i })));
    for (const dep of b.depends_on) await trx('task_dependencies').insert({ task_id: t.id, depends_on_task_id: dep }).onConflict().ignore();
    await trx('task_updates').insert({ task_id: t.id, user_id: u.id, kind: 'status', status_to: 'not_started', note: 'Task created' });
    await audit(req, { action: 'task.created', entityType: 'task', entityId: t.id, summary: `${t.task_key} ${t.title}`, after: { ...b, reminders: undefined } }, trx);
    return t;
  });
  // Deadline-relative reminders ("30 minutes before the deadline")
  if (task.deadline) {
    for (const r of b.reminders) {
      const [s] = await db('notification_schedules').insert({
        title: `Reminder: ${task.title}`, message: `Due in ${r.offset_minutes} minutes`, created_by: u.id, task_id: task.id, project_id: task.project_id,
        schedule_type: 'deadline_offset', offset_minutes: r.offset_minutes, timezone: u.timezone, channels: r.channels,
      }).returning('id');
      await db('notification_recipients').insert(b.assignee_ids.map((id) => ({ schedule_id: s.id, user_id: id })));
      await armSchedule(s.id);
    }
  }
  if (task.project_id) await recomputeProjectProgress(task.project_id);
  await emitEvent({ type: 'task.assigned', actorId: u.id, taskId: task.id });
  res.status(201).json(task);
});

// ===================================================================== detail
router.get('/:id', requirePerm('tasks.view'), async (req, res) => {
  const u = me(req);
  const t = await loadVisibleTask(u, idParam(req));
  const [extra, assignees, subtasks, checklist, attachments, deps, dependents, approvals, time, reminders, rec] = await Promise.all([
    db('tasks as t').leftJoin('projects as p', 'p.id', 't.project_id').leftJoin('departments as d', 'd.id', 't.department_id')
      .leftJoin('users as ab', 'ab.id', 't.assigned_by').leftJoin('users as ap', 'ap.id', 't.approved_by').leftJoin('project_milestones as m', 'm.id', 't.milestone_id')
      .where('t.id', t.id).first('p.name as project_name', 'p.code as project_code', 'd.name as department_name', 'ab.name as assigned_by_name', 'ap.name as approved_by_name', 'm.title as milestone_title'),
    db('task_assignees as ta').join('users as us', 'us.id', 'ta.user_id').where('ta.task_id', t.id).select('us.id', 'us.name', 'us.employee_code', 'ta.is_primary', 'ta.assigned_at'),
    db('subtasks as s').leftJoin('users as us', 'us.id', 's.assignee_id').where('s.task_id', t.id).orderBy(['s.sort_order', 's.id']).select('s.*', 'us.name as assignee_name'),
    db('task_checklist_items').where({ task_id: t.id }).orderBy(['sort_order', 'id']),
    db('task_attachments as a').join('files as f', 'f.id', 'a.file_id').join('users as us', 'us.id', 'a.uploaded_by').where('a.task_id', t.id)
      .orderBy('a.created_at', 'desc').select('a.id', 'a.is_deliverable', 'a.created_at', 'f.id as file_id', 'f.original_name', 'f.size_bytes', 'f.mime_type', 'us.name as uploaded_by_name'),
    db('task_dependencies as d').join('tasks as x', 'x.id', 'd.depends_on_task_id').where('d.task_id', t.id).select('x.id', 'x.task_key', 'x.title', 'x.status', 'd.dependency_type'),
    db('task_dependencies as d').join('tasks as x', 'x.id', 'd.task_id').where('d.depends_on_task_id', t.id).select('x.id', 'x.task_key', 'x.title', 'x.status'),
    db('task_approvals as a').join('users as r', 'r.id', 'a.requested_by').leftJoin('users as v', 'v.id', 'a.reviewer_id').where('a.task_id', t.id)
      .orderBy('a.requested_at', 'desc').select('a.*', 'r.name as requested_by_name', 'v.name as reviewer_name'),
    db('time_entries as e').join('users as us', 'us.id', 'e.user_id').where('e.task_id', t.id).orderBy('e.entry_date', 'desc').select('e.*', 'us.name as user_name'),
    db('notification_schedules').where({ task_id: t.id }).whereIn('status', ['active', 'paused']).select('id', 'title', 'schedule_type', 'offset_minutes', 'next_run_at', 'channels', 'status'),
    t.recurring_schedule_id ? db('recurring_schedules').where({ id: t.recurring_schedule_id }).first() : null,
  ]);
  const isAssignee = assignees.some((a: any) => a.id === u.id);
  res.json({
    ...t, ...extra, assignees, subtasks, checklist, attachments, dependencies: deps, dependents, approvals, time_entries: time, reminders, recurrence: rec,
    permissions: { can_manage: await canManageTask(u, t), can_review: await canReviewTask(u, t), is_assignee: isAssignee, can_delete: can(u, 'tasks.delete') && (await canManageTask(u, t)) },
  });
});

router.get('/:id/history', requirePerm('tasks.view'), async (req, res) => {
  const t = await loadVisibleTask(me(req), idParam(req));
  const [updates, auditRows] = await Promise.all([
    db('task_updates as tu').join('users as us', 'us.id', 'tu.user_id').where('tu.task_id', t.id).orderBy('tu.created_at', 'desc').select('tu.*', 'us.name as user_name'),
    db('audit_logs as a').leftJoin('users as us', 'us.id', 'a.actor_id').where({ 'a.entity_type': 'task', 'a.entity_id': t.id }).orderBy('a.created_at', 'desc')
      .select('a.id', 'a.action', 'a.summary', 'a.before', 'a.after', 'a.created_at', 'us.name as actor_name'),
  ]);
  res.json({ updates, audit: auditRows });
});

// ===================================================================== edit (managers)
router.patch('/:id', async (req, res) => {
  const u = me(req);
  const t = await loadVisibleTask(u, idParam(req));
  await assertCanManageTask(u, t);
  if (['completed', 'cancelled'].includes(t.status)) throw badRequest('Closed tasks cannot be edited');
  const b = parse(taskSchema.omit({ assignee_ids: true, subtasks: true, checklist: true, depends_on: true, reminders: true, recurrence: true, primary_assignee_id: true })
    .partial().extend({ deadline_change_reason: z.string().max(1000).optional() }), req.body);
  const { deadline_change_reason, ...patch } = b;
  if (patch.project_id) await loadVisibleProject(u, patch.project_id);
  const deadlineChanged = patch.deadline !== undefined && String(new Date(patch.deadline ?? 0).getTime()) !== String(new Date(t.deadline ?? 0).getTime());
  const upd: any = { ...patch, updated_at: db.fn.now() };
  if (deadlineChanged) upd.is_overdue = !!patch.deadline && new Date(patch.deadline) < new Date() && OPEN.includes(t.status);
  const [row] = await db('tasks').where({ id: t.id }).update(upd).returning('*');
  const d = diff(t, patch);
  if (d.changed.length) {
    await audit(req, { action: deadlineChanged ? 'task.deadline_changed' : 'task.updated', entityType: 'task', entityId: t.id, before: d.before, after: { ...d.after, reason: deadline_change_reason }, summary: deadlineChanged ? `Deadline ${t.deadline ? new Date(t.deadline).toISOString() : 'none'} → ${patch.deadline ?? 'none'}` : undefined });
  }
  if (deadlineChanged) {
    await db('task_updates').insert({ task_id: t.id, user_id: u.id, kind: 'deadline', note: `Deadline changed${deadline_change_reason ? `: ${deadline_change_reason}` : ''}` });
    await onTaskDeadlineChanged(t.id);
    await emitEvent({ type: 'task.deadline_changed', actorId: u.id, taskId: t.id, vars: { reason: deadline_change_reason ?? '' } });
  }
  for (const pid of new Set([t.project_id, row.project_id].filter(Boolean))) await recomputeProjectProgress(pid as number);
  res.json(row);
});

router.post('/:id/assign', async (req, res) => {
  const u = me(req);
  const t = await loadVisibleTask(u, idParam(req));
  await assertCanManageTask(u, t);
  if (!can(u, 'tasks.assign')) throw forbidden();
  const { assignee_ids, primary_assignee_id, note } = parse(z.object({ assignee_ids: z.array(zId).min(1), primary_assignee_id: zOptId, note: zOptStr }), req.body);
  await validateAssignment(u, assignee_ids);
  const before: number[] = await db('task_assignees').where({ task_id: t.id }).pluck('user_id');
  const primary = primary_assignee_id ?? assignee_ids[0];
  await db.transaction(async (trx) => {
    await trx('task_assignees').where({ task_id: t.id }).whereNotIn('user_id', assignee_ids).del();
    await trx('task_assignees').insert(assignee_ids.map((id) => ({ task_id: t.id, user_id: id, is_primary: id === primary, assigned_by: u.id })))
      .onConflict(['task_id', 'user_id']).merge(['is_primary']);
    await trx('task_updates').insert({ task_id: t.id, user_id: u.id, kind: 'assignment', note: note ?? 'Assignees updated' });
    await audit(req, { action: before.length ? 'task.reassigned' : 'task.assigned', entityType: 'task', entityId: t.id, before: { assignees: before }, after: { assignees: assignee_ids, note } }, trx);
  });
  // keep deadline reminders pointed at the current assignees
  const scheds: number[] = await db('notification_schedules').where({ task_id: t.id, schedule_type: 'deadline_offset' }).whereIn('status', ['active']).pluck('id');
  for (const sid of scheds) {
    await db('notification_recipients').where({ schedule_id: sid }).del();
    await db('notification_recipients').insert(assignee_ids.map((id) => ({ schedule_id: sid, user_id: id })));
  }
  await emitEvent({ type: 'task.assigned', actorId: u.id, taskId: t.id });
  res.json({ ok: true });
});

// ===================================================================== work by assignees
async function assertAssignee(u: AuthUser, taskId: number) {
  const a = await db('task_assignees').where({ task_id: taskId, user_id: u.id }).first();
  if (!a) throw forbidden('Only assignees can update work progress');
  if (!can(u, 'tasks.update_own')) throw forbidden();
}

async function incompletePredecessors(taskId: number) {
  return db('task_dependencies as d').join('tasks as x', 'x.id', 'd.depends_on_task_id').where('d.task_id', taskId)
    .where('d.dependency_type', 'finish_to_start').whereNot('x.status', 'completed').whereNull('x.deleted_at').select('x.task_key', 'x.title');
}

router.post('/:id/progress', async (req, res) => {
  const u = me(req);
  const t = await loadVisibleTask(u, idParam(req));
  const isManager = await canManageTask(u, t);
  const isAssignee = !!(await db('task_assignees').where({ task_id: t.id, user_id: u.id }).first());
  if (!isAssignee && !isManager) throw forbidden();
  const b = parse(z.object({
    progress: z.number().int().min(0).max(100).optional(),
    status: z.enum(['in_progress', 'on_hold', 'blocked', 'not_started']).optional(),
    note: zOptStr,
    blocker_note: zOptStr,
    hours: z.number().min(0.1).max(24).optional(),
    entry_date: zDate.optional(),
    force: z.boolean().optional(),
  }), req.body);
  if (['completed', 'cancelled', 'submitted', 'under_review'].includes(t.status)) throw badRequest(`Task is ${t.status.replace('_', ' ')}; progress cannot be changed`);
  if (b.status === 'blocked' && !b.blocker_note && !b.note) throw badRequest('Describe the blocker');
  if (b.status === 'in_progress' && t.status === 'not_started' && !(b.force && isManager)) {
    const pending = await incompletePredecessors(t.id);
    if (pending.length) throw badRequest(`Blocked by unfinished dependencies: ${pending.map((p: any) => p.task_key).join(', ')}`, { dependencies: pending });
  }
  const status = b.status ?? (t.status === 'not_started' || t.status === 'revision_required' ? (b.progress ? 'in_progress' : t.status) : t.status);
  const progress = b.progress ?? t.progress;
  await db.transaction(async (trx) => {
    await trx('tasks').where({ id: t.id }).update({
      status, progress: Math.min(progress, 99), // 100% only after approval
      blocker_note: status === 'blocked' ? (b.blocker_note ?? b.note) : null, updated_at: trx.fn.now(),
      ...(b.hours ? { actual_hours: trx.raw('actual_hours + ?', [b.hours]) } : {}),
    });
    await trx('task_updates').insert({ task_id: t.id, user_id: u.id, kind: status === 'blocked' ? 'blocker' : status !== t.status ? 'status' : 'progress', status_from: t.status, status_to: status, progress, note: b.note ?? b.blocker_note });
    if (b.hours) await trx('time_entries').insert({ task_id: t.id, user_id: u.id, entry_date: b.entry_date ?? new Date().toISOString().slice(0, 10), hours: b.hours, note: b.note });
    await audit(req, { action: status !== t.status ? 'task.status_changed' : 'task.progress_updated', entityType: 'task', entityId: t.id, before: { status: t.status, progress: t.progress }, after: { status, progress, note: b.note } }, trx);
  });
  if (status === 'blocked' && t.status !== 'blocked') await emitEvent({ type: 'task.blocked', actorId: u.id, taskId: t.id, vars: { blocker: b.blocker_note ?? b.note } });
  res.json({ ok: true, status, progress });
});

router.post('/:id/submit', async (req, res) => {
  const u = me(req);
  const t = await loadVisibleTask(u, idParam(req));
  await assertAssignee(u, t.id);
  if (!OPEN.includes(t.status)) throw badRequest(`Cannot submit a task that is ${t.status.replace('_', ' ')}`);
  const { note } = parse(z.object({ note: zOptStr }), req.body);
  const pending = await incompletePredecessors(t.id);
  if (pending.length) throw badRequest(`Finish dependencies first: ${pending.map((p: any) => p.task_key).join(', ')}`);
  await db.transaction(async (trx) => {
    await trx('tasks').where({ id: t.id }).update({ status: 'submitted', progress: 100, submitted_at: trx.fn.now(), updated_at: trx.fn.now() });
    await trx('task_approvals').insert({ task_id: t.id, approval_type: 'completion', requested_by: u.id, request_note: note });
    await trx('task_updates').insert({ task_id: t.id, user_id: u.id, kind: 'submission', status_from: t.status, status_to: 'submitted', progress: 100, note });
    await audit(req, { action: 'task.submitted', entityType: 'task', entityId: t.id, before: { status: t.status }, after: { status: 'submitted', note } }, trx);
  });
  await emitEvent({ type: 'task.submitted', actorId: u.id, taskId: t.id, vars: { note: note ?? '' } });
  res.json({ ok: true });
});

router.post('/:id/review/start', async (req, res) => {
  const u = me(req);
  const t = await loadVisibleTask(u, idParam(req));
  if (!(await canReviewTask(u, t))) throw forbidden('You cannot review this task');
  if (t.status !== 'submitted') throw badRequest('Task is not awaiting review');
  await db('tasks').where({ id: t.id }).update({ status: 'under_review', updated_at: db.fn.now() });
  await db('task_approvals').where({ task_id: t.id, approval_type: 'completion', decision: 'pending' }).update({ reviewer_id: u.id });
  await db('task_updates').insert({ task_id: t.id, user_id: u.id, kind: 'review', status_from: 'submitted', status_to: 'under_review' });
  await audit(req, { action: 'task.review_started', entityType: 'task', entityId: t.id });
  res.json({ ok: true });
});

/** Approval decision. Only an approval moves a task to "completed". */
router.post('/:id/review', async (req, res) => {
  const u = me(req);
  const t = await loadVisibleTask(u, idParam(req));
  if (!(await canReviewTask(u, t))) throw forbidden('You cannot review this task');
  if (!['submitted', 'under_review'].includes(t.status)) throw badRequest('Task is not awaiting review');
  const { decision, comments, quality_rating } = parse(z.object({
    decision: z.enum(['approved', 'revision_required', 'rejected']),
    comments: zOptStr,
    quality_rating: z.number().int().min(1).max(5).optional(),
  }), req.body);
  if (decision !== 'approved' && !comments) throw badRequest('Comments are required when requesting revision or rejecting');
  const newStatus = decision === 'approved' ? 'completed' : 'revision_required';
  await db.transaction(async (trx) => {
    const appr = await trx('task_approvals').where({ task_id: t.id, approval_type: 'completion', decision: 'pending' }).first();
    if (appr) await trx('task_approvals').where({ id: appr.id }).update({ decision, comments, quality_rating, reviewer_id: u.id, decided_at: trx.fn.now() });
    else await trx('task_approvals').insert({ task_id: t.id, approval_type: 'completion', requested_by: u.id, decision, comments, quality_rating, reviewer_id: u.id, decided_at: trx.fn.now() });
    await trx('tasks').where({ id: t.id }).update({
      status: newStatus, updated_at: trx.fn.now(),
      ...(decision === 'approved'
        ? { completed_at: trx.fn.now(), approved_by: u.id, progress: 100, quality_rating: quality_rating ?? null, is_overdue: false }
        : { progress: 90, revision_count: trx.raw('revision_count + 1'), is_overdue: t.deadline ? new Date(t.deadline) < new Date() : false }),
    });
    await trx('task_updates').insert({ task_id: t.id, user_id: u.id, kind: 'review', status_from: t.status, status_to: newStatus, note: comments });
    if (comments) await trx('task_comments').insert({ task_id: t.id, author_id: u.id, body: comments, is_feedback: true });
    await audit(req, { action: `task.${decision}`, entityType: 'task', entityId: t.id, before: { status: t.status }, after: { status: newStatus, comments, quality_rating }, summary: `Review: ${decision.replace('_', ' ')}` }, trx);
  });
  if (decision === 'approved') {
    await onTaskClosed(t.id, u.id, 'completed');
    if (t.project_id) await recomputeProjectProgress(t.project_id);
  }
  await emitEvent({ type: decision === 'approved' ? 'task.approved' : decision === 'rejected' ? 'task.rejected' : 'task.revision_required', actorId: u.id, taskId: t.id, vars: { comments: comments ?? '' } });
  res.json({ ok: true, status: newStatus });
});

router.post('/:id/cancel', async (req, res) => {
  const u = me(req);
  const t = await loadVisibleTask(u, idParam(req));
  await assertCanManageTask(u, t);
  const { reason } = parse(z.object({ reason: z.string().trim().min(2).max(1000) }), req.body);
  if (['completed', 'cancelled'].includes(t.status)) throw badRequest('Task already closed');
  await db('tasks').where({ id: t.id }).update({ status: 'cancelled', is_overdue: false, updated_at: db.fn.now() });
  await db('task_approvals').where({ task_id: t.id, decision: 'pending' }).update({ decision: 'withdrawn', decided_at: db.fn.now() });
  await db('task_updates').insert({ task_id: t.id, user_id: u.id, kind: 'status', status_from: t.status, status_to: 'cancelled', note: reason });
  await audit(req, { action: 'task.cancelled', entityType: 'task', entityId: t.id, before: { status: t.status }, after: { status: 'cancelled', reason } });
  await onTaskClosed(t.id, u.id, 'cancelled');
  if (t.project_id) await recomputeProjectProgress(t.project_id);
  res.json({ ok: true });
});

router.post('/:id/reopen', async (req, res) => {
  const u = me(req);
  const t = await loadVisibleTask(u, idParam(req));
  await assertCanManageTask(u, t);
  if (!['completed', 'cancelled'].includes(t.status)) throw badRequest('Task is not closed');
  await db('tasks').where({ id: t.id }).update({ status: 'in_progress', completed_at: null, approved_by: null, progress: Math.min(t.progress, 90), updated_at: db.fn.now() });
  await db('task_updates').insert({ task_id: t.id, user_id: u.id, kind: 'status', status_from: t.status, status_to: 'in_progress', note: 'Reopened' });
  await audit(req, { action: 'task.reopened', entityType: 'task', entityId: t.id, before: { status: t.status }, after: { status: 'in_progress' } });
  if (t.project_id) await recomputeProjectProgress(t.project_id);
  res.json({ ok: true });
});

router.post('/:id/archive', async (req, res) => {
  const u = me(req);
  const t = await loadVisibleTask(u, idParam(req));
  if (!can(u, 'tasks.delete')) throw forbidden();
  await assertCanManageTask(u, t);
  const { archived } = parse(z.object({ archived: z.boolean().default(true) }), req.body);
  await db('tasks').where({ id: t.id }).update({ is_archived: archived, updated_at: db.fn.now() });
  await audit(req, { action: archived ? 'task.archived' : 'task.unarchived', entityType: 'task', entityId: t.id });
  res.json({ ok: true });
});

router.delete('/:id', async (req, res) => {
  const u = me(req);
  const t = await loadVisibleTask(u, idParam(req));
  if (!can(u, 'tasks.delete')) throw forbidden();
  await assertCanManageTask(u, t);
  await db('tasks').where({ id: t.id }).update({ deleted_at: db.fn.now() });
  await onTaskClosed(t.id, u.id, 'cancelled');
  await audit(req, { action: 'task.deleted', entityType: 'task', entityId: t.id, summary: `${t.task_key} ${t.title}` });
  if (t.project_id) await recomputeProjectProgress(t.project_id);
  res.json({ ok: true });
});

// ===================================================================== extensions
router.post('/:id/extension', async (req, res) => {
  const u = me(req);
  const t = await loadVisibleTask(u, idParam(req));
  await assertAssignee(u, t.id);
  if (!t.deadline) throw badRequest('Task has no deadline');
  if (!OPEN.includes(t.status)) throw badRequest('Extensions can only be requested for open tasks');
  const { requested_deadline, reason } = parse(z.object({ requested_deadline: z.string().datetime({ offset: true }), reason: z.string().trim().min(5).max(2000) }), req.body);
  if (new Date(requested_deadline) <= new Date(t.deadline)) throw badRequest('Requested deadline must be later than the current deadline');
  if (await db('task_approvals').where({ task_id: t.id, approval_type: 'extension', decision: 'pending' }).first()) throw conflict('An extension request is already pending');
  const [row] = await db('task_approvals').insert({ task_id: t.id, approval_type: 'extension', requested_by: u.id, request_note: reason, previous_deadline: t.deadline, requested_deadline }).returning('*');
  await db('task_updates').insert({ task_id: t.id, user_id: u.id, kind: 'deadline', note: `Extension requested to ${requested_deadline}: ${reason}` });
  await audit(req, { action: 'task.extension_requested', entityType: 'task', entityId: t.id, after: { requested_deadline, reason } });
  await emitEvent({ type: 'task.extension_requested', actorId: u.id, taskId: t.id, vars: { requested_deadline, reason } });
  res.status(201).json(row);
});

router.post('/:id/extension/:approvalId/decide', async (req, res) => {
  const u = me(req);
  const t = await loadVisibleTask(u, idParam(req));
  if (!(await canReviewTask(u, t))) throw forbidden('You cannot decide extensions for this task');
  const appr = await db('task_approvals').where({ id: idParam(req, 'approvalId'), task_id: t.id, approval_type: 'extension', decision: 'pending' }).first();
  if (!appr) throw notFound('Pending extension request not found');
  const { decision, comments, new_deadline } = parse(z.object({ decision: z.enum(['approved', 'rejected']), comments: zOptStr, new_deadline: z.string().datetime({ offset: true }).optional() }), req.body);
  const deadline = new_deadline ?? appr.requested_deadline;
  await db.transaction(async (trx) => {
    await trx('task_approvals').where({ id: appr.id }).update({ decision, comments, reviewer_id: u.id, decided_at: trx.fn.now() });
    if (decision === 'approved') {
      await trx('tasks').where({ id: t.id }).update({ deadline, is_overdue: new Date(deadline) < new Date(), updated_at: trx.fn.now() });
      await trx('task_updates').insert({ task_id: t.id, user_id: u.id, kind: 'deadline', note: `Extension approved: new deadline ${new Date(deadline).toISOString()}` });
    }
    await audit(req, { action: `task.extension_${decision}`, entityType: 'task', entityId: t.id, before: { deadline: t.deadline }, after: { deadline: decision === 'approved' ? deadline : t.deadline, comments } }, trx);
  });
  if (decision === 'approved') await onTaskDeadlineChanged(t.id);
  await emitEvent({ type: 'task.extension_decided', actorId: u.id, taskId: t.id, extraUserIds: { requester: [appr.requested_by] }, vars: { decision, comments: comments ?? '' } });
  res.json({ ok: true });
});

// ===================================================================== subtasks & checklist
async function canEditItems(u: AuthUser, t: any) {
  if (await canManageTask(u, t)) return true;
  return !!(await db('task_assignees').where({ task_id: t.id, user_id: u.id }).first());
}

router.post('/:id/subtasks', async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  if (!(await canEditItems(u, t))) throw forbidden();
  const b = parse(z.object({ title: z.string().trim().min(1).max(300), assignee_id: zOptId, due_date: zDate.nullable().optional() }), req.body);
  const [row] = await db('subtasks').insert({ ...b, task_id: t.id, sort_order: 999 }).returning('*');
  await audit(req, { action: 'task.subtask_added', entityType: 'task', entityId: t.id, summary: b.title });
  res.status(201).json(row);
});
router.patch('/:id/subtasks/:sid', async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  if (!(await canEditItems(u, t))) throw forbidden();
  const b = parse(z.object({ title: z.string().trim().min(1).max(300).optional(), is_done: z.boolean().optional(), assignee_id: zOptId, due_date: zDate.nullable().optional() }), req.body);
  const [row] = await db('subtasks').where({ id: idParam(req, 'sid'), task_id: t.id }).update({ ...b, ...(b.is_done !== undefined ? { done_at: b.is_done ? db.fn.now() : null } : {}) }).returning('*');
  if (!row) throw notFound();
  res.json(row);
});
router.delete('/:id/subtasks/:sid', async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  if (!(await canEditItems(u, t))) throw forbidden();
  await db('subtasks').where({ id: idParam(req, 'sid'), task_id: t.id }).del();
  res.json({ ok: true });
});
router.post('/:id/checklist', async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  if (!(await canEditItems(u, t))) throw forbidden();
  const { label } = parse(z.object({ label: z.string().trim().min(1).max(300) }), req.body);
  const [row] = await db('task_checklist_items').insert({ task_id: t.id, label, sort_order: 999 }).returning('*');
  res.status(201).json(row);
});
router.patch('/:id/checklist/:cid', async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  if (!(await canEditItems(u, t))) throw forbidden();
  const b = parse(z.object({ label: z.string().trim().min(1).max(300).optional(), is_done: z.boolean().optional() }), req.body);
  const [row] = await db('task_checklist_items').where({ id: idParam(req, 'cid'), task_id: t.id }).update(b).returning('*');
  if (!row) throw notFound();
  res.json(row);
});
router.delete('/:id/checklist/:cid', async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  if (!(await canEditItems(u, t))) throw forbidden();
  await db('task_checklist_items').where({ id: idParam(req, 'cid'), task_id: t.id }).del();
  res.json({ ok: true });
});

// ===================================================================== comments
router.get('/:id/comments', async (req, res) => {
  const t = await loadVisibleTask(me(req), idParam(req));
  res.json(await db('task_comments as c').join('users as u', 'u.id', 'c.author_id').where('c.task_id', t.id).whereNull('c.deleted_at')
    .orderBy('c.created_at').select('c.*', 'u.name as author_name'));
});
router.post('/:id/comments', async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  const { body, mentions } = parse(z.object({ body: z.string().trim().min(1).max(10000), mentions: z.array(zId).default([]) }), req.body);
  const isReviewer = await canReviewTask(u, t);
  const [row] = await db('task_comments').insert({ task_id: t.id, author_id: u.id, body, mentions, is_feedback: isReviewer }).returning('*');
  await emitEvent({ type: 'task.comment', actorId: u.id, taskId: t.id, extraUserIds: { mentioned: mentions }, vars: { comment: { body: body.slice(0, 300) } } });
  res.status(201).json({ ...row, author_name: u.name });
});
router.delete('/:id/comments/:cid', async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  const c = await db('task_comments').where({ id: idParam(req, 'cid'), task_id: t.id }).first();
  if (!c) throw notFound();
  if (c.author_id !== u.id && !can(u, 'tasks.manage_all')) throw forbidden();
  await db('task_comments').where({ id: c.id }).update({ deleted_at: db.fn.now() });
  await audit(req, { action: 'task.comment_deleted', entityType: 'task', entityId: t.id, before: { body: c.body } });
  res.json({ ok: true });
});

// ===================================================================== attachments
router.post('/:id/attachments', upload.array('files', 10), async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  if (!(await canEditItems(u, t))) throw forbidden();
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) throw badRequest('No files uploaded');
  const isDeliverable = req.body.is_deliverable === 'true';
  const out = [];
  for (const f of files) {
    const file = await registerFile(f, u.id);
    const [a] = await db('task_attachments').insert({ task_id: t.id, file_id: file.id, uploaded_by: u.id, is_deliverable: isDeliverable }).returning('*');
    out.push({ ...a, original_name: file.original_name });
  }
  await audit(req, { action: 'task.attachments_uploaded', entityType: 'task', entityId: t.id, summary: out.map((o) => o.original_name).join(', ') });
  res.status(201).json(out);
});
router.delete('/:id/attachments/:aid', async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  const a = await db('task_attachments').where({ id: idParam(req, 'aid'), task_id: t.id }).first();
  if (!a) throw notFound();
  if (a.uploaded_by !== u.id && !(await canManageTask(u, t))) throw forbidden();
  await db('task_attachments').where({ id: a.id }).del();
  await audit(req, { action: 'task.attachment_removed', entityType: 'task', entityId: t.id, after: { file_id: a.file_id } });
  res.json({ ok: true });
});

// ===================================================================== dependencies
router.post('/:id/dependencies', async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  await assertCanManageTask(u, t);
  const { depends_on_task_id, dependency_type } = parse(z.object({ depends_on_task_id: zId, dependency_type: z.enum(['finish_to_start', 'start_to_start', 'finish_to_finish']).default('finish_to_start') }), req.body);
  await loadVisibleTask(u, depends_on_task_id);
  if (await wouldCreateCycle(t.id, depends_on_task_id)) throw badRequest('This dependency would create a cycle');
  await db('task_dependencies').insert({ task_id: t.id, depends_on_task_id, dependency_type }).onConflict(['task_id', 'depends_on_task_id']).merge();
  await audit(req, { action: 'task.dependency_added', entityType: 'task', entityId: t.id, after: { depends_on_task_id, dependency_type } });
  res.status(201).json({ ok: true });
});
router.delete('/:id/dependencies/:depId', async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  await assertCanManageTask(u, t);
  await db('task_dependencies').where({ task_id: t.id, depends_on_task_id: idParam(req, 'depId') }).del();
  await audit(req, { action: 'task.dependency_removed', entityType: 'task', entityId: t.id, after: { depends_on_task_id: idParam(req, 'depId') } });
  res.json({ ok: true });
});

// ===================================================================== time tracking
router.post('/:id/time', async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  await assertAssignee(u, t.id);
  const b = parse(z.object({ hours: z.number().min(0.1).max(24), entry_date: zDate, note: zOptStr }), req.body);
  const day = await db('time_entries').where({ user_id: u.id, entry_date: b.entry_date }).sum({ h: 'hours' }).first();
  if (Number(day?.h ?? 0) + b.hours > 24) throw badRequest('Total logged hours for the day would exceed 24');
  const [row] = await db('time_entries').insert({ ...b, task_id: t.id, user_id: u.id }).returning('*');
  await db('tasks').where({ id: t.id }).update({ actual_hours: db.raw('actual_hours + ?', [b.hours]) });
  await audit(req, { action: 'task.time_logged', entityType: 'task', entityId: t.id, after: b });
  res.status(201).json(row);
});
router.delete('/:id/time/:eid', async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  const e = await db('time_entries').where({ id: idParam(req, 'eid'), task_id: t.id }).first();
  if (!e) throw notFound();
  if (e.user_id !== u.id) throw forbidden();
  await db('time_entries').where({ id: e.id }).del();
  await db('tasks').where({ id: t.id }).update({ actual_hours: db.raw('greatest(actual_hours - ?, 0)', [e.hours]) });
  await audit(req, { action: 'task.time_removed', entityType: 'task', entityId: t.id, before: e });
  res.json({ ok: true });
});

// ===================================================================== recurring templates
router.patch('/:id/recurrence', async (req, res) => {
  const u = me(req); const t = await loadVisibleTask(u, idParam(req));
  await assertCanManageTask(u, t);
  if (!t.is_recurring_template) throw badRequest('Not a recurring task');
  const { active } = parse(z.object({ active: z.boolean() }), req.body);
  await db('tasks').where({ id: t.id }).update({ status: active ? 'not_started' : 'cancelled' });
  await audit(req, { action: active ? 'task.recurrence_resumed' : 'task.recurrence_stopped', entityType: 'task', entityId: t.id });
  res.json({ ok: true });
});

export { localToUtc };
export type { Request };
