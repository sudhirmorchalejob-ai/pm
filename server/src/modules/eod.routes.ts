import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { db } from '../db/knex';
import { AuthUser, can, me, requirePerm } from '../auth/middleware';
import { scopeProjects, supervisedUserIds } from '../auth/scope';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { parse, zDate, zId } from '../lib/http';
import { getSetting, setSetting } from '../lib/settings';
import { localDateIn } from '../questionnaire/engine';
import { buildEodSnapshot, deriveEodView, eodText, EodFilter, sendEodPdf, sendEodXlsx, storeEodReport } from '../questionnaire/eod';

export const router = Router();
router.use(requirePerm('eod.view', 'eod.generate'));

/** What part of a report this viewer may see: organization scope → everything; otherwise their people. */
async function viewerFilter(u: AuthUser): Promise<EodFilter> {
  const userIds = await supervisedUserIds(u);
  if (!userIds) return {};
  const projectIds = await scopeProjects(db('projects as p').whereNull('p.deleted_at'), u).pluck('p.id');
  return { userIds, projectIds };
}

const viewQ = z.object({
  date: zDate.optional(),
  report_id: zId.optional(),
  department_id: zId.optional(),
  user_id: zId.optional(),
  company_id: zId.optional(),
  live: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  view: z.enum(['consolidated', 'employee']).default('consolidated'),
  format: z.enum(['json', 'text', 'xlsx', 'pdf']).default('json'),
});

/**
 * A stored report (latest for the date, or a specific one). When nothing has been generated yet
 * for that date, a live preview is built from current data and marked as such (not stored).
 */
router.get('/', async (req, res) => {
  const u = me(req);
  const f = parse(viewQ, req.query);
  const tz: string = await getSetting('default_timezone');
  const today = localDateIn(tz);
  let row: any = null;
  if (f.report_id) {
    row = await db('eod_reports as r').leftJoin('users as g', 'g.id', 'r.generated_by').where('r.id', f.report_id).first('r.*', 'g.name as generated_by_name');
    if (!row) throw notFound('Report not found');
  } else if (!f.live) {
    const date = f.date ?? today;
    if (date > today) throw badRequest('Reports cannot be built for future dates');
    row = await db('eod_reports as r').leftJoin('users as g', 'g.id', 'r.generated_by').where('r.report_date', date)
      .orderBy('r.generated_at', 'desc').first('r.*', 'g.name as generated_by_name');
  }
  const date = row ? String(row.report_date) : f.date ?? today;
  if (date > today) throw badRequest('Reports cannot be built for future dates');
  const snap = row ? row.data : await buildEodSnapshot(date);
  const view = deriveEodView(snap, { ...(await viewerFilter(u)), departmentId: f.department_id, userId: f.user_id, companyId: f.company_id });
  const meta = { report_id: row?.id ?? null, generated_at: row?.generated_at ?? null, trigger: row?.trigger ?? null, generated_by_name: row?.generated_by_name ?? null, live: !row };
  if (f.format === 'json') {
    const versions = await db('eod_reports as r').leftJoin('users as g', 'g.id', 'r.generated_by').where('r.report_date', date).orderBy('r.generated_at', 'desc')
      .select('r.id', 'r.trigger', 'r.generated_at', 'g.name as generated_by_name');
    return res.json({ ...meta, versions, report: view, text: eodText(view, f.view, meta) });
  }
  if (f.format !== 'text' && !can(u, 'reports.export') && !can(u, 'eod.generate')) throw forbidden('You are not allowed to export reports');
  await audit(req, { action: 'eod.exported', entityType: 'eod_report', entityId: row?.id ?? null, summary: `${f.view} ${f.format} ${date}${f.department_id ? ` dept ${f.department_id}` : ''}${f.user_id ? ` user ${f.user_id}` : ''}${f.company_id ? ` company ${f.company_id}` : ''}` });
  if (f.format === 'text') return res.type('text/plain').send(eodText(view, f.view, meta));
  if (f.format === 'xlsx') return sendEodXlsx(res, view, f.view);
  return sendEodPdf(res, view, f.view, meta);
});

/** Generate (and store) a report now. Every manual run is kept as a separate version. */
router.post('/generate', requirePerm('eod.generate'), async (req, res) => {
  const u = me(req);
  const { date } = parse(z.object({ date: zDate.optional() }), req.body ?? {});
  const tz: string = await getSetting('default_timezone');
  const d = date ?? localDateIn(tz);
  if (d > localDateIn(tz)) throw badRequest('Reports cannot be generated for future dates');
  const r = await storeEodReport(d, 'manual', u.id);
  await audit(req, { action: 'eod.generated', entityType: 'eod_report', entityId: r!.id, summary: `Manual EOD report for ${d}` });
  res.status(201).json({ id: r!.id, date: d, generated_at: r!.generated_at, summary: r!.summary });
});

/** Date-wise history of stored reports. */
router.get('/history', async (req, res) => {
  const f = parse(z.object({ from: zDate.optional(), to: zDate.optional() }), req.query);
  const tz: string = await getSetting('default_timezone');
  const to = f.to ?? localDateIn(tz);
  const from = f.from ?? DateTime.fromISO(to).minus({ days: 60 }).toISODate()!;
  const rows = await db('eod_reports as r').leftJoin('users as g', 'g.id', 'r.generated_by').whereBetween('r.report_date', [from, to])
    .orderBy([{ column: 'r.report_date', order: 'desc' }, { column: 'r.generated_at', order: 'desc' }])
    .select('r.id', db.raw('r.report_date::text AS report_date'), 'r.trigger', 'r.generated_at', 'g.name as generated_by_name',
      ...(me(req).scope === 'organization' ? ['r.summary'] : []));
  res.json({ from, to, reports: rows });
});

router.get('/settings', async (_req, res) => {
  res.json({
    eod_auto_enabled: await getSetting('eod_auto_enabled'), eod_generation_time: await getSetting('eod_generation_time'),
    eod_notify_roles: await getSetting('eod_notify_roles'), default_timezone: await getSetting('default_timezone'), working_days: await getSetting('working_days'),
  });
});

router.put('/settings', requirePerm('eod.generate'), async (req, res) => {
  const b = parse(z.object({
    eod_auto_enabled: z.boolean().optional(),
    eod_generation_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    eod_notify_roles: z.array(z.string()).max(20).optional(),
  }), req.body);
  const before = { eod_auto_enabled: await getSetting('eod_auto_enabled'), eod_generation_time: await getSetting('eod_generation_time'), eod_notify_roles: await getSetting('eod_notify_roles') };
  for (const [k, v] of Object.entries(b)) if (v !== undefined) await setSetting(k as any, v, me(req).id);
  await audit(req, { action: 'eod.settings_updated', entityType: 'settings', before, after: b });
  res.json({ ok: true });
});
