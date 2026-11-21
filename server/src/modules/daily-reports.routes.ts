import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { db } from '../db/knex';
import { can, me, requirePerm } from '../auth/middleware';
import { scopeUsers, supervisedUserIds } from '../auth/scope';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { idParam, paginate, parse, zDate, zId, zOptStr, zPage } from '../lib/http';
import { getSetting } from '../lib/settings';
import { emitEvent } from '../notifications/events';

export const router = Router();

const reportSchema = z.object({
  report_date: zDate,
  work_planned: zOptStr,
  work_completed: z.string().trim().min(3).max(20000),
  work_pending: zOptStr,
  hours_spent: z.number().min(0).max(24),
  delay_reason: zOptStr,
  challenges: zOptStr,
  next_actions: zOptStr,
  support_required: zOptStr,
});

const localToday = (tz: string) => DateTime.now().setZone(tz).toISODate()!;

/** Submit or update (same day) a daily report. */
router.post('/', requirePerm('reports.daily.submit'), async (req, res) => {
  const u = me(req);
  const b = parse(reportSchema, req.body);
  const today = localToday(u.timezone);
  if (b.report_date > today) throw badRequest('Cannot submit a report for a future date');
  const minDate = DateTime.fromISO(today).minus({ days: 7 }).toISODate()!;
  if (b.report_date < minDate) throw badRequest('Reports older than 7 days cannot be submitted');
  const existing = await db('daily_reports').where({ user_id: u.id, report_date: b.report_date }).first();
  if (existing?.status === 'reviewed') throw badRequest('This report has already been reviewed and is locked');
  const [row] = await db('daily_reports').insert({ ...b, user_id: u.id })
    .onConflict(['user_id', 'report_date']).merge({ ...b, status: 'submitted', updated_at: db.fn.now() }).returning('*');
  await audit(req, { action: existing ? 'daily_report.updated' : 'daily_report.submitted', entityType: 'daily_report', entityId: row.id, summary: b.report_date });
  res.status(existing ? 200 : 201).json(row);
});

router.get('/mine', async (req, res) => {
  const f = parse(z.object({ ...zPage }), req.query);
  const q = db('daily_reports as d').leftJoin('users as r', 'r.id', 'd.reviewer_id').where('d.user_id', me(req).id)
    .orderBy('d.report_date', 'desc').select('d.*', 'r.name as reviewer_name');
  res.json(await paginate(q, f.page, f.pageSize));
});

/** Reports from people the reviewer supervises. */
router.get('/', requirePerm('reports.daily.review', 'monitoring.employees'), async (req, res) => {
  const f = parse(z.object({ ...zPage, from: zDate.optional(), to: zDate.optional(), user_id: zId.optional(), department_id: zId.optional(), status: z.string().optional() }), req.query);
  const q = scopeUsers(db('daily_reports as d').join('users as u', 'u.id', 'd.user_id'), me(req))
    .leftJoin('departments as dp', 'dp.id', 'u.department_id').leftJoin('users as r', 'r.id', 'd.reviewer_id')
    .whereNot('d.user_id', me(req).id)
    .orderBy([{ column: 'd.report_date', order: 'desc' }, { column: 'u.name' }])
    .select('d.*', 'u.name as user_name', 'u.employee_code', 'dp.name as department_name', 'r.name as reviewer_name');
  if (f.from) q.where('d.report_date', '>=', f.from);
  if (f.to) q.where('d.report_date', '<=', f.to);
  if (f.user_id) q.where('d.user_id', f.user_id);
  if (f.department_id) q.where('u.department_id', f.department_id);
  if (f.status) q.where('d.status', f.status);
  res.json(await paginate(q, f.page, f.pageSize));
});

router.post('/:id/review', requirePerm('reports.daily.review'), async (req, res) => {
  const u = me(req);
  const r = await db('daily_reports').where({ id: idParam(req) }).first();
  if (!r) throw notFound();
  if (r.user_id === u.id) throw forbidden('You cannot review your own report');
  const visible = await scopeUsers(db('users as u').where('u.id', r.user_id), u).first('u.id');
  if (!visible) throw notFound();
  const { comment, status } = parse(z.object({ comment: z.string().trim().max(5000).optional(), status: z.enum(['reviewed', 'needs_info']).default('reviewed') }), req.body);
  if (status === 'needs_info' && !comment) throw badRequest('Add a comment describing what information is needed');
  const [row] = await db('daily_reports').where({ id: r.id }).update({ status, review_comment: comment, reviewer_id: u.id, reviewed_at: db.fn.now() }).returning('*');
  await audit(req, { action: 'daily_report.reviewed', entityType: 'daily_report', entityId: r.id, after: { status, comment } });
  await emitEvent({ type: 'daily_report.reviewed', actorId: u.id, link: '/daily-reports', extraUserIds: { requester: [r.user_id] }, vars: { report: { date: r.report_date, status }, comment: comment ?? '' } });
  res.json(row);
});

