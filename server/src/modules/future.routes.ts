import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/knex';
import { can, me, requirePerm } from '../auth/middleware';
import { assertCanManageProject, loadVisibleProject, scopeProjects } from '../auth/scope';
import { audit, diff } from '../lib/audit';
import { badRequest, forbidden } from '../lib/errors';
import { idParam, parse, zDate } from '../lib/http';
import { emitEvent } from '../notifications/events';

export const router = Router();

const CHECKS = ['chk_requirements', 'chk_budget_approved', 'chk_resources_identified', 'chk_team_allocated', 'chk_technology_selected',
  'chk_dependencies_resolved', 'chk_documentation', 'chk_management_approval'] as const;

function futureQuery(req: any) {
  return scopeProjects(db('projects as p'), me(req)).whereNull('p.deleted_at').where('p.is_future', true)
    .join('future_projects as fp', 'fp.project_id', 'p.id')
    .leftJoin('users as m', 'm.id', 'p.manager_id').leftJoin('departments as d', 'd.id', 'p.department_id').leftJoin('users as h', 'h.id', 'p.hod_id')
    .select('p.id', 'p.code', 'p.name', 'p.description', 'p.business_objective', 'p.status', 'p.priority', 'p.estimated_budget',
      'p.manager_id', 'm.name as manager_name', 'p.department_id', 'd.name as department_name', 'p.hod_id', 'h.name as hod_name', 'fp.*');
}

/** Future project list + summary (upcoming dashboard). */
router.get('/', requirePerm('projects.view'), async (req, res) => {
  const { horizon, approval_status } = parse(z.object({ horizon: z.string().optional(), approval_status: z.string().optional() }), req.query);
  const q = futureQuery(req).orderBy('fp.expected_start_date');
  if (horizon) q.where('fp.planning_horizon', horizon);
  if (approval_status) q.where('fp.approval_status', approval_status);
  const items = await q;
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  res.json({
    items,
    summary: {
      total: items.length,
      starting_30_days: items.filter((i: any) => i.expected_start_date >= today && i.expected_start_date <= in30).length,
      ready: items.filter((i: any) => i.readiness_percent === 100).length,
      approved: items.filter((i: any) => i.approval_status === 'approved').length,
      avg_readiness: items.length ? Math.round(items.reduce((s: number, i: any) => s + i.readiness_percent, 0) / items.length) : 0,
      total_budget: items.reduce((s: number, i: any) => s + Number(i.estimated_budget ?? 0), 0),
    },
  });
});

/** Pipeline grouped by approval status. */
router.get('/pipeline', requirePerm('projects.view'), async (req, res) => {
  const items = await futureQuery(req).orderBy('fp.expected_start_date');
  const stages = ['draft', 'pending', 'approved', 'rejected'];
  res.json(stages.map((s) => ({ stage: s, items: items.filter((i: any) => i.approval_status === s) })));
});

/** Quarterly roadmap: future + active projects bucketed by start quarter. */
router.get('/roadmap', requirePerm('projects.view'), async (req, res) => {
  const { year } = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()) }), req.query);
  const rows = await scopeProjects(db('projects as p'), me(req)).whereNull('p.deleted_at').whereNotIn('p.status', ['cancelled'])
    .leftJoin('future_projects as fp', 'fp.project_id', 'p.id')
    .select('p.id', 'p.code', 'p.name', 'p.status', 'p.is_future', 'p.priority', 'p.progress',
      db.raw('coalesce(p.start_date, fp.expected_start_date) AS start'), db.raw('coalesce(p.end_date, fp.expected_end_date) AS "end"'), 'fp.readiness_percent')
    .whereRaw('extract(year from coalesce(p.start_date, fp.expected_start_date)) <= ?', [year])
    .whereRaw('coalesce(extract(year from coalesce(p.end_date, fp.expected_end_date)), extract(year from coalesce(p.start_date, fp.expected_start_date))) >= ?', [year]);
  const quarters = [1, 2, 3, 4].map((qn) => {
    const qs = `${year}-${String((qn - 1) * 3 + 1).padStart(2, '0')}-01`;
    const qe = new Date(Date.UTC(year, qn * 3, 0)).toISOString().slice(0, 10);
    return { quarter: `Q${qn} ${year}`, start: qs, end: qe, items: rows.filter((r: any) => r.start && r.start <= qe && (r.end ?? r.start) >= qs) };
  });
  res.json({ year, quarters });
});

