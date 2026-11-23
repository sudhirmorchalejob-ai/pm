import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { db } from '../db/knex';
import { AuthUser, can, me, requirePerm } from '../auth/middleware';
import { scopeUsers, supervisedUserIds } from '../auth/scope';
import { audit } from '../lib/audit';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { idParam, paginate, parse, zDate, zId, zPage } from '../lib/http';
import { userKpis } from '../lib/kpi';
import { getSetting } from '../lib/settings';
import { formatAnswer, isAnswered, validateAnswer } from '../questionnaire/answers';
import { CHECKLIST_STATUSES, loadQuestionCtx, localDateIn, recomputeChecklist, syncUserChecklist } from '../questionnaire/engine';
import { registerFile, upload } from './files';

export const router = Router();

/** How many days back an employee may still answer or revise a checklist. */
const EDIT_WINDOW_DAYS = 7;

// ------------------------------------------------------------------ helpers
async function fileMap(ids: number[]): Promise<Record<number, string>> {
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return {};
  const rows = await db('files').whereIn('id', uniq).select('id', 'original_name');
  return Object.fromEntries(rows.map((r: any) => [r.id, r.original_name]));
}

async function fullChecklist(id: number) {
  const cl = await db('checklists as c').join('users as u', 'u.id', 'c.user_id').leftJoin('departments as d', 'd.id', 'c.department_id')
    .where('c.id', id).first('c.*', 'u.name as user_name', 'u.employee_code', 'd.name as department_name');
  if (!cl) return null;
  const items = await db('checklist_items as i').leftJoin('users as a', 'a.id', 'i.assigned_by').where('i.checklist_id', id)
    .orderBy(['i.section_order', 'i.sort_order', 'i.id'])
    .select('i.*', 'a.name as assigned_by_name', db.raw('(SELECT count(*) FROM checklist_answer_revisions r WHERE r.item_id = i.id)::int AS revision_count'));
  const allFiles = items.flatMap((i: any) => [...(i.file_ids ?? []), ...(i.draft?.file_ids ?? []), ...(i.answer_type === 'file' ? [...(Array.isArray(i.answer) ? i.answer : []), ...(Array.isArray(i.draft?.value) ? i.draft.value : [])] : [])]);
  const names = await fileMap(allFiles);
  return {
    ...cl,
    overdue: cl.status !== 'submitted' && cl.due_at && new Date(cl.due_at) < new Date(),
    items: items.map((i: any) => ({ ...i, applicable: i.status !== 'skipped' })),
    files: names,
  };
}

function editable(cl: any, u: AuthUser) {
  const today = localDateIn(cl.timezone || u.timezone);
  const min = DateTime.fromISO(today).minus({ days: EDIT_WINDOW_DAYS }).toISODate()!;
  return cl.checklist_date >= min && cl.checklist_date <= today;
}

async function ownChecklist(req: any) {
  const cl = await db('checklists').where({ id: idParam(req) }).first();
  if (!cl || cl.user_id !== me(req).id) throw notFound('Checklist not found');
  if (!editable(cl, me(req))) throw badRequest(`Checklists older than ${EDIT_WINDOW_DAYS} days are locked`);
  return cl;
}

const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const entrySchema = z.object({
  item_id: zId,
  value: z.any().optional(),
  note: z.string().trim().max(5000).nullable().optional(),
  supporting_urls: z.array(z.string().trim().max(2000)).max(20).optional(),
  file_ids: z.array(zId).max(10).optional(),
});
type Entry = z.infer<typeof entrySchema>;

/** Files may only be attached by the person who uploaded them (or kept from the previous answer). */
async function assertFiles(u: AuthUser, ids: number[], keep: number[] = []) {
  const want = ids.filter((id) => !keep.includes(id));
  if (!want.length) return;
  const mine = await db('files').whereIn('id', want).where('uploaded_by', u.id).pluck('id');
  const bad = want.filter((id) => !mine.includes(id));
  if (bad.length) throw badRequest('One or more attachments are not yours or no longer exist');
}

function cleanUrls(urls?: string[]) {
  const list = (urls ?? []).map((s) => s.trim()).filter(Boolean);
  const bad = list.find((s) => !URL_RE.test(s));
  if (bad) throw badRequest(`Not a valid http(s) URL: ${bad}`);
  return [...new Set(list)];
}

