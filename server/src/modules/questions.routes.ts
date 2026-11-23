import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/knex';
import { me, requirePerm } from '../auth/middleware';
import { audit, diff } from '../lib/audit';
import { badRequest, notFound } from '../lib/errors';
import { idParam, parse, zBoolQ, zDate, zId, zOptId, zTime } from '../lib/http';
import { ANSWER_TYPES, CONDITION_OPS, REPORT_TAGS, validateOptions } from '../questionnaire/answers';
import { applicableQuestions, loadQuestionCtx, requestChecklistSync } from '../questionnaire/engine';
import { describeFrequency, validateFrequency } from '../questionnaire/schedule';
import { applyTemplate } from '../questionnaire/templates';

export const router = Router();

/** Static metadata for the builder UI (answer types, EOD tags, condition operators). */
router.get('/meta', (_req, res) => res.json({
  answer_types: ANSWER_TYPES, report_tags: REPORT_TAGS, condition_operators: CONDITION_OPS,
  frequencies: ['daily', 'weekly', 'monthly', 'specific_dates', 'custom'],
  escalation_roles: ['employee', 'team_leader', 'hod', 'manager', 'admin', 'director'],
}));

router.use(requirePerm('questions.manage'));

// =========================================================================== sections
const sectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  is_active: z.boolean().optional(),
});

router.get('/sections', async (_req, res) => {
  res.json(await db('question_sections as s').whereNull('s.deleted_at').orderBy([{ column: 's.sort_order' }, { column: 's.id' }])
    .select('s.*', db.raw('(SELECT count(*) FROM questions q WHERE q.section_id = s.id AND q.deleted_at IS NULL)::int AS question_count')));
});

router.post('/sections', async (req, res) => {
  const b = parse(sectionSchema, req.body);
  const max = await db('question_sections').whereNull('deleted_at').max({ m: 'sort_order' }).first();
  const [row] = await db('question_sections').insert({ ...b, sort_order: Number(max?.m ?? 0) + 10, created_by: me(req).id, updated_by: me(req).id }).returning('*');
  await audit(req, { action: 'question_section.created', entityType: 'question_section', entityId: row.id, summary: row.name, after: b });
  res.status(201).json(row);
});

router.patch('/sections/:id', async (req, res) => {
  const id = idParam(req);
  const before = await db('question_sections').where({ id }).whereNull('deleted_at').first();
  if (!before) throw notFound('Section not found');
  const b = parse(sectionSchema.partial(), req.body);
  const [row] = await db('question_sections').where({ id }).update({ ...b, updated_by: me(req).id, updated_at: db.fn.now() }).returning('*');
  const d = diff(before, b);
  await audit(req, { action: 'question_section.updated', entityType: 'question_section', entityId: id, before: d.before, after: d.after, summary: row.name });
  if (b.is_active !== undefined || b.name) await requestChecklistSync();
  res.json(row);
});

/** Soft delete: questions in the section stay (unsectioned), checklist history is untouched. */
router.delete('/sections/:id', async (req, res) => {
  const id = idParam(req);
  const s = await db('question_sections').where({ id }).whereNull('deleted_at').first();
  if (!s) throw notFound('Section not found');
  await db('questions').where({ section_id: id }).update({ section_id: null, updated_at: db.fn.now() });
  await db('question_sections').where({ id }).update({ deleted_at: db.fn.now(), updated_by: me(req).id });
  await audit(req, { action: 'question_section.deleted', entityType: 'question_section', entityId: id, summary: s.name });
  await requestChecklistSync();
  res.json({ ok: true });
});

router.post('/sections/reorder', async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(zId).min(1).max(500) }), req.body);
  for (const [i, id] of ids.entries()) await db('question_sections').where({ id }).update({ sort_order: (i + 1) * 10 });
  await audit(req, { action: 'question_section.reordered', entityType: 'question_section', after: ids });
  await requestChecklistSync();
  res.json({ ok: true });
});

