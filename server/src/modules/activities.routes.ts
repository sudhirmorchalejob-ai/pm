import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { db } from '../db/knex';
import { AuthUser, can, me, requirePerm } from '../auth/middleware';
import { loadVisibleProject, scopeUsers } from '../auth/scope';
import { audit } from '../lib/audit';
import { assertActiveUsers } from '../lib/employees';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { idParam, paginate, parse, zDate, zId, zPage, patchOf } from '../lib/http';
import { REPORT_SECTION_LABELS, REPORT_SECTIONS } from '../daily-work/categories';
import { registerFile, upload } from './files';

/**
 * Quick daily activities ("My Daily Work & Activities"). Every entry is saved immediately,
 * every edit keeps the previous version (activity_revisions, append-only), and employees
 * selected on an entry form the coordination history visible from both sides.
 */
export const router = Router();

// ------------------------------------------------------------------ visibility
/** May this viewer see activities performed by `userId`? */
export async function canSeeActivitiesOf(u: AuthUser, userId: number) {
  if (u.id === userId) return true;
  if (!can(u, 'activities.view_team')) return false;
  return !!(await scopeUsers(db('users as u').where('u.id', userId), u).first('u.id'));
}
async function assertCanSee(u: AuthUser, userId: number) {
  if (!(await canSeeActivitiesOf(u, userId))) throw notFound('Not found');
}

/** Base query: activities with category, project, performer and participants. */
export function activityQuery() {
  return db('activities as a').join('activity_categories as c', 'c.id', 'a.category_id').join('users as p', 'p.id', 'a.user_id')
    .leftJoin('projects as pr', 'pr.id', 'a.project_id').whereNull('a.deleted_at')
    .select('a.*', 'c.name as category_name', 'c.report_section', 'c.group_name', 'p.name as user_name', 'pr.name as project_name', 'pr.code as project_code',
      db.raw(`coalesce((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'via_department_id', ap.via_department_id) ORDER BY u.name)
        FROM activity_participants ap JOIN users u ON u.id = ap.user_id WHERE ap.activity_id = a.id), '[]') AS participants`),
      db.raw(`coalesce((SELECT json_agg(json_build_object('id', d.id, 'name', d.name) ORDER BY d.name) FROM departments d WHERE d.id = ANY(a.department_ids)), '[]') AS departments`),
      db.raw(`coalesce((SELECT json_agg(json_build_object('id', f.id, 'original_name', f.original_name)) FROM files f WHERE f.id = ANY(a.file_ids)), '[]') AS files`),
      db.raw(`(SELECT count(*) FROM activity_revisions r WHERE r.activity_id = a.id)::int AS revision_count`));
}

async function snapshot(id: number) {
  const a = await activityQuery().where('a.id', id).first();
  if (!a) return null;
  return {
    category_id: a.category_id, category_name: a.category_name, description: a.description, status: a.status, occurred_at: a.occurred_at,
    activity_date: a.activity_date, duration_minutes: a.duration_minutes, project_id: a.project_id, project_name: a.project_name,
    participants: a.participants.filter((p: any) => !p.via_department_id).map((p: any) => ({ id: p.id, name: p.name })),
    departments: a.departments, follow_up_required: a.follow_up_required, follow_up_note: a.follow_up_note, follow_up_due: a.follow_up_due,
    follow_up_done_at: a.follow_up_done_at, issue_resolved: a.issue_resolved, bugs_found: a.bugs_found, file_ids: a.file_ids,
  };
}

async function recordRevision(id: number, revision: number, action: 'created' | 'updated' | 'deleted', actorId: number, reason?: string | null) {
  await db('activity_revisions').insert({ activity_id: id, revision, action, snapshot: JSON.stringify(await snapshot(id)), reason: reason ?? null, changed_by: actorId });
}