/** Store drafts for the given entries (never touches submitted answers). */
async function applyDrafts(u: AuthUser, cl: any, entries: Entry[]) {
  if (!entries.length) return;
  const items = await db('checklist_items').where({ checklist_id: cl.id });
  const errors: Record<number, string> = {};
  for (const e of entries) {
    const it = items.find((i: any) => i.id === e.item_id);
    if (!it) throw badRequest(`Item ${e.item_id} is not part of this checklist`);
    if (it.status === 'submitted') throw conflict(`"${it.question_text}" is already submitted. Use “Revise answer” to change it.`);
    const prev = it.draft ?? {};
    const draft = {
      value: e.value !== undefined ? e.value : prev.value,
      note: e.note !== undefined ? e.note : prev.note ?? null,
      supporting_urls: e.supporting_urls !== undefined ? cleanUrls(e.supporting_urls) : prev.supporting_urls ?? [],
      file_ids: e.file_ids !== undefined ? e.file_ids : prev.file_ids ?? [],
    };
    if (isAnswered(it.answer_type, draft.value)) {
      const v = validateAnswer(it.answer_type, it.options, draft.value);
      if (!v.ok) { errors[it.id] = v.error; continue; }
      draft.value = v.value;
    } else draft.value = null;
    const fileIds = [...draft.file_ids, ...(it.answer_type === 'file' && Array.isArray(draft.value) ? draft.value : [])];
    await assertFiles(u, fileIds);
    const empty = draft.value === null && !draft.note && !draft.supporting_urls.length && !draft.file_ids.length;
    await db('checklist_items').where({ id: it.id }).update({
      draft: empty ? null : JSON.stringify(draft), draft_saved_at: empty ? null : db.fn.now(),
      status: it.status === 'skipped' ? 'skipped' : empty ? 'pending' : 'draft', updated_at: db.fn.now(),
    });
  }
  if (Object.keys(errors).length) throw badRequest('Some answers are not valid', { items: errors });
  await db('checklists').where({ id: cl.id }).update({ last_activity_at: db.fn.now() });
}

async function answerText(it: any, value: any) {
  const ids = it.answer_type === 'file' && Array.isArray(value) ? value : [];
  return formatAnswer(it.answer_type, value, await fileMap(ids), it.options?.unit);
}

// ------------------------------------------------------------------ employee: my checklist
router.get('/mine', requirePerm('checklists.submit'), async (req, res) => {
  const u = me(req);
  const { date } = parse(z.object({ date: zDate.optional() }), req.query);
  const today = localDateIn(u.timezone);
  const d = date ?? today;
  if (d > today) throw badRequest('Checklists are generated on the day they are due');
  if (d === today) {
    // make sure today's checklist reflects the latest question configuration
    const user = await db('users').where({ id: u.id }).where('is_active', true).whereIn('employment_status', CHECKLIST_STATUSES).first('id', 'department_id', 'timezone');
    if (user) await syncUserChecklist(user, today, await loadQuestionCtx());
  }
  const cl = await db('checklists').where({ user_id: u.id, checklist_date: d }).first('id');
  const full = cl ? await fullChecklist(cl.id) : null;
  res.json({ date: d, today, editable: full ? editable(full, u) : false, checklist: full });
});

router.get('/mine/history', requirePerm('checklists.submit'), async (req, res) => {
  const f = parse(z.object({ ...zPage }), req.query);
  const q = db('checklists').where({ user_id: me(req).id }).orderBy('checklist_date', 'desc')
    .select('id', 'checklist_date', 'status', 'completion_percent', 'total_items', 'answered_items', 'required_items', 'required_answered', 'due_at', 'submitted_at', 'is_late');
  res.json(await paginate(q, f.page, f.pageSize));
});

router.put('/:id/draft', requirePerm('checklists.submit'), async (req, res) => {
  const cl = await ownChecklist(req);
  const { items } = parse(z.object({ items: z.array(entrySchema).max(500) }), req.body);
  await applyDrafts(me(req), cl, items);
  await recomputeChecklist(cl.id);
  res.json(await fullChecklist(cl.id));
});

