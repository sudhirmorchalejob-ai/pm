import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { db } from '../db/knex';
import { AuthUser, can, me, requirePerm } from '../auth/middleware';
import { assertCanSeeUser, scopeTasks, supervisedUserIds } from '../auth/scope';
import { forbidden, notFound } from '../lib/errors';
import { idParam, parse, zDate, zId } from '../lib/http';
import { taskTotals, userKpis } from '../lib/kpi';

export const router = Router();

const range = z.object({
  from: zDate.default(() => DateTime.now().minus({ days: 30 }).toISODate()!),
  to: zDate.default(() => DateTime.now().toISODate()!),
  department_id: zId.optional(),
  project_id: zId.optional(),
  user_id: zId.optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
});

async function scopeIds(u: AuthUser, departmentId?: number) {
  let ids = await supervisedUserIds(u);
  if (departmentId) {
    const inDept: number[] = await db('users').where({ department_id: departmentId }).pluck('id');
    ids = ids ? ids.filter((i) => inDept.includes(i)) : inDept;
  }
  return ids;
}

/** Employee monitoring list with balanced KPIs (timeliness, quality, complexity — not only counts). */
router.get('/employees', requirePerm('monitoring.employees'), async (req, res) => {
  const u = me(req);
  const f = parse(range, req.query);
  let ids = await scopeIds(u, f.department_id);
  if (f.user_id) ids = (ids ?? [f.user_id]).filter((i) => i === f.user_id);
  const rows = await userKpis({ from: f.from, to: f.to, userIds: ids, projectId: f.project_id });
  const today = DateTime.now().toISODate()!;
  const lastUpdates = await db('task_updates').whereIn('user_id', rows.map((r) => r.id)).groupBy('user_id').select('user_id', db.raw('max(created_at) AS last_update'));
  const reportsToday = await db('daily_reports').whereIn('user_id', rows.map((r) => r.id)).where('report_date', today).pluck('user_id');
  const lu = new Map(lastUpdates.map((r: any) => [r.user_id, r.last_update]));
  res.json({ from: f.from, to: f.to, items: rows.map((r) => ({ ...r, last_update: lu.get(r.id) ?? null, reported_today: reportsToday.includes(r.id) })) });
});

/** Detailed monitoring for one employee. */
router.get('/employees/:id', requirePerm('monitoring.employees'), async (req, res) => {
  const u = me(req);
  const id = idParam(req);
  if (id !== u.id) await assertCanSeeUser(u, id);
  const f = parse(range, req.query);
  const profile = await db('users as us').leftJoin('departments as d', 'd.id', 'us.department_id').leftJoin('designations as g', 'g.id', 'us.designation_id')
    .leftJoin('teams as t', 't.id', 'us.team_id').where('us.id', id)
    .first('us.id', 'us.name', 'us.employee_code', 'us.email', 'd.name as department_name', 'g.title as designation', 't.name as team_name', 'us.capacity_hours_per_week', 'us.employment_status');
  if (!profile) throw notFound();
  const [kpi] = await userKpis({ from: f.from, to: f.to, userIds: [id], projectId: f.project_id });
  const tasksQ = db('tasks as t').join('task_assignees as ta', 'ta.task_id', 't.id').leftJoin('projects as p', 'p.id', 't.project_id')
    .where('ta.user_id', id).whereNull('t.deleted_at').where('t.is_recurring_template', false)
    .select('t.id', 't.task_key', 't.title', 't.status', 't.priority', 't.progress', 't.deadline', 't.is_overdue', 't.estimated_hours', 't.actual_hours', 't.complexity',
      't.completed_at', 't.submitted_at', 't.revision_count', 't.quality_rating', 'p.name as project_name')
    .orderBy('t.deadline', 'asc');
  if (f.project_id) tasksQ.where('t.project_id', f.project_id);
  if (f.status) tasksQ.whereIn('t.status', f.status.split(','));
  if (f.priority) tasksQ.whereIn('t.priority', f.priority.split(','));
  const [tasks, updates, approvals, time, trend, reports] = await Promise.all([
    tasksQ,
    db('task_updates as tu').join('tasks as t', 't.id', 'tu.task_id').where('tu.user_id', id).whereBetween('tu.created_at', [f.from, DateTime.fromISO(f.to).plus({ days: 1 }).toISODate()!])
      .orderBy('tu.created_at', 'desc').limit(100).select('tu.*', 't.task_key', 't.title'),
    db('task_approvals as a').join('tasks as t', 't.id', 'a.task_id').leftJoin('users as r', 'r.id', 'a.reviewer_id').where('a.requested_by', id)
      .orderBy('a.requested_at', 'desc').limit(100).select('a.*', 't.task_key', 't.title', 'r.name as reviewer_name'),
    db('time_entries').where({ user_id: id }).whereBetween('entry_date', [f.from, f.to]).groupBy('entry_date').orderBy('entry_date').select('entry_date', db.raw('sum(hours)::float AS hours')),
    db.raw(`SELECT to_char(date_trunc('week', t.completed_at), 'YYYY-MM-DD') AS week,
              count(*)::int AS completed,
              count(*) FILTER (WHERE t.deadline IS NULL OR t.completed_at <= t.deadline)::int AS on_time,
              round(avg(t.quality_rating), 1)::float AS quality,
              sum(t.complexity)::int AS weighted
            FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id
            WHERE ta.user_id = ? AND t.status = 'completed' AND t.completed_at >= now() - interval '12 weeks'
            GROUP BY 1 ORDER BY 1`, [id]),
    db('daily_reports').where({ user_id: id }).orderBy('report_date', 'desc').limit(14),
  ]);
  const open = tasks.filter((t: any) => !['completed', 'cancelled'].includes(t.status));
  res.json({
    profile, kpi, trend: trend.rows, time_by_day: time, updates, approvals, daily_reports: reports,
    tasks: {
      current: open.filter((t: any) => t.status === 'in_progress'),
      pending: open.filter((t: any) => ['not_started', 'on_hold', 'blocked', 'revision_required'].includes(t.status)),
      submitted: open.filter((t: any) => ['submitted', 'under_review'].includes(t.status)),
      overdue: open.filter((t: any) => t.is_overdue),
      completed: tasks.filter((t: any) => t.status === 'completed').slice(-50).reverse(),
      all: tasks,
    },
    workload: {
      open_tasks: open.length,
      open_estimated_hours: open.reduce((s: number, t: any) => s + Math.max(0, Number(t.estimated_hours ?? 0) - Number(t.actual_hours ?? 0)), 0),
      capacity_hours_per_week: Number(profile.capacity_hours_per_week),
    },
  });
});

