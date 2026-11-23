import { Response } from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { DateTime } from 'luxon';
import { db } from '../db/knex';
import { getSetting } from '../lib/settings';
import { logger } from '../lib/logger';
import { Channel } from '../notifications/channels';
import { notify } from '../notifications/service';
import { CHECKLIST_STATUSES } from './engine';

/**
 * End-of-Day report. `buildEodSnapshot` consolidates real records for one date into a JSON
 * snapshot (stored in eod_reports for history). `deriveEodView` turns a snapshot into the
 * consolidated + employee-wise view, optionally filtered to what a viewer may see.
 * Nothing is inferred: unanswered questions are listed as unanswered, and employees without
 * submissions are listed as such.
 */

const OPEN = ['not_started', 'in_progress', 'on_hold', 'blocked', 'revision_required', 'submitted', 'under_review'];

export async function buildEodSnapshot(date: string) {
  const tz: string = await getSetting('default_timezone');
  const orgName: string = await getSetting('organization_name');
  const start = DateTime.fromISO(date, { zone: tz }).startOf('day');
  const end = start.plus({ days: 1 });
  const [s, e] = [start.toUTC().toJSDate(), end.toUTC().toJSDate()];

  const checklists = await db('checklists').where({ checklist_date: date });
  const clByUser = new Map(checklists.map((c: any) => [c.user_id, c]));
  // Everyone active today + anyone who had a checklist that day (even if deactivated since)
  const users = await db('users as u').leftJoin('departments as d', 'd.id', 'u.department_id').leftJoin('designations as g', 'g.id', 'u.designation_id')
    .leftJoin('teams as t', 't.id', 'u.team_id').leftJoin('companies as co', 'co.id', 'u.company_id').whereNull('u.deleted_at')
    .where((w) => w.where((a) => a.where('u.is_active', true).whereIn('u.employment_status', CHECKLIST_STATUSES)).orWhereIn('u.id', checklists.map((c: any) => c.user_id)))
    .select('u.id', 'u.name', 'u.employee_code', 'u.is_active', 'u.department_id', 'd.name as department_name', 'g.title as designation', 't.name as team_name',
      'u.company_id', 'co.name as company_name')
    .orderBy('u.name');
  const userIds = users.map((u: any) => u.id);
  const items = checklists.length ? await db('checklist_items').whereIn('checklist_id', checklists.map((c: any) => c.id)).orderBy(['section_order', 'sort_order', 'id']) : [];

  const completed = userIds.length ? await db('tasks as t').join('task_assignees as ta', 'ta.task_id', 't.id').leftJoin('projects as p', 'p.id', 't.project_id')
    .whereIn('ta.user_id', userIds).where('t.status', 'completed').where('t.completed_at', '>=', s).where('t.completed_at', '<', e).whereNull('t.deleted_at')
    .select('ta.user_id', 't.id', 't.task_key', 't.title', 't.completed_at', 't.priority', 'p.name as project_name') : [];
  const pending = userIds.length ? await db('tasks as t').join('task_assignees as ta', 'ta.task_id', 't.id').leftJoin('projects as p', 'p.id', 't.project_id')
    .whereIn('ta.user_id', userIds).whereIn('t.status', OPEN).whereNull('t.deleted_at').where('t.is_recurring_template', false)
    .where('t.created_at', '<', e)
    .orderByRaw('t.deadline ASC NULLS LAST')
    .select('ta.user_id', 't.id', 't.task_key', 't.title', 't.status', 't.deadline', 't.progress', 't.priority', 't.blocker_note', 'p.name as project_name') : [];
  const dailyReports = userIds.length ? await db('daily_reports').whereIn('user_id', userIds).where({ report_date: date })
    .select('user_id', 'work_completed', 'work_pending', 'challenges', 'support_required', 'delay_reason', 'next_actions', 'hours_spent') : [];
  // Daily activities (quick entries) and personal EOD reports recorded for this date
  const activities = userIds.length ? await db('activities as a').join('activity_categories as c', 'c.id', 'a.category_id').leftJoin('projects as p', 'p.id', 'a.project_id')
    .whereIn('a.user_id', userIds).where('a.activity_date', date).whereNull('a.deleted_at').orderBy('a.occurred_at')
    .select('a.user_id', 'a.id', 'a.occurred_at', 'a.description', 'a.status', 'a.duration_minutes', 'a.follow_up_required', 'a.follow_up_note', 'a.follow_up_done_at',
      'a.issue_resolved', 'a.bugs_found', 'c.name as category', 'c.report_section as section', 'p.name as project_name',
      db.raw(`coalesce((SELECT array_agg(u.name ORDER BY u.name) FROM activity_participants ap JOIN users u ON u.id = ap.user_id WHERE ap.activity_id = a.id AND ap.via_department_id IS NULL), '{}') AS participants`),
      db.raw(`coalesce((SELECT array_agg(d.name ORDER BY d.name) FROM departments d WHERE d.id = ANY(a.department_ids)), '{}') AS departments`)) : [];
  const personalReports = userIds.length ? await db('personal_eod_reports').whereIn('user_id', userIds).where({ report_date: date })
    .select('user_id', 'status', 'content', 'finalized_at', 'updated_at') : [];
  const companies = await db('companies').whereNull('deleted_at').select('id', 'name').orderBy('name');
  const projects = await db('projects as p').leftJoin('departments as d', 'd.id', 'p.department_id').leftJoin('users as m', 'm.id', 'p.manager_id')
    .whereNull('p.deleted_at').where('p.is_future', false).whereIn('p.status', ['approved', 'planned', 'ready_to_start', 'in_progress', 'on_hold'])
    .select('p.id', 'p.code', 'p.name', 'p.status', 'p.progress', 'p.end_date', 'p.department_id', 'd.name as department_name', 'm.name as manager_name',
      db.raw(`(SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND NOT t.is_recurring_template AND t.status NOT IN ('completed','cancelled'))::int AS open_tasks`),
      db.raw(`(SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.is_overdue AND t.status NOT IN ('completed','cancelled'))::int AS overdue_tasks`),
      db.raw(`(SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed' AND t.completed_at >= ? AND t.completed_at < ?)::int AS completed_today`, [s, e]))
    .orderBy('p.name');
  const departments = await db('departments as d').leftJoin('users as h', 'h.id', 'd.hod_id').whereNull('d.deleted_at')
    .select('d.id', 'd.name', 'h.name as hod_name').orderBy('d.name');
  const fileIds = items.flatMap((i: any) => i.file_ids ?? []);
  const fileNames = fileIds.length ? Object.fromEntries((await db('files').whereIn('id', [...new Set(fileIds)]).select('id', 'original_name')).map((f: any) => [f.id, f.original_name])) : {};
  const now = new Date();

  const employees = users.map((u: any) => {
    const c: any = clByUser.get(u.id);
    const mine = c ? items.filter((i: any) => i.checklist_id === c.id) : [];
    const applicable = mine.filter((i: any) => i.status !== 'skipped');
    const submission = !c || c.total_items === 0 ? 'no_checklist' : c.status === 'submitted' ? 'submitted' : c.answered_items > 0 ? 'partial' : 'not_submitted';
    const pend = pending.filter((t: any) => t.user_id === u.id);
    const dr = dailyReports.find((r: any) => r.user_id === u.id) ?? null;
    return {
      ...u,
      submission,
      checklist: c ? {
        id: c.id, status: c.status, completion_percent: c.completion_percent, total_items: c.total_items, required_items: c.required_items,
        answered_items: c.answered_items, required_answered: c.required_answered, due_at: c.due_at, submitted_at: c.submitted_at, is_late: c.is_late,
        overdue: c.status !== 'submitted' && c.due_at && new Date(c.due_at) < now, department_id: c.department_id,
      } : null,
      answers: applicable.filter((i: any) => i.status === 'submitted').map((i: any) => ({
        item_id: i.id, section: i.section_name, question: i.question_text, answer_type: i.answer_type, report_tag: i.report_tag, required: i.is_required,
        value: i.answer, text: i.answer_text, note: i.note, urls: i.supporting_urls ?? [], files: (i.file_ids ?? []).map((id: number) => fileNames[id] ?? `file #${id}`),
        unit: i.options?.unit ?? null, submitted_at: i.submitted_at, late: i.is_late, revision: i.revision,
      })),
      unanswered: applicable.filter((i: any) => i.status !== 'submitted').map((i: any) => ({ question: i.question_text, required: i.is_required, section: i.section_name, has_draft: i.status === 'draft', report_tag: i.report_tag, answer_type: i.answer_type, unit: i.options?.unit ?? null })),
      tasks_completed: completed.filter((t: any) => t.user_id === u.id).map(({ user_id: _u, ...t }: any) => t),
      tasks_pending: pend.map(({ user_id: _u, ...t }: any) => ({ ...t, overdue: !!t.deadline && new Date(t.deadline) < e })),
      daily_report: dr ? { ...dr, user_id: undefined } : null,
      activities: activities.filter((a: any) => a.user_id === u.id).map(({ user_id: _u, ...a }: any) => a),
      personal_report: (() => {
        const r: any = personalReports.find((x: any) => x.user_id === u.id);
        // Only a finalized report is included as text; a draft is only flagged.
        return r ? { status: r.status, finalized_at: r.finalized_at, content: r.status === 'final' ? r.content : null } : null;
      })(),
    };
  });

  return { org_name: orgName, date, timezone: tz, built_at: now.toISOString(), departments, companies, employees, projects };
}