/** Submit every drafted answer. Mandatory questions left blank are reported back, never counted as done. */
router.post('/:id/submit', requirePerm('checklists.submit'), async (req, res) => {
  const u = me(req);
  const cl = await ownChecklist(req);
  const { items: entries } = parse(z.object({ items: z.array(entrySchema).max(500).default([]) }), req.body);
  await applyDrafts(u, cl, entries);
  await recomputeChecklist(cl.id); // evaluate conditions before deciding what is applicable
  const items = await db('checklist_items').where({ checklist_id: cl.id }).orderBy(['section_order', 'sort_order', 'id']);
  const toSubmit = items.filter((i: any) => i.status === 'draft' && isAnswered(i.answer_type, i.draft?.value));
  if (!toSubmit.length) throw badRequest('Nothing to submit yet — answer at least one question first');
  const now = new Date();
  for (const it of toSubmit) {
    const v = validateAnswer(it.answer_type, it.options, it.draft.value);
    if (!v.ok) throw badRequest('Some answers are not valid', { items: { [it.id]: v.error } });
    const text = await answerText(it, v.value);
    const revision = it.revision + 1;
    const fields = { answer: JSON.stringify(v.value), answer_text: text, note: it.draft.note ?? null, supporting_urls: it.draft.supporting_urls ?? [], file_ids: it.draft.file_ids ?? [] };
    await db('checklist_items').where({ id: it.id, status: 'draft' }).update({
      ...fields, revision, status: 'submitted', submitted_at: now, submitted_by: u.id, is_late: now > new Date(it.due_at), draft: null, draft_saved_at: null, updated_at: db.fn.now(),
    });
    await db('checklist_answer_revisions').insert({ item_id: it.id, revision, ...fields, submitted_by: u.id, submitted_at: now });
  }
  const after = await recomputeChecklist(cl.id);
  await db('checklists').where({ id: cl.id }).update({ last_activity_at: db.fn.now() });
  const fresh = await fullChecklist(cl.id);
  const unanswered = fresh!.items.filter((i: any) => i.applicable && i.is_required && i.status !== 'submitted').map((i: any) => ({ id: i.id, question_text: i.question_text }));
  await audit(req, {
    action: 'checklist.answers_submitted', entityType: 'checklist', entityId: cl.id,
    summary: `${toSubmit.length} answer(s) for ${cl.checklist_date}${unanswered.length ? `; ${unanswered.length} mandatory still unanswered` : ''}`,
    after: { item_ids: toSubmit.map((i: any) => i.id), completion_percent: after?.completion_percent, status: after?.status },
  });
  res.json({ checklist: fresh, submitted: toSubmit.length, unanswered_required: unanswered });
});

/**
 * Revise a submitted answer. Requires a reason and the revision number the employee was looking at,
 * so a stale screen can never silently overwrite a newer answer. Every version is kept.
 */
router.post('/items/:itemId/revise', requirePerm('checklists.submit'), async (req, res) => {
  const u = me(req);
  const b = parse(entrySchema.omit({ item_id: true }).extend({ reason: z.string().trim().min(3).max(1000), expected_revision: z.number().int().min(1) }), req.body);
  const it = await db('checklist_items').where({ id: idParam(req, 'itemId') }).first();
  if (!it) throw notFound('Answer not found');
  const cl = await db('checklists').where({ id: it.checklist_id }).first();
  if (cl.user_id !== u.id) throw notFound('Answer not found');
  if (!editable(cl, u)) throw badRequest(`Checklists older than ${EDIT_WINDOW_DAYS} days are locked`);
  if (it.status !== 'submitted') throw badRequest('Only submitted answers can be revised; save or submit it instead');
  if (it.revision !== b.expected_revision) throw conflict('This answer was changed in the meantime. Reload to see the latest version before revising.');
  const v = validateAnswer(it.answer_type, it.options, b.value);
  if (!v.ok) throw badRequest(v.error);
  const fileIds = b.file_ids ?? it.file_ids ?? [];
  await assertFiles(u, [...fileIds, ...(it.answer_type === 'file' ? v.value : [])], [...(it.file_ids ?? []), ...(it.answer_type === 'file' && Array.isArray(it.answer) ? it.answer : [])]);
  const text = await answerText(it, v.value);
  const fields = { answer: JSON.stringify(v.value), answer_text: text, note: b.note !== undefined ? b.note : it.note, supporting_urls: b.supporting_urls !== undefined ? cleanUrls(b.supporting_urls) : it.supporting_urls, file_ids: fileIds };
  const revision = it.revision + 1;
  const updated = await db('checklist_items').where({ id: it.id, revision: it.revision }).update({ ...fields, revision, updated_at: db.fn.now() });
  if (!updated) throw conflict('This answer was changed in the meantime. Reload and try again.');
  await db('checklist_answer_revisions').insert({ item_id: it.id, revision, ...fields, reason: b.reason, submitted_by: u.id });
  await recomputeChecklist(cl.id);
  await audit(req, {
    action: 'checklist.answer_revised', entityType: 'checklist_item', entityId: it.id,
    summary: `${it.question_text} (${cl.checklist_date}) → revision ${revision}: ${b.reason}`.slice(0, 500),
    before: { answer: it.answer_text, revision: it.revision }, after: { answer: text, revision },
  });
  res.json(await fullChecklist(cl.id));
});

