import { Router } from 'express';
import { DateTime } from 'luxon';
import { db } from '../db/knex';
import { AuthUser, can, me } from '../auth/middleware';
import { canReviewTask, scopeProjects, scopeTasks, supervisedUserIds } from '../auth/scope';
import { taskTotals, userKpis } from '../lib/kpi';

export const router = Router();

const taskCols = ['t.id', 't.task_key', 't.title', 't.status', 't.priority', 't.deadline', 't.progress', 't.is_overdue', 'p.name as project_name',
  db.raw(`(SELECT string_agg(u.name, ', ') FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id = t.id) AS assignee_names`)];

const openTasks = (u: AuthUser) => scopeTasks(db('tasks as t'), u).whereNull('t.deleted_at').where('t.is_recurring_template', false).where('t.is_archived', false)
  .leftJoin('projects as p', 'p.id', 't.project_id');

async function pendingApprovalCount(u: AuthUser) {
  let n = 0;
  if (can(u, 'tasks.review')) {
    const rows = await scopeTasks(db('tasks as t'), u).whereNull('t.deleted_at').join('task_approvals as a', 'a.task_id', 't.id').where('a.decision', 'pending')
      .select('t.id', 't.department_id', 't.project_id', 't.assigned_by');
    for (const r of rows) if (await canReviewTask(u, r)) n++;
  }
  if (can(u, 'approvals.decide')) n += Number((await db('approval_requests').where({ status: 'pending' }).count({ c: '*' }).first())?.c ?? 0);
  return n;
}

async function weeklyTrend(u: AuthUser) {
  const r = await openTasks(u).where('t.status', 'completed').where('t.completed_at', '>=', DateTime.now().minus({ weeks: 8 }).startOf('week').toJSDate())
    .groupByRaw(`date_trunc('week', t.completed_at)`).orderByRaw('1')
    .select(db.raw(`to_char(date_trunc('week', t.completed_at), 'YYYY-MM-DD') AS week`), db.raw('count(*)::int AS completed'),
      db.raw(`count(*) FILTER (WHERE t.deadline IS NULL OR t.completed_at <= t.deadline)::int AS on_time`));
  return r;
}

