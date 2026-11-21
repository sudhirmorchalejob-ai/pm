import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { db } from '../db/knex';
import { can, me, requirePerm } from '../auth/middleware';
import { loadVisibleProject, scopeProjects, scopeTasks, supervisedUserIds } from '../auth/scope';
import { audit } from '../lib/audit';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { idParam, paginate, parse, zDate, zId, zOptId, zOptStr, zPage } from '../lib/http';
import { isValidTimezone } from '../lib/recurrence';
import { DEFAULT_SETTINGS, getAllSettings, setSetting, SettingKey } from '../lib/settings';
import { userKpis } from '../lib/kpi';
import { emitEvent } from '../notifications/events';

export const router = Router();

// ===================================================================== meetings
const meetingSchema = z.object({
  title: z.string().trim().min(2).max(200),
  project_id: zOptId,
  department_id: zOptId,
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
  location: z.string().max(300).nullable().optional(),
  agenda: zOptStr,
  attendee_ids: z.array(zId).default([]),
});

router.get('/meetings', async (req, res) => {
  const u = me(req);
  const f = parse(z.object({ ...zPage, project_id: zId.optional(), upcoming: z.enum(['true', 'false']).optional() }), req.query);
  const q = db('meetings as m').leftJoin('users as o', 'o.id', 'm.organizer_id').leftJoin('projects as p', 'p.id', 'm.project_id')
    .select('m.*', 'o.name as organizer_name', 'p.name as project_name',
      db.raw(`coalesce((SELECT json_agg(json_build_object('id', u.id, 'name', u.name)) FROM meeting_attendees a JOIN users u ON u.id = a.user_id WHERE a.meeting_id = m.id), '[]') AS attendees`),
      db.raw(`(SELECT count(*) FROM meeting_action_items i WHERE i.meeting_id = m.id AND i.status = 'open')::int AS open_actions`))
    .orderBy('m.starts_at', f.upcoming === 'true' ? 'asc' : 'desc');
  if (u.scope !== 'organization') q.where((w) => w.where('m.organizer_id', u.id).orWhereExists(db('meeting_attendees as a').whereRaw('a.meeting_id = m.id').andWhere('a.user_id', u.id)));
  if (f.project_id) q.where('m.project_id', f.project_id);
  if (f.upcoming === 'true') q.where('m.ends_at', '>=', new Date());
  res.json(await paginate(q, f.page, f.pageSize));
});

async function loadMeeting(req: any, needOrganizer = false) {
  const u = me(req);
  const m = await db('meetings').where({ id: idParam(req) }).first();
  if (!m) throw notFound();
  const attendee = await db('meeting_attendees').where({ meeting_id: m.id, user_id: u.id }).first();
  if (u.scope !== 'organization' && m.organizer_id !== u.id && !attendee) throw notFound();
  if (needOrganizer && m.organizer_id !== u.id && !can(u, 'settings.manage')) throw forbidden('Only the organizer can change this meeting');
  return m;
}

router.get('/meetings/:id', async (req, res) => {
  const m = await loadMeeting(req);
  const [attendees, actions] = await Promise.all([
    db('meeting_attendees as a').join('users as u', 'u.id', 'a.user_id').where('a.meeting_id', m.id).select('u.id', 'u.name'),
    db('meeting_action_items as i').leftJoin('users as u', 'u.id', 'i.assignee_id').leftJoin('tasks as t', 't.id', 'i.task_id').where('i.meeting_id', m.id)
      .select('i.*', 'u.name as assignee_name', 't.task_key'),
  ]);
  res.json({ ...m, attendees, action_items: actions });
});

