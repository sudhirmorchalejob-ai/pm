import { Router } from 'express';
import { z } from 'zod';
import { db, Tx } from '../db/knex';
import { can, me, requirePerm } from '../auth/middleware';
import { assertCanManageProject, canManageProject, loadVisibleProject, scopeProjects, scopeTasks } from '../auth/scope';
import { assertActiveUsers } from '../lib/employees';
import { audit, diff } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { applySort, idParam, paginate, parse, zBoolQ, zCsv, zDate, zId, zOptId, zOptStr, zPage, zPriority, patchOf } from '../lib/http';
import { emitEvent } from '../notifications/events';
import { registerFile, upload } from './files';

export const router = Router();

export const PROJECT_STATUSES = ['proposed', 'under_evaluation', 'approved', 'planned', 'ready_to_start', 'in_progress', 'on_hold', 'completed', 'cancelled'] as const;

/** Progress = share of estimated effort (fallback: count) in approved-completed tasks. */
export async function recomputeProjectProgress(projectId: number, trx: Tx = db) {
  const r = await trx('tasks').where({ project_id: projectId, is_recurring_template: false }).whereNull('deleted_at').whereNull('parent_task_id')
    .whereNot('status', 'cancelled')
    .first(trx.raw('coalesce(sum(coalesce(estimated_hours, 1)), 0) AS total'),
      trx.raw(`coalesce(sum(coalesce(estimated_hours, 1)) FILTER (WHERE status = 'completed'), 0) AS done`));
  const progress = Number(r.total) > 0 ? Math.round((Number(r.done) / Number(r.total)) * 100) : 0;
  await trx('projects').where({ id: projectId }).update({ progress });
  return progress;
}

const listQ = z.object({
  ...zPage,
  q: z.string().max(100).optional(),
  status: zCsv,
  future: zBoolQ,
  department_id: zId.optional(),
  manager_id: zId.optional(),
  priority: zPriority.optional(),
  sort: z.string().optional(),
});

router.get('/', requirePerm('projects.view'), async (req, res) => {
  const f = parse(listQ, req.query);
  const q = scopeProjects(db('projects as p'), me(req)).whereNull('p.deleted_at')
    .leftJoin('users as m', 'm.id', 'p.manager_id').leftJoin('departments as d', 'd.id', 'p.department_id')
    .leftJoin('future_projects as fp', 'fp.project_id', 'p.id')
    .select('p.id', 'p.code', 'p.name', 'p.status', 'p.priority', 'p.start_date', 'p.end_date', 'p.progress', 'p.is_future', 'p.client_name',
      'p.estimated_budget', 'p.manager_id', 'm.name as manager_name', 'p.department_id', 'd.name as department_name',
      'fp.expected_start_date', 'fp.readiness_percent', 'fp.approval_status',
      db.raw(`(SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND NOT t.is_recurring_template)::int AS task_count`),
      db.raw(`(SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.is_overdue)::int AS overdue_count`),
      db.raw(`(SELECT count(*) FROM project_members pm WHERE pm.project_id = p.id)::int AS member_count`));
  if (f.q) q.where((w) => w.whereILike('p.name', `%${f.q}%`).orWhereILike('p.code', `%${f.q}%`).orWhereILike('p.client_name', `%${f.q}%`));
  if (f.status) q.whereIn('p.status', f.status);
  if (f.future !== undefined) q.where('p.is_future', f.future);
  if (f.department_id) q.where('p.department_id', f.department_id);
  if (f.manager_id) q.where('p.manager_id', f.manager_id);
  if (f.priority) q.where('p.priority', f.priority);
  applySort(q, f.sort, { name: 'p.name', code: 'p.code', start: 'p.start_date', end: 'p.end_date', progress: 'p.progress', priority: 'p.priority', created: 'p.created_at' }, 'created:desc');
  res.json(await paginate(q, f.page, f.pageSize));
});