// =========================================================================== questions
const assignmentSchema = z.object({
  mode: z.enum(['none', 'all', 'departments', 'users']),
  department_ids: z.array(zId).max(500).default([]),
  user_ids: z.array(zId).max(5000).default([]),
});

const questionSchema = z.object({
  text: z.string().trim().min(2).max(1000),
  help_text: z.string().trim().max(2000).nullable().optional(),
  section_id: zOptId,
  answer_type: z.enum(ANSWER_TYPES),
  options: z.record(z.string(), z.any()).default({}),
  is_required: z.boolean().default(true),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  report_tag: z.enum(REPORT_TAGS).default('other'),
  frequency: z.enum(['daily', 'weekly', 'monthly', 'specific_dates', 'custom']).default('daily'),
  frequency_config: z.record(z.string(), z.any()).default({}),
  start_date: zDate.nullable().optional(),
  end_date: zDate.nullable().optional(),
  deadline_time: zTime.default('18:00'),
  reminder_offsets: z.array(z.number().int().min(1).max(10080)).max(5).default([60]),
  condition_question_id: zOptId,
  condition_operator: z.enum(CONDITION_OPS).nullable().optional(),
  condition_value: z.any().optional(),
  is_active: z.boolean().optional(),
  assignment: assignmentSchema.optional(),
});
type QuestionBody = z.infer<typeof questionSchema>;

async function validateQuestion(b: Partial<QuestionBody>, current: any | null) {
  const type = (b.answer_type ?? current?.answer_type) as any;
  if (b.options !== undefined || b.answer_type !== undefined) {
    const err = validateOptions(type, b.options ?? current?.options ?? {});
    if (err) throw badRequest(err);
  }
  if (b.frequency !== undefined || b.frequency_config !== undefined) {
    const f = validateFrequency((b.frequency ?? current?.frequency) as any, b.frequency_config ?? current?.frequency_config ?? {});
    if (!f.ok) throw badRequest(`Invalid frequency: ${f.error}`);
    b.frequency_config = f.config;
  }
  const start = b.start_date !== undefined ? b.start_date : current?.start_date;
  const end = b.end_date !== undefined ? b.end_date : current?.end_date;
  if (start && end && end < start) throw badRequest('End date must be on or after the start date');
  if (b.section_id) {
    const s = await db('question_sections').where({ id: b.section_id }).whereNull('deleted_at').first('id');
    if (!s) throw badRequest('Unknown section');
  }
  const condQ = b.condition_question_id !== undefined ? b.condition_question_id : current?.condition_question_id;
  const condOp = b.condition_operator !== undefined ? b.condition_operator : current?.condition_operator;
  if (condQ || condOp) {
    if (!condQ || !condOp) throw badRequest('A condition needs both a controlling question and an operator');
    if (current && condQ === current.id) throw badRequest('A question cannot depend on itself');
    const ctl = await db('questions').where({ id: condQ }).whereNull('deleted_at').first('id', 'condition_question_id');
    if (!ctl) throw badRequest('The controlling question does not exist');
    const needsValue = ['equals', 'not_equals', 'contains', 'gt', 'lt'].includes(condOp);
    const value = b.condition_value !== undefined ? b.condition_value : current?.condition_value;
    if (needsValue && (value === undefined || value === null || value === '')) throw badRequest('This condition needs a comparison value');
    // no dependency cycles
    let cursor = ctl.condition_question_id;
    for (let i = 0; cursor && i < 20; i++) {
      if (current && cursor === current.id) throw badRequest('Conditions would form a cycle');
      cursor = (await db('questions').where({ id: cursor }).first('condition_question_id'))?.condition_question_id;
    }
  }
}

