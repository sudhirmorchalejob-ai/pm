import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { db } from '../db/knex';
import { can, me, requirePerm } from '../auth/middleware';
import { loadVisibleProject, scopeProjects, scopeTasks, scopeUsers } from '../auth/scope';
import { badRequest } from '../lib/errors';
import { parse, zCsv, zDate, zId } from '../lib/http';
import { occurrencesBetween } from '../lib/recurrence';
import { getSetting } from '../lib/settings';

export const router = Router();

// ===================================================================== calendar
const calQ = z.object({
  from: zDate, to: zDate,
  types: zCsv,
  employee_id: zId.optional(), department_id: zId.optional(), project_id: zId.optional(), status: zCsv,
});

/** Unified calendar feed: task deadlines, milestones, future project starts, meetings, agenda, reminders. */
router.get('/calendar', async (req, res) => {
  const u = me(req);
  const f = parse(calQ, req.query);
  if (f.to < f.from) throw badRequest('Invalid range');
  if (DateTime.fromISO(f.to).diff(DateTime.fromISO(f.from), 'days').days > 400) throw badRequest('Range too large (max 400 days)');
  const types = new Set(f.types ?? ['tasks', 'milestones', 'future', 'projects', 'meetings', 'agenda', 'reminders']);
  const toEx = DateTime.fromISO(f.to).plus({ days: 1 }).toISODate()!;
  const events: any[] = [];

  if (types.has('tasks') && can(u, 'tasks.view')) {
    const q = scopeTasks(db('tasks as t'), u).whereNull('t.deleted_at').where('t.is_recurring_template', false).where('t.deadline', '>=', f.from).where('t.deadline', '<', toEx)
      .leftJoin('projects as p', 'p.id', 't.project_id').select('t.id', 't.task_key', 't.title', 't.deadline', 't.status', 't.priority', 't.is_overdue', 'p.name as project_name');
    if (f.employee_id) q.whereExists(db('task_assignees as x').whereRaw('x.task_id = t.id').andWhere('x.user_id', f.employee_id));
    if (f.department_id) q.where('t.department_id', f.department_id);
    if (f.project_id) q.where('t.project_id', f.project_id);
    if (f.status) q.whereIn('t.status', f.status);
    for (const t of await q) events.push({ id: `task-${t.id}`, type: 'task', title: `${t.task_key} ${t.title}`, start: t.deadline, allDay: false, status: t.status, priority: t.priority, overdue: t.is_overdue, link: `/tasks/${t.id}`, meta: t.project_name });
  }
  if ((types.has('milestones') || types.has('projects') || types.has('future')) && can(u, 'projects.view')) {
    const pq = scopeProjects(db('projects as p'), u).whereNull('p.deleted_at');
    if (f.project_id) pq.where('p.id', f.project_id);
    if (f.department_id) pq.where('p.department_id', f.department_id);
    const pids = (await pq.clone().pluck('p.id')) as number[];
    if (types.has('milestones') && pids.length) {
      const ms = await db('project_milestones as m').join('projects as p', 'p.id', 'm.project_id').whereIn('m.project_id', pids).whereBetween('m.due_date', [f.from, f.to])
        .select('m.id', 'm.title', 'm.due_date', 'm.status', 'p.id as project_id', 'p.name as project_name');
      for (const m of ms) events.push({ id: `ms-${m.id}`, type: 'milestone', title: `◆ ${m.title}`, start: m.due_date, allDay: true, status: m.status, link: `/projects/${m.project_id}?tab=milestones`, meta: m.project_name });
    }
    if (types.has('future')) {
      const fps = await pq.clone().where('p.is_future', true).join('future_projects as fp', 'fp.project_id', 'p.id').whereBetween('fp.expected_start_date', [f.from, f.to])
        .select('p.id', 'p.name', 'fp.expected_start_date', 'fp.readiness_percent', 'fp.approval_status');
      for (const p of fps) events.push({ id: `fp-${p.id}`, type: 'future_project', title: `Planned start: ${p.name}`, start: p.expected_start_date, allDay: true, status: p.approval_status, link: `/projects/${p.id}`, meta: `${p.readiness_percent}% ready` });
    }
    if (types.has('projects')) {
      const ps = await pq.clone().where('p.is_future', false).where((w) => w.whereBetween('p.start_date', [f.from, f.to]).orWhereBetween('p.end_date', [f.from, f.to])).select('p.id', 'p.name', 'p.start_date', 'p.end_date', 'p.status');
      for (const p of ps) {
        if (p.start_date >= f.from && p.start_date <= f.to) events.push({ id: `ps-${p.id}`, type: 'project', title: `Start: ${p.name}`, start: p.start_date, allDay: true, status: p.status, link: `/projects/${p.id}` });
        if (p.end_date && p.end_date >= f.from && p.end_date <= f.to) events.push({ id: `pe-${p.id}`, type: 'project', title: `Due: ${p.name}`, start: p.end_date, allDay: true, status: p.status, link: `/projects/${p.id}` });
      }
    }
  }
  if (types.has('meetings')) {
    const mq = db('meetings as m').where('m.starts_at', '<', toEx).where('m.ends_at', '>=', f.from).whereNot('m.status', 'cancelled')
      .where((w) => { if (u.scope !== 'organization') w.where('m.organizer_id', u.id).orWhereExists(db('meeting_attendees as a').whereRaw('a.meeting_id = m.id').andWhere('a.user_id', u.id)); })
      .select('m.id', 'm.title', 'm.starts_at', 'm.ends_at', 'm.location', 'm.status');
    if (f.project_id) mq.where('m.project_id', f.project_id);
    for (const m of await mq) events.push({ id: `mt-${m.id}`, type: 'meeting', title: m.title, start: m.starts_at, end: m.ends_at, allDay: false, status: m.status, link: `/meetings?id=${m.id}`, meta: m.location });
  }
  if (types.has('agenda') && can(u, 'agenda.use')) {
    const items = await db('management_agenda').where({ owner_id: u.id }).whereNot('status', 'cancelled').where('due_at', '>=', f.from).where('due_at', '<', toEx);
    for (const a of items) events.push({ id: `ag-${a.id}`, type: 'agenda', title: a.title, start: a.due_at, allDay: false, status: a.status, priority: a.priority, link: '/agenda' });
  }
  if (types.has('reminders')) {
    const scheds = await db('notification_schedules as s').leftJoin('recurring_schedules as r', 'r.id', 's.recurring_schedule_id')
      .where('s.status', 'active').where((w) => w.where('s.created_by', u.id).orWhereExists(db('notification_recipients as nr').whereRaw('nr.schedule_id = s.id').andWhere('nr.user_id', u.id)))
      .select('s.id', 's.title', 's.schedule_type', 's.next_run_at', db.raw('row_to_json(r.*) AS rule'));
    const from = new Date(f.from); const to = new Date(toEx);
    for (const s of scheds) {
      const times = s.rule ? occurrencesBetween({ ...s.rule, time_of_day: String(s.rule.time_of_day) }, from, to, 100) : s.next_run_at && new Date(s.next_run_at) >= from && new Date(s.next_run_at) < to ? [new Date(s.next_run_at)] : [];
      for (const t of times) events.push({ id: `rm-${s.id}-${t.getTime()}`, type: 'reminder', title: `🔔 ${s.title}`, start: t.toISOString(), allDay: false, link: `/notifications?schedule=${s.id}` });
    }
  }
  events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
  res.json({ from: f.from, to: f.to, events });
});