/** Department monitoring (HOD view; org-scoped roles can pick any department). */
router.get('/departments/:id', requirePerm('monitoring.departments'), async (req, res) => {
  const u = me(req);
  const deptId = idParam(req);
  if (u.scope !== 'organization' && u.departmentId !== deptId && !can(u, 'analytics.view_all')) throw forbidden('You can only monitor your own department');
  const f = parse(range, req.query);
  const dept = await db('departments as d').leftJoin('users as h', 'h.id', 'd.hod_id').where('d.id', deptId).first('d.*', 'h.name as hod_name');
  if (!dept) throw notFound();
  const employees = await userKpis({ from: f.from, to: f.to, departmentId: deptId, projectId: f.project_id });
  const empIds = employees.map((e) => e.id);
  const tasksBase = () => db('tasks as t').whereNull('t.deleted_at').where('t.is_recurring_template', false)
    .where((w) => w.where('t.department_id', deptId).orWhereExists(db('task_assignees as ta').whereRaw('ta.task_id = t.id').whereIn('ta.user_id', empIds.length ? empIds : [0])));
  const now = new Date();
  const cutoff48h = new Date(now.getTime() - 48 * 3600_000);
  const today = DateTime.now().setZone(u.timezone).toISODate()!;
  const listCols = ['t.id', 't.task_key', 't.title', 't.status', 't.priority', 't.deadline', 't.progress', 't.blocker_note', 't.submitted_at', 't.updated_at',
    db.raw(`(SELECT string_agg(u.name, ', ') FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id = t.id) AS assignee_names`)];
  const [totals, overdue, blocked, pendingReview, dueToday, upcoming, noUpdates, reportsToday, byStatus, weekly] = await Promise.all([
    taskTotals(tasksBase()),
    tasksBase().where('t.is_overdue', true).whereNotIn('t.status', ['completed', 'cancelled']).orderBy('t.deadline').limit(100).select(listCols),
    tasksBase().where('t.status', 'blocked').orderBy('t.updated_at', 'desc').limit(100).select(listCols),
    tasksBase().whereIn('t.status', ['submitted', 'under_review']).orderBy('t.submitted_at').limit(100).select(listCols),
    tasksBase().whereNotIn('t.status', ['completed', 'cancelled']).whereRaw(`(t.deadline AT TIME ZONE ?)::date = ?`, [u.timezone, today]).select(listCols),
    tasksBase().whereNotIn('t.status', ['completed', 'cancelled']).whereBetween('t.deadline', [now, new Date(now.getTime() + 7 * 86400_000)]).orderBy('t.deadline').select(listCols),
    db('users as us').where('us.department_id', deptId).where('us.is_active', true).whereNull('us.deleted_at')
      .whereExists(db('task_assignees as ta').join('tasks as t', 't.id', 'ta.task_id').whereRaw('ta.user_id = us.id').whereIn('t.status', ['in_progress', 'not_started', 'revision_required']).whereNull('t.deleted_at'))
      .whereNotExists(db('task_updates as tu').whereRaw('tu.user_id = us.id').where('tu.created_at', '>', cutoff48h))
      .select('us.id', 'us.name', db.raw('(SELECT max(created_at) FROM task_updates tu WHERE tu.user_id = us.id) AS last_update')),
    db('daily_reports').whereIn('user_id', empIds.length ? empIds : [0]).where('report_date', today).count({ c: '*' }).first(),
    tasksBase().groupBy('t.status').select('t.status', db.raw('count(*)::int AS count')),
    db.raw(`SELECT to_char(date_trunc('week', t.completed_at), 'YYYY-MM-DD') AS week, count(*)::int AS completed,
              count(*) FILTER (WHERE t.deadline IS NULL OR t.completed_at <= t.deadline)::int AS on_time
            FROM tasks t WHERE t.status = 'completed' AND t.completed_at >= now() - interval '12 weeks' AND t.deleted_at IS NULL
              AND (t.department_id = ? OR EXISTS (SELECT 1 FROM task_assignees ta JOIN users x ON x.id = ta.user_id WHERE ta.task_id = t.id AND x.department_id = ?))
            GROUP BY 1 ORDER BY 1`, [deptId, deptId]),
  ]);
  res.json({
    department: dept, from: f.from, to: f.to, totals, employees,
    workload: employees.map((e) => ({ id: e.id, name: e.name, open: e.open, open_estimated_hours: e.open_estimated_hours, capacity: e.capacity_hours_per_week,
      utilization: e.capacity_hours_per_week ? Math.round((e.open_estimated_hours / e.capacity_hours_per_week) * 100) : null })),
    overdue, blocked, pending_review: pendingReview, due_today: dueToday, upcoming, employees_without_updates: noUpdates,
    daily_reports_today: { submitted: Number(reportsToday?.c ?? 0), expected: empIds.length },
    by_status: byStatus, weekly_trend: weekly.rows,
  });
});