/** Deactivated employees and inactive departments cannot receive new assignments. */
async function validateAssignment(a: z.infer<typeof assignmentSchema>) {
  if (a.mode === 'departments') {
    if (!a.department_ids.length) throw badRequest('Choose at least one department');
    const ok = await db('departments').whereIn('id', a.department_ids).where('is_active', true).whereNull('deleted_at').pluck('id');
    const bad = a.department_ids.filter((d) => !ok.includes(d));
    if (bad.length) throw badRequest(`Unknown or inactive department(s): ${bad.join(', ')}`);
  }
  if (a.mode === 'users') {
    if (!a.user_ids.length) throw badRequest('Choose at least one employee');
    const rows = await db('users').whereIn('id', a.user_ids).whereNull('deleted_at').select('id', 'name', 'is_active');
    const missing = a.user_ids.filter((id) => !rows.some((r: any) => r.id === id));
    if (missing.length) throw badRequest(`Unknown employee(s): ${missing.join(', ')}`);
    const inactive = rows.filter((r: any) => !r.is_active);
    if (inactive.length) throw badRequest(`Deactivated employees cannot receive new questions: ${inactive.map((r: any) => r.name).join(', ')}`);
  }
}

async function assignmentsOf(questionId: number) {
  return db('question_assignments as a').leftJoin('users as u', 'u.id', 'a.user_id').leftJoin('departments as d', 'd.id', 'a.department_id')
    .leftJoin('users as c', 'c.id', 'a.created_by').where('a.question_id', questionId)
    .select('a.id', 'a.target_type', 'a.user_id', 'u.name as user_name', 'a.department_id', 'd.name as department_name', 'a.created_at', 'c.name as created_by_name');
}

function describeAssignment(rows: any[]) {
  if (!rows.length) return 'Not assigned';
  if (rows.some((r) => r.target_type === 'all')) return 'All active employees';
  const parts = [];
  const d = rows.filter((r) => r.target_type === 'department');
  const u = rows.filter((r) => r.target_type === 'user');
  if (d.length) parts.push(d.length <= 2 ? d.map((x) => x.department_name).join(', ') : `${d.length} departments`);
  if (u.length) parts.push(u.length <= 2 ? u.map((x) => x.user_name).join(', ') : `${u.length} employees`);
  return parts.join(' + ');
}

async function setAssignments(questionId: number, a: z.infer<typeof assignmentSchema>, actorId: number) {
  const before = await assignmentsOf(questionId);
  const want = a.mode === 'all' ? [{ target_type: 'all', user_id: null, department_id: null }]
    : a.mode === 'departments' ? [...new Set(a.department_ids)].map((d) => ({ target_type: 'department', user_id: null, department_id: d }))
      : a.mode === 'users' ? [...new Set(a.user_ids)].map((u) => ({ target_type: 'user', user_id: u, department_id: null })) : [];
  const key = (r: any) => `${r.target_type}:${r.user_id ?? 0}:${r.department_id ?? 0}`;
  const wantKeys = new Set(want.map(key));
  const remove = before.filter((r: any) => !wantKeys.has(key(r))).map((r: any) => r.id);
  if (remove.length) await db('question_assignments').whereIn('id', remove).del();
  const haveKeys = new Set(before.map(key));
  const add = want.filter((r) => !haveKeys.has(key(r)));
  if (add.length) await db('question_assignments').insert(add.map((r) => ({ ...r, question_id: questionId, created_by: actorId })));
  return { before: describeAssignment(before), changed: remove.length + add.length > 0 };
}

const questionCols = (b: Partial<QuestionBody>) => {
  const { assignment: _a, ...rest } = b as any;
  const out: any = { ...rest };
  if (out.options !== undefined) out.options = JSON.stringify(out.options);
  if (out.frequency_config !== undefined) out.frequency_config = JSON.stringify(out.frequency_config);
  if ('condition_value' in out) out.condition_value = out.condition_value === undefined || out.condition_value === null ? null : JSON.stringify(out.condition_value);
  if (out.condition_question_id === null) { out.condition_operator = null; out.condition_value = null; }
  return out;
};