async function canMonitorUser(u: AuthUser, userId: number) {
  if (userId === u.id) return true;
  if (!can(u, 'checklists.monitor') && !can(u, 'eod.view')) return false;
  return !!(await scopeUsers(db('users as u').where('u.id', userId), u).first('u.id'));
}

router.get('/items/:itemId/revisions', async (req, res) => {
  const it = await db('checklist_items as i').join('checklists as c', 'c.id', 'i.checklist_id').where('i.id', idParam(req, 'itemId')).first('i.id', 'i.question_text', 'i.answer_type', 'c.user_id');
  if (!it || !(await canMonitorUser(me(req), it.user_id))) throw notFound('Answer not found');
  const rows = await db('checklist_answer_revisions as r').leftJoin('users as u', 'u.id', 'r.submitted_by').where('r.item_id', it.id)
    .orderBy('r.revision', 'desc').select('r.*', 'u.name as submitted_by_name');
  res.json({ item: it, revisions: rows, files: await fileMap(rows.flatMap((r: any) => [...(r.file_ids ?? []), ...(it.answer_type === 'file' && Array.isArray(r.answer) ? r.answer : [])])) });
});

router.post('/files', requirePerm('checklists.submit'), upload.array('files', 10), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) throw badRequest('No files uploaded');
  const out = [];
  for (const f of files) out.push(await registerFile(f, me(req).id));
  res.status(201).json(out.map((f: any) => ({ id: f.id, original_name: f.original_name, size_bytes: f.size_bytes, mime_type: f.mime_type })));
});

// ------------------------------------------------------------------ supervisors
const monitorPerm = requirePerm('checklists.monitor');

router.get('/users/:userId', async (req, res) => {
  const u = me(req);
  const userId = idParam(req, 'userId');
  if (!(await canMonitorUser(u, userId))) throw notFound('Employee not found');
  const { date } = parse(z.object({ date: zDate.optional() }), req.query);
  const emp = await db('users as u').leftJoin('departments as d', 'd.id', 'u.department_id').where('u.id', userId).first('u.id', 'u.name', 'u.timezone', 'u.is_active', 'd.name as department_name');
  const d = date ?? localDateIn(emp.timezone);
  const cl = await db('checklists').where({ user_id: userId, checklist_date: d }).first('id');
  res.json({ date: d, employee: emp, checklist: cl ? await fullChecklist(cl.id) : null });
});

const orgToday = async () => localDateIn(await getSetting('default_timezone'));

/** Submissions of everyone in scope for one date. */
router.get('/team', monitorPerm, async (req, res) => {
  const u = me(req);
  const f = parse(z.object({ date: zDate.optional(), department_id: zId.optional(), status: z.enum(['submitted', 'in_progress', 'pending', 'overdue', 'none']).optional(), q: z.string().max(100).optional() }), req.query);
  const date = f.date ?? (await orgToday());
  const qb = scopeUsers(db('users as u'), u).leftJoin('departments as d', 'd.id', 'u.department_id')
    .leftJoin('checklists as c', (j) => j.on('c.user_id', 'u.id').andOnVal('c.checklist_date', date))
    .whereNull('u.deleted_at').where((w) => w.where((a) => a.where('u.is_active', true).whereIn('u.employment_status', CHECKLIST_STATUSES)).orWhereNotNull('c.id'))
    .select('u.id as user_id', 'u.name', 'u.employee_code', 'u.is_active', 'd.id as department_id', 'd.name as department_name', 'c.id as checklist_id', 'c.status', 'c.completion_percent',
      'c.total_items', 'c.answered_items', 'c.required_items', 'c.required_answered', 'c.due_at', 'c.submitted_at', 'c.is_late')
    .orderBy(['d.name', 'u.name']);
  if (f.department_id) qb.where('u.department_id', f.department_id);
  if (f.q) qb.whereILike('u.name', `%${f.q}%`);
  if (f.status === 'none') qb.whereNull('c.id');
  else if (f.status === 'overdue') qb.whereNot('c.status', 'submitted').where('c.due_at', '<', new Date());
  else if (f.status) qb.where('c.status', f.status);
  const rows = await qb;
  res.json({ date, rows: rows.map((r: any) => ({ ...r, overdue: !!r.checklist_id && r.status !== 'submitted' && r.due_at && new Date(r.due_at) < new Date() })) });
});