router.post('/meetings', requirePerm('meetings.manage'), async (req, res) => {
  const u = me(req);
  const b = parse(meetingSchema, req.body);
  if (new Date(b.ends_at) <= new Date(b.starts_at)) throw badRequest('Meeting must end after it starts');
  if (b.project_id) await loadVisibleProject(u, b.project_id);
  const { attendee_ids, ...m } = b;
  const [row] = await db('meetings').insert({ ...m, organizer_id: u.id }).returning('*');
  const att = [...new Set([...attendee_ids, u.id])];
  await db('meeting_attendees').insert(att.map((id) => ({ meeting_id: row.id, user_id: id })));
  await audit(req, { action: 'meeting.scheduled', entityType: 'meeting', entityId: row.id, summary: row.title, after: b });
  await emitEvent({ type: 'meeting.scheduled', actorId: u.id, link: `/meetings?id=${row.id}`, extraUserIds: { attendees: att },
    vars: { meeting: { title: row.title, when: DateTime.fromJSDate(new Date(row.starts_at)).toUTC().toFormat("dd LLL yyyy HH:mm 'UTC'"), location: row.location ?? '' } } });
  res.status(201).json(row);
});

router.patch('/meetings/:id', async (req, res) => {
  const m = await loadMeeting(req, true);
  const b = parse(meetingSchema.partial().extend({ minutes: zOptStr, status: z.enum(['scheduled', 'completed', 'cancelled']).optional() }), req.body);
  const { attendee_ids, ...patch } = b;
  const s = patch.starts_at ?? m.starts_at; const e = patch.ends_at ?? m.ends_at;
  if (new Date(e) <= new Date(s)) throw badRequest('Meeting must end after it starts');
  const [row] = await db('meetings').where({ id: m.id }).update({ ...patch, updated_at: db.fn.now() }).returning('*');
  if (attendee_ids) {
    await db('meeting_attendees').where({ meeting_id: m.id }).del();
    await db('meeting_attendees').insert([...new Set([...attendee_ids, m.organizer_id])].map((id) => ({ meeting_id: m.id, user_id: id })));
  }
  await audit(req, { action: b.minutes !== undefined ? 'meeting.minutes_recorded' : 'meeting.updated', entityType: 'meeting', entityId: m.id, after: b });
  res.json(row);
});

router.post('/meetings/:id/actions', async (req, res) => {
  const m = await loadMeeting(req, true);
  const b = parse(z.object({ title: z.string().trim().min(2).max(300), assignee_id: zOptId, due_date: zDate.nullable().optional() }), req.body);
  const [row] = await db('meeting_action_items').insert({ ...b, meeting_id: m.id }).returning('*');
  res.status(201).json(row);
});

router.patch('/meetings/:id/actions/:aid', async (req, res) => {
  const m = await loadMeeting(req);
  const b = parse(z.object({ status: z.enum(['open', 'done']).optional(), title: z.string().max(300).optional(), assignee_id: zOptId, due_date: zDate.nullable().optional() }), req.body);
  const [row] = await db('meeting_action_items').where({ id: idParam(req, 'aid'), meeting_id: m.id }).update(b).returning('*');
  if (!row) throw notFound();
  res.json(row);
});

/** Turn an action item into a formal task (assigned to the action owner). */
router.post('/meetings/:id/actions/:aid/to-task', requirePerm('tasks.create'), async (req, res) => {
  const u = me(req);
  const m = await loadMeeting(req, true);
  const item = await db('meeting_action_items').where({ id: idParam(req, 'aid'), meeting_id: m.id }).first();
  if (!item) throw notFound();
  if (item.task_id) throw badRequest('Already converted');
  if (!item.assignee_id) throw badRequest('Assign an owner first');
  if (item.assignee_id !== u.id && !can(u, 'tasks.assign')) throw forbidden();
  const assignee = await db('users').where({ id: item.assignee_id }).first('department_id');
  const task = await db.transaction(async (trx) => {
    const [t] = await trx('tasks').insert({
      title: item.title, description: `Action item from meeting "${m.title}"`, project_id: m.project_id, department_id: assignee?.department_id ?? m.department_id,
      assigned_by: u.id, deadline: item.due_date ? DateTime.fromISO(item.due_date, { zone: u.timezone }).set({ hour: 18 }).toUTC().toISO() : null,
    }).returning('*');
    await trx('task_assignees').insert({ task_id: t.id, user_id: item.assignee_id, is_primary: true, assigned_by: u.id });
    await trx('meeting_action_items').where({ id: item.id }).update({ task_id: t.id });
    await trx('task_updates').insert({ task_id: t.id, user_id: u.id, kind: 'status', status_to: 'not_started', note: `Created from meeting "${m.title}"` });
    await audit(req, { action: 'task.created', entityType: 'task', entityId: t.id, summary: `${t.task_key} from meeting action` }, trx);
    return t;
  });
  await emitEvent({ type: 'task.assigned', actorId: u.id, taskId: task.id });
  res.status(201).json(task);
});