router.get('/', async (req, res) => {
  const f = parse(z.object({
    q: z.string().max(200).optional(), section_id: zId.optional(), department_id: zId.optional(), user_id: zId.optional(),
    active: zBoolQ, priority: z.string().optional(), answer_type: z.string().optional(),
  }), req.query);
  const qb = db('questions as q').leftJoin('question_sections as s', 's.id', 'q.section_id').leftJoin('users as c', 'c.id', 'q.created_by')
    .leftJoin('users as m', 'm.id', 'q.updated_by').whereNull('q.deleted_at')
    .select('q.*', 's.name as section_name', 's.sort_order as section_order', 'c.name as created_by_name', 'm.name as updated_by_name',
      db.raw('(SELECT count(*) FROM checklist_items ci WHERE ci.question_id = q.id)::int AS times_asked'),
      db.raw(`(SELECT count(*) FROM checklist_items ci WHERE ci.question_id = q.id AND ci.status = 'submitted')::int AS times_answered`))
    .orderByRaw('coalesce(s.sort_order, 999999), q.section_id NULLS LAST, q.sort_order, q.id');
  if (f.q) qb.whereILike('q.text', `%${f.q}%`);
  if (f.section_id) qb.where('q.section_id', f.section_id);
  if (f.active !== undefined) qb.where('q.is_active', f.active);
  if (f.priority) qb.where('q.priority', f.priority);
  if (f.answer_type) qb.where('q.answer_type', f.answer_type);
  if (f.department_id) qb.whereExists(db('question_assignments as a').whereRaw('a.question_id = q.id').where((w) => w.where('a.department_id', f.department_id!).orWhere('a.target_type', 'all')));
  if (f.user_id) {
    const u = await db('users').where({ id: f.user_id }).first('department_id');
    qb.whereExists(db('question_assignments as a').whereRaw('a.question_id = q.id').where((w) => {
      w.where('a.user_id', f.user_id!).orWhere('a.target_type', 'all');
      if (u?.department_id) w.orWhere('a.department_id', u.department_id);
    }));
  }
  const rows = await qb;
  const assigns = rows.length ? await db('question_assignments as a').leftJoin('users as u', 'u.id', 'a.user_id').leftJoin('departments as d', 'd.id', 'a.department_id')
    .whereIn('a.question_id', rows.map((r: any) => r.id)).select('a.*', 'u.name as user_name', 'd.name as department_name') : [];
  res.json(rows.map((r: any) => {
    const mine = assigns.filter((a: any) => a.question_id === r.id);
    return { ...r, deadline_time: String(r.deadline_time).slice(0, 5), frequency_label: describeFrequency(r), assignment_label: describeAssignment(mine), assignments: mine };
  }));
});

router.get('/:id', async (req, res, next) => {
  if (!/^\d+$/.test(String(req.params.id))) return next(); // /templates, /preview etc. are matched further down
  const id = idParam(req);
  const q = await db('questions').where({ id }).whereNull('deleted_at').first();
  if (!q) throw notFound('Question not found');
  const history = await db('audit_logs as l').leftJoin('users as u', 'u.id', 'l.actor_id').where({ 'l.entity_type': 'question', 'l.entity_id': id })
    .orderBy('l.created_at', 'desc').limit(50).select('l.id', 'l.action', 'l.summary', 'l.before', 'l.after', 'l.created_at', 'u.name as actor_name');
  res.json({ ...q, deadline_time: String(q.deadline_time).slice(0, 5), frequency_label: describeFrequency(q), assignments: await assignmentsOf(id), history });
});

router.post('/', async (req, res) => {
  const b = parse(questionSchema, req.body);
  await validateQuestion(b, null);
  if (b.assignment) await validateAssignment(b.assignment);
  const max = await db('questions').where({ section_id: b.section_id ?? null }).whereNull('deleted_at').max({ m: 'sort_order' }).first();
  const [row] = await db('questions').insert({ ...questionCols(b), sort_order: Number(max?.m ?? 0) + 10, created_by: me(req).id, updated_by: me(req).id }).returning('*');
  if (b.assignment) await setAssignments(row.id, b.assignment, me(req).id);
  const assignment = describeAssignment(await assignmentsOf(row.id));
  await audit(req, { action: 'question.created', entityType: 'question', entityId: row.id, summary: row.text, after: { ...b, assignment } });
  await requestChecklistSync();
  res.status(201).json(row);
});