// ===================================================================== gantt
/** Project Gantt (tasks + dependencies + milestones) or portfolio Gantt (projects) when no project given. */
router.get('/gantt', requirePerm('projects.view', 'tasks.view'), async (req, res) => {
  const u = me(req);
  const f = parse(z.object({ project_id: zId.optional(), department_id: zId.optional(), employee_id: zId.optional(), status: zCsv, include_future: z.enum(['true', 'false']).optional() }), req.query);
  if (!f.project_id) {
    const q = scopeProjects(db('projects as p'), u).whereNull('p.deleted_at').whereNot('p.status', 'cancelled').leftJoin('future_projects as fp', 'fp.project_id', 'p.id')
      .select('p.id', 'p.code', 'p.name', 'p.status', 'p.progress', 'p.is_future', 'p.priority', db.raw('coalesce(p.start_date, fp.expected_start_date) AS start'), db.raw('coalesce(p.end_date, fp.expected_end_date) AS "end"'))
      .orderByRaw('coalesce(p.start_date, fp.expected_start_date) NULLS LAST');
    if (f.include_future !== 'true') q.where('p.is_future', false);
    if (f.department_id) q.where('p.department_id', f.department_id);
    if (f.status) q.whereIn('p.status', f.status);
    const projects = await q;
    const deps = await db('project_dependencies').whereIn('project_id', projects.map((p: any) => p.id)).whereNotNull('depends_on_project_id').select('project_id as to', 'depends_on_project_id as from');
    return res.json({ mode: 'portfolio', items: projects.map((p: any) => ({ id: p.id, label: `${p.code} ${p.name}`, start: p.start, end: p.end ?? p.start, progress: p.progress, status: p.status, kind: p.is_future ? 'future' : 'project', link: `/projects/${p.id}` })), dependencies: deps, milestones: [] });
  }
  const p = await loadVisibleProject(u, f.project_id);
  const tq = scopeTasks(db('tasks as t'), u).where('t.project_id', p.id).whereNull('t.deleted_at').where('t.is_recurring_template', false)
    .select('t.id', 't.task_key', 't.title', 't.status', 't.progress', 't.priority', 't.start_date', 't.deadline', 't.created_at', 't.is_overdue', 't.milestone_id',
      db.raw(`(SELECT string_agg(u.name, ', ') FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id = t.id) AS assignee_names`))
    .orderByRaw('coalesce(t.start_date, t.created_at::date), t.id');
  if (f.employee_id) tq.whereExists(db('task_assignees as x').whereRaw('x.task_id = t.id').andWhere('x.user_id', f.employee_id));
  if (f.status) tq.whereIn('t.status', f.status);
  if (f.department_id) tq.where('t.department_id', f.department_id);
  const tasks = await tq;
  const ids = tasks.map((t: any) => t.id);
  const [deps, milestones] = await Promise.all([
    db('task_dependencies').whereIn('task_id', ids.length ? ids : [0]).whereIn('depends_on_task_id', ids.length ? ids : [0]).select('depends_on_task_id as from', 'task_id as to', 'dependency_type as type'),
    db('project_milestones').where({ project_id: p.id }).select('id', 'title', 'due_date', 'status'),
  ]);
  const items = tasks.map((t: any) => {
    const start = t.start_date ?? DateTime.fromJSDate(new Date(t.created_at)).toISODate();
    const end = t.deadline ? DateTime.fromJSDate(new Date(t.deadline)).toISODate() : start;
    return { id: t.id, label: `${t.task_key} ${t.title}`, start, end: end! < start ? start : end, progress: t.progress, status: t.status, priority: t.priority, overdue: t.is_overdue, meta: t.assignee_names, kind: 'task', link: `/tasks/${t.id}` };
  });
  res.json({ mode: 'project', project: { id: p.id, name: p.name, start: p.start_date, end: p.end_date }, items, dependencies: deps, milestones });
});