const projectSchema = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(2).max(200),
  description: zOptStr,
  business_objective: zOptStr,
  client_name: z.string().max(200).nullable().optional(),
  client_contact: z.string().max(200).nullable().optional(),
  client_email: z.string().email().nullable().optional().or(z.literal('').transform(() => null)),
  manager_id: zOptId,
  department_id: zOptId,
  hod_id: zOptId,
  start_date: zDate.nullable().optional(),
  end_date: zDate.nullable().optional(),
  priority: zPriority.default('medium'),
  estimated_budget: z.number().min(0).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  member_ids: z.array(zId).optional(),
});

const futureSchema = z.object({
  expected_start_date: zDate,
  expected_end_date: zDate.nullable().optional(),
  planning_horizon: z.enum(['next_week', 'next_month', 'next_quarter', 'six_months', 'next_year', 'custom']).default('custom'),
  required_employees: z.number().int().min(0).default(0),
  required_skills: z.array(z.string().max(80)).default([]),
  expected_deliverables: zOptStr,
});

function checkDates(s?: string | null, e?: string | null) {
  if (s && e && e < s) throw badRequest('End date must be on or after start date');
}

router.post('/', async (req, res) => {
  const u = me(req);
  const body = parse(projectSchema.extend({ is_future: z.boolean().default(false), future: futureSchema.optional() }), req.body);
  if (body.is_future ? !can(u, 'future_projects.manage') : !can(u, 'projects.create')) throw forbidden();
  if (body.is_future && !body.future) throw badRequest('Future project planning details are required');
  checkDates(body.start_date, body.end_date);
  if (await db('projects').where({ code: body.code }).first()) throw conflict('Project code already exists');
  const { member_ids, future, ...p } = body;
  if (body.is_future) {
    checkDates(future!.expected_start_date, future!.expected_end_date);
    if (future!.expected_start_date <= new Date().toISOString().slice(0, 10)) throw badRequest('Expected start date of a future project must be in the future');
    p.start_date = p.start_date ?? future!.expected_start_date;
    p.end_date = p.end_date ?? future!.expected_end_date ?? null;
  }
  // Only approvers may create a project directly in an approved/active state.
  if (p.status && !['proposed', 'under_evaluation', 'planned'].includes(p.status) && !can(u, 'approvals.decide') && !can(u, 'projects.manage_all')) p.status = 'proposed';
  const row = await db.transaction(async (trx) => {
    const [proj] = await trx('projects').insert({ ...p, status: p.status ?? (body.is_future ? 'proposed' : 'planned'), created_by: u.id, manager_id: p.manager_id ?? (u.roleKey === 'project_manager' ? u.id : null) }).returning('*');
    if (future) await trx('future_projects').insert({ project_id: proj.id, ...future });
    const members = [...new Set([...(member_ids ?? []), ...(proj.manager_id ? [proj.manager_id] : [])])];
    if (members.length) await trx('project_members').insert(members.map((m) => ({ project_id: proj.id, user_id: m, added_by: u.id, role_in_project: m === proj.manager_id ? 'manager' : 'member' })));
    await audit(req, { action: body.is_future ? 'future_project.created' : 'project.created', entityType: 'project', entityId: proj.id, summary: `${proj.code} ${proj.name}`, after: p }, trx);
    return proj;
  });
  res.status(201).json(row);
});