router.get('/', async (req, res) => {
  const u = me(req);
  const now = new Date();
  const in7 = new Date(now.getTime() + 7 * 86400_000);
  const today = DateTime.now().setZone(u.timezone).toISODate()!;
  const from30 = DateTime.now().minus({ days: 30 }).toISODate()!;

  // ---------- personal block (everyone who can have tasks)
  const mine = () => openTasks(u).whereExists(db('task_assignees as x').whereRaw('x.task_id = t.id').andWhere('x.user_id', u.id));
  const [myTotals, myToday, myUpcoming, myOverdue, myRevision, [myKpi], trend] = await Promise.all([
    taskTotals(mine()),
    mine().whereNotIn('t.status', ['completed', 'cancelled']).whereRaw(`(t.deadline AT TIME ZONE ?)::date = ?`, [u.timezone, today]).orderBy('t.deadline').select(taskCols),
    mine().whereNotIn('t.status', ['completed', 'cancelled']).whereBetween('t.deadline', [now, in7]).orderBy('t.deadline').limit(10).select(taskCols),
    mine().where('t.is_overdue', true).whereNotIn('t.status', ['completed', 'cancelled']).orderBy('t.deadline').limit(10).select(taskCols),
    mine().where('t.status', 'revision_required').select(taskCols),
    userKpis({ from: from30, to: today, userIds: [u.id] }),
    weeklyTrend(u),
  ]);
  const personal = { totals: myTotals, today: myToday, upcoming: myUpcoming, overdue: myOverdue, revisions: myRevision, kpi: myKpi };

  const base: any = { kind: u.scope === 'self' ? 'employee' : u.roleKey, role: u.roleName, personal, trend, pending_approvals: await pendingApprovalCount(u) };

  if (u.scope === 'self') return res.json(base);

  // ---------- scoped overview (managers)
  const [totals, overdue, upcoming, blocked, statusDist] = await Promise.all([
    taskTotals(openTasks(u)),
    openTasks(u).where('t.is_overdue', true).whereNotIn('t.status', ['completed', 'cancelled']).orderByRaw(`array_position(ARRAY['critical','high','medium','low'], t.priority), t.deadline`).limit(10).select(taskCols),
    openTasks(u).whereNotIn('t.status', ['completed', 'cancelled']).whereBetween('t.deadline', [now, in7]).orderBy('t.deadline').limit(10).select(taskCols),
    openTasks(u).where('t.status', 'blocked').orderBy('t.updated_at', 'desc').limit(10).select([...taskCols, 't.blocker_note']),
    openTasks(u).groupBy('t.status').select('t.status', db.raw('count(*)::int AS count')),
  ]);
  const dueToday = Number((await openTasks(u).whereNotIn('t.status', ['completed', 'cancelled']).whereRaw(`(t.deadline AT TIME ZONE ?)::date = ?`, [u.timezone, today]).count({ c: '*' }).first())?.c ?? 0);
  base.overview = { totals: { ...totals, due_today: dueToday }, overdue, upcoming, blocked, status_distribution: statusDist };

  const ids = await supervisedUserIds(u);
  const people = (await userKpis({ from: from30, to: today, userIds: ids })).filter((p) => p.id !== u.id || u.scope === 'organization');
  base.workload = people.map((p) => ({ id: p.id, name: p.name, department: p.department_name, open: p.open, overdue: p.overdue_open, open_hours: p.open_estimated_hours, capacity: p.capacity_hours_per_week, score: p.performance_score, completed: p.completed, on_time_rate: p.on_time_rate }))
    .sort((a, b) => b.open_hours - a.open_hours).slice(0, 25);

  if (u.scope === 'organization') {
    const [counts, depts, projStatus, escalations] = await Promise.all([
      db.raw(`SELECT
          (SELECT count(*) FROM departments WHERE is_active AND deleted_at IS NULL)::int AS departments,
          (SELECT count(*) FROM users WHERE is_active AND deleted_at IS NULL)::int AS employees,
          (SELECT count(*) FROM projects WHERE deleted_at IS NULL AND NOT is_future AND status IN ('approved','planned','ready_to_start','in_progress','on_hold'))::int AS active_projects,
          (SELECT count(*) FROM projects WHERE deleted_at IS NULL AND is_future AND status <> 'cancelled')::int AS future_projects,
          (SELECT count(*) FROM projects WHERE deleted_at IS NULL AND status = 'completed')::int AS completed_projects`),
      db('departments as d').where('d.is_active', true).whereNull('d.deleted_at').select('d.id', 'd.name',
        db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.deleted_at IS NULL AND NOT t.is_recurring_template AND t.status NOT IN ('completed','cancelled'))::int AS open`),
        db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.deleted_at IS NULL AND t.is_overdue AND t.status NOT IN ('completed','cancelled'))::int AS overdue`),
        db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.status = 'completed' AND t.completed_at >= now() - interval '30 days')::int AS completed`),
        db.raw(`(SELECT round(100.0 * count(*) FILTER (WHERE t.deadline IS NULL OR t.completed_at <= t.deadline) / nullif(count(*),0))::int FROM tasks t WHERE t.department_id = d.id AND t.status = 'completed' AND t.completed_at >= now() - interval '30 days') AS on_time_rate`))
        .orderBy('d.name'),
      db('projects').whereNull('deleted_at').groupBy('status').select('status', db.raw('count(*)::int AS count')),
      db('escalation_history as h').join('tasks as t', 't.id', 'h.task_id').where('h.escalated_at', '>', new Date(now.getTime() - 7 * 86400_000)).where('h.level', '>=', 2)
        .whereNotIn('t.status', ['completed', 'cancelled']).orderBy('h.escalated_at', 'desc').limit(10)
        .select('h.id', 'h.level', 'h.escalated_at', 'h.note', 't.id as task_id', 't.task_key', 't.title', 't.priority'),
    ]);
    base.org = { counts: counts.rows[0], departments: depts, project_status: projStatus, escalations };
    base.critical_alerts = [
      ...overdue.filter((t: any) => ['critical', 'high'].includes(t.priority)).map((t: any) => ({ type: 'overdue', severity: t.priority, title: `${t.task_key} overdue`, detail: t.title, link: `/tasks/${t.id}` })),
      ...blocked.map((t: any) => ({ type: 'blocked', severity: 'high', title: `${t.task_key} blocked`, detail: t.blocker_note ?? t.title, link: `/tasks/${t.id}` })),
      ...escalations.map((e: any) => ({ type: 'escalation', severity: e.level >= 3 ? 'critical' : 'high', title: `Escalation L${e.level}: ${e.task_key}`, detail: e.title, link: `/tasks/${e.task_id}` })),
    ].slice(0, 12);
  }

  if (u.scope === 'project' || u.scope === 'organization') {
    const projQ = scopeProjects(db('projects as p'), u).whereNull('p.deleted_at').where('p.is_future', false);
    if (u.scope === 'project') projQ.where((w) => w.where('p.manager_id', u.id).orWhere('p.created_by', u.id));
    const projects = await projQ.whereNotIn('p.status', ['completed', 'cancelled']).orderBy('p.end_date')
      .select('p.id', 'p.code', 'p.name', 'p.status', 'p.progress', 'p.start_date', 'p.end_date', 'p.priority',
        db.raw(`(SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.is_overdue AND t.deleted_at IS NULL AND t.status NOT IN ('completed','cancelled'))::int AS overdue`),
        db.raw(`(SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'blocked' AND t.deleted_at IS NULL)::int AS blocked`));
    const pids = projects.map((p: any) => p.id);
    const [milestones, contributions, deliveries] = await Promise.all([
      db('project_milestones as m').join('projects as p', 'p.id', 'm.project_id').whereIn('m.project_id', pids.length ? pids : [0]).whereNot('m.status', 'completed')
        .orderBy('m.due_date').limit(10).select('m.*', 'p.name as project_name'),
      db('tasks as t').leftJoin('departments as d', 'd.id', 't.department_id').whereIn('t.project_id', pids.length ? pids : [0]).whereNull('t.deleted_at')
        .groupBy('d.name').select(db.raw(`coalesce(d.name,'Unassigned') AS department`), db.raw('count(*)::int AS total'), db.raw(`count(*) FILTER (WHERE t.status='completed')::int AS completed`)),
      db('project_deliverables as dl').join('projects as p', 'p.id', 'dl.project_id').whereIn('dl.project_id', pids.length ? pids : [0])
        .whereIn('dl.status', ['pending', 'in_progress']).where('dl.due_date', '<=', DateTime.now().plus({ days: 30 }).toISODate()!).orderBy('dl.due_date').select('dl.*', 'p.name as project_name'),
    ]);
    base.projects = {
      list: projects,
      delayed: projects.filter((p: any) => (p.end_date && p.end_date < today) || p.overdue > 0),
      milestones, contributions, deliveries,
    };
  }

  if (u.scope === 'department' && u.departmentId) {
    const dept = await db('departments').where({ id: u.departmentId }).first('id', 'name');
    const emp = await db('users').where({ department_id: u.departmentId, is_active: true }).whereNull('deleted_at').count({ c: '*' }).first();
    const done30 = Number((await openTasks(u).where('t.status', 'completed').where('t.completed_at', '>=', from30).count({ c: '*' }).first())?.c ?? 0);
    base.department = { ...dept, employees: Number(emp?.c ?? 0), completed_30d: done30,
      progress: totals.total ? Math.round((totals.completed / (totals.total)) * 100) : 0 };
  }
  res.json(base);
});