// ===================================================================== resources & capacity
router.get('/resources', requirePerm('resources.view'), async (req, res) => {
  const u = me(req);
  const f = parse(z.object({ department_id: zId.optional(), skill: z.string().optional() }), req.query);
  const threshold: number = await getSetting('overload_threshold_percent');
  const q = scopeUsers(db('users as u'), u).whereNull('u.deleted_at').where('u.is_active', true).whereNot('u.employment_status', 'exited')
    .leftJoin('departments as d', 'd.id', 'u.department_id').leftJoin('designations as g', 'g.id', 'u.designation_id')
    .select('u.id', 'u.name', 'u.employee_code', 'u.employment_status', 'u.capacity_hours_per_week', 'u.department_id', 'd.name as department_name', 'g.title as designation',
      db.raw(`(SELECT count(*) FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE ta.user_id = u.id AND t.deleted_at IS NULL AND NOT t.is_recurring_template AND t.status NOT IN ('completed','cancelled'))::int AS open_tasks`),
      // remaining effort due in the next 7 days, plus 1/4 of later remaining effort (spread over ~4 weeks)
      db.raw(`(SELECT coalesce(sum(CASE WHEN t.deadline IS NULL OR t.deadline <= now() + interval '7 days'
                   THEN greatest(coalesce(t.estimated_hours,4) - t.actual_hours, 0)
                   ELSE greatest(coalesce(t.estimated_hours,4) - t.actual_hours, 0) / 4 END), 0)
               FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id WHERE ta.user_id = u.id AND t.deleted_at IS NULL AND NOT t.is_recurring_template
               AND t.status NOT IN ('completed','cancelled','submitted','under_review'))::float AS load_hours_week`),
      db.raw(`(SELECT coalesce(sum(pm.allocation_percent),0) FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE pm.user_id = u.id AND p.deleted_at IS NULL AND NOT p.is_future AND p.status IN ('approved','planned','ready_to_start','in_progress'))::int AS project_allocation`),
      db.raw(`coalesce((SELECT json_agg(json_build_object('name', s.name, 'level', us.level)) FROM user_skills us JOIN skills s ON s.id = us.skill_id WHERE us.user_id = u.id), '[]') AS skills`),
      db.raw(`coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'allocation', pm.allocation_percent)) FROM project_members pm JOIN projects p ON p.id = pm.project_id WHERE pm.user_id = u.id AND p.deleted_at IS NULL AND p.status NOT IN ('completed','cancelled')), '[]') AS projects`))
    .orderBy('u.name');
  if (f.department_id) q.where('u.department_id', f.department_id);
  if (f.skill) q.whereExists(db('user_skills as us').join('skills as s', 's.id', 'us.skill_id').whereRaw('us.user_id = u.id').whereILike('s.name', f.skill));
  const people: any[] = (await q).map((p: any) => {
    const cap = p.employment_status === 'on_leave' ? 0 : Number(p.capacity_hours_per_week);
    const util = cap ? Math.round((p.load_hours_week / cap) * 100) : p.load_hours_week > 0 ? 999 : 0;
    return { ...p, capacity: cap, utilization: util, available_hours: Math.max(0, Math.round((cap - p.load_hours_week) * 10) / 10), overloaded: util > threshold || p.project_allocation > 100 };
  });
  const byDept = new Map<string, any>();
  for (const p of people) {
    const k = p.department_name ?? 'Unassigned';
    const d = byDept.get(k) ?? { department: k, people: 0, capacity: 0, load: 0, overloaded: 0 };
    d.people++; d.capacity += p.capacity; d.load += p.load_hours_week; if (p.overloaded) d.overloaded++;
    byDept.set(k, d);
  }
  const shortages = await db('project_resources as r').join('projects as p', 'p.id', 'r.project_id').leftJoin('skills as s', 's.id', 'r.skill_id').leftJoin('departments as d', 'd.id', 'r.department_id')
    .whereIn('r.status', ['required', 'requested']).whereNull('p.deleted_at').whereNot('p.status', 'cancelled')
    .select('r.*', 'p.name as project_name', 'p.code as project_code', 'p.is_future', 's.name as skill_name', 'd.name as department_name',
      db.raw(`(SELECT count(*) FROM user_skills us JOIN users x ON x.id = us.user_id WHERE us.skill_id = r.skill_id AND x.is_active AND us.level >= 3)::int AS skilled_people`))
    .orderBy('r.start_date');
  res.json({
    threshold, people,
    departments: [...byDept.values()].map((d) => ({ ...d, load: Math.round(d.load), utilization: d.capacity ? Math.round((d.load / d.capacity) * 100) : 0 })),
    overloaded: people.filter((p) => p.overloaded),
    underutilized: people.filter((p) => p.capacity > 0 && p.utilization < 40),
    shortages,
  });
});