router.get('/:id', requirePerm('projects.view'), async (req, res) => {
  const u = me(req);
  const p = await loadVisibleProject(u, idParam(req));
  const [extra, future, members, milestones, deliverables, risks, deps, resources, taskStats] = await Promise.all([
    db('projects as p').leftJoin('users as m', 'm.id', 'p.manager_id').leftJoin('users as h', 'h.id', 'p.hod_id')
      .leftJoin('departments as d', 'd.id', 'p.department_id').leftJoin('users as c', 'c.id', 'p.created_by')
      .where('p.id', p.id).first('m.name as manager_name', 'h.name as hod_name', 'd.name as department_name', 'c.name as created_by_name'),
    db('future_projects').where({ project_id: p.id }).first(),
    db('project_members as pm').join('users as us', 'us.id', 'pm.user_id').leftJoin('departments as d', 'd.id', 'us.department_id')
      .leftJoin('designations as g', 'g.id', 'us.designation_id')
      .where('pm.project_id', p.id).select('pm.*', 'us.name', 'us.employee_code', 'd.name as department_name', 'g.title as designation',
        db.raw(`(SELECT count(*) FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id WHERE t.project_id = pm.project_id AND ta.user_id = pm.user_id
                 AND t.deleted_at IS NULL AND t.status NOT IN ('completed','cancelled'))::int AS open_tasks`)),
    db('project_milestones').where({ project_id: p.id }).orderBy(['due_date', 'sort_order']).select('*',
      db.raw(`(SELECT count(*) FROM tasks t WHERE t.milestone_id = project_milestones.id AND t.deleted_at IS NULL)::int AS task_count`),
      db.raw(`(SELECT count(*) FROM tasks t WHERE t.milestone_id = project_milestones.id AND t.deleted_at IS NULL AND t.status = 'completed')::int AS done_count`)),
    db('project_deliverables').where({ project_id: p.id }).orderBy('due_date'),
    db('project_risks as r').leftJoin('users as o', 'o.id', 'r.owner_id').where('r.project_id', p.id).orderBy('r.created_at', 'desc').select('r.*', 'o.name as owner_name'),
    db('project_dependencies as d').leftJoin('projects as x', 'x.id', 'd.depends_on_project_id').where('d.project_id', p.id).select('d.*', 'x.name as depends_on_name', 'x.code as depends_on_code', 'x.status as depends_on_status'),
    db('project_resources as r').leftJoin('skills as s', 's.id', 'r.skill_id').leftJoin('users as us', 'us.id', 'r.user_id').leftJoin('departments as d', 'd.id', 'r.department_id')
      .where('r.project_id', p.id).select('r.*', 's.name as skill_name', 'us.name as user_name', 'd.name as department_name'),
    db('tasks').where({ project_id: p.id, is_recurring_template: false }).whereNull('deleted_at').groupBy('status').select('status').count({ c: '*' }),
  ]);
  res.json({
    ...p, ...extra, future: future ?? null, members, milestones, deliverables, risks, dependencies: deps, resources,
    task_stats: Object.fromEntries(taskStats.map((r: any) => [r.status, Number(r.c)])), can_manage: canManageProject(u, p),
  });
});

router.patch('/:id', async (req, res) => {
  const u = me(req);
  const p = await loadVisibleProject(u, idParam(req));
  assertCanManageProject(u, p);
  const body = parse(patchOf(projectSchema).omit({ member_ids: true, status: true }), req.body);
  checkDates(body.start_date ?? p.start_date, body.end_date ?? p.end_date);
  if (body.code && body.code.toLowerCase() !== String(p.code).toLowerCase() && await db('projects').where({ code: body.code }).first()) throw conflict('Project code already exists');
  // Budget changes on approved projects go through approval unless the user is an approver.
  if (body.estimated_budget !== undefined && Number(body.estimated_budget) !== Number(p.estimated_budget) && !p.is_future
      && !['proposed', 'under_evaluation'].includes(p.status) && !can(u, 'approvals.decide')) {
    throw badRequest('Budget changes on approved projects require a budget-change approval request');
  }
  const [row] = await db('projects').where({ id: p.id }).update({ ...body, updated_at: db.fn.now() }).returning('*');
  const d = diff(p, body);
  if (d.changed.length) await audit(req, { action: 'project.updated', entityType: 'project', entityId: p.id, before: d.before, after: d.after });
  res.json(row);
});

router.post('/:id/status', async (req, res) => {
  const u = me(req);
  const p = await loadVisibleProject(u, idParam(req));
  assertCanManageProject(u, p);
  const { status, note } = parse(z.object({ status: z.enum(PROJECT_STATUSES), note: zOptStr }), req.body);
  if (status === p.status) return res.json(p);
  if (['approved'].includes(status) && !can(u, 'approvals.decide') && !can(u, 'projects.manage_all')) {
    throw forbidden('Project approval requires an approver. Submit a project approval request instead.');
  }
  if (p.is_future && ['in_progress', 'completed'].includes(status)) throw badRequest('Convert the future project to an active project first');
  const [row] = await db('projects').where({ id: p.id }).update({ status, updated_at: db.fn.now() }).returning('*');
  await audit(req, { action: 'project.status_changed', entityType: 'project', entityId: p.id, before: { status: p.status }, after: { status, note }, summary: `${p.status} → ${status}` });
  await emitEvent({ type: 'project.status_changed', actorId: u.id, projectId: p.id, vars: { project: row, from: p.status, to: status } });
  res.json(row);
});

