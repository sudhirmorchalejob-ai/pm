import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/knex';
import { can, invalidateUserCache, me, requirePerm } from '../auth/middleware';
import { assertCanSeeUser, scopeUsers } from '../auth/scope';
import { revokeAllForUser } from '../auth/tokens';
import { audit, diff } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { applySort, idParam, paginate, parse, zBoolQ, zDate, zId, zOptId, zOptStr, zPage, patchOf } from '../lib/http';
import { isValidTimezone } from '../lib/recurrence';
import { passwordSchema } from './auth.routes';
import { assertActiveUsers, recordDepartmentChange, recordStatusChange } from '../lib/employees';
import { dropUntouchedChecklists, requestChecklistSync } from '../questionnaire/engine';
import { loadStarterStructure, optionsSchema, runTeamSetup, structureSchema } from '../daily-work/team-setup';

export const router = Router();

// ===================================================================== departments
router.get('/departments', requirePerm('org.view', 'users.view'), async (req, res) => {
  const { includeInactive } = parse(z.object({ includeInactive: zBoolQ }), req.query);
  const q = db('departments as d').leftJoin('users as h', 'h.id', 'd.hod_id').whereNull('d.deleted_at')
    .select('d.*', 'h.name as hod_name',
      db.raw('(SELECT count(*) FROM users u WHERE u.department_id = d.id AND u.deleted_at IS NULL AND u.is_active)::int AS employee_count'),
      db.raw('(SELECT count(*) FROM teams t WHERE t.department_id = d.id AND t.is_active)::int AS team_count'),
      db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.deleted_at IS NULL AND t.status NOT IN ('completed','cancelled') AND NOT t.is_recurring_template)::int AS open_tasks`))
    .orderBy('d.name');
  if (!includeInactive) q.where('d.is_active', true);
  res.json(await q);
});

const deptSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9_-]+$/),
  description: zOptStr,
  hod_id: zOptId,
  is_active: z.boolean().optional(),
});

router.post('/departments', requirePerm('org.manage'), async (req, res) => {
  const body = parse(deptSchema, req.body);
  if (await db('departments').where({ code: body.code }).first()) throw conflict('Department code already exists');
  await assertActiveUsers([body.hod_id], 'a head-of-department role');
  const [row] = await db('departments').insert(body).returning('*');
  if (body.hod_id) await moveToDepartment([body.hod_id], row.id, me(req).id, `Appointed head of ${row.name}`);
  await audit(req, { action: 'department.created', entityType: 'department', entityId: row.id, after: row, summary: row.name });
  res.status(201).json(row);
});

router.patch('/departments/:id', requirePerm('org.manage'), async (req, res) => {
  const id = idParam(req);
  const body = parse(patchOf(deptSchema), req.body);
  const before = await db('departments').where({ id }).first();
  if (!before) throw notFound();
  if (body.hod_id && body.hod_id !== before.hod_id) await assertActiveUsers([body.hod_id], 'a head-of-department role');
  const [row] = await db('departments').where({ id }).update({ ...body, updated_at: db.fn.now() }).returning('*');
  if (body.hod_id && body.hod_id !== before.hod_id) await moveToDepartment([body.hod_id], id, me(req).id, `Appointed head of ${row.name}`);
  const d = diff(before, body);
  await audit(req, { action: body.is_active === false ? 'department.deactivated' : 'department.updated', entityType: 'department', entityId: id, before: d.before, after: d.after });
  res.json(row);
});

/** Move employees into a department (keeps their team only if it belongs to that department) and record history. */
async function moveToDepartment(userIds: number[], departmentId: number, actorId: number, reason: string) {
  const moved: number[] = [];
  for (const uid of userIds) {
    const u = await db('users').where({ id: uid }).whereNull('deleted_at').first('id', 'department_id', 'team_id');
    if (!u) continue;
    let teamId = u.team_id;
    if (teamId) {
      const t = await db('teams').where({ id: teamId }).first('department_id');
      if (t?.department_id !== departmentId) teamId = null;
    }
    if (u.department_id === departmentId && teamId === u.team_id) continue;
    await db('users').where({ id: uid }).update({ department_id: departmentId, team_id: teamId, updated_at: db.fn.now() });
    await recordDepartmentChange(uid, departmentId, teamId, actorId, reason);
    invalidateUserCache(uid);
    moved.push(uid);
  }
  if (moved.length) await requestChecklistSync();
  return moved;
}

router.get('/departments/:id', requirePerm('org.view', 'users.view'), async (req, res) => {
  const id = idParam(req);
  const u = me(req);
  if (u.scope !== 'organization' && !can(u, 'org.manage') && u.departmentId !== id) throw notFound();
  const d = await db('departments as d').leftJoin('users as h', 'h.id', 'd.hod_id').where('d.id', id).whereNull('d.deleted_at').first('d.*', 'h.name as hod_name');
  if (!d) throw notFound();
  const [teams, members, history] = await Promise.all([
    db('teams as t').leftJoin('users as l', 'l.id', 't.leader_id').where('t.department_id', id).where('t.is_active', true)
      .select('t.id', 't.name', 't.leader_id', 'l.name as leader_name', db.raw('(SELECT count(*) FROM users x WHERE x.team_id = t.id AND x.deleted_at IS NULL AND x.is_active)::int AS member_count')).orderBy('t.name'),
    db('users as x').join('roles as r', 'r.id', 'x.role_id').leftJoin('teams as t', 't.id', 'x.team_id').leftJoin('designations as g', 'g.id', 'x.designation_id')
      .where('x.department_id', id).whereNull('x.deleted_at')
      .select('x.id', 'x.name', 'x.employee_code', 'x.is_active', 'x.employment_status', 'r.name as role_name', 't.name as team_name', 'g.title as designation',
        db.raw('(SELECT min(h.effective_from) FROM department_history h WHERE h.user_id = x.id AND h.department_id = x.department_id AND h.effective_to IS NULL) AS member_since'))
      .orderBy([{ column: 'x.is_active', order: 'desc' }, { column: 'x.name' }]),
    db('department_history as h').join('users as x', 'x.id', 'h.user_id').leftJoin('users as c', 'c.id', 'h.changed_by').leftJoin('teams as t', 't.id', 'h.team_id')
      .where('h.department_id', id).orderBy('h.effective_from', 'desc').limit(300)
      .select('h.id', 'h.user_id', 'x.name as user_name', 'h.effective_from', 'h.effective_to', 'h.reason', 't.name as team_name', 'c.name as changed_by_name'),
  ]);
  res.json({ ...d, teams, members, history });
});

/** Assign (transfer) several employees to this department at once. */
router.post('/departments/:id/members', requirePerm('org.manage', 'users.manage'), async (req, res) => {
  const id = idParam(req);
  const dept = await db('departments').where({ id }).whereNull('deleted_at').first();
  if (!dept) throw notFound();
  if (!dept.is_active) throw badRequest('This department is inactive');
  const { user_ids, reason } = parse(z.object({ user_ids: z.array(zId).min(1).max(500), reason: z.string().trim().max(500).optional() }), req.body);
  await assertActiveUsers(user_ids, 'a department assignment');
  const moved = await moveToDepartment(user_ids, id, me(req).id, reason || `Assigned to ${dept.name}`);
  for (const uid of moved) await audit(req, { action: 'user.department_transferred', entityType: 'user', entityId: uid, summary: `→ ${dept.name}${reason ? `: ${reason}` : ''}`, after: { department_id: id } });
  res.json({ moved: moved.length });
});

// ===================================================================== designations
// ===================================================================== companies (business entities)
router.get('/companies', async (req, res) => {
  const all = req.query.all === 'true';
  const q = db('companies as c').whereNull('c.deleted_at').orderBy('c.name').select('c.*',
    db.raw('(SELECT count(*) FROM users u WHERE u.company_id = c.id AND u.is_active AND u.deleted_at IS NULL)::int AS employees'));
  if (!all) q.where('c.is_active', true);
  res.json(await q);
});
const companySchema = z.object({ name: z.string().trim().min(2).max(120), code: z.string().trim().min(1).max(30), description: zOptStr, is_active: z.boolean().optional() });
async function assertCompanyUnique(b: { name?: string; code?: string }, exceptId?: number) {
  if (!b.name && !b.code) return;
  const q = db('companies').whereNull('deleted_at').where((w) => {
    if (b.name) w.orWhereRaw('lower(name) = lower(?)', [b.name]);
    if (b.code) w.orWhereRaw('lower(code) = lower(?)', [b.code]);
  });
  if (exceptId) q.whereNot('id', exceptId);
  if (await q.first('id')) throw conflict('A company with this name or code already exists');
}
router.post('/companies', requirePerm('org.manage'), async (req, res) => {
  const b = parse(companySchema, req.body);
  await assertCompanyUnique(b);
  const [row] = await db('companies').insert({ ...b, code: b.code.toUpperCase() }).returning('*');
  await audit(req, { action: 'company.created', entityType: 'company', entityId: row.id, summary: row.name, after: b });
  res.status(201).json(row);
});
router.patch('/companies/:id', requirePerm('org.manage'), async (req, res) => {
  const id = idParam(req);
  const b = parse(patchOf(companySchema), req.body);
  const before = await db('companies').where({ id }).whereNull('deleted_at').first();
  if (!before) throw notFound();
  await assertCompanyUnique(b, id);
  const [row] = await db('companies').where({ id }).update({ ...b, ...(b.code ? { code: b.code.toUpperCase() } : {}), updated_at: db.fn.now() }).returning('*');
  const d = diff(before, b);
  await audit(req, { action: b.is_active === false ? 'company.deactivated' : 'company.updated', entityType: 'company', entityId: id, summary: row.name, before: d.before, after: d.after });
  res.json(row);
});

// ===================================================================== team structure setup (idempotent, previewable)
router.get('/setup/team-structure/starter', requirePerm('users.manage'), async (_req, res) => {
  res.json(loadStarterStructure());
});
router.post('/setup/team-structure', requirePerm('users.manage'), async (req, res) => {
  const u = me(req);
  if (!can(u, 'org.manage')) throw forbidden('Team setup needs both employee and organization management permissions');
  const body = parse(z.object({ structure: structureSchema.optional(), options: optionsSchema.default({ dry_run: true, apply_templates: true }) }), req.body);
  const structure = body.structure ?? loadStarterStructure();
  const result = await runTeamSetup(u, structure, body.options);
  if (!body.options.dry_run) {
    await requestChecklistSync();
    invalidateUserCache();
    await audit(req, { action: 'org.team_structure_applied', entityType: 'organization', summary: Object.entries(result.summary).map(([k, v]) => `${k}: ${v}`).join(', '), after: { summary: result.summary, plan: result.plan } });
  }
  res.json(result);
});

router.get('/designations', requirePerm('org.view', 'users.view'), async (_req, res) => {
  res.json(await db('designations as g').leftJoin('departments as d', 'd.id', 'g.department_id')
    .select('g.*', 'd.name as department_name').orderBy(['g.level', 'g.title']));
});
const desigSchema = z.object({ title: z.string().trim().min(2).max(120), level: z.number().int().min(1).max(20).default(1), department_id: zOptId, is_active: z.boolean().optional() });
router.post('/designations', requirePerm('org.manage'), async (req, res) => {
  const [row] = await db('designations').insert(parse(desigSchema, req.body)).returning('*');
  await audit(req, { action: 'designation.created', entityType: 'designation', entityId: row.id, summary: row.title });
  res.status(201).json(row);
});
router.patch('/designations/:id', requirePerm('org.manage'), async (req, res) => {
  const [row] = await db('designations').where({ id: idParam(req) }).update(parse(patchOf(desigSchema), req.body)).returning('*');
  if (!row) throw notFound();
  res.json(row);
});

// ===================================================================== teams
router.get('/teams', requirePerm('org.view', 'users.view'), async (req, res) => {
  const { department_id } = parse(z.object({ department_id: zId.optional() }), req.query);
  const q = db('teams as t').join('departments as d', 'd.id', 't.department_id').leftJoin('users as l', 'l.id', 't.leader_id')
    .where('t.is_active', true)
    .select('t.*', 'd.name as department_name', 'l.name as leader_name',
      db.raw('(SELECT count(*) FROM users u WHERE u.team_id = t.id AND u.deleted_at IS NULL AND u.is_active)::int AS member_count'))
    .orderBy(['d.name', 't.name']);
  if (department_id) q.where('t.department_id', department_id);
  const u = me(req);
  if (u.scope === 'department' && u.departmentId) q.where('t.department_id', u.departmentId);
  if (u.scope === 'team') q.where('t.id', u.teamId ?? 0);
  res.json(await q);
});
const teamSchema = z.object({ name: z.string().trim().min(2).max(120), department_id: zId, leader_id: zOptId, description: zOptStr, is_active: z.boolean().optional() });

async function assertDeptManager(req: any, deptId: number) {
  const u = me(req);
  if (can(u, 'org.manage')) return;
  // HODs may manage teams inside their own department
  const d = await db('departments').where({ id: deptId }).first('hod_id');
  if (!(d && d.hod_id === u.id)) throw forbidden();
}

router.post('/teams', async (req, res) => {
  const body = parse(teamSchema, req.body);
  await assertDeptManager(req, body.department_id);
  await assertActiveUsers([body.leader_id], 'a team-leader role');
  const [row] = await db('teams').insert(body).returning('*');
  if (body.leader_id) {
    await db('users').where({ id: body.leader_id }).update({ team_id: row.id, department_id: row.department_id });
    await recordDepartmentChange(body.leader_id, row.department_id, row.id, me(req).id, `Appointed leader of team ${row.name}`);
    invalidateUserCache(body.leader_id);
  }
  await audit(req, { action: 'team.created', entityType: 'team', entityId: row.id, summary: row.name });
  res.status(201).json(row);
});
router.patch('/teams/:id', async (req, res) => {
  const id = idParam(req);
  const before = await db('teams').where({ id }).first();
  if (!before) throw notFound();
  await assertDeptManager(req, before.department_id);
  const body = parse(patchOf(teamSchema), req.body);
  if (body.leader_id && body.leader_id !== before.leader_id) await assertActiveUsers([body.leader_id], 'a team-leader role');
  const [row] = await db('teams').where({ id }).update({ ...body, updated_at: db.fn.now() }).returning('*');
  if (body.leader_id && body.leader_id !== before.leader_id) {
    await db('users').where({ id: body.leader_id }).update({ team_id: id, department_id: row.department_id });
    await recordDepartmentChange(body.leader_id, row.department_id, id, me(req).id, `Appointed leader of team ${row.name}`);
    invalidateUserCache(body.leader_id);
  }
  const d = diff(before, body);
  await audit(req, { action: 'team.updated', entityType: 'team', entityId: id, before: d.before, after: d.after });
  res.json(row);
});
router.post('/teams/:id/members', async (req, res) => {
  const id = idParam(req);
  const team = await db('teams').where({ id }).first();
  if (!team) throw notFound();
  await assertDeptManager(req, team.department_id);
  const { user_ids } = parse(z.object({ user_ids: z.array(zId).min(1) }), req.body);
  await assertActiveUsers(user_ids, 'a team assignment');
  await db('users').whereIn('id', user_ids).update({ team_id: id, department_id: team.department_id, updated_at: db.fn.now() });
  for (const uid of user_ids) { await recordDepartmentChange(uid, team.department_id, id, me(req).id, `Added to team ${team.name}`); invalidateUserCache(uid); }
  await requestChecklistSync();
  await audit(req, { action: 'team.members_added', entityType: 'team', entityId: id, after: { user_ids } });
  res.json({ ok: true });
});
router.delete('/teams/:id/members/:userId', async (req, res) => {
  const id = idParam(req);
  const team = await db('teams').where({ id }).first();
  if (!team) throw notFound();
  await assertDeptManager(req, team.department_id);
  const removed = await db('users').where({ id: idParam(req, 'userId'), team_id: id }).update({ team_id: null });
  if (removed) await recordDepartmentChange(idParam(req, 'userId'), team.department_id, null, me(req).id, `Removed from team ${team.name}`);
  await audit(req, { action: 'team.member_removed', entityType: 'team', entityId: id, after: { user_id: idParam(req, 'userId') } });
  res.json({ ok: true });
});

// ===================================================================== skills
router.get('/skills', async (_req, res) => {
  res.json(await db('skills as s').select('s.*', db.raw('(SELECT count(*) FROM user_skills us WHERE us.skill_id = s.id)::int AS people')).orderBy('name'));
});
router.post('/skills', requirePerm('users.manage', 'org.manage'), async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
  const [row] = await db('skills').insert({ name }).onConflict(['organization_id', 'name']).merge().returning('*');
  res.status(201).json(row);
});

// ===================================================================== directory (minimal, for pickers & mentions)
router.get('/directory', async (req, res) => {
  const { q, department_id } = parse(z.object({ q: z.string().max(100).optional(), department_id: zId.optional() }), req.query);
  const qb = db('users as u').leftJoin('departments as d', 'd.id', 'u.department_id').leftJoin('designations as g', 'g.id', 'u.designation_id')
    .join('roles as r', 'r.id', 'u.role_id').leftJoin('companies as co', 'co.id', 'u.company_id')
    .whereNull('u.deleted_at').where('u.is_active', true)
    .select('u.id', 'u.name', 'u.employee_code', 'u.department_id', 'd.name as department_name', 'g.title as designation', 'r.key as role', 'u.team_id', 'u.avatar_url',
      'u.company_id', 'co.name as company_name')
    .orderBy('u.name').limit(1000);
  if (q) qb.where((w) => w.whereILike('u.name', `%${q}%`).orWhereILike('u.employee_code', `%${q}%`));
  if (department_id) qb.where('u.department_id', department_id);
  res.json(await qb);
});

// ===================================================================== users
const userListQ = z.object({
  ...zPage,
  q: z.string().max(100).optional(),
  department_id: zId.optional(),
  team_id: zId.optional(),
  company_id: zId.optional(),
  role: z.string().optional(),
  status: z.enum(['active', 'on_leave', 'notice', 'exited']).optional(),
  active: zBoolQ,
  sort: z.string().optional(),
});

router.get('/users', requirePerm('users.view'), async (req, res) => {
  const f = parse(userListQ, req.query);
  const q = scopeUsers(db('users as u'), me(req))
    .join('roles as r', 'r.id', 'u.role_id').leftJoin('departments as d', 'd.id', 'u.department_id')
    .leftJoin('teams as t', 't.id', 'u.team_id').leftJoin('designations as g', 'g.id', 'u.designation_id')
    .leftJoin('users as m', 'm.id', 'u.manager_id').leftJoin('companies as co', 'co.id', 'u.company_id')
    .whereNull('u.deleted_at')
    .select('u.id', 'u.employee_code', 'u.name', 'u.email', 'u.phone', 'u.department_id', 'd.name as department_name', 'u.team_id', 'u.company_id', 'co.name as company_name',
      db.raw(`coalesce((SELECT array_agg(g2.title ORDER BY ud.created_at, g2.id) FROM user_designations ud JOIN designations g2 ON g2.id = ud.designation_id WHERE ud.user_id = u.id), '{}') AS additional_designations`),
      't.name as team_name', 'u.designation_id', 'g.title as designation', 'u.manager_id', 'm.name as manager_name', 'r.key as role', 'r.name as role_name',
      'u.employment_status', 'u.joining_date', 'u.exit_date', 'u.is_active', 'u.timezone', 'u.capacity_hours_per_week', 'u.last_login_at',
      db.raw(`(SELECT count(*) FROM task_assignees ta JOIN tasks tk ON tk.id = ta.task_id WHERE ta.user_id = u.id AND tk.deleted_at IS NULL
               AND tk.status NOT IN ('completed','cancelled') AND NOT tk.is_recurring_template)::int AS open_tasks`));
  if (f.q) q.where((w) => w.whereILike('u.name', `%${f.q}%`).orWhereILike('u.email', `%${f.q}%`).orWhereILike('u.employee_code', `%${f.q}%`));
  if (f.department_id) q.where('u.department_id', f.department_id);
  if (f.team_id) q.where('u.team_id', f.team_id);
  if (f.company_id) q.where('u.company_id', f.company_id);
  if (f.role) q.where('r.key', f.role);
  if (f.status) q.where('u.employment_status', f.status);
  if (f.active !== undefined) q.where('u.is_active', f.active);
  applySort(q, f.sort, { name: 'u.name', code: 'u.employee_code', department: 'd.name', joined: 'u.joining_date', role: 'r.rank' }, 'name:asc');
  res.json(await paginate(q, f.page, f.pageSize));
});

router.get('/users/:id', requirePerm('users.view'), async (req, res) => {
  const id = idParam(req);
  await assertCanSeeUser(me(req), id);
  const u = await db('users as u').join('roles as r', 'r.id', 'u.role_id').leftJoin('departments as d', 'd.id', 'u.department_id')
    .leftJoin('teams as t', 't.id', 'u.team_id').leftJoin('designations as g', 'g.id', 'u.designation_id')
    .leftJoin('users as m', 'm.id', 'u.manager_id').leftJoin('companies as co', 'co.id', 'u.company_id').where('u.id', id)
    .first('u.id', 'u.employee_code', 'u.name', 'u.email', 'u.phone', 'u.department_id', 'd.name as department_name', 'u.team_id', 't.name as team_name',
      'u.company_id', 'co.name as company_name',
      'u.designation_id', 'g.title as designation', 'u.manager_id', 'm.name as manager_name', 'r.key as role', 'r.name as role_name', 'u.role_id',
      'u.employment_status', 'u.joining_date', 'u.exit_date', 'u.is_active', 'u.timezone', 'u.capacity_hours_per_week', 'u.created_at', 'u.last_login_at');
  const [skills, history, reports, projects, departmentHistory, statusHistory] = await Promise.all([
    db('user_skills as us').join('skills as s', 's.id', 'us.skill_id').where('us.user_id', id).select('s.id', 's.name', 'us.level'),
    db('reporting_hierarchy as h').leftJoin('users as m', 'm.id', 'h.manager_id').leftJoin('users as c', 'c.id', 'h.changed_by')
      .where('h.user_id', id).orderBy('h.effective_from', 'desc').select('h.*', 'm.name as manager_name', 'c.name as changed_by_name'),
    db('users').where({ manager_id: id }).whereNull('deleted_at').select('id', 'name', 'employee_code'),
    db('project_members as pm').join('projects as p', 'p.id', 'pm.project_id').where('pm.user_id', id).whereNull('p.deleted_at')
      .select('p.id', 'p.code', 'p.name', 'p.status', 'pm.role_in_project', 'pm.allocation_percent'),
    db('department_history as h').leftJoin('departments as d', 'd.id', 'h.department_id').leftJoin('teams as t', 't.id', 'h.team_id').leftJoin('users as c', 'c.id', 'h.changed_by')
      .where('h.user_id', id).orderBy('h.effective_from', 'desc').select('h.*', 'd.name as department_name', 't.name as team_name', 'c.name as changed_by_name'),
    db('employee_status_history as h').leftJoin('users as c', 'c.id', 'h.changed_by').where('h.user_id', id).orderBy('h.changed_at', 'desc').select('h.*', 'c.name as changed_by_name'),
  ]);
  const extraDesignations = await db('user_designations as ud').join('designations as g', 'g.id', 'ud.designation_id').where('ud.user_id', id).orderBy(['ud.created_at', 'g.id']).select('g.id', 'g.title');
  res.json({ ...u, additional_designations: extraDesignations, additional_designation_ids: extraDesignations.map((g: any) => g.id), skills, reporting_history: history, direct_reports: reports, projects, department_history: departmentHistory, status_history: statusHistory });
});

const userSchema = z.object({
  employee_code: z.string().trim().min(1).max(30),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(30).nullable().optional(),
  role_id: zId,
  department_id: zOptId,
  designation_id: zOptId,
  additional_designation_ids: z.array(zId).max(10).optional(),
  company_id: zOptId,
  team_id: zOptId,
  manager_id: zOptId,
  timezone: z.string().max(64).optional(),
  employment_status: z.enum(['active', 'on_leave', 'notice', 'exited']).optional(),
  joining_date: zDate.nullable().optional(),
  exit_date: zDate.nullable().optional(),
  capacity_hours_per_week: z.number().min(0).max(80).optional(),
  is_active: z.boolean().optional(),
});

async function writeAdditionalDesignations(userId: number, ids: number[] | undefined, primary: number | null | undefined) {
  if (ids === undefined) return;
  const want = [...new Set(ids)].filter((x) => x !== primary);
  if (want.length && (await db('designations').whereIn('id', want).pluck('id')).length !== want.length) throw badRequest('Unknown designation');
  await db('user_designations').where({ user_id: userId }).whereNotIn('designation_id', want.length ? want : [0]).del();
  if (want.length) await db('user_designations').insert(want.map((designation_id) => ({ user_id: userId, designation_id }))).onConflict(['user_id', 'designation_id']).ignore();
}
async function assertCompany(id: number | null | undefined) {
  if (id && !(await db('companies').where({ id, is_active: true }).whereNull('deleted_at').first('id'))) throw badRequest('Unknown or inactive company');
}

async function guardRoleAssignment(req: any, roleId: number) {
  const role = await db('roles').where({ id: roleId }).first();
  if (!role) throw badRequest('Unknown role');
  if (role.rank >= me(req).rank && me(req).roleKey !== 'super_admin') throw forbidden('Cannot assign a role equal to or above your own');
}

async function recordManagerChange(userId: number, managerId: number | null, actorId: number) {
  await db('reporting_hierarchy').where({ user_id: userId }).whereNull('effective_to').update({ effective_to: db.fn.now() });
  await db('reporting_hierarchy').insert({ user_id: userId, manager_id: managerId, changed_by: actorId });
}

router.post('/users', requirePerm('users.manage'), async (req, res) => {
  const body = parse(userSchema.extend({ password: passwordSchema.optional() }), req.body);
  await guardRoleAssignment(req, body.role_id);
  if (body.timezone && !isValidTimezone(body.timezone)) throw badRequest('Unknown timezone');
  if (await db('users').where({ email: body.email }).orWhere({ employee_code: body.employee_code }).first()) throw conflict('Email or employee code already in use');
  // If no password given, generate a temporary one the admin hands over; user must change it on first login.
  await assertCompany(body.company_id);
  const tempPassword = body.password ?? `Tmp-${crypto.randomBytes(5).toString('hex')}1`;
  const { password: _p, additional_designation_ids: extraDesig, ...rest } = body;
  const [row] = await db('users').insert({
    ...rest, timezone: body.timezone ?? 'Asia/Kolkata', password_hash: await bcrypt.hash(tempPassword, 12), must_change_password: !body.password,
  }).returning(['id', 'name', 'email', 'employee_code']);
  await db('user_notification_preferences').insert({ user_id: row.id }).onConflict('user_id').ignore();
  await writeAdditionalDesignations(row.id, extraDesig, body.designation_id);
  if (body.manager_id) await recordManagerChange(row.id, body.manager_id, me(req).id);
  await recordDepartmentChange(row.id, body.department_id ?? null, body.team_id ?? null, me(req).id, 'Joined');
  await recordStatusChange(row.id, body.is_active ?? true, body.employment_status ?? 'active', me(req).id, 'Employee created');
  await requestChecklistSync();
  await audit(req, { action: 'user.created', entityType: 'user', entityId: row.id, summary: `${row.name} <${row.email}>`, after: rest });
  res.status(201).json({ ...row, temporaryPassword: body.password ? undefined : tempPassword });
});

router.patch('/users/:id', requirePerm('users.manage'), async (req, res) => {
  const id = idParam(req);
  const body = parse(patchOf(userSchema), req.body);
  const before = await db('users').where({ id }).whereNull('deleted_at').first();
  if (!before) throw notFound();
  const target = await db('roles').where({ id: before.role_id }).first('rank');
  if (target.rank >= me(req).rank && me(req).roleKey !== 'super_admin' && id !== me(req).id) throw forbidden('Cannot edit a user at or above your level');
  if (body.role_id && body.role_id !== before.role_id) await guardRoleAssignment(req, body.role_id);
  if (body.timezone && !isValidTimezone(body.timezone)) throw badRequest('Unknown timezone');
  if (body.manager_id === id) throw badRequest('A user cannot report to themselves');
  if (body.company_id !== undefined && body.company_id !== before.company_id) await assertCompany(body.company_id);
  const extraDesig = body.additional_designation_ids;
  delete body.additional_designation_ids;
  if (body.employment_status === 'exited' && !body.exit_date && !before.exit_date) body.exit_date = new Date().toISOString().slice(0, 10);
  const patch: any = { ...body, updated_at: db.fn.now() };
  if (body.employment_status === 'exited') patch.is_active = false;
  if (patch.is_active === true && !before.is_active && body.employment_status === undefined && before.employment_status === 'exited') patch.employment_status = 'active';
  await db('users').where({ id }).update(patch);
  await writeAdditionalDesignations(id, extraDesig, body.designation_id !== undefined ? body.designation_id : before.designation_id);
  if (body.manager_id !== undefined && body.manager_id !== before.manager_id) await recordManagerChange(id, body.manager_id ?? null, me(req).id);
  const newDept = body.department_id !== undefined ? body.department_id ?? null : before.department_id;
  const newTeam = body.team_id !== undefined ? body.team_id ?? null : before.team_id;
  const transferred = (newDept !== before.department_id || newTeam !== before.team_id)
    && await recordDepartmentChange(id, newDept, newTeam, me(req).id, 'Changed in employee profile');
  const newActive = patch.is_active ?? before.is_active;
  const newStatus = patch.employment_status ?? before.employment_status;
  const statusChanged = newActive !== before.is_active || newStatus !== before.employment_status;
  if (statusChanged) await recordStatusChange(id, newActive, newStatus, me(req).id, 'Changed in employee profile');
  if (newActive === false && before.is_active) { await revokeAllForUser(id); await dropUntouchedChecklists(id); }
  invalidateUserCache(id);
  if (transferred || statusChanged) await requestChecklistSync();
  const d = diff(before, body);
  if (extraDesig !== undefined) { d.after.additional_designation_ids = extraDesig; d.changed.push('additional_designation_ids'); }
  const action = newActive !== before.is_active ? (newActive ? 'user.activated' : 'user.deactivated')
    : d.changed.includes('role_id') ? 'user.role_changed' : transferred ? 'user.department_transferred' : 'user.updated';
  await audit(req, { action, entityType: 'user', entityId: id, before: d.before, after: d.after });
  res.json({ ok: true });
});

/** Deactivate: no new assignments, questions or notifications; every historical record is kept. */
router.post('/users/:id/deactivate', requirePerm('users.manage'), async (req, res) => {
  const id = idParam(req);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(1000) }), req.body);
  if (id === me(req).id) throw badRequest('You cannot deactivate your own account');
  const before = await db('users').where({ id }).whereNull('deleted_at').first();
  if (!before) throw notFound();
  const target = await db('roles').where({ id: before.role_id }).first('rank');
  if (target.rank >= me(req).rank && me(req).roleKey !== 'super_admin') throw forbidden('Cannot deactivate a user at or above your level');
  if (!before.is_active) throw badRequest('This employee is already deactivated');
  await db('users').where({ id }).update({ is_active: false, updated_at: db.fn.now() });
  await recordStatusChange(id, false, before.employment_status, me(req).id, reason);
  await revokeAllForUser(id);
  await dropUntouchedChecklists(id);
  invalidateUserCache(id);
  await requestChecklistSync();
  await audit(req, { action: 'user.deactivated', entityType: 'user', entityId: id, summary: `${before.name}: ${reason}`, before: { is_active: true }, after: { is_active: false, reason } });
  res.json({ ok: true });
});

router.post('/users/:id/activate', requirePerm('users.manage'), async (req, res) => {
  const id = idParam(req);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(1000) }), req.body);
  const before = await db('users').where({ id }).whereNull('deleted_at').first();
  if (!before) throw notFound();
  if (before.is_active) throw badRequest('This employee is already active');
  const status = before.employment_status === 'exited' ? 'active' : before.employment_status;
  await db('users').where({ id }).update({ is_active: true, employment_status: status, exit_date: before.employment_status === 'exited' ? null : before.exit_date, failed_logins: 0, locked_until: null, updated_at: db.fn.now() });
  await recordStatusChange(id, true, status, me(req).id, reason);
  invalidateUserCache(id);
  await requestChecklistSync();
  await audit(req, { action: 'user.activated', entityType: 'user', entityId: id, summary: `${before.name}: ${reason}`, before: { is_active: false, employment_status: before.employment_status }, after: { is_active: true, employment_status: status, reason } });
  res.json({ ok: true });
});

/** Department transfer with reason; history keeps the previous department and team. */
router.post('/users/:id/transfer', requirePerm('users.manage'), async (req, res) => {
  const id = idParam(req);
  const b = parse(z.object({ department_id: zId, team_id: zOptId, manager_id: zOptId, reason: z.string().trim().min(3).max(1000) }), req.body);
  const before = await db('users').where({ id }).whereNull('deleted_at').first();
  if (!before) throw notFound();
  if (!before.is_active) throw badRequest('Deactivated employees cannot be transferred; reactivate them first');
  const dept = await db('departments').where({ id: b.department_id }).where('is_active', true).whereNull('deleted_at').first();
  if (!dept) throw badRequest('Unknown or inactive department');
  if (b.team_id) {
    const t = await db('teams').where({ id: b.team_id }).first('department_id');
    if (t?.department_id !== b.department_id) throw badRequest('The team must belong to the target department');
  }
  if (b.manager_id === id) throw badRequest('A user cannot report to themselves');
  if (b.manager_id) await assertActiveUsers([b.manager_id], 'direct reports');
  if (before.department_id === b.department_id && (b.team_id ?? null) === before.team_id) throw badRequest('The employee is already in this department and team');
  await db('users').where({ id }).update({ department_id: b.department_id, team_id: b.team_id ?? null, ...(b.manager_id !== undefined ? { manager_id: b.manager_id } : {}), updated_at: db.fn.now() });
  await recordDepartmentChange(id, b.department_id, b.team_id ?? null, me(req).id, b.reason);
  if (b.manager_id !== undefined && b.manager_id !== before.manager_id) await recordManagerChange(id, b.manager_id ?? null, me(req).id);
  invalidateUserCache(id);
  await requestChecklistSync();
  const from = before.department_id ? (await db('departments').where({ id: before.department_id }).first('name'))?.name : 'no department';
  await audit(req, { action: 'user.department_transferred', entityType: 'user', entityId: id, summary: `${before.name}: ${from} → ${dept.name} (${b.reason})`,
    before: { department_id: before.department_id, team_id: before.team_id }, after: { department_id: b.department_id, team_id: b.team_id ?? null } });
  res.json({ ok: true });
});

router.post('/users/:id/reset-password', requirePerm('users.manage'), async (req, res) => {
  const id = idParam(req);
  const tempPassword = `Tmp-${crypto.randomBytes(5).toString('hex')}1`;
  await db('users').where({ id }).update({ password_hash: await bcrypt.hash(tempPassword, 12), must_change_password: true, failed_logins: 0, locked_until: null });
  await revokeAllForUser(id);
  await audit(req, { action: 'user.password_reset', entityType: 'user', entityId: id });
  res.json({ temporaryPassword: tempPassword });
});

router.put('/users/:id/skills', async (req, res) => {
  const id = idParam(req);
  if (!(can(me(req), 'users.manage') || id === me(req).id)) throw forbidden();
  const { skills } = parse(z.object({ skills: z.array(z.object({ skill_id: zId, level: z.number().int().min(1).max(5) })) }), req.body);
  await db.transaction(async (trx) => {
    await trx('user_skills').where({ user_id: id }).del();
    if (skills.length) await trx('user_skills').insert(skills.map((s) => ({ user_id: id, ...s })));
  });
  await audit(req, { action: 'user.skills_updated', entityType: 'user', entityId: id, after: skills });
  res.json({ ok: true });
});

router.delete('/users/:id', requirePerm('users.manage'), async (req, res) => {
  const id = idParam(req);
  if (id === me(req).id) throw badRequest('You cannot delete your own account');
  await db('users').where({ id }).update({ deleted_at: db.fn.now(), is_active: false });
  await revokeAllForUser(id);
  invalidateUserCache(id);
  await audit(req, { action: 'user.deleted', entityType: 'user', entityId: id });
  res.json({ ok: true });
});

// Org chart: hierarchy tree data
router.get('/org-chart', requirePerm('org.view'), async (req, res) => {
  const rows = await scopeUsers(db('users as u'), me(req)).join('roles as r', 'r.id', 'u.role_id')
    .leftJoin('designations as g', 'g.id', 'u.designation_id').leftJoin('departments as d', 'd.id', 'u.department_id')
    .whereNull('u.deleted_at').where('u.is_active', true)
    .select('u.id', 'u.name', 'u.manager_id', 'r.name as role_name', 'g.title as designation', 'd.name as department_name');
  res.json(rows);
});

// ===================================================================== roles & permissions
router.get('/roles', async (_req, res) => {
  const roles = await db('roles').orderBy('rank', 'desc');
  const rp = await db('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id').select('rp.role_id', 'p.key');
  res.json(roles.map((r) => ({ ...r, permissions: rp.filter((x) => x.role_id === r.id).map((x) => x.key) })));
});
router.get('/permissions', requirePerm('roles.manage'), async (_req, res) => {
  res.json(await db('permissions').orderBy(['module', 'key']));
});
router.put('/roles/:id/permissions', requirePerm('roles.manage'), async (req, res) => {
  const id = idParam(req);
  const role = await db('roles').where({ id }).first();
  if (!role) throw notFound();
  if (role.key === 'super_admin') throw badRequest('Super Admin always has every permission');
  const { permissions } = parse(z.object({ permissions: z.array(z.string()) }), req.body);
  const before = await db('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id').where('rp.role_id', id).pluck('p.key');
  const ids = await db('permissions').whereIn('key', permissions).pluck('id');
  await db.transaction(async (trx) => {
    await trx('role_permissions').where({ role_id: id }).del();
    if (ids.length) await trx('role_permissions').insert(ids.map((pid: number) => ({ role_id: id, permission_id: pid })));
  });
  invalidateUserCache();
  await audit(req, { action: 'role.permissions_changed', entityType: 'role', entityId: id, before, after: permissions, summary: role.name });
  res.json({ ok: true });
});