router.patch('/:id', async (req, res) => {
  const id = idParam(req);
  const before = await db('questions').where({ id }).whereNull('deleted_at').first();
  if (!before) throw notFound('Question not found');
  const b = parse(questionSchema.partial(), req.body);
  await validateQuestion(b, before);
  if (b.assignment) await validateAssignment(b.assignment);
  const contentChanged = ['text', 'answer_type', 'options'].some((k) => k in b && JSON.stringify((b as any)[k]) !== JSON.stringify(before[k]));
  const cols = questionCols(b);
  if (Object.keys(cols).length) {
    await db('questions').where({ id }).update({ ...cols, ...(contentChanged ? { version: before.version + 1 } : {}), updated_by: me(req).id, updated_at: db.fn.now() });
  }
  let assign: any = null;
  if (b.assignment) assign = await setAssignments(id, b.assignment, me(req).id);
  const { assignment: _x, ...fields } = b;
  const d = diff({ ...before, deadline_time: String(before.deadline_time).slice(0, 5) }, fields);
  if (assign?.changed) { d.before.assignment = assign.before; d.after.assignment = describeAssignment(await assignmentsOf(id)); }
  if (Object.keys(d.after).length) {
    const action = 'is_active' in d.after && Object.keys(d.after).length === 1 ? (b.is_active ? 'question.activated' : 'question.deactivated')
      : assign?.changed && Object.keys(d.after).length === 1 ? 'question.assigned' : 'question.updated';
    await audit(req, { action, entityType: 'question', entityId: id, before: d.before, after: d.after, summary: (b.text ?? before.text).slice(0, 200) });
  }
  await requestChecklistSync();
  res.json(await db('questions').where({ id }).first());
});

router.post('/:id/duplicate', async (req, res) => {
  const id = idParam(req);
  const q = await db('questions').where({ id }).whereNull('deleted_at').first();
  if (!q) throw notFound('Question not found');
  const { id: _id, created_at: _c, updated_at: _u, version: _v, organization_id: _o, ...rest } = q;
  const [row] = await db('questions').insert({
    ...rest, text: `${q.text} (copy)`.slice(0, 1000), options: JSON.stringify(q.options ?? {}), frequency_config: JSON.stringify(q.frequency_config ?? {}),
    condition_value: q.condition_value === null ? null : JSON.stringify(q.condition_value), is_active: false, sort_order: q.sort_order + 1,
    created_by: me(req).id, updated_by: me(req).id,
  }).returning('*');
  const assigns = await db('question_assignments').where({ question_id: id });
  if (assigns.length) await db('question_assignments').insert(assigns.map((a: any) => ({ question_id: row.id, target_type: a.target_type, user_id: a.user_id, department_id: a.department_id, created_by: me(req).id })));
  await audit(req, { action: 'question.duplicated', entityType: 'question', entityId: row.id, summary: `Copy of #${id}: ${q.text}`.slice(0, 300) });
  res.status(201).json(row);
});

/** Soft delete. Submitted answers and checklist history are kept; unanswered items for today disappear. */
router.delete('/:id', async (req, res) => {
  const id = idParam(req);
  const q = await db('questions').where({ id }).whereNull('deleted_at').first();
  if (!q) throw notFound('Question not found');
  const dependents = await db('questions').where({ condition_question_id: id }).whereNull('deleted_at').pluck('text');
  if (dependents.length) throw badRequest(`Other questions depend on this one: ${dependents.slice(0, 3).join('; ')}. Remove their conditions first.`);
  await db('questions').where({ id }).update({ deleted_at: db.fn.now(), is_active: false, updated_by: me(req).id });
  await audit(req, { action: 'question.deleted', entityType: 'question', entityId: id, summary: q.text });
  await requestChecklistSync();
  res.json({ ok: true });
});