// ===================================================================== settings
router.get('/settings', async (_req, res) => res.json(await getAllSettings()));

router.put('/settings', requirePerm('settings.manage'), async (req, res) => {
  const b = parse(z.object({
    organization_name: z.string().trim().min(2).max(120).optional(),
    default_timezone: z.string().optional(),
    reminders_on_task_close: z.enum(['cancel', 'keep']).optional(),
    overload_threshold_percent: z.number().int().min(50).max(300).optional(),
    daily_report_roles: z.array(z.string()).optional(),
    daily_report_reminder_time: z.string().regex(/^(\d{2}:\d{2})?$/).optional(),
    working_days: z.array(z.number().int().min(1).max(7)).optional(),
  }), req.body);
  if (b.default_timezone && !isValidTimezone(b.default_timezone)) throw badRequest('Unknown timezone');
  const before = await getAllSettings();
  for (const [k, v] of Object.entries(b)) if (v !== undefined && k in DEFAULT_SETTINGS) await setSetting(k as SettingKey, v, me(req).id);
  await audit(req, { action: 'settings.updated', entityType: 'settings', before: Object.fromEntries(Object.keys(b).map((k) => [k, before[k]])), after: b });
  res.json(await getAllSettings());
});

router.get('/timezones', (_req, res) => res.json(['UTC', ...Intl.supportedValuesOf('timeZone')]));

// ===================================================================== AI-ready insights
/**
 * Deterministic, rule-based management summary built from live data. The structured
 * `signals` payload is the integration point for an LLM provider (see docs/AI.md):
 * an AI layer may summarise or explain these signals but has no write access —
 * approvals and deadline changes always go through the authorised human endpoints.
 */
