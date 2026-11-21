import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/knex';
import { AuthUser, can, me, requirePerm } from '../auth/middleware';
import { canManageProject, canReviewTask, loadVisibleProject, scopeTasks } from '../auth/scope';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { idParam, paginate, parse, zId, zOptId, zOptStr, zPage } from '../lib/http';
import { emitEvent } from '../notifications/events';

export const router = Router();

async function reviewableTasks(u: AuthUser, type: 'completion' | 'extension') {
  const rows = await scopeTasks(db('tasks as t'), u).whereNull('t.deleted_at')
    .join('task_approvals as a', 'a.task_id', 't.id').join('users as r', 'r.id', 'a.requested_by')
    .leftJoin('projects as p', 'p.id', 't.project_id').leftJoin('departments as d', 'd.id', 't.department_id')
    .where('a.decision', 'pending').where('a.approval_type', type)
    .orderBy('a.requested_at')
    .select('a.*', 't.task_key', 't.title', 't.priority', 't.deadline', 't.status', 't.department_id', 't.project_id', 't.assigned_by', 't.id as task_id',
      'p.name as project_name', 'd.name as department_name', 'r.name as requested_by_name');
  const out = [];
  for (const r of rows) if (await canReviewTask(u, { id: r.task_id, department_id: r.department_id, project_id: r.project_id, assigned_by: r.assigned_by })) out.push(r);
  return out;
}

/** Unified approvals inbox. */
router.get('/pending', async (req, res) => {
  const u = me(req);
  const [completions, extensions] = can(u, 'tasks.review') ? await Promise.all([reviewableTasks(u, 'completion'), reviewableTasks(u, 'extension')]) : [[], []];
  const requests = can(u, 'approvals.decide')
    ? await db('approval_requests as a').join('users as r', 'r.id', 'a.requested_by').leftJoin('projects as p', 'p.id', 'a.project_id')
        .where('a.status', 'pending').orderBy('a.requested_at').select('a.*', 'r.name as requested_by_name', 'p.name as project_name', 'p.code as project_code')
    : await db('approval_requests as a').leftJoin('projects as p', 'p.id', 'a.project_id').where({ 'a.status': 'pending', 'a.requested_by': u.id })
        .select('a.*', 'p.name as project_name', 'p.code as project_code');
  res.json({ completions, extensions, requests, counts: { completions: completions.length, extensions: extensions.length, requests: can(u, 'approvals.decide') ? requests.length : 0 } });
});

/** Decision history across task and project approvals. */
router.get('/history', async (req, res) => {
  const u = me(req);
  const f = parse(z.object({ ...zPage, type: z.string().optional() }), req.query);
  const tq = scopeTasks(db('task_approvals as a').join('tasks as t', 't.id', 'a.task_id'), u).whereNot('a.decision', 'pending')
    .join('users as r', 'r.id', 'a.requested_by').leftJoin('users as v', 'v.id', 'a.reviewer_id')
    .select(db.raw(`'task_' || a.approval_type AS kind`), 'a.id', db.raw(`t.task_key || ' ' || t.title AS title`), 'a.decision', 'a.comments', 'a.decided_at',
      'a.requested_at', 'r.name as requested_by_name', 'v.name as reviewer_name', db.raw(`'/tasks/' || t.id AS link`));
  const pq = db('approval_requests as a').whereNot('a.status', 'pending').join('users as r', 'r.id', 'a.requested_by').leftJoin('users as v', 'v.id', 'a.reviewer_id')
    .select('a.approval_type as kind', 'a.id', 'a.title', 'a.status as decision', 'a.comments', 'a.decided_at', 'a.requested_at', 'r.name as requested_by_name', 'v.name as reviewer_name',
      db.raw(`'/projects/' || a.project_id AS link`));
  if (!can(u, 'approvals.decide')) pq.where((w) => w.where('a.requested_by', u.id).orWhere('a.reviewer_id', u.id));
  const union = db.from(tq.unionAll(pq).as('x')).orderBy('decided_at', 'desc');
  if (f.type) union.where('kind', f.type);
  res.json(await paginate(union, f.page, f.pageSize));
});

const requestSchema = z.object({
  approval_type: z.enum(['project_approval', 'milestone', 'resource_allocation', 'scope_change', 'budget_change']),
  project_id: zId,
  entity_id: zOptId,
  title: z.string().trim().min(3).max(300),
  details: zOptStr,
  payload: z.record(z.string(), z.any()).default({}),
});