router.put('/:id/assignments', async (req, res) => {
  const id = idParam(req);
  const q = await db('questions').where({ id }).whereNull('deleted_at').first();
  if (!q) throw notFound('Question not found');
  const a = parse(assignmentSchema, req.body);
  await validateAssignment(a);
  const r = await setAssignments(id, a, me(req).id);
  if (r.changed) {
    await audit(req, { action: 'question.assigned', entityType: 'question', entityId: id, before: { assignment: r.before }, after: { assignment: describeAssignment(await assignmentsOf(id)) }, summary: q.text });
    await requestChecklistSync();
  }
  res.json(await assignmentsOf(id));
});

/** Assign several questions at once (adds to, or replaces, their current targets). */
router.post('/bulk-assign', async (req, res) => {
  const b = parse(assignmentSchema.extend({ question_ids: z.array(zId).min(1).max(500), replace: z.boolean().default(false) }), req.body);
  await validateAssignment(b);
  for (const qid of b.question_ids) {
    const q = await db('questions').where({ id: qid }).whereNull('deleted_at').first('id', 'text');
    if (!q) continue;
    if (b.replace) await setAssignments(qid, b, me(req).id);
    else {
      const rows = b.mode === 'all' ? [{ target_type: 'all' }] : b.mode === 'departments' ? b.department_ids.map((d) => ({ target_type: 'department', department_id: d }))
        : b.mode === 'users' ? b.user_ids.map((u) => ({ target_type: 'user', user_id: u })) : [];
      for (const r of rows) {
        await db('question_assignments').insert({ ...r, question_id: qid, created_by: me(req).id })
          .onConflict(db.raw('(question_id, target_type, coalesce(user_id, 0), coalesce(department_id, 0))')).ignore();
      }
    }
    await audit(req, { action: 'question.assigned', entityType: 'question', entityId: qid, after: { assignment: describeAssignment(await assignmentsOf(qid)), bulk: true }, summary: q.text });
  }
  await requestChecklistSync();
  res.json({ ok: true });
});

router.post('/reorder', async (req, res) => {
  const { items } = parse(z.object({ items: z.array(z.object({ id: zId, section_id: zOptId, sort_order: z.number().int().min(0).max(1_000_000) })).min(1).max(1000) }), req.body);
  for (const it of items) await db('questions').where({ id: it.id }).whereNull('deleted_at').update({ section_id: it.section_id ?? null, sort_order: it.sort_order, updated_at: db.fn.now() });
  await audit(req, { action: 'question.reordered', entityType: 'question', after: items.map((i) => i.id) });
  await requestChecklistSync();
  res.json({ ok: true });
});

/** Which questions would an employee get on a date? (admin preview) */
router.get('/preview', async (req, res) => {
  const { user_id, date } = parse(z.object({ user_id: zId, date: zDate }), req.query);
  const u = await db('users').where({ id: user_id }).whereNull('deleted_at').first('id', 'name', 'department_id', 'timezone', 'is_active');
  if (!u) throw notFound('Employee not found');
  const ctx = await loadQuestionCtx();
  res.json({ user: u, date, questions: applicableQuestions(u, date, ctx).map(({ q, assignment }) => ({ id: q.id, text: q.text, section_name: q.section_name, deadline_time: String(q.deadline_time).slice(0, 5), via: assignment.target_type })) });
});

// =========================================================================== templates
const templateItemSchema = z.object({
  text: z.string().trim().min(2).max(1000),
  help_text: z.string().trim().max(2000).nullable().optional(),
  answer_type: z.enum(ANSWER_TYPES),
  options: z.record(z.string(), z.any()).default({}),
  is_required: z.boolean().default(true),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  report_tag: z.enum(REPORT_TAGS).default('other'),
  sort_order: z.number().int().min(0).optional(),
});