router.get('/insights/summary', requirePerm('analytics.view'), async (req, res) => {
  const u = me(req);
  const today = DateTime.now().setZone(u.timezone).toISODate()!;
  const from = DateTime.now().minus({ days: 14 }).toISODate()!;
  const ids = await supervisedUserIds(u);
  const people = await userKpis({ from, to: today, userIds: ids });
  const tasks = scopeTasks(db('tasks as t'), u).whereNull('t.deleted_at').where('t.is_recurring_template', false);
  const [overdue, blocked, submitted, delayedProjects, risks, updates] = await Promise.all([
    tasks.clone().where('t.is_overdue', true).whereNotIn('t.status', ['completed', 'cancelled']).count({ c: '*' }).first(),
    tasks.clone().where('t.status', 'blocked').select('t.id', 't.task_key', 't.title', 't.blocker_note').limit(10),
    tasks.clone().whereIn('t.status', ['submitted', 'under_review']).where('t.submitted_at', '<', new Date(Date.now() - 48 * 3600_000)).count({ c: '*' }).first(),
    scopeProjects(db('projects as p'), u).whereNull('p.deleted_at').where('p.is_future', false).whereNotIn('p.status', ['completed', 'cancelled'])
      .where((w) => w.where('p.end_date', '<', today).orWhereExists(db('tasks as t').whereRaw('t.project_id = p.id').where('t.is_overdue', true).whereNotIn('t.status', ['completed', 'cancelled'])))
      .select('p.id', 'p.name', 'p.end_date', 'p.progress', db.raw(`(SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.is_overdue AND t.status NOT IN ('completed','cancelled'))::int AS overdue`)),
    scopeProjects(db('project_risks as r').join('projects as p', 'p.id', 'r.project_id'), u).whereIn('r.status', ['open', 'mitigating']).whereIn('r.impact', ['high', 'critical'])
      .select('r.title', 'r.impact', 'p.name as project_name').limit(10),
    db('task_updates as tu').join('users as us', 'us.id', 'tu.user_id').where('tu.created_at', '>', new Date(Date.now() - 24 * 3600_000))
      .modify((q) => { if (ids) q.whereIn('tu.user_id', ids); }).count({ c: '*' }).first(),
  ]);
  const active = people.filter((p) => p.open > 0 || p.completed > 0);
  const loads = active.map((p) => p.open_estimated_hours / Math.max(1, p.capacity_hours_per_week));
  const avgLoad = loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : 0;
  const overloaded = active.filter((p) => p.open_estimated_hours / Math.max(1, p.capacity_hours_per_week) > Math.max(1.1, avgLoad * 1.6));
  const idle = people.filter((p) => p.open === 0 && p.capacity_hours_per_week > 0);
  const lines: string[] = [];
  lines.push(`${Number(overdue?.c ?? 0)} overdue task(s), ${blocked.length} blocked, ${Number(submitted?.c ?? 0)} submission(s) waiting more than 48h for review.`);
  if (delayedProjects.length) lines.push(`${delayedProjects.length} project(s) delayed or at risk: ${delayedProjects.slice(0, 5).map((p: any) => p.name).join(', ')}.`);
  if (overloaded.length) lines.push(`Workload imbalance: ${overloaded.map((p) => p.name).slice(0, 5).join(', ')} carry well above average load${idle.length ? `, while ${idle.length} people have no open work` : ''}.`);
  if (risks.length) lines.push(`${risks.length} high-impact risk(s) open, e.g. "${risks[0].title}" (${risks[0].project_name}).`);
  const top = [...people].filter((p) => p.performance_score != null).sort((a, b) => (b.performance_score ?? 0) - (a.performance_score ?? 0))[0];
  if (top) lines.push(`Top performer (14 days, balanced score): ${top.name} (${top.performance_score}).`);
  lines.push(`${Number(updates?.c ?? 0)} work update(s) recorded in the last 24 hours.`);
  res.json({
    generated_at: new Date().toISOString(), engine: 'rules-v1', summary: lines,
    signals: { overdue: Number(overdue?.c ?? 0), blocked, stale_reviews: Number(submitted?.c ?? 0), delayed_projects: delayedProjects, high_risks: risks,
      overloaded: overloaded.map((p) => ({ id: p.id, name: p.name, open_hours: p.open_estimated_hours, capacity: p.capacity_hours_per_week })), idle: idle.map((p) => ({ id: p.id, name: p.name })) },
  });
});

// ===================================================================== global search
router.get('/search', async (req, res) => {
  const u = me(req);
  const { q } = parse(z.object({ q: z.string().trim().min(2).max(100) }), req.query);
  const like = `%${q}%`;
  const [tasks, projects, people] = await Promise.all([
    can(u, 'tasks.view') ? scopeTasks(db('tasks as t'), u).whereNull('t.deleted_at').where((w) => w.whereILike('t.title', like).orWhereILike('t.task_key', like)).limit(8).select('t.id', 't.task_key', 't.title', 't.status') : [],
    can(u, 'projects.view') ? scopeProjects(db('projects as p'), u).whereNull('p.deleted_at').where((w) => w.whereILike('p.name', like).orWhereILike('p.code', like)).limit(6).select('p.id', 'p.code', 'p.name', 'p.status') : [],
    db('users').whereNull('deleted_at').where('is_active', true).where((w) => w.whereILike('name', like).orWhereILike('employee_code', like)).limit(6).select('id', 'name', 'employee_code'),
  ]);
  res.json({ tasks, projects, people });
});