export type EodSnapshot = Awaited<ReturnType<typeof buildEodSnapshot>>;

export interface EodFilter { userIds?: number[] | null; departmentId?: number | null; userId?: number | null; companyId?: number | null; projectIds?: number[] | null }

const actsOf = (e: any): any[] => e.activities ?? []; // snapshots stored before activities existed have none
const actLine = (a: any) => {
  const who = [...(a.participants ?? []), ...(a.departments ?? []).map((d: string) => `${d} team`)];
  return `${a.category}: ${a.description}${who.length ? ` (with ${who.join(', ')})` : ''}${a.project_name ? ` [${a.project_name}]` : ''}${a.bugs_found ? ` · ${a.bugs_found} bug(s)` : ''}${a.issue_resolved === true ? ' · resolved' : a.issue_resolved === false ? ' · unresolved' : ''}${a.status !== 'completed' ? ` · ${String(a.status).replace('_', ' ')}` : ''}`;
};

const has = (s?: string | null) => !!s && s.trim().length > 0;

/** Consolidated + employee-wise view of a snapshot, filtered for the viewer. */
export function deriveEodView(snap: EodSnapshot, f: EodFilter = {}) {
  let emps = snap.employees;
  if (f.userIds) emps = emps.filter((e: any) => f.userIds!.includes(e.id));
  if (f.departmentId) emps = emps.filter((e: any) => (e.checklist?.department_id ?? e.department_id) === f.departmentId);
  if (f.userId) emps = emps.filter((e: any) => e.id === f.userId);
  if (f.companyId) emps = emps.filter((e: any) => e.company_id === f.companyId);
  let projects = snap.projects;
  if (f.projectIds) projects = projects.filter((p: any) => f.projectIds!.includes(p.id));
  if (f.departmentId) projects = projects.filter((p: any) => p.department_id === f.departmentId);
  if (f.userId) projects = projects.filter((p: any) => emps.some((e: any) => [...e.tasks_pending, ...e.tasks_completed].some((t: any) => t.project_name === p.name)));

  const expected = emps.filter((e: any) => e.submission !== 'no_checklist');
  const count = (k: string) => expected.filter((e: any) => e.submission === k).length;
  const summary = {
    employees: emps.length,
    expected: expected.length,
    submitted: count('submitted'),
    partial: count('partial'),
    not_submitted: count('not_submitted'),
    no_checklist: emps.length - expected.length,
    late: expected.filter((e: any) => e.checklist?.is_late).length,
    compliance: expected.length ? Math.round((count('submitted') / expected.length) * 100) : null,
    tasks_completed: emps.reduce((s: number, e: any) => s + e.tasks_completed.length, 0),
    tasks_pending: emps.reduce((s: number, e: any) => s + e.tasks_pending.length, 0),
    tasks_overdue: emps.reduce((s: number, e: any) => s + e.tasks_pending.filter((t: any) => t.overdue).length, 0),
    tasks_blocked: emps.reduce((s: number, e: any) => s + e.tasks_pending.filter((t: any) => t.status === 'blocked').length, 0),
    activities: emps.reduce((s: number, e: any) => s + actsOf(e).length, 0),
  };

  const deptName = (id: number | null) => snap.departments.find((d: any) => d.id === id)?.name ?? 'No department';
  const groups = new Map<number | null, any[]>();
  for (const e of emps) {
    const id = e.checklist?.department_id ?? e.department_id ?? null;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(e);
  }
  const departments = [...groups.entries()].map(([id, list]) => {
    const exp = list.filter((e: any) => e.submission !== 'no_checklist');
    const sub = exp.filter((e: any) => e.submission === 'submitted').length;
    const answers = list.flatMap((e: any) => e.answers.map((a: any) => ({ ...a, employee: e.name, employee_id: e.id })));
    const by = (tag: string) => answers.filter((a: any) => a.report_tag === tag && has(a.text)).map((a: any) => ({ employee: a.employee, question: a.question, text: a.text, late: a.late }));
    // numeric metrics: sum per question, with how many people reported vs. were asked
    const metricMap = new Map<string, { question: string; unit: string | null; total: number; reported: number; asked: number }>();
    const isMetric = (x: any) => x.report_tag === 'metric' && x.answer_type === 'number';
    for (const e of list) {
      for (const a of [...e.answers.filter(isMetric), ...e.unanswered.filter(isMetric)]) {
        const m = metricMap.get(a.question) ?? { question: a.question, unit: a.unit, total: 0, reported: 0, asked: 0 };
        m.asked++;
        if ('value' in a) { m.total += Number(a.value) || 0; m.reported++; }
        metricMap.set(a.question, m);
      }
    }
    // A metric nobody reported has no value (never shown as 0).
    const metrics = [...metricMap.values()].map((m) => ({ ...m, total: m.reported ? m.total : null }));
    const urls = answers.flatMap((a: any) => {
      const out: any[] = [];
      if (a.answer_type === 'url_list' && Array.isArray(a.value)) a.value.forEach((v: any) => out.push({ employee: a.employee, question: a.question, url: v.url, published_at: v.published_at, label: v.label }));
      if (a.answer_type === 'url' && a.value) out.push({ employee: a.employee, question: a.question, url: a.value, published_at: null, label: null });
      (a.urls ?? []).forEach((u: string) => out.push({ employee: a.employee, question: a.question, url: u, published_at: null, label: 'supporting link' }));
      return out;
    });
    const blockers = [
      ...by('blocker').map((b: any) => ({ ...b, source: 'checklist' })),
      ...list.flatMap((e: any) => e.tasks_pending.filter((t: any) => t.status === 'blocked').map((t: any) => ({ employee: e.name, question: `${t.task_key} ${t.title}`, text: t.blocker_note || 'Task is blocked (no reason recorded)', source: 'task' }))),
      ...list.filter((e: any) => has(e.daily_report?.challenges) || has(e.daily_report?.support_required)).map((e: any) => ({ employee: e.name, question: 'Daily report', text: [e.daily_report.challenges, e.daily_report.support_required && `Support needed: ${e.daily_report.support_required}`].filter(has).join(' · '), source: 'daily_report' })),
    ];
    const delays = [
      ...by('delay').map((b: any) => ({ ...b, source: 'checklist' })),
      ...list.flatMap((e: any) => e.tasks_pending.filter((t: any) => t.overdue).map((t: any) => ({ employee: e.name, question: `${t.task_key} ${t.title}`, text: `Overdue since ${String(t.deadline instanceof Date ? t.deadline.toISOString() : t.deadline).slice(0, 10)} (${t.status.replace(/_/g, ' ')}, ${t.progress}%)`, source: 'task' }))),
      ...list.filter((e: any) => has(e.daily_report?.delay_reason)).map((e: any) => ({ employee: e.name, question: 'Daily report', text: e.daily_report.delay_reason, source: 'daily_report' })),
    ];
    const dept = snap.departments.find((d: any) => d.id === id);
    return {
      id, name: deptName(id), hod_name: dept?.hod_name ?? null,
      employees: list.length, expected: exp.length, submitted: sub,
      partial: exp.filter((e: any) => e.submission === 'partial').length, not_submitted: exp.filter((e: any) => e.submission === 'not_submitted').length,
      compliance: exp.length ? Math.round((sub / exp.length) * 100) : null,
      metrics,
      work_done: [
        ...by('work_done'),
        ...list.filter((e: any) => has(e.daily_report?.work_completed)).map((e: any) => ({ employee: e.name, question: 'Daily report', text: e.daily_report.work_completed })),
      ],
      plans: by('plan'), pending_work: by('pending'), progress: [...by('progress'), ...by('deadline')],
      campaigns: by('campaign'), urls, blockers, delays, other: by('other'),
      tasks_completed: list.flatMap((e: any) => e.tasks_completed.map((t: any) => ({ ...t, employee: e.name }))),
      activities: list.flatMap((e: any) => actsOf(e).map((a: any) => ({ ...a, employee: e.name, text: actLine(a) }))),
      tasks_pending: list.reduce((s: number, e: any) => s + e.tasks_pending.length, 0),
      tasks_overdue: list.reduce((s: number, e: any) => s + e.tasks_pending.filter((t: any) => t.overdue).length, 0),
      projects: projects.filter((p: any) => p.department_id === id),
    };
  }).sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : a.name.localeCompare(b.name)));

  const notSubmitted = expected.filter((e: any) => e.submission !== 'submitted').map((e: any) => ({
    id: e.id, name: e.name, department_name: deptName(e.checklist?.department_id ?? e.department_id), status: e.submission,
    missing_required: e.unanswered.filter((u: any) => u.required).length, answered: e.checklist.answered_items, total: e.checklist.total_items,
    due_at: e.checklist.due_at, overdue: e.checklist.overdue,
  }));

  // Company-wise breakdown (business entities); employees without a company are grouped as "No company"
  const companyNames = new Map<number, string>(((snap as any).companies ?? []).map((c: any) => [c.id, c.name]));
  const byCompany = new Map<number | null, any[]>();
  for (const e of emps) { const k = e.company_id ?? null; if (!byCompany.has(k)) byCompany.set(k, []); byCompany.get(k)!.push(e); }
  const companies = [...byCompany.entries()].map(([id, list]) => {
    const exp = list.filter((e: any) => e.submission !== 'no_checklist');
    const sub = exp.filter((e: any) => e.submission === 'submitted').length;
    return { id, name: id ? companyNames.get(id) ?? list[0].company_name ?? `Company #${id}` : 'No company', employees: list.length, expected: exp.length, submitted: sub,
      compliance: exp.length ? Math.round((sub / exp.length) * 100) : null, activities: list.reduce((n: number, e: any) => n + actsOf(e).length, 0),
      tasks_completed: list.reduce((n: number, e: any) => n + e.tasks_completed.length, 0) };
  }).sort((a, b) => (a.id === null ? 1 : b.id === null ? -1 : a.name.localeCompare(b.name)));

  return {
    org_name: snap.org_name, date: snap.date, timezone: snap.timezone, built_at: snap.built_at, summary, not_submitted: notSubmitted,
    departments, companies, employees: emps.map((e: any) => ({ ...e, activities: actsOf(e), personal_report: e.personal_report ?? null })), projects,
  };
}
export type EodView = ReturnType<typeof deriveEodView>;