// ------------------------------------------------------------------ categories
router.get('/meta', requirePerm('activities.log', 'activities.view_team', 'settings.manage'), (_req, res) => {
  res.json({ report_sections: REPORT_SECTIONS.map((k) => ({ value: k, label: REPORT_SECTION_LABELS[k] })) });
});

router.get('/categories', requirePerm('activities.log', 'activities.view_team', 'settings.manage'), async (req, res) => {
  const u = me(req);
  const all = req.query.all === 'true' && can(u, 'settings.manage');
  const q = db('activity_categories as c').select('c.*',
    db.raw(`(SELECT count(*) FROM activities a WHERE a.category_id = c.id AND a.user_id = ? AND a.deleted_at IS NULL AND a.occurred_at > now() - interval '60 days')::int AS my_uses`, [u.id]),
    db.raw(`(SELECT count(*) FROM activities a WHERE a.category_id = c.id AND a.deleted_at IS NULL)::int AS total_uses`))
    .orderBy(['c.sort_order', 'c.id']);
  if (!all) q.where('c.is_active', true);
  res.json(await q);
});

const categorySchema = z.object({
  name: z.string().trim().min(2).max(80),
  group_name: z.string().trim().min(1).max(60).default('Other'),
  report_section: z.enum(REPORT_SECTIONS).default('other'),
  suggests_employee: z.boolean().default(false),
  is_active: z.boolean().optional(),
});

async function assertUniqueName(name: string, exceptId?: number) {
  const q = db('activity_categories').whereRaw('lower(name) = lower(?)', [name]);
  if (exceptId) q.whereNot('id', exceptId);
  if (await q.first('id')) throw conflict(`A category named "${name}" already exists`);
}

router.post('/categories', requirePerm('settings.manage'), async (req, res) => {
  const b = parse(categorySchema, req.body);
  await assertUniqueName(b.name);
  const max = await db('activity_categories').max({ m: 'sort_order' }).first();
  const [row] = await db('activity_categories').insert({ ...b, sort_order: Number(max?.m ?? 0) + 10, created_by: me(req).id }).returning('*');
  await audit(req, { action: 'activity_category.created', entityType: 'activity_category', entityId: row.id, summary: row.name, after: b });
  res.status(201).json(row);
});

router.patch('/categories/:id', requirePerm('settings.manage'), async (req, res) => {
  const id = idParam(req);
  const b = parse(patchOf(categorySchema), req.body);
  const before = await db('activity_categories').where({ id }).first();
  if (!before) throw notFound();
  if (b.name) await assertUniqueName(b.name, id);
  const [row] = await db('activity_categories').where({ id }).update({ ...b, updated_at: db.fn.now() }).returning('*');
  await audit(req, { action: b.is_active === false ? 'activity_category.deactivated' : 'activity_category.updated', entityType: 'activity_category', entityId: id, summary: row.name, before, after: b });
  res.json(row);
});

router.post('/categories/reorder', requirePerm('settings.manage'), async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(zId).min(1).max(500) }), req.body);
  for (const [i, id] of ids.entries()) await db('activity_categories').where({ id }).update({ sort_order: (i + 1) * 10 });
  await audit(req, { action: 'activity_category.reordered', entityType: 'activity_category', after: { ids } });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ attachments
router.post('/files', requirePerm('activities.log'), upload.array('files', 10), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) throw badRequest('No files uploaded');
  const out = [];
  for (const f of files) out.push(await registerFile(f, me(req).id));
  res.status(201).json(out.map((f: any) => ({ id: f.id, original_name: f.original_name, size_bytes: f.size_bytes, mime_type: f.mime_type })));
});