/** Resource requirement forecast: required skills/headcount of upcoming projects vs current supply. */
router.get('/forecast', requirePerm('projects.view', 'resources.view'), async (req, res) => {
  const { months } = parse(z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }), req.query);
  const until = new Date(Date.now() + months * 30 * 86400_000).toISOString().slice(0, 10);
  const items = await futureQuery(req).where('fp.expected_start_date', '<=', until);
  const demand = new Map<string, { skill: string; projects: string[]; required: number }>();
  for (const i of items) for (const s of i.required_skills ?? []) {
    const k = s.toLowerCase();
    const d = demand.get(k) ?? { skill: s, projects: [] as string[], required: 0 };
    d.projects.push(i.name); d.required += 1; demand.set(k, d);
  }
  const supply = await db('user_skills as us').join('skills as s', 's.id', 'us.skill_id').join('users as u', 'u.id', 'us.user_id')
    .where('u.is_active', true).whereNull('u.deleted_at').where('us.level', '>=', 3).groupBy('s.name').select('s.name', db.raw('count(*)::int AS people'));
  const supplyMap = new Map(supply.map((s: any) => [String(s.name).toLowerCase(), s.people]));
  const byMonth: Record<string, number> = {};
  for (const i of items) { const m = String(i.expected_start_date).slice(0, 7); byMonth[m] = (byMonth[m] ?? 0) + Number(i.required_employees); }
  res.json({
    months, projects: items.length,
    headcount_required: items.reduce((s: number, i: any) => s + Number(i.required_employees), 0),
    headcount_by_month: Object.entries(byMonth).sort().map(([month, required]) => ({ month, required })),
    skills: [...demand.values()].map((d) => ({ ...d, available: supplyMap.get(d.skill.toLowerCase()) ?? 0, gap: Math.max(0, d.required - (supplyMap.get(d.skill.toLowerCase()) ?? 0)) }))
      .sort((a, b) => b.gap - a.gap),
  });
});

/** Update planning details / readiness checklist. */
router.patch('/:id', async (req, res) => {
  const u = me(req);
  const p = await loadVisibleProject(u, idParam(req));
  if (!p.is_future) throw badRequest('Not a future project');
  assertCanManageProject(u, p);
  const body = parse(z.object({
    expected_start_date: zDate.optional(), expected_end_date: zDate.nullable().optional(),
    planning_horizon: z.enum(['next_week', 'next_month', 'next_quarter', 'six_months', 'next_year', 'custom']).optional(),
    required_employees: z.number().int().min(0).optional(), required_skills: z.array(z.string().max(80)).optional(),
    expected_deliverables: z.string().max(20000).nullable().optional(),
    approval_status: z.enum(['draft', 'pending', 'approved', 'rejected']).optional(),
    ...Object.fromEntries(CHECKS.map((c) => [c, z.boolean().optional()])),
  }), req.body);
  const before = await db('future_projects').where({ project_id: p.id }).first();
  if (body.approval_status && ['approved', 'rejected'].includes(body.approval_status) && !can(u, 'approvals.decide')) throw forbidden('Only approvers can approve or reject future projects');
  if ((body as any).chk_management_approval && !before.chk_management_approval && !can(u, 'approvals.decide')) throw forbidden('Only management can tick "Management approval received"');
  if (body.approval_status === 'pending' && before.approval_status !== 'pending') {
    await db('approval_requests').insert({ approval_type: 'project_approval', project_id: p.id, title: `Approve future project ${p.code} ${p.name}`, requested_by: u.id, payload: JSON.stringify({ approval_status: 'approved' }) });
    await emitEvent({ type: 'approval.requested', actorId: u.id, projectId: p.id, link: '/approvals', vars: { approval: { title: `Approve future project ${p.name}` } } });
  }
  const s = body.expected_start_date ?? before.expected_start_date;
  const e = body.expected_end_date === undefined ? before.expected_end_date : body.expected_end_date;
  if (e && e < s) throw badRequest('Expected completion must be after expected start');
  const [row] = await db('future_projects').where({ project_id: p.id }).update(body).returning('*');
  if (body.expected_start_date || body.expected_end_date !== undefined) await db('projects').where({ id: p.id }).update({ start_date: s, end_date: e });
  const d = diff(before, body);
  await audit(req, { action: 'future_project.updated', entityType: 'project', entityId: p.id, before: d.before, after: d.after });
  res.json(row);
});

/**
 * One-click conversion to an active project. All planning data stays in place
 * (future_projects row retained with converted_at), dates are carried over.
 */
router.post('/:id/convert', requirePerm('future_projects.convert'), async (req, res) => {
  const u = me(req);
  const p = await loadVisibleProject(u, idParam(req));
  if (!p.is_future) throw badRequest('Project is already active');
  assertCanManageProject(u, p);
  const fp = await db('future_projects').where({ project_id: p.id }).first();
  const { start_date, status, force } = parse(z.object({
    start_date: zDate.optional(), status: z.enum(['ready_to_start', 'in_progress', 'planned']).default('ready_to_start'), force: z.boolean().default(false),
  }), req.body);
  if (fp.approval_status !== 'approved' && !can(u, 'approvals.decide')) throw badRequest('Future project must be approved before conversion');
  if (fp.readiness_percent < 100 && !force) throw badRequest(`Readiness is ${fp.readiness_percent}%. Complete the checklist or convert with force.`, { readiness: fp.readiness_percent });
  const row = await db.transaction(async (trx) => {
    const [proj] = await trx('projects').where({ id: p.id }).update({
      is_future: false, status, start_date: start_date ?? fp.expected_start_date, end_date: p.end_date ?? fp.expected_end_date, updated_at: trx.fn.now(),
    }).returning('*');
    await trx('future_projects').where({ project_id: p.id }).update({ converted_at: trx.fn.now(), converted_by: u.id });
    await audit(req, { action: 'future_project.converted', entityType: 'project', entityId: p.id, summary: `${p.code} converted to active (${status})`, before: { is_future: true, status: p.status }, after: { is_future: false, status } }, trx);
    return proj;
  });
  await emitEvent({ type: 'project.converted', actorId: u.id, projectId: p.id, vars: { project: row } });
  res.json(row);
});