router.delete('/:id', async (req, res) => {
  const u = me(req);
  const p = await loadVisibleProject(u, idParam(req));
  if (!can(u, 'projects.manage_all') && !(canManageProject(u, p) && p.created_by === u.id)) throw forbidden();
  await db('projects').where({ id: p.id }).update({ deleted_at: db.fn.now() });
  await audit(req, { action: 'project.deleted', entityType: 'project', entityId: p.id, summary: p.name });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ sub-resources (generic CRUD)
async function managed(req: any) {
  const u = me(req);
  const p = await loadVisibleProject(u, idParam(req));
  assertCanManageProject(u, p);
  return p;
}

router.post('/:id/members', async (req, res) => {
  const p = await managed(req);
  const { members } = parse(z.object({ members: z.array(z.object({ user_id: zId, role_in_project: z.string().max(60).default('member'), allocation_percent: z.number().int().min(0).max(100).default(100) })).min(1) }), req.body);
  await assertActiveUsers(members.map((m) => m.user_id), 'project assignments');
  await db('project_members').insert(members.map((m) => ({ ...m, project_id: p.id, added_by: me(req).id }))).onConflict(['project_id', 'user_id']).merge(['role_in_project', 'allocation_percent']);
  await audit(req, { action: 'project.members_added', entityType: 'project', entityId: p.id, after: members });
  res.json({ ok: true });
});
router.delete('/:id/members/:userId', async (req, res) => {
  const p = await managed(req);
  await db('project_members').where({ project_id: p.id, user_id: idParam(req, 'userId') }).del();
  await audit(req, { action: 'project.member_removed', entityType: 'project', entityId: p.id, after: { user_id: idParam(req, 'userId') } });
  res.json({ ok: true });
});

type SubDef = { table: string; schema: z.ZodObject<any>; label: string };
const SUBS: Record<string, SubDef> = {
  milestones: { table: 'project_milestones', label: 'milestone', schema: z.object({ title: z.string().trim().min(2).max(200), description: zOptStr, due_date: zDate, status: z.enum(['pending', 'in_progress', 'awaiting_approval', 'completed', 'missed']).optional(), sort_order: z.number().int().optional() }) },
  deliverables: { table: 'project_deliverables', label: 'deliverable', schema: z.object({ title: z.string().trim().min(2).max(200), description: zOptStr, due_date: zDate.nullable().optional(), status: z.enum(['pending', 'in_progress', 'delivered', 'accepted']).optional() }) },
  risks: { table: 'project_risks', label: 'risk', schema: z.object({ title: z.string().trim().min(2).max(200), description: zOptStr, probability: z.enum(['low', 'medium', 'high']).optional(), impact: z.enum(['low', 'medium', 'high', 'critical']).optional(), mitigation: zOptStr, owner_id: zOptId, status: z.enum(['open', 'mitigating', 'closed', 'occurred']).optional() }) },
  dependencies: { table: 'project_dependencies', label: 'dependency', schema: z.object({ depends_on_project_id: zOptId, description: z.string().trim().min(2).max(2000), status: z.enum(['open', 'resolved']).optional() }) },
  resources: { table: 'project_resources', label: 'resource', schema: z.object({ skill_id: zOptId, user_id: zOptId, department_id: zOptId, required_count: z.number().int().min(1).default(1), hours_per_week: z.number().min(0).max(80).default(40), start_date: zDate.nullable().optional(), end_date: zDate.nullable().optional(), status: z.enum(['required', 'requested', 'allocated', 'released']).optional() }) },
};

for (const [path, def] of Object.entries(SUBS)) {
  router.post(`/:id/${path}`, async (req, res) => {
    const p = await managed(req);
    const body = parse(def.schema, req.body);
    // Completing a milestone requires approval when the user is not an approver.
    if (path === 'milestones' && body.status === 'completed' && !can(me(req), 'approvals.decide')) body.status = 'awaiting_approval';
    if (path === 'resources' && body.status === 'allocated' && !can(me(req), 'approvals.decide') && !can(me(req), 'projects.manage_all')) body.status = 'requested';
    const [row] = await db(def.table).insert({ ...body, project_id: p.id }).returning('*');
    await audit(req, { action: `project.${def.label}_added`, entityType: 'project', entityId: p.id, after: row, summary: row.title ?? row.description });
    res.status(201).json(row);
  });
  router.patch(`/:id/${path}/:subId`, async (req, res) => {
    const p = await managed(req);
    const subId = idParam(req, 'subId');
    const before = await db(def.table).where({ id: subId, project_id: p.id }).first();
    if (!before) throw notFound();
    const body: any = parse(patchOf(def.schema), req.body);
    if (path === 'milestones' && body.status === 'completed' && before.status !== 'completed') {
      if (!can(me(req), 'approvals.decide')) {
        body.status = 'awaiting_approval';
        await db('approval_requests').insert({ approval_type: 'milestone', project_id: p.id, entity_id: subId, title: `Milestone completion: ${before.title}`, requested_by: me(req).id, payload: JSON.stringify({ status: 'completed' }) });
      } else body.completed_at = db.fn.now();
    }
    if (path === 'resources' && body.status === 'allocated' && before.status !== 'allocated' && !can(me(req), 'approvals.decide') && !can(me(req), 'projects.manage_all')) {
      body.status = 'requested';
      await db('approval_requests').insert({ approval_type: 'resource_allocation', project_id: p.id, entity_id: subId, title: `Resource allocation for project ${p.code}`, requested_by: me(req).id, payload: JSON.stringify({ status: 'allocated' }) });
    }
    if (path === 'risks') body.updated_at = db.fn.now();
    const [row] = await db(def.table).where({ id: subId }).update(body).returning('*');
    const d = diff(before, body);
    await audit(req, { action: `project.${def.label}_updated`, entityType: 'project', entityId: p.id, before: d.before, after: d.after, summary: before.title ?? before.description });
    res.json(row);
  });
  router.delete(`/:id/${path}/:subId`, async (req, res) => {
    const p = await managed(req);
    const n = await db(def.table).where({ id: idParam(req, 'subId'), project_id: p.id }).del();
    if (!n) throw notFound();
    await audit(req, { action: `project.${def.label}_removed`, entityType: 'project', entityId: p.id, after: { id: idParam(req, 'subId') } });
    res.json({ ok: true });
  });
}

// ------------------------------------------------------------------ documents
router.get('/:id/documents', async (req, res) => {
  const p = await loadVisibleProject(me(req), idParam(req));
  res.json(await db('project_documents as d').join('files as f', 'f.id', 'd.file_id').join('users as u', 'u.id', 'd.uploaded_by')
    .where('d.project_id', p.id).orderBy('d.created_at', 'desc')
    .select('d.id', 'd.title', 'd.category', 'd.created_at', 'f.id as file_id', 'f.original_name', 'f.size_bytes', 'f.mime_type', 'u.name as uploaded_by_name'));
});
router.post('/:id/documents', upload.array('files', 10), async (req, res) => {
  const u = me(req);
  const p = await loadVisibleProject(u, idParam(req));
  const isMember = await db('project_members').where({ project_id: p.id, user_id: u.id }).first();
  if (!canManageProject(u, p) && !isMember) throw forbidden();
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) throw badRequest('No files uploaded');
  const category = String(req.body.category ?? 'general').slice(0, 60);
  const out = [];
  for (const f of files) {
    const file = await registerFile(f, u.id);
    const [doc] = await db('project_documents').insert({ project_id: p.id, file_id: file.id, title: String(req.body.title || file.original_name).slice(0, 200), category, uploaded_by: u.id }).returning('*');
    out.push(doc);
  }
  await audit(req, { action: 'project.documents_uploaded', entityType: 'project', entityId: p.id, summary: `${out.length} file(s)` });
  res.status(201).json(out);
});

// ------------------------------------------------------------------ discussions
router.get('/:id/discussions', async (req, res) => {
  const p = await loadVisibleProject(me(req), idParam(req));
  res.json(await db('project_discussions as d').join('users as u', 'u.id', 'd.author_id').where('d.project_id', p.id).whereNull('d.deleted_at')
    .orderBy('d.created_at').select('d.*', 'u.name as author_name'));
});
router.post('/:id/discussions', async (req, res) => {
  const u = me(req);
  const p = await loadVisibleProject(u, idParam(req));
  const { body, parent_id, mentions } = parse(z.object({ body: z.string().trim().min(1).max(10000), parent_id: zOptId, mentions: z.array(zId).default([]) }), req.body);
  const [row] = await db('project_discussions').insert({ project_id: p.id, author_id: u.id, body, parent_id, mentions }).returning('*');
  if (mentions.length) {
    await emitEvent({ type: 'task.comment', actorId: u.id, projectId: p.id, link: `/projects/${p.id}?tab=discussions`, extraUserIds: { mentioned: mentions },
      vars: { comment: { body: body.slice(0, 300) }, task: { title: p.name, task_key: p.code } } });
  }
  res.status(201).json({ ...row, author_name: u.name });
});

// ------------------------------------------------------------------ tasks, activity, report
router.get('/:id/activity', async (req, res) => {
  const p = await loadVisibleProject(me(req), idParam(req));
  res.json(await db('audit_logs as a').leftJoin('users as u', 'u.id', 'a.actor_id')
    .where((w) => w.where({ 'a.entity_type': 'project', 'a.entity_id': p.id })
      .orWhere((w2) => w2.where('a.entity_type', 'task').whereIn('a.entity_id', db('tasks').where({ project_id: p.id }).select('id'))))
    .orderBy('a.created_at', 'desc').limit(200).select('a.id', 'a.action', 'a.entity_type', 'a.entity_id', 'a.summary', 'a.created_at', 'a.after', 'u.name as actor_name'));
});

router.get('/:id/report', async (req, res) => {
  const u = me(req);
  const p = await loadVisibleProject(u, idParam(req));
  const base = () => scopeTasks(db('tasks as t'), u).where('t.project_id', p.id).whereNull('t.deleted_at').where('t.is_recurring_template', false);
  const [summary, byDept, byAssignee, milestones, risks] = await Promise.all([
    base().first(
      db.raw('count(*)::int AS total'),
      db.raw(`count(*) FILTER (WHERE t.status = 'completed')::int AS completed`),
      db.raw(`count(*) FILTER (WHERE t.is_overdue)::int AS overdue`),
      db.raw(`count(*) FILTER (WHERE t.status = 'blocked')::int AS blocked`),
      db.raw(`count(*) FILTER (WHERE t.status = 'completed' AND t.completed_at <= t.deadline)::int AS on_time`),
      db.raw('coalesce(sum(t.estimated_hours),0)::float AS estimated_hours'),
      db.raw('coalesce(sum(t.actual_hours),0)::float AS actual_hours')),
    base().leftJoin('departments as d', 'd.id', 't.department_id').groupBy('d.name')
      .select(db.raw(`coalesce(d.name, 'Unassigned') AS department`), db.raw('count(*)::int AS total'), db.raw(`count(*) FILTER (WHERE t.status = 'completed')::int AS completed`)),
    base().join('task_assignees as ta', 'ta.task_id', 't.id').join('users as us', 'us.id', 'ta.user_id').groupBy('us.id', 'us.name')
      .select('us.id', 'us.name', db.raw('count(*)::int AS total'), db.raw(`count(*) FILTER (WHERE t.status = 'completed')::int AS completed`), db.raw(`count(*) FILTER (WHERE t.is_overdue)::int AS overdue`)),
    db('project_milestones').where({ project_id: p.id }).orderBy('due_date'),
    db('project_risks').where({ project_id: p.id }).whereNot('status', 'closed'),
  ]);
  res.json({ project: { id: p.id, code: p.code, name: p.name, status: p.status, progress: p.progress }, summary, by_department: byDept, by_assignee: byAssignee, milestones, open_risks: risks });
});