// ------------------------------------------------------------------ list
const listQ = z.object({
  ...zPage,
  user_id: zId.optional(),
  date: zDate.optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  category_id: zId.optional(),
  section: z.enum(REPORT_SECTIONS).optional(),
  participant_id: zId.optional(),
  project_id: zId.optional(),
  status: z.enum(['completed', 'in_progress', 'pending']).optional(),
  follow_up: z.enum(['open', 'done', 'any']).optional(),
  q: z.string().max(200).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

router.get('/', requirePerm('activities.log', 'activities.view_team'), async (req, res) => {
  const u = me(req);
  const f = parse(listQ, req.query);
  const userId = f.user_id ?? u.id;
  await assertCanSee(u, userId);
  const q = activityQuery().where('a.user_id', userId);
  if (f.date) q.where('a.activity_date', f.date);
  if (f.from) q.where('a.activity_date', '>=', f.from);
  if (f.to) q.where('a.activity_date', '<=', f.to);
  if (f.category_id) q.where('a.category_id', f.category_id);
  if (f.section) q.where('c.report_section', f.section);
  if (f.project_id) q.where('a.project_id', f.project_id);
  if (f.status) q.where('a.status', f.status);
  if (f.follow_up === 'open') q.where('a.follow_up_required', true).whereNull('a.follow_up_done_at');
  if (f.follow_up === 'done') q.where('a.follow_up_required', true).whereNotNull('a.follow_up_done_at');
  if (f.participant_id) q.whereExists(db('activity_participants as x').whereRaw('x.activity_id = a.id').andWhere('x.user_id', f.participant_id));
  if (f.q) q.where((w) => w.whereILike('a.description', `%${f.q}%`).orWhereILike('a.follow_up_note', `%${f.q}%`));
  q.orderBy('a.occurred_at', f.order).orderBy('a.id', f.order);
  res.json(await paginate(q, f.page, f.pageSize));
});

router.get('/:id', requirePerm('activities.log', 'activities.view_team'), async (req, res, next) => {
  if (!/^\d+$/.test(String(req.params.id))) return next();
  const a = await activityQuery().where('a.id', idParam(req)).first();
  if (!a) throw notFound();
  await assertCanSee(me(req), a.user_id);
  res.json(a);
});

router.get('/:id/revisions', requirePerm('activities.log', 'activities.view_team'), async (req, res) => {
  const id = idParam(req);
  const a = await db('activities').where({ id }).first('user_id');
  if (!a) throw notFound();
  await assertCanSee(me(req), a.user_id);
  res.json(await db('activity_revisions as r').leftJoin('users as u', 'u.id', 'r.changed_by').where('r.activity_id', id)
    .orderBy([{ column: 'r.revision', order: 'desc' }, { column: 'r.id', order: 'desc' }]).select('r.*', 'u.name as changed_by_name'));
});

// ------------------------------------------------------------------ create / edit
const activitySchema = z.object({
  category_id: zId,
  description: z.string().trim().min(2).max(5000),
  participant_ids: z.array(zId).max(200).default([]),
  department_ids: z.array(zId).max(50).default([]),
  project_id: zId.nullable().optional(),
  status: z.enum(['completed', 'in_progress', 'pending']).default('completed'),
  occurred_at: z.string().datetime({ offset: true }).nullable().optional(),
  duration_minutes: z.number().int().min(1).max(1440).nullable().optional(),
  file_ids: z.array(zId).max(20).default([]),
  follow_up_required: z.boolean().default(false),
  follow_up_note: z.string().trim().max(2000).nullable().optional(),
  follow_up_due: zDate.nullable().optional(),
  issue_resolved: z.boolean().nullable().optional(),
  bugs_found: z.number().int().min(0).max(10000).nullable().optional(),
});

async function validate(u: AuthUser, b: Partial<z.infer<typeof activitySchema>>) {
  if (b.category_id !== undefined) {
    const cat = await db('activity_categories').where({ id: b.category_id }).first();
    if (!cat) throw badRequest('Unknown category');
    if (!cat.is_active) throw badRequest(`Category "${cat.name}" is no longer active`);
  }
  if (b.participant_ids?.length) await assertActiveUsers(b.participant_ids, 'activity entries');
  if (b.department_ids?.length) {
    const ok = await db('departments').whereIn('id', b.department_ids).where('is_active', true).whereNull('deleted_at').pluck('id');
    if (ok.length !== new Set(b.department_ids).size) throw badRequest('One or more departments are unknown or inactive');
  }
  if (b.project_id) await loadVisibleProject(u, b.project_id);
  if (b.file_ids?.length) {
    const mine = await db('files').whereIn('id', b.file_ids).where('uploaded_by', u.id).pluck('id');
    if (mine.length !== new Set(b.file_ids).size) throw badRequest('Attach only files you uploaded');
  }
  if (b.occurred_at) {
    const at = DateTime.fromISO(b.occurred_at).setZone(u.timezone);
    if (at > DateTime.now().setZone(u.timezone).endOf('day')) throw badRequest('An activity cannot be dated after today');
    if (at < DateTime.now().minus({ years: 1 })) throw badRequest('An activity cannot be older than one year');
  }
}

/** Participants = selected people + active members of selected departments (the performer excluded). */
async function writeParticipants(activityId: number, performerId: number, participantIds: number[], departmentIds: number[]) {
  await db('activity_participants').where({ activity_id: activityId }).del();
  const rows = new Map<number, number | null>();
  for (const id of participantIds) if (id !== performerId) rows.set(id, null);
  if (departmentIds.length) {
    const members = await db('users').whereIn('department_id', departmentIds).where('is_active', true).whereNull('deleted_at').select('id', 'department_id');
    for (const m of members) if (m.id !== performerId && !rows.has(m.id)) rows.set(m.id, m.department_id);
  }
  if (rows.size) await db('activity_participants').insert([...rows.entries()].map(([user_id, via]) => ({ activity_id: activityId, user_id, via_department_id: via })));
}

const localDate = (at: Date, tz: string) => DateTime.fromJSDate(at).setZone(tz || 'UTC').toISODate()!;

router.post('/', requirePerm('activities.log'), async (req, res) => {
  const u = me(req);
  const b = parse(activitySchema, req.body);
  await validate(u, b);
  const occurred = b.occurred_at ? new Date(b.occurred_at) : new Date();
  const [row] = await db('activities').insert({
    user_id: u.id, category_id: b.category_id, description: b.description, status: b.status, project_id: b.project_id ?? null,
    occurred_at: occurred, activity_date: localDate(occurred, u.timezone), duration_minutes: b.duration_minutes ?? null,
    department_ids: [...new Set(b.department_ids)], file_ids: [...new Set(b.file_ids)],
    follow_up_required: b.follow_up_required, follow_up_note: b.follow_up_required ? b.follow_up_note ?? null : null,
    follow_up_due: b.follow_up_required ? b.follow_up_due ?? null : null, issue_resolved: b.issue_resolved ?? null, bugs_found: b.bugs_found ?? null,
  }).returning('*');
  await writeParticipants(row.id, u.id, b.participant_ids, b.department_ids);
  await recordRevision(row.id, 1, 'created', u.id);
  await audit(req, { action: 'activity.created', entityType: 'activity', entityId: row.id, summary: b.description.slice(0, 120) });
  res.status(201).json(await activityQuery().where('a.id', row.id).first());
});

async function ownActivity(req: any) {
  const a = await db('activities').where({ id: idParam(req) }).whereNull('deleted_at').first();
  if (!a) throw notFound('Activity not found');
  if (a.user_id !== me(req).id) throw forbidden('Only the person who recorded an activity can change it');
  return a;
}

router.patch('/:id', requirePerm('activities.log'), async (req, res) => {
  const u = me(req);
  const before = await ownActivity(req);
  const b = parse(patchOf(activitySchema).extend({ reason: z.string().trim().max(500).nullable().optional(), expected_revision: z.number().int().optional() }), req.body);
  if (b.expected_revision !== undefined && b.expected_revision !== before.revision) throw conflict('This activity was changed elsewhere. Reload it and try again.');
  await validate(u, b);
  const patch: any = { updated_at: db.fn.now(), revision: before.revision + 1 };
  for (const k of ['category_id', 'description', 'status', 'duration_minutes', 'follow_up_required', 'issue_resolved', 'bugs_found'] as const) if (b[k] !== undefined) patch[k] = b[k];
  if (b.project_id !== undefined) patch.project_id = b.project_id;
  if (b.file_ids) patch.file_ids = [...new Set(b.file_ids)];
  if (b.department_ids) patch.department_ids = [...new Set(b.department_ids)];
  if (b.occurred_at) { patch.occurred_at = new Date(b.occurred_at); patch.activity_date = localDate(patch.occurred_at, u.timezone); }
  const followUp = b.follow_up_required ?? before.follow_up_required;
  if (b.follow_up_note !== undefined || b.follow_up_required !== undefined) patch.follow_up_note = followUp ? (b.follow_up_note !== undefined ? b.follow_up_note : before.follow_up_note) : null;
  if (b.follow_up_due !== undefined || b.follow_up_required !== undefined) patch.follow_up_due = followUp ? (b.follow_up_due !== undefined ? b.follow_up_due : before.follow_up_due) : null;
  if (!followUp) patch.follow_up_done_at = null;
  await db('activities').where({ id: before.id }).update(patch);
  if (b.participant_ids || b.department_ids) {
    const current = await db('activity_participants').where({ activity_id: before.id }).whereNull('via_department_id').pluck('user_id');
    await writeParticipants(before.id, u.id, b.participant_ids ?? current, b.department_ids ?? before.department_ids ?? []);
  }
  await recordRevision(before.id, before.revision + 1, 'updated', u.id, b.reason);
  await audit(req, { action: 'activity.updated', entityType: 'activity', entityId: before.id, summary: b.reason ?? undefined, after: { ...b, expected_revision: undefined } });
  res.json(await activityQuery().where('a.id', before.id).first());
});

/** Mark a follow-up done / the issue resolved without opening the full editor. */
router.post('/:id/follow-up', requirePerm('activities.log'), async (req, res) => {
  const u = me(req);
  const before = await ownActivity(req);
  const b = parse(z.object({ done: z.boolean().optional(), issue_resolved: z.boolean().nullable().optional(), note: z.string().trim().max(2000).optional() }), req.body);
  const patch: any = { updated_at: db.fn.now(), revision: before.revision + 1 };
  if (b.done !== undefined) {
    if (!before.follow_up_required) throw badRequest('This activity has no follow-up');
    patch.follow_up_done_at = b.done ? new Date() : null;
  }
  if (b.issue_resolved !== undefined) patch.issue_resolved = b.issue_resolved;
  if (b.note) patch.follow_up_note = [before.follow_up_note, b.note].filter(Boolean).join('\n');
  await db('activities').where({ id: before.id }).update(patch);
  const reason = b.done !== undefined ? (b.done ? 'Follow-up done' : 'Follow-up reopened') : b.issue_resolved ? 'Marked resolved' : 'Marked unresolved';
  await recordRevision(before.id, before.revision + 1, 'updated', u.id, reason);
  await audit(req, { action: 'activity.follow_up_updated', entityType: 'activity', entityId: before.id, summary: reason, after: b });
  res.json(await activityQuery().where('a.id', before.id).first());
});

router.delete('/:id', requirePerm('activities.log'), async (req, res) => {
  const u = me(req);
  const before = await ownActivity(req);
  const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
  await recordRevision(before.id, before.revision, 'deleted', u.id, reason ?? null);
  await db('activities').where({ id: before.id }).update({ deleted_at: db.fn.now() });
  await audit(req, { action: 'activity.deleted', entityType: 'activity', entityId: before.id, summary: before.description.slice(0, 120) });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ coordination history
/** Per-employee summary of the coordination a person recorded (default: me). */
router.get('/coordination/summary', requirePerm('activities.log', 'activities.view_team'), async (req, res) => {
  const u = me(req);
  const f = parse(z.object({ user_id: zId.optional(), from: zDate.optional(), to: zDate.optional() }), req.query);
  const performer = f.user_id ?? u.id;
  await assertCanSee(u, performer);
  const q = db('activity_participants as ap').join('activities as a', 'a.id', 'ap.activity_id').join('users as e', 'e.id', 'ap.user_id')
    .join('activity_categories as c', 'c.id', 'a.category_id').leftJoin('departments as d', 'd.id', 'e.department_id')
    .where('a.user_id', performer).whereNull('a.deleted_at')
    .groupBy('e.id', 'e.name', 'e.is_active', 'd.name')
    .select('e.id', 'e.name', 'e.is_active', 'd.name as department_name',
      db.raw('count(*)::int AS total'),
      db.raw('count(*) FILTER (WHERE ap.via_department_id IS NULL)::int AS direct'),
      db.raw(`count(*) FILTER (WHERE c.report_section = 'guidance')::int AS guidance`),
      db.raw(`count(*) FILTER (WHERE c.report_section = 'coordination')::int AS coordination`),
      db.raw(`count(*) FILTER (WHERE a.follow_up_required AND a.follow_up_done_at IS NULL)::int AS open_follow_ups`),
      db.raw('count(*) FILTER (WHERE a.issue_resolved = false)::int AS unresolved'),
      db.raw('count(*) FILTER (WHERE a.issue_resolved = true)::int AS resolved'),
      db.raw('max(a.occurred_at) AS last_at'))
    .orderBy('total', 'desc');
  if (f.from) q.where('a.activity_date', '>=', f.from);
  if (f.to) q.where('a.activity_date', '<=', f.to);
  res.json(await q);
});

/** An employee's coordination history: entries in which they were involved, visible to this viewer. */
router.get('/coordination/employee/:userId', requirePerm('activities.log', 'activities.view_team'), async (req, res) => {
  const u = me(req);
  const employeeId = idParam(req, 'userId');
  const f = parse(z.object({ ...zPage, performer_id: zId.optional(), from: zDate.optional(), to: zDate.optional() }), req.query);
  const employee = await db('users as e').leftJoin('departments as d', 'd.id', 'e.department_id').leftJoin('companies as co', 'co.id', 'e.company_id')
    .where('e.id', employeeId).whereNull('e.deleted_at').first('e.id', 'e.name', 'e.is_active', 'd.name as department_name', 'co.name as company_name');
  if (!employee) throw notFound('Employee not found');
  const seesTeam = await canSeeActivitiesOf(u, employeeId) && can(u, 'activities.view_team');
  const q = activityQuery().whereExists(db('activity_participants as x').whereRaw('x.activity_id = a.id').andWhere('x.user_id', employeeId));
  // Own entries are always visible; other people's entries only with team visibility over this employee.
  if (!seesTeam) q.where('a.user_id', u.id);
  if (f.performer_id) q.where('a.user_id', f.performer_id);
  if (f.from) q.where('a.activity_date', '>=', f.from);
  if (f.to) q.where('a.activity_date', '<=', f.to);
  q.orderBy('a.occurred_at', 'desc');
  const page = await paginate(q, f.page, f.pageSize);
  const statsQ = db('activity_participants as ap').join('activities as a', 'a.id', 'ap.activity_id').where('ap.user_id', employeeId).whereNull('a.deleted_at');
  if (!seesTeam) statsQ.where('a.user_id', u.id);
  if (f.performer_id) statsQ.where('a.user_id', f.performer_id);
  const [stats] = await statsQ.select(db.raw('count(*)::int AS total'),
    db.raw('count(*) FILTER (WHERE a.follow_up_required AND a.follow_up_done_at IS NULL)::int AS open_follow_ups'),
    db.raw('count(*) FILTER (WHERE a.issue_resolved = true)::int AS resolved'),
    db.raw('count(*) FILTER (WHERE a.issue_resolved = false)::int AS unresolved'),
    db.raw('max(a.occurred_at) AS last_at'));
  res.json({ employee, stats, ...page });
});