/** Department comparison for org-level roles. */
router.get('/departments', requirePerm('monitoring.departments'), async (req, res) => {
  const u = me(req);
  const q = db('departments as d').where('d.is_active', true).whereNull('d.deleted_at').leftJoin('users as h', 'h.id', 'd.hod_id')
    .select('d.id', 'd.name', 'd.code', 'h.name as hod_name',
      db.raw(`(SELECT count(*) FROM users x WHERE x.department_id = d.id AND x.is_active AND x.deleted_at IS NULL)::int AS employees`),
      db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.deleted_at IS NULL AND NOT t.is_recurring_template AND t.status NOT IN ('completed','cancelled'))::int AS open_tasks`),
      db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.deleted_at IS NULL AND t.is_overdue AND t.status NOT IN ('completed','cancelled'))::int AS overdue`),
      db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.deleted_at IS NULL AND t.status = 'completed' AND t.completed_at >= now() - interval '30 days')::int AS completed_30d`),
      db.raw(`(SELECT round(100.0 * count(*) FILTER (WHERE t.deadline IS NULL OR t.completed_at <= t.deadline) / nullif(count(*),0))::int FROM tasks t WHERE t.department_id = d.id AND t.deleted_at IS NULL AND t.status = 'completed' AND t.completed_at >= now() - interval '30 days') AS on_time_rate`),
      db.raw(`(SELECT round(avg(t.quality_rating),1)::float FROM tasks t WHERE t.department_id = d.id AND t.status = 'completed' AND t.completed_at >= now() - interval '30 days') AS avg_quality`),
      db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.deleted_at IS NULL AND t.status IN ('submitted','under_review'))::int AS pending_review`))
    .orderBy('d.name');
  if (u.scope !== 'organization') q.where('d.id', u.departmentId ?? 0);
  res.json(await q);
});

/** Live overview of my team's tasks (used by team leaders). */
router.get('/team', requirePerm('monitoring.employees'), async (req, res) => {
  const u = me(req);
  const totals = await taskTotals(scopeTasks(db('tasks as t'), u).whereNull('t.deleted_at').where('t.is_recurring_template', false));
  res.json({ totals });
});