router.get('/templates', async (_req, res) => {
  const tpls = await db('question_templates').orderBy('name');
  const items = tpls.length ? await db('question_template_items').whereIn('template_id', tpls.map((t: any) => t.id)).orderBy(['template_id', 'sort_order', 'id']) : [];
  res.json(tpls.map((t: any) => ({ ...t, items: items.filter((i: any) => i.template_id === t.id) })));
});

router.post('/templates', async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(120), description: z.string().trim().max(2000).nullable().optional() }), req.body);
  const key = `${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)}_${Date.now().toString(36)}`;
  const [row] = await db('question_templates').insert({ ...b, key, created_by: me(req).id }).returning('*');
  await audit(req, { action: 'question_template.created', entityType: 'question_template', entityId: row.id, summary: row.name });
  res.status(201).json({ ...row, items: [] });
});

router.patch('/templates/:id', async (req, res) => {
  const id = idParam(req);
  const b = parse(z.object({ name: z.string().trim().min(2).max(120).optional(), description: z.string().trim().max(2000).nullable().optional(), is_active: z.boolean().optional() }), req.body);
  const [row] = await db('question_templates').where({ id }).update({ ...b, updated_at: db.fn.now() }).returning('*');
  if (!row) throw notFound('Template not found');
  await audit(req, { action: 'question_template.updated', entityType: 'question_template', entityId: id, after: b, summary: row.name });
  res.json(row);
});

router.delete('/templates/:id', async (req, res) => {
  const id = idParam(req);
  const t = await db('question_templates').where({ id }).first();
  if (!t) throw notFound('Template not found');
  await db('question_templates').where({ id }).del();
  await audit(req, { action: 'question_template.deleted', entityType: 'question_template', entityId: id, summary: t.name });
  res.json({ ok: true });
});

router.post('/templates/:id/items', async (req, res) => {
  const id = idParam(req);
  if (!(await db('question_templates').where({ id }).first('id'))) throw notFound('Template not found');
  const b = parse(templateItemSchema, req.body);
  const err = validateOptions(b.answer_type, b.options);
  if (err) throw badRequest(err);
  const max = await db('question_template_items').where({ template_id: id }).max({ m: 'sort_order' }).first();
  const [row] = await db('question_template_items').insert({ ...b, options: JSON.stringify(b.options), template_id: id, sort_order: b.sort_order ?? Number(max?.m ?? 0) + 10 }).returning('*');
  await audit(req, { action: 'question_template.item_added', entityType: 'question_template', entityId: id, summary: b.text });
  res.status(201).json(row);
});

router.patch('/template-items/:id', async (req, res) => {
  const id = idParam(req);
  const before = await db('question_template_items').where({ id }).first();
  if (!before) throw notFound('Template question not found');
  const b = parse(templateItemSchema.partial(), req.body);
  const err = validateOptions((b.answer_type ?? before.answer_type) as any, b.options ?? before.options);
  if (err) throw badRequest(err);
  const [row] = await db('question_template_items').where({ id }).update({ ...b, ...(b.options ? { options: JSON.stringify(b.options) } : {}) }).returning('*');
  await audit(req, { action: 'question_template.item_updated', entityType: 'question_template', entityId: before.template_id, summary: row.text });
  res.json(row);
});

router.delete('/template-items/:id', async (req, res) => {
  const id = idParam(req);
  const it = await db('question_template_items').where({ id }).first();
  if (!it) throw notFound('Template question not found');
  await db('question_template_items').where({ id }).del();
  await audit(req, { action: 'question_template.item_removed', entityType: 'question_template', entityId: it.template_id, summary: it.text });
  res.json({ ok: true });
});