/** People in scope who have not submitted for a given date. */
router.get('/missing', requirePerm('reports.daily.review', 'monitoring.employees'), async (req, res) => {
  const u = me(req);
  const { date } = parse(z.object({ date: zDate.optional() }), req.query);
  const d = date ?? localToday(u.timezone);
  const roles: string[] = await getSetting('daily_report_roles');
  const rows = await scopeUsers(db('users as u'), u).join('roles as r', 'r.id', 'u.role_id').leftJoin('departments as dp', 'dp.id', 'u.department_id')
    .whereIn('r.key', roles).where('u.is_active', true).whereNull('u.deleted_at').where('u.employment_status', 'active').whereNot('u.id', u.id)
    .whereNotExists(db('daily_reports as x').whereRaw('x.user_id = u.id').andWhere('x.report_date', d))
    .select('u.id', 'u.name', 'u.employee_code', 'dp.name as department_name', db.raw(`(SELECT max(report_date) FROM daily_reports z WHERE z.user_id = u.id) AS last_report_date`))
    .orderBy('u.name');
  res.json({ date: d, missing: rows });
});

/** Daily / weekly / monthly summaries (hours, submissions, compliance). */
router.get('/summary', async (req, res) => {
  const u = me(req);
  const { period, date, user_id } = parse(z.object({ period: z.enum(['daily', 'weekly', 'monthly']).default('weekly'), date: zDate.optional(), user_id: zId.optional() }), req.query);
  const anchor = DateTime.fromISO(date ?? localToday(u.timezone));
  const start = period === 'daily' ? anchor : period === 'weekly' ? anchor.startOf('week') : anchor.startOf('month');
  const end = period === 'daily' ? anchor : period === 'weekly' ? anchor.endOf('week') : anchor.endOf('month');
  let userIds: number[] | null;
  if (user_id) {
    if (user_id !== u.id && !can(u, 'reports.daily.review') && !can(u, 'monitoring.employees')) throw forbidden();
    userIds = [user_id];
  } else userIds = can(u, 'reports.daily.review') || can(u, 'monitoring.employees') ? await supervisedUserIds(u) : [u.id];
  const q = db('daily_reports as d').join('users as us', 'us.id', 'd.user_id')
    .whereBetween('d.report_date', [start.toISODate()!, end.toISODate()!]);
  if (userIds) q.whereIn('d.user_id', userIds);
  const rows = await q.clone().groupBy('us.id', 'us.name').select('us.id', 'us.name',
    db.raw('count(*)::int AS reports'), db.raw('coalesce(sum(d.hours_spent),0)::float AS hours'),
    db.raw(`count(*) FILTER (WHERE d.delay_reason IS NOT NULL AND d.delay_reason <> '')::int AS delays`),
    db.raw(`count(*) FILTER (WHERE d.support_required IS NOT NULL AND d.support_required <> '')::int AS support_requests`)).orderBy('us.name');
  const byDay = await q.clone().groupBy('d.report_date').orderBy('d.report_date').select('d.report_date', db.raw('count(*)::int AS reports'), db.raw('coalesce(sum(d.hours_spent),0)::float AS hours'));
  const workingDays: number[] = await getSetting('working_days');
  let expectedDays = 0;
  for (let c = start; c <= end && c <= DateTime.now(); c = c.plus({ days: 1 })) if (workingDays.includes(c.weekday)) expectedDays++;
  const recent = await q.clone().orderBy('d.report_date', 'desc').limit(50).select('d.id', 'd.report_date', 'us.name as user_name', 'd.work_completed', 'd.challenges', 'd.support_required', 'd.hours_spent', 'd.status');
  res.json({ period, start: start.toISODate(), end: end.toISODate(), expected_days: expectedDays, by_user: rows.map((r: any) => ({ ...r, compliance: expectedDays ? Math.min(100, Math.round((r.reports / expectedDays) * 100)) : null })), by_day: byDay, recent });
});