router.post('/requests', async (req, res) => {
  const u = me(req);
  const b = parse(requestSchema, req.body);
  const p = await loadVisibleProject(u, b.project_id);
  if (!canManageProject(u, p)) throw forbidden('Only the project manager can raise approval requests for this project');
  if (b.approval_type === 'budget_change' && typeof b.payload.estimated_budget !== 'number') throw badRequest('payload.estimated_budget (number) is required');
  const [row] = await db('approval_requests').insert({ ...b, payload: JSON.stringify(b.payload), requested_by: u.id }).returning('*');
  await audit(req, { action: 'approval.requested', entityType: 'approval_request', entityId: row.id, summary: `${b.approval_type}: ${b.title}`, after: b });
  await emitEvent({ type: 'approval.requested', actorId: u.id, projectId: p.id, link: '/approvals', vars: { approval: row } });
  res.status(201).json(row);
});

/** Decide a project-level approval; on approval the proposed change is applied atomically. */
router.post('/requests/:id/decide', requirePerm('approvals.decide'), async (req, res) => {
  const u = me(req);
  const a = await db('approval_requests').where({ id: idParam(req) }).first();
  if (!a) throw notFound();
  if (a.status !== 'pending') throw badRequest('Already decided');
  if (a.requested_by === u.id && u.roleKey !== 'super_admin') throw forbidden('You cannot approve your own request');
  const { decision, comments } = parse(z.object({ decision: z.enum(['approved', 'rejected']), comments: zOptStr }), req.body);
  await db.transaction(async (trx) => {
    await trx('approval_requests').where({ id: a.id }).update({ status: decision, comments, reviewer_id: u.id, decided_at: trx.fn.now() });
    const p = a.project_id ? await trx('projects').where({ id: a.project_id }).first() : null;
    if (decision === 'approved' && p) {
      switch (a.approval_type) {
        case 'budget_change':
          await trx('projects').where({ id: p.id }).update({ estimated_budget: a.payload.estimated_budget, updated_at: trx.fn.now() });
          break;
        case 'project_approval':
          if (p.is_future) await trx('future_projects').where({ project_id: p.id }).update({ approval_status: 'approved', chk_management_approval: true });
          else if (['proposed', 'under_evaluation'].includes(p.status)) await trx('projects').where({ id: p.id }).update({ status: 'approved' });
          break;
        case 'milestone':
          if (a.entity_id) await trx('project_milestones').where({ id: a.entity_id, project_id: p.id }).update({ status: 'completed', completed_at: trx.fn.now() });
          break;
        case 'resource_allocation':
          if (a.entity_id) await trx('project_resources').where({ id: a.entity_id, project_id: p.id }).update({ status: 'allocated' });
          break;
        case 'scope_change':
          if (typeof a.payload.description === 'string') await trx('projects').where({ id: p.id }).update({ description: a.payload.description });
          if (typeof a.payload.end_date === 'string') await trx('projects').where({ id: p.id }).update({ end_date: a.payload.end_date });
          break;
      }
    }
    if (decision === 'rejected' && p) {
      if (a.approval_type === 'project_approval' && p.is_future) await trx('future_projects').where({ project_id: p.id }).update({ approval_status: 'rejected' });
      if (a.approval_type === 'milestone' && a.entity_id) await trx('project_milestones').where({ id: a.entity_id }).update({ status: 'in_progress' });
      if (a.approval_type === 'resource_allocation' && a.entity_id) await trx('project_resources').where({ id: a.entity_id }).update({ status: 'required' });
    }
    await audit(req, { action: `approval.${decision}`, entityType: 'approval_request', entityId: a.id, summary: `${a.approval_type}: ${a.title}`, after: { decision, comments, payload: a.payload } }, trx);
    if (p) await audit(req, { action: `project.${a.approval_type}_${decision}`, entityType: 'project', entityId: p.id, summary: a.title, after: a.payload }, trx);
  });
  await emitEvent({ type: 'approval.decided', actorId: u.id, projectId: a.project_id, link: '/approvals', extraUserIds: { requester: [a.requested_by] }, vars: { approval: { ...a, status: decision }, comments: comments ?? '' } });
  res.json({ ok: true });
});

router.post('/requests/:id/withdraw', async (req, res) => {
  const a = await db('approval_requests').where({ id: idParam(req), requested_by: me(req).id, status: 'pending' }).first();
  if (!a) throw notFound();
  await db('approval_requests').where({ id: a.id }).update({ status: 'withdrawn', decided_at: db.fn.now() });
  await audit(req, { action: 'approval.withdrawn', entityType: 'approval_request', entityId: a.id });
  res.json({ ok: true });
});