/** Compliance dashboard: totals, trends, department-wise and employee-wise submissions. */
router.get('/dashboard', monitorPerm, async (req, res) => {
  const u = me(req);
  const today = await orgToday();
  const f = parse(z.object({
    from: zDate.optional(), to: zDate.optional(), department_id: zId.optional(), user_id: zId.optional(),
    status: z.enum(['submitted', 'in_progress', 'pending', 'overdue', 'late']).optional(),
  }), req.query);
  const to = f.to ?? today;
  const from = f.from ?? DateTime.fromISO(to).minus({ days: 6 }).toISODate()!;
  if (from > to) throw badRequest('"from" must be on or before "to"');
  if (DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days > 366) throw badRequest('Choose a range of at most one year');
  const ids = await supervisedUserIds(u); // null = whole organization
  const inScope = (qb: any, col: string) => (ids ? qb.whereIn(col, ids) : qb);

  const people = inScope(db('users as u').whereNull('u.deleted_at'), 'u.id');
  if (f.department_id) people.where('u.department_id', f.department_id);
  const [counts] = await people.clone().select(
    db.raw('count(*) FILTER (WHERE u.is_active)::int AS active_employees'),
    db.raw('count(*) FILTER (WHERE NOT u.is_active)::int AS deactivated_employees'));
  const departments = u.scope === 'organization'
    ? Number((await db('departments').where('is_active', true).whereNull('deleted_at').count({ c: '*' }).first())!.c)
    : Number((await inScope(db('users as u').whereNull('u.deleted_at').whereNotNull('u.department_id'), 'u.id').countDistinct({ c: 'u.department_id' }).first())!.c);

  const base = () => {
    const q = inScope(db('checklists as c').join('users as u', 'u.id', 'c.user_id'), 'c.user_id').whereBetween('c.checklist_date', [from, to]).where('c.total_items', '>', 0);
    if (f.department_id) q.where('c.department_id', f.department_id);
    if (f.user_id) q.where('c.user_id', f.user_id);
    if (f.status === 'overdue') q.whereNot('c.status', 'submitted').where('c.due_at', '<', new Date());
    else if (f.status === 'late') q.where('c.is_late', true);
    else if (f.status) q.where('c.status', f.status);
    return q;
  };
  const agg = [
    db.raw('count(*)::int AS total'),
    db.raw(`count(*) FILTER (WHERE c.status = 'submitted')::int AS completed`),
    db.raw(`count(*) FILTER (WHERE c.status = 'submitted' AND NOT c.is_late)::int AS on_time`),
    db.raw(`count(*) FILTER (WHERE c.status = 'submitted' AND c.is_late)::int AS late`),
    db.raw(`count(*) FILTER (WHERE c.status <> 'submitted')::int AS pending`),
    db.raw(`count(*) FILTER (WHERE c.status <> 'submitted' AND c.due_at < now())::int AS overdue`),
    db.raw('coalesce(round(avg(c.completion_percent)), 0)::int AS avg_completion'),
  ];
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);
  const [totals] = await base().select(agg);
  const byDay = await base().groupBy('c.checklist_date').orderBy('c.checklist_date').select(db.raw('c.checklist_date::text AS date'), ...agg);
  const byDept = await base().leftJoin('departments as d', 'd.id', 'c.department_id').groupBy('d.id', 'd.name').orderBy('d.name')
    .select('d.id as department_id', db.raw(`coalesce(d.name, 'No department') AS department_name`), ...agg);
  const byEmp = await base().leftJoin('departments as d', 'd.id', 'c.department_id').groupBy('u.id', 'u.name', 'u.employee_code', 'u.is_active', 'd.name')
    .orderBy('u.name').select('u.id as user_id', 'u.name', 'u.employee_code', 'u.is_active', 'd.name as department_name', ...agg,
      db.raw(`count(*) FILTER (WHERE c.status <> 'submitted' AND c.checklist_date < ?)::int AS missed`, [today]), db.raw('max(c.submitted_at) AS last_submitted_at'));
  const overdue = await base().clone().whereNot('c.status', 'submitted').where('c.due_at', '<', new Date()).leftJoin('departments as d', 'd.id', 'c.department_id')
    .orderBy('c.due_at').limit(100).select('c.id', db.raw('c.checklist_date::text AS date'), 'c.due_at', 'c.required_items', 'c.required_answered', 'c.completion_percent', 'u.id as user_id', 'u.name', 'd.name as department_name');

  // fixed windows independent of the chosen range
  const windowRate = async (start: string, end: string) => {
    const q = inScope(db('checklists as c'), 'c.user_id').whereBetween('c.checklist_date', [start, end]).where('c.total_items', '>', 0);
    if (f.department_id) q.where('c.department_id', f.department_id);
    const [r] = await q.select(db.raw('count(*)::int AS total'), db.raw(`count(*) FILTER (WHERE c.status = 'submitted')::int AS completed`));
    return { ...r, compliance: pct(r.completed, r.total) };
  };
  const daily = await windowRate(today, today);
  const weekly = await windowRate(DateTime.fromISO(today).minus({ days: 6 }).toISODate()!, today);

  const withRate = (r: any) => ({ ...r, compliance: pct(r.completed, r.total), on_time_rate: pct(r.on_time, r.completed) });
  res.json({
    from, to, today,
    people: { ...counts, departments },
    totals: withRate(totals), daily, weekly,
    by_day: byDay.map(withRate), by_department: byDept.map(withRate), by_employee: byEmp.map(withRate), overdue,
  });
});