// --------------------------------------------------------------------------- plain text (clipboard)
const fmtDT = (v: any, tz: string) => (v ? DateTime.fromJSDate(new Date(v)).setZone(tz).toFormat('dd LLL HH:mm') : '—');
const indent = (s: string, pad = '    ') => s.split('\n').map((l, i) => (i ? pad + l : l)).join('\n');

export function eodText(v: EodView, mode: 'consolidated' | 'employee', meta: { generated_at?: string | null; trigger?: string | null } = {}) {
  const L: string[] = [];
  const day = DateTime.fromISO(v.date).toFormat('cccc, dd LLLL yyyy');
  L.push(`${mode === 'consolidated' ? 'END-OF-DAY REPORT' : 'EMPLOYEE-WISE EOD REPORT'} — ${v.org_name}`);
  L.push(`${day} (${v.timezone})${meta.generated_at ? ` · generated ${fmtDT(meta.generated_at, v.timezone)}${meta.trigger ? ` (${meta.trigger})` : ''}` : ' · live preview'}`);
  L.push('');
  const s = v.summary;
  L.push('SUMMARY');
  L.push(`• Checklists: ${s.submitted} of ${s.expected} complete${s.compliance !== null ? ` (${s.compliance}%)` : ''} · ${s.partial} partial · ${s.not_submitted} not submitted${s.late ? ` · ${s.late} late` : ''}`);
  L.push(`• Tasks: ${s.tasks_completed} completed today · ${s.tasks_pending} pending (${s.tasks_overdue} overdue, ${s.tasks_blocked} blocked)`);
  if (s.activities) L.push(`• Daily activities recorded: ${s.activities}`);
  if (s.no_checklist) L.push(`• ${s.no_checklist} employee(s) had no questions assigned for this date`);
  if (v.companies.length > 1 || (v.companies.length === 1 && v.companies[0].id !== null)) {
    for (const c of v.companies) L.push(`• ${c.name}: ${c.employees} employee(s)${c.expected ? `, ${c.submitted}/${c.expected} checklists complete` : ''}${c.activities ? `, ${c.activities} activities` : ''}`);
  }
  L.push('');
  L.push('NOT SUBMITTED / INCOMPLETE');
  if (!v.not_submitted.length) L.push('• Everyone with a checklist submitted it.');
  for (const n of v.not_submitted) L.push(`• ${n.name} (${n.department_name}) — ${n.status === 'partial' ? `partial: ${n.answered}/${n.total} answered` : 'nothing submitted'}; ${n.missing_required} mandatory unanswered${n.overdue ? ' · overdue' : ''}`);
  L.push('');

  if (mode === 'consolidated') {
    for (const d of v.departments) {
      L.push(`${d.name.toUpperCase()}${d.hod_name ? ` (HOD: ${d.hod_name})` : ''} — ${d.expected ? `${d.submitted}/${d.expected} checklists complete${d.compliance !== null ? ` (${d.compliance}%)` : ''}` : 'no checklists'}`);
      const sec = (title: string, rows: string[]) => { if (rows.length) { L.push(`  ${title}`); rows.forEach((r) => L.push(`    • ${indent(r, '      ')}`)); } };
      sec('Key metrics', d.metrics.map((m: any) => (m.total === null ? `${m.question}: not reported (0 of ${m.asked})` : `${m.question}: ${m.total.toLocaleString('en-US')}${m.unit ? ` ${m.unit}` : ''} (${m.reported} of ${m.asked} reported)`)));
      sec('Completed work', d.work_done.map((w: any) => `${w.employee}: ${w.text}`));
      sec('Tasks completed', d.tasks_completed.map((t: any) => `${t.employee}: ${t.task_key} ${t.title}${t.project_name ? ` [${t.project_name}]` : ''}`));
      sec('Daily activities & coordination', d.activities.map((a: any) => `${a.employee}: ${a.text}`));
      sec('Progress & deadlines', d.progress.map((w: any) => `${w.employee} — ${w.question}: ${w.text}`));
      sec('Campaigns', d.campaigns.map((w: any) => `${w.employee} — ${w.question}: ${w.text}`));
      sec('Published / supporting URLs', d.urls.map((u: any) => `${u.employee}: ${u.url}${u.published_at ? ` (published ${String(u.published_at).replace('T', ' ').slice(0, 16)})` : ''}`));
      sec('Blockers & dependencies', d.blockers.map((b: any) => `${b.employee} — ${b.question}: ${b.text}`));
      sec('Delays', d.delays.map((b: any) => `${b.employee} — ${b.question}: ${b.text}`));
      sec('Pending work', d.pending_work.map((w: any) => `${w.employee}: ${w.text}`));
      sec('Next plans', d.plans.map((w: any) => `${w.employee}: ${w.text}`));
      sec('Other updates', d.other.map((w: any) => `${w.employee} — ${w.question}: ${w.text}`));
      if (d.tasks_pending) L.push(`  Open tasks: ${d.tasks_pending} (${d.tasks_overdue} overdue)`);
      L.push('');
    }
    if (v.projects.length) {
      L.push('PROJECT PROGRESS');
      for (const p of v.projects) L.push(`• ${p.code} ${p.name} — ${p.progress}% · ${String(p.status).replace(/_/g, ' ')} · ${p.open_tasks} open (${p.overdue_tasks} overdue) · ${p.completed_today} completed today`);
    }
  } else {
    for (const e of v.employees) {
      L.push(`${e.name}${e.employee_code ? ` (${e.employee_code})` : ''} — ${e.department_name ?? 'No department'}${e.designation ? `, ${e.designation}` : ''}${e.company_name ? ` · ${e.company_name}` : ''}`);
      const st = e.submission === 'submitted' ? `Checklist complete${e.checklist?.is_late ? ' (late)' : ''}, submitted ${fmtDT(e.checklist?.submitted_at, v.timezone)}`
        : e.submission === 'partial' ? `Checklist PARTIAL — ${e.checklist?.answered_items}/${e.checklist?.total_items} answered`
          : e.submission === 'not_submitted' ? 'Checklist NOT SUBMITTED' : 'No checklist assigned';
      L.push(`  ${st}`);
      for (const a of e.answers) L.push(`  • ${a.question}: ${indent(a.text || '—', '      ')}${a.late ? ' (late)' : ''}${a.revision > 1 ? ` (revised ×${a.revision - 1})` : ''}${a.note ? `\n      Note: ${a.note}` : ''}${a.files.length ? `\n      Files: ${a.files.join(', ')}` : ''}`);
      for (const u of e.unanswered) L.push(`  • ${u.question}: NOT ANSWERED${u.required ? ' (mandatory)' : ''}`);
      if (e.tasks_completed.length) L.push(`  Completed tasks: ${e.tasks_completed.map((t: any) => `${t.task_key} ${t.title}`).join('; ')}`);
      if (e.tasks_pending.length) L.push(`  Pending tasks (${e.tasks_pending.length}): ${e.tasks_pending.slice(0, 8).map((t: any) => `${t.task_key} ${t.title}${t.overdue ? ' [OVERDUE]' : ''}${t.status === 'blocked' ? ' [BLOCKED]' : ''}`).join('; ')}${e.tasks_pending.length > 8 ? '; …' : ''}`);
      if (e.daily_report) L.push(`  Daily report: ${e.daily_report.work_completed}${has(e.daily_report.challenges) ? ` · Challenges: ${e.daily_report.challenges}` : ''}`);
      if (e.activities.length) {
        L.push(`  Activities (${e.activities.length}):`);
        for (const a of e.activities) L.push(`    • ${fmtDT(a.occurred_at, v.timezone).slice(-5)} ${actLine(a)}`);
      }
      if (e.personal_report?.content) L.push(`  Personal EOD report (finalized):\n      ${indent(e.personal_report.content.trim(), '      ')}`);
      else if (e.personal_report) L.push('  Personal EOD report: draft, not finalized');
      L.push('');
    }
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// --------------------------------------------------------------------------- Excel
export async function sendEodXlsx(res: Response, v: EodView, mode: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = v.org_name;
  const head = (ws: ExcelJS.Worksheet, cols: { header: string; key: string; width?: number }[]) => {
    ws.columns = cols.map((c) => ({ ...c, width: c.width ?? 16 }));
    const r = ws.getRow(1);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } }; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const sum = wb.addWorksheet('Summary');
  sum.addRow([`${v.org_name} — End-of-Day report`]).font = { bold: true, size: 14 };
  sum.addRow([`Date: ${v.date} (${v.timezone})`, `Built: ${v.built_at.replace('T', ' ').slice(0, 16)} UTC`]);
  sum.addRow([]);
  for (const [k, val] of Object.entries(v.summary)) sum.addRow([k.replace(/_/g, ' '), val ?? '—']);
  sum.getColumn(1).width = 28; sum.getColumn(2).width = 24;

  const dep = wb.addWorksheet('Departments');
  head(dep, [{ header: 'Department', key: 'name', width: 24 }, { header: 'HOD', key: 'hod', width: 20 }, { header: 'Employees', key: 'employees' }, { header: 'Expected', key: 'expected' },
    { header: 'Submitted', key: 'submitted' }, { header: 'Partial', key: 'partial' }, { header: 'Not submitted', key: 'not_submitted' }, { header: 'Compliance %', key: 'compliance' },
    { header: 'Tasks completed', key: 'tc' }, { header: 'Open tasks', key: 'tp' }, { header: 'Overdue tasks', key: 'to' }]);
  v.departments.forEach((d: any) => dep.addRow({ name: d.name, hod: d.hod_name, employees: d.employees, expected: d.expected, submitted: d.submitted, partial: d.partial, not_submitted: d.not_submitted, compliance: d.compliance, tc: d.tasks_completed.length, tp: d.tasks_pending, to: d.tasks_overdue }));

  const emp = wb.addWorksheet('Employees');
  head(emp, [{ header: 'Employee', key: 'name', width: 24 }, { header: 'Code', key: 'code', width: 10 }, { header: 'Department', key: 'dept', width: 20 }, { header: 'Company', key: 'company', width: 22 }, { header: 'Submission', key: 'sub', width: 14 },
    { header: 'Answered', key: 'ans' }, { header: 'Total', key: 'tot' }, { header: 'Mandatory unanswered', key: 'mu' }, { header: 'Submitted at', key: 'at', width: 18 }, { header: 'Late', key: 'late', width: 8 },
    { header: 'Tasks completed', key: 'tc' }, { header: 'Pending tasks', key: 'tp' }, { header: 'Overdue tasks', key: 'to' }, { header: 'Activities', key: 'act' }, { header: 'Personal report', key: 'pr', width: 14 }]);
  v.employees.forEach((e: any) => emp.addRow({ name: e.name, code: e.employee_code, dept: e.department_name, company: e.company_name ?? '', act: e.activities.length, pr: e.personal_report?.status ?? '', sub: e.submission.replace(/_/g, ' '), ans: e.checklist?.answered_items ?? '', tot: e.checklist?.total_items ?? '',
    mu: e.unanswered.filter((u: any) => u.required).length, at: e.checklist?.submitted_at ? fmtDT(e.checklist.submitted_at, v.timezone) : '', late: e.checklist?.is_late ? 'yes' : '',
    tc: e.tasks_completed.length, tp: e.tasks_pending.length, to: e.tasks_pending.filter((t: any) => t.overdue).length }));

  const ans = wb.addWorksheet('Answers');
  head(ans, [{ header: 'Employee', key: 'e', width: 22 }, { header: 'Department', key: 'd', width: 18 }, { header: 'Section', key: 's', width: 18 }, { header: 'Question', key: 'q', width: 40 },
    { header: 'Answer', key: 'a', width: 60 }, { header: 'Note', key: 'n', width: 30 }, { header: 'Submitted', key: 't', width: 16 }, { header: 'Late', key: 'l', width: 7 }, { header: 'Revisions', key: 'r', width: 9 }]);
  for (const e of v.employees) {
    for (const a of e.answers) ans.addRow({ e: e.name, d: e.department_name, s: a.section, q: a.question, a: a.text, n: a.note, t: fmtDT(a.submitted_at, v.timezone), l: a.late ? 'yes' : '', r: Math.max(0, a.revision - 1) });
    for (const u of e.unanswered) ans.addRow({ e: e.name, d: e.department_name, s: u.section, q: u.question, a: u.required ? 'NOT ANSWERED (mandatory)' : 'Not answered' });
  }
  ans.getColumn('a').alignment = { wrapText: true, vertical: 'top' };

  const ns = wb.addWorksheet('Not submitted');
  head(ns, [{ header: 'Employee', key: 'n', width: 24 }, { header: 'Department', key: 'd', width: 20 }, { header: 'Status', key: 's', width: 14 }, { header: 'Answered', key: 'a' }, { header: 'Total', key: 't' }, { header: 'Mandatory unanswered', key: 'm' }, { header: 'Deadline', key: 'due', width: 16 }]);
  v.not_submitted.forEach((n: any) => ns.addRow({ n: n.name, d: n.department_name, s: n.status.replace(/_/g, ' '), a: n.answered, t: n.total, m: n.missing_required, due: fmtDT(n.due_at, v.timezone) }));

  const met = wb.addWorksheet('Metrics & URLs');
  head(met, [{ header: 'Department', key: 'd', width: 20 }, { header: 'Type', key: 'k', width: 12 }, { header: 'Employee / question', key: 'q', width: 40 }, { header: 'Value / URL', key: 'v', width: 60 }, { header: 'Detail', key: 'x', width: 24 }]);
  for (const d of v.departments) {
    d.metrics.forEach((m: any) => met.addRow({ d: d.name, k: 'metric', q: m.question, v: m.total ?? 'not reported', x: `${m.reported} of ${m.asked} reported${m.unit ? ` · ${m.unit}` : ''}` }));
    d.urls.forEach((u: any) => met.addRow({ d: d.name, k: 'url', q: `${u.employee} — ${u.question}`, v: u.url, x: u.published_at ? `published ${String(u.published_at).replace('T', ' ').slice(0, 16)}` : u.label ?? '' }));
    d.blockers.forEach((b: any) => met.addRow({ d: d.name, k: 'blocker', q: `${b.employee} — ${b.question}`, v: b.text, x: b.source }));
    d.delays.forEach((b: any) => met.addRow({ d: d.name, k: 'delay', q: `${b.employee} — ${b.question}`, v: b.text, x: b.source }));
  }

  const ac = wb.addWorksheet('Activities');
  head(ac, [{ header: 'Employee', key: 'e', width: 22 }, { header: 'Time', key: 't', width: 8 }, { header: 'Category', key: 'c', width: 30 }, { header: 'Description', key: 'd', width: 60 },
    { header: 'With', key: 'w', width: 28 }, { header: 'Project', key: 'p', width: 20 }, { header: 'Status', key: 's', width: 12 }, { header: 'Minutes', key: 'm', width: 9 },
    { header: 'Follow-up', key: 'f', width: 30 }, { header: 'Resolved', key: 'r', width: 10 }, { header: 'Bugs', key: 'b', width: 7 }]);
  for (const e of v.employees) {
    e.activities.forEach((a: any) => ac.addRow({ e: e.name, t: fmtDT(a.occurred_at, v.timezone).slice(-5), c: a.category, d: a.description, w: [...(a.participants ?? []), ...(a.departments ?? []).map((d: string) => `${d} team`)].join(', '),
      p: a.project_name ?? '', s: String(a.status).replace('_', ' '), m: a.duration_minutes ?? '', f: a.follow_up_required ? `${a.follow_up_done_at ? 'done' : 'open'}${a.follow_up_note ? `: ${a.follow_up_note}` : ''}` : '',
      r: a.issue_resolved === true ? 'yes' : a.issue_resolved === false ? 'no' : '', b: a.bugs_found ?? '' }));
  }
  ac.getColumn('d').alignment = { wrapText: true, vertical: 'top' };
  if (v.companies.length) {
    const co = wb.addWorksheet('Companies');
    head(co, [{ header: 'Company', key: 'n', width: 30 }, { header: 'Employees', key: 'e' }, { header: 'Expected', key: 'x' }, { header: 'Submitted', key: 's' }, { header: 'Compliance %', key: 'c' }, { header: 'Activities', key: 'a' }, { header: 'Tasks completed', key: 't' }]);
    v.companies.forEach((c: any) => co.addRow({ n: c.name, e: c.employees, x: c.expected, s: c.submitted, c: c.compliance, a: c.activities, t: c.tasks_completed }));
  }

  const tk = wb.addWorksheet('Tasks');
  head(tk, [{ header: 'Employee', key: 'e', width: 22 }, { header: 'State', key: 's', width: 12 }, { header: 'Task', key: 'k', width: 12 }, { header: 'Title', key: 't', width: 44 }, { header: 'Project', key: 'p', width: 22 }, { header: 'Status', key: 'st', width: 16 }, { header: 'Deadline / completed', key: 'd', width: 18 }]);
  for (const e of v.employees) {
    e.tasks_completed.forEach((t: any) => tk.addRow({ e: e.name, s: 'completed', k: t.task_key, t: t.title, p: t.project_name, st: 'completed', d: fmtDT(t.completed_at, v.timezone) }));
    e.tasks_pending.forEach((t: any) => tk.addRow({ e: e.name, s: t.overdue ? 'overdue' : 'pending', k: t.task_key, t: t.title, p: t.project_name, st: String(t.status).replace(/_/g, ' '), d: fmtDT(t.deadline, v.timezone) }));
  }
  const pr = wb.addWorksheet('Projects');
  head(pr, [{ header: 'Code', key: 'c', width: 10 }, { header: 'Project', key: 'n', width: 30 }, { header: 'Department', key: 'd', width: 20 }, { header: 'Status', key: 's', width: 12 }, { header: 'Progress %', key: 'p' }, { header: 'Open tasks', key: 'o' }, { header: 'Overdue tasks', key: 'od' }, { header: 'Completed today', key: 'ct' }]);
  v.projects.forEach((p: any) => pr.addRow({ c: p.code, n: p.name, d: p.department_name, s: p.status, p: p.progress, o: p.open_tasks, od: p.overdue_tasks, ct: p.completed_today }));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="EOD_${mode}_${v.date}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

// --------------------------------------------------------------------------- PDF
export function sendEodPdf(res: Response, v: EodView, mode: 'consolidated' | 'employee', meta: { generated_at?: string | null; trigger?: string | null }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="EOD_${mode}_${v.date}.pdf"`);
  doc.pipe(res);
  const W = doc.page.width - 80;
  const ensure = (h: number) => { if (doc.y + h > doc.page.height - 50) doc.addPage(); };
  const h1 = (t: string) => { ensure(40); doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor('#1E3A8A').text(t, 40, doc.y, { width: W }); doc.moveTo(40, doc.y + 2).lineTo(40 + W, doc.y + 2).strokeColor('#CBD5E1').stroke(); doc.moveDown(0.4).fillColor('#000'); };
  const h2 = (t: string) => { ensure(28); doc.moveDown(0.3).font('Helvetica-Bold').fontSize(9.5).fillColor('#334155').text(t, 40, doc.y, { width: W }).fillColor('#000'); };
  const bullet = (t: string) => { doc.font('Helvetica').fontSize(8.5); ensure(doc.heightOfString(t, { width: W - 14 }) + 4); doc.text('•', 46, doc.y, { continued: false }); doc.moveUp(); doc.text(t, 56, doc.y, { width: W - 16 }); };

  doc.font('Helvetica-Bold').fontSize(17).text(mode === 'consolidated' ? 'End-of-Day Report' : 'Employee-wise EOD Report');
  doc.font('Helvetica').fontSize(10).fillColor('#475569').text(`${v.org_name} · ${DateTime.fromISO(v.date).toFormat('cccc, dd LLLL yyyy')} (${v.timezone})`);
  doc.fontSize(8).text(meta.generated_at ? `Generated ${fmtDT(meta.generated_at, v.timezone)} (${meta.trigger})` : `Live preview built ${fmtDT(v.built_at, v.timezone)}`).fillColor('#000');

  const s = v.summary;
  doc.moveDown(0.8);
  const tiles: [string, string][] = [
    ['Checklists complete', `${s.submitted}/${s.expected}${s.compliance !== null ? ` (${s.compliance}%)` : ''}`], ['Partial', String(s.partial)], ['Not submitted', String(s.not_submitted)],
    ['Tasks completed', String(s.tasks_completed)], ['Pending tasks', `${s.tasks_pending} (${s.tasks_overdue} overdue)`], ['Blocked tasks', String(s.tasks_blocked)],
  ];
  const tw = W / 3; const y0 = doc.y;
  tiles.forEach(([k, val], i) => {
    const x = 40 + (i % 3) * tw; const y = y0 + Math.floor(i / 3) * 40;
    doc.roundedRect(x + 2, y, tw - 6, 34, 4).fillAndStroke('#F8FAFC', '#E2E8F0');
    doc.fillColor('#64748B').font('Helvetica').fontSize(7.5).text(k, x + 10, y + 6, { width: tw - 20 });
    doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(11).text(val, x + 10, y + 17, { width: tw - 20 });
  });
  doc.y = y0 + 84; doc.x = 40; doc.fillColor('#000');

  h1('Not submitted / incomplete');
  if (!v.not_submitted.length) bullet('Everyone with a checklist submitted it.');
  v.not_submitted.forEach((n: any) => bullet(`${n.name} (${n.department_name}) — ${n.status === 'partial' ? `partial ${n.answered}/${n.total}` : 'nothing submitted'}; ${n.missing_required} mandatory unanswered${n.overdue ? ' · overdue' : ''}`));

  if (mode === 'consolidated') {
    for (const d of v.departments) {
      h1(`${d.name}${d.hod_name ? ` — HOD ${d.hod_name}` : ''}  ·  ${d.expected ? `${d.submitted}/${d.expected} complete${d.compliance !== null ? ` (${d.compliance}%)` : ''}` : 'no checklists'}`);
      const sec = (t: string, rows: string[]) => { if (rows.length) { h2(t); rows.forEach(bullet); } };
      sec('Key metrics', d.metrics.map((m: any) => (m.total === null ? `${m.question}: not reported (0 of ${m.asked})` : `${m.question}: ${m.total.toLocaleString('en-US')}${m.unit ? ` ${m.unit}` : ''} (${m.reported} of ${m.asked} reported)`)));
      sec('Completed work', d.work_done.map((w: any) => `${w.employee}: ${w.text}`));
      sec('Tasks completed', d.tasks_completed.map((t: any) => `${t.employee}: ${t.task_key} ${t.title}${t.project_name ? ` [${t.project_name}]` : ''}`));
      sec('Daily activities & coordination', d.activities.map((a: any) => `${a.employee}: ${a.text}`));
      sec('Progress & deadlines', d.progress.map((w: any) => `${w.employee} — ${w.question}: ${w.text}`));
      sec('Campaigns', d.campaigns.map((w: any) => `${w.employee} — ${w.question}: ${w.text}`));
      sec('Published / supporting URLs', d.urls.map((u: any) => `${u.employee}: ${u.url}${u.published_at ? ` (published ${String(u.published_at).replace('T', ' ').slice(0, 16)})` : ''}`));
      sec('Blockers & dependencies', d.blockers.map((b: any) => `${b.employee} — ${b.question}: ${b.text}`));
      sec('Delays', d.delays.map((b: any) => `${b.employee} — ${b.question}: ${b.text}`));
      sec('Pending work', d.pending_work.map((w: any) => `${w.employee}: ${w.text}`));
      sec('Next plans', d.plans.map((w: any) => `${w.employee}: ${w.text}`));
      sec('Other updates', d.other.map((w: any) => `${w.employee} — ${w.question}: ${w.text}`));
      if (d.tasks_pending) { h2('Open tasks'); bullet(`${d.tasks_pending} open, ${d.tasks_overdue} overdue`); }
    }
    if (v.projects.length) {
      h1('Project progress');
      v.projects.forEach((p: any) => bullet(`${p.code} ${p.name} — ${p.progress}% · ${String(p.status).replace(/_/g, ' ')} · ${p.open_tasks} open (${p.overdue_tasks} overdue) · ${p.completed_today} completed today`));
    }
  } else {
    for (const e of v.employees) {
      h1(`${e.name}${e.employee_code ? ` (${e.employee_code})` : ''} — ${e.department_name ?? 'No department'}`);
      const st = e.submission === 'submitted' ? `Checklist complete${e.checklist?.is_late ? ' (late)' : ''} · submitted ${fmtDT(e.checklist?.submitted_at, v.timezone)}`
        : e.submission === 'partial' ? `Checklist PARTIAL — ${e.checklist?.answered_items}/${e.checklist?.total_items} answered`
          : e.submission === 'not_submitted' ? 'Checklist NOT SUBMITTED' : 'No checklist assigned';
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#475569').text(st, 40, doc.y, { width: W }).fillColor('#000');
      if (e.answers.length || e.unanswered.length) h2('Answers');
      e.answers.forEach((a: any) => bullet(`${a.question}: ${a.text}${a.late ? ' (late)' : ''}${a.revision > 1 ? ` (revised ×${a.revision - 1})` : ''}${a.note ? ` — Note: ${a.note}` : ''}${a.files.length ? ` — Files: ${a.files.join(', ')}` : ''}`));
      e.unanswered.forEach((u: any) => bullet(`${u.question}: NOT ANSWERED${u.required ? ' (mandatory)' : ''}`));
      if (e.tasks_completed.length) { h2('Completed tasks'); e.tasks_completed.forEach((t: any) => bullet(`${t.task_key} ${t.title}${t.project_name ? ` [${t.project_name}]` : ''}`)); }
      if (e.tasks_pending.length) { h2(`Pending tasks (${e.tasks_pending.length})`); e.tasks_pending.slice(0, 15).forEach((t: any) => bullet(`${t.task_key} ${t.title} — ${String(t.status).replace(/_/g, ' ')}, ${t.progress}%${t.overdue ? ' · OVERDUE' : ''}`)); }
      if (e.daily_report) { h2('Daily report'); bullet(e.daily_report.work_completed); if (has(e.daily_report.challenges)) bullet(`Challenges: ${e.daily_report.challenges}`); }
      if (e.activities.length) { h2(`Activities (${e.activities.length})`); e.activities.forEach((a: any) => bullet(`${fmtDT(a.occurred_at, v.timezone).slice(-5)} ${actLine(a)}`)); }
      if (e.personal_report?.content) { h2('Personal EOD report (finalized)'); e.personal_report.content.split('\n').filter((l: string) => l.trim()).forEach((l: string) => bullet(l.replace(/^•\s*/, ''))); }
    }
  }
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(7).fillColor('#94A3B8').text(`${v.org_name} · EOD ${v.date} · page ${i + 1} of ${range.count}`, 40, doc.page.height - 30, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
}

// --------------------------------------------------------------------------- storage & automation
export async function storeEodReport(date: string, trigger: 'auto' | 'manual', actorId: number | null) {
  const snap = await buildEodSnapshot(date);
  const view = deriveEodView(snap);
  const [row] = await db('eod_reports').insert({ report_date: date, trigger, generated_by: actorId, timezone: snap.timezone, summary: JSON.stringify(view.summary), data: JSON.stringify(snap) })
    .onConflict(db.raw('(organization_id, report_date) WHERE trigger = \'auto\'')).ignore().returning(['id', 'generated_at']);
  return row ? { id: row.id as number, generated_at: row.generated_at, summary: view.summary } : null;
}

/** Runs every minute per organization; generates the day's report once, after the configured local time. */
export async function autoGenerateEodInOrg(now = new Date()): Promise<number> {
  if (!(await getSetting('eod_auto_enabled'))) return 0;
  const time: string = await getSetting('eod_generation_time');
  if (!time) return 0;
  const tz: string = await getSetting('default_timezone');
  const days: number[] = await getSetting('working_days');
  const local = DateTime.fromJSDate(now).setZone(tz);
  if (!days.includes(local.weekday)) return 0;
  const [h, m] = time.split(':').map(Number);
  const target = local.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (local < target || local > target.plus({ hours: 6 })) return 0; // inside a 6-hour window after the configured time
  const date = local.toISODate()!;
  if (await db('eod_reports').where({ report_date: date, trigger: 'auto' }).first('id')) return 0;
  const r = await storeEodReport(date, 'auto', null);
  if (!r) return 0;
  const roles: string[] = await getSetting('eod_notify_roles');
  const managers: number[] = await db('users as u').join('roles as ro', 'ro.id', 'u.role_id').whereIn('ro.key', roles).where('u.is_active', true).whereNull('u.deleted_at').pluck('u.id');
  const hods: number[] = await db('departments').where('is_active', true).whereNotNull('hod_id').pluck('hod_id');
  const channels: Channel[] = await getSetting('checklist_channels');
  const s = r.summary;
  await notify({
    userIds: [...new Set([...managers, ...hods])], channels, category: 'system',
    title: `EOD report ready — ${date}`,
    body: `${s.submitted} of ${s.expected} checklists complete${s.compliance !== null ? ` (${s.compliance}%)` : ''}; ${s.not_submitted + s.partial} incomplete. ${s.tasks_completed} tasks completed, ${s.tasks_overdue} overdue.`,
    link: `/eod?date=${date}`, dedupePrefix: `eod:${r.id}`,
  }).catch((e) => logger.error({ e }, 'eod notify failed'));
  return 1;
}