router.post('/templates/:id/apply', async (req, res) => {
  const id = idParam(req);
  const b = parse(assignmentSchema.extend({
    section_name: z.string().trim().max(120).optional(),
    deadline_time: zTime.default('18:00'),
    reminder_offsets: z.array(z.number().int().min(1).max(10080)).max(5).default([60]),
    frequency: z.enum(['daily', 'weekly', 'monthly', 'specific_dates', 'custom']).default('daily'),
    frequency_config: z.record(z.string(), z.any()).default({ working_days_only: true }),
  }), req.body);
  const tpl = await db('question_templates').where({ id }).first();
  if (!tpl) throw notFound('Template not found');
  if (!(await db('question_template_items').where({ template_id: id }).first('id'))) throw badRequest('This template has no questions');
  if (b.mode === 'none') throw badRequest('Choose who should answer these questions');
  await validateAssignment(b);
  const f = validateFrequency(b.frequency, b.frequency_config);
  if (!f.ok) throw badRequest(`Invalid frequency: ${f.error}`);
  const target = b.mode === 'all' ? { type: 'all' as const } : b.mode === 'departments' ? { type: 'department' as const, departmentIds: b.department_ids } : { type: 'user' as const, userIds: b.user_ids };
  const r = await applyTemplate({ templateId: id, actorId: me(req).id, sectionName: b.section_name, target, deadlineTime: b.deadline_time, reminderOffsets: b.reminder_offsets, frequency: b.frequency, frequencyConfig: f.config });
  await audit(req, { action: 'question_template.applied', entityType: 'question_template', entityId: id, summary: `${tpl.name} → ${r.questionIds.length} questions`, after: { section_id: r.sectionId, question_ids: r.questionIds, mode: b.mode, department_ids: b.department_ids, user_ids: b.user_ids } });
  for (const qid of r.questionIds) await audit(req, { action: 'question.created', entityType: 'question', entityId: qid, summary: `From template ${tpl.name}` });
  await requestChecklistSync();
  res.status(201).json(r);
});

// =========================================================================== checklist escalation rules
const escSchema = z.object({
  name: z.string().trim().min(2).max(120),
  level: z.number().int().min(1).max(10).default(1),
  offset_minutes: z.number().int().min(0).max(20160),
  notify_roles: z.array(z.enum(['employee', 'team_leader', 'hod', 'manager', 'admin', 'director'])).min(1),
  channels: z.array(z.enum(['in_app', 'email', 'browser_push', 'mobile_push', 'whatsapp'])).min(1).default(['in_app', 'email']),
  department_id: zOptId,
  is_active: z.boolean().optional(),
});

router.get('/escalation-rules', async (_req, res) => {
  res.json(await db('checklist_escalation_rules as r').leftJoin('departments as d', 'd.id', 'r.department_id')
    .select('r.*', 'd.name as department_name', db.raw('(SELECT count(*) FROM checklist_escalations e WHERE e.rule_id = r.id)::int AS fired'))
    .orderBy(['r.level', 'r.offset_minutes']));
});
router.post('/escalation-rules', async (req, res) => {
  const b = parse(escSchema, req.body);
  const [row] = await db('checklist_escalation_rules').insert({ ...b, created_by: me(req).id }).returning('*');
  await audit(req, { action: 'checklist_escalation_rule.created', entityType: 'checklist_escalation_rule', entityId: row.id, after: b, summary: row.name });
  res.status(201).json(row);
});
router.patch('/escalation-rules/:id', async (req, res) => {
  const id = idParam(req);
  const before = await db('checklist_escalation_rules').where({ id }).first();
  if (!before) throw notFound('Rule not found');
  const b = parse(escSchema.partial(), req.body);
  const [row] = await db('checklist_escalation_rules').where({ id }).update({ ...b, updated_at: db.fn.now() }).returning('*');
  const d = diff(before, b);
  await audit(req, { action: 'checklist_escalation_rule.updated', entityType: 'checklist_escalation_rule', entityId: id, before: d.before, after: d.after, summary: row.name });
  res.json(row);
});
router.delete('/escalation-rules/:id', async (req, res) => {
  const id = idParam(req);
  const r = await db('checklist_escalation_rules').where({ id }).first();
  if (!r) throw notFound('Rule not found');
  await db('checklist_escalation_rules').where({ id }).del();
  await audit(req, { action: 'checklist_escalation_rule.deleted', entityType: 'checklist_escalation_rule', entityId: id, summary: r.name });
  res.json({ ok: true });
});