/** Employee performance history: checklist compliance over time + task KPIs + department/status history. */
router.get('/history/:userId', async (req, res) => {
  const u = me(req);
  const userId = idParam(req, 'userId');
  if (userId !== u.id && !can(u, 'checklists.monitor')) throw forbidden();
  if (!(await canMonitorUser(u, userId))) throw notFound('Employee not found');
  const f = parse(z.object({ from: zDate.optional(), to: zDate.optional() }), req.query);
  const today = await orgToday();
  const to = f.to ?? today;
  const from = f.from ?? DateTime.fromISO(to).minus({ days: 29 }).toISODate()!;
  const emp = await db('users as u').leftJoin('departments as d', 'd.id', 'u.department_id').leftJoin('designations as g', 'g.id', 'u.designation_id')
    .where('u.id', userId).first('u.id', 'u.name', 'u.employee_code', 'u.is_active', 'u.employment_status', 'u.joining_date', 'd.name as department_name', 'g.title as designation');
  const days = await db('checklists as c').leftJoin('departments as d', 'd.id', 'c.department_id').where('c.user_id', userId).whereBetween('c.checklist_date', [from, to])
    .orderBy('c.checklist_date', 'desc').select('c.id', db.raw('c.checklist_date::text AS date'), 'c.status', 'c.completion_percent', 'c.total_items', 'c.answered_items',
      'c.required_items', 'c.required_answered', 'c.due_at', 'c.submitted_at', 'c.is_late', 'd.name as department_name');
  const counted = days.filter((d: any) => d.total_items > 0);
  const completed = counted.filter((d: any) => d.status === 'submitted').length;
  const [kpi] = await userKpis({ from, to, userIds: [userId], includeInactive: true });
  const departmentHistory = await db('department_history as h').leftJoin('departments as d', 'd.id', 'h.department_id').leftJoin('teams as t', 't.id', 'h.team_id')
    .leftJoin('users as c', 'c.id', 'h.changed_by').where('h.user_id', userId).orderBy('h.effective_from', 'desc')
    .select('h.*', 'd.name as department_name', 't.name as team_name', 'c.name as changed_by_name');
  const statusHistory = await db('employee_status_history as h').leftJoin('users as c', 'c.id', 'h.changed_by').where('h.user_id', userId)
    .orderBy('h.changed_at', 'desc').select('h.*', 'c.name as changed_by_name');
  res.json({
    from, to, employee: emp,
    summary: {
      checklists: counted.length, completed, late: counted.filter((d: any) => d.is_late).length,
      missed: counted.filter((d: any) => d.status !== 'submitted' && d.date < today).length,
      compliance: counted.length ? Math.round((completed / counted.length) * 100) : null,
      avg_completion: counted.length ? Math.round(counted.reduce((s: number, d: any) => s + d.completion_percent, 0) / counted.length) : null,
    },
    days, task_kpis: kpi ?? null, department_history: departmentHistory, status_history: statusHistory,
  });
});