// ===================================================================== audit log
router.get('/audit', requirePerm('audit.view'), async (req, res) => {
  const f = parse(z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
    entity_type: z.string().optional(), entity_id: zId.optional(), actor_id: zId.optional(), action: z.string().optional(), from: zDate.optional(), to: zDate.optional() }), req.query);
  const q = db('audit_logs as a').leftJoin('users as u', 'u.id', 'a.actor_id').orderBy('a.created_at', 'desc')
    .select('a.*', 'u.name as actor_name');
  if (f.entity_type) q.where('a.entity_type', f.entity_type);
  if (f.entity_id) q.where('a.entity_id', f.entity_id);
  if (f.actor_id) q.where('a.actor_id', f.actor_id);
  if (f.action) q.whereILike('a.action', `%${f.action}%`);
  if (f.from) q.where('a.created_at', '>=', f.from);
  if (f.to) q.where('a.created_at', '<', db.raw(`?::date + 1`, [f.to]));
  const countQ = q.clone().clearSelect().clearOrder().count({ c: '*' }).first();
  const [items, c] = await Promise.all([q.limit(f.pageSize).offset((f.page - 1) * f.pageSize), countQ]);
  res.json({ items, total: Number(c?.c ?? 0), page: f.page, pageSize: f.pageSize });
});
