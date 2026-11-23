import { DateTime } from 'luxon';
import { db } from '../db/knex';
import { REPORT_SECTION_LABELS, ReportSection } from './categories';

/**
 * Personal EOD report, built only from what the person recorded: activities, personal tasks,
 * tasks completed in the task system, their checklist status, open follow-ups and the
 * next-day priorities they typed. Empty sections are left out; nothing is inferred.
 */

export async function buildPersonalEodData(userId: number, date: string) {
  const user = await db('users as u').leftJoin('departments as d', 'd.id', 'u.department_id').leftJoin('designations as g', 'g.id', 'u.designation_id')
    .leftJoin('companies as co', 'co.id', 'u.company_id').where('u.id', userId)
    .first('u.id', 'u.name', 'u.timezone', 'd.name as department_name', 'g.title as designation', 'co.name as company_name');
  const extra: string[] = await db('user_designations as ud').join('designations as g', 'g.id', 'ud.designation_id').where('ud.user_id', userId).orderBy(['ud.created_at', 'g.id']).pluck('g.title');
  const designations = [...new Set([user?.designation, ...extra].filter(Boolean))] as string[];
  const tz = user?.timezone || 'UTC';
  const start = DateTime.fromISO(date, { zone: tz }).startOf('day');
  const [s, e] = [start.toUTC().toJSDate(), start.plus({ days: 1 }).toUTC().toJSDate()];
  const tomorrow = start.plus({ days: 1 }).toISODate()!;

  const activities = await db('activities as a').join('activity_categories as c', 'c.id', 'a.category_id').leftJoin('projects as p', 'p.id', 'a.project_id')
    .where('a.user_id', userId).where('a.activity_date', date).whereNull('a.deleted_at').orderBy('a.occurred_at')
    .select('a.id', 'a.occurred_at', 'a.description', 'a.status', 'a.duration_minutes', 'a.follow_up_required', 'a.follow_up_note', 'a.follow_up_done_at',
      'a.issue_resolved', 'a.bugs_found', 'c.name as category', 'c.report_section as section', 'p.name as project_name',
      db.raw(`coalesce((SELECT json_agg(json_build_object('id', u.id, 'name', u.name, 'via', ap.via_department_id) ORDER BY u.name)
        FROM activity_participants ap JOIN users u ON u.id = ap.user_id WHERE ap.activity_id = a.id), '[]') AS participants`),
      db.raw(`coalesce((SELECT array_agg(d.name ORDER BY d.name) FROM departments d WHERE d.id = ANY(a.department_ids)), '{}') AS departments`));

  const [tasksDone, tasksPending, tasksTomorrow, assignedDone, followUps, checklist] = await Promise.all([
    db('personal_tasks as t').leftJoin('projects as p', 'p.id', 't.project_id').where('t.user_id', userId).whereNull('t.deleted_at').where('t.status', 'completed')
      .where('t.completed_at', '>=', s).where('t.completed_at', '<', e).orderBy('t.completed_at').select('t.id', 't.title', 't.completion_note', 't.priority', 'p.name as project_name'),
    db('personal_tasks as t').leftJoin('projects as p', 'p.id', 't.project_id').where('t.user_id', userId).whereNull('t.deleted_at').where('t.status', 'pending')
      .where((w) => w.whereNull('t.due_date').orWhere('t.due_date', '<=', date)).where('t.created_at', '<', e)
      .orderByRaw(`array_position(ARRAY['critical','high','medium','low'], t.priority), t.due_date NULLS LAST`).select('t.id', 't.title', 't.due_date', 't.priority', 'p.name as project_name'),
    db('personal_tasks as t').where('t.user_id', userId).whereNull('t.deleted_at').where('t.status', 'pending').where('t.due_date', tomorrow)
      .orderByRaw(`array_position(ARRAY['critical','high','medium','low'], t.priority)`).select('t.id', 't.title', 't.priority'),
    db('tasks as t').join('task_assignees as ta', 'ta.task_id', 't.id').where('ta.user_id', userId).where('t.status', 'completed').whereNull('t.deleted_at')
      .where('t.completed_at', '>=', s).where('t.completed_at', '<', e).select('t.id', 't.task_key', 't.title'),
    db('activities as a').where('a.user_id', userId).whereNull('a.deleted_at').where('a.follow_up_required', true).whereNull('a.follow_up_done_at')
      .where('a.activity_date', '<=', date).orderBy('a.occurred_at')
      .select('a.id', 'a.description', 'a.follow_up_note', 'a.follow_up_due', 'a.activity_date',
        db.raw(`coalesce((SELECT string_agg(u.name, ', ' ORDER BY u.name) FROM activity_participants ap JOIN users u ON u.id = ap.user_id WHERE ap.activity_id = a.id AND ap.via_department_id IS NULL), '') AS people`)),
    db('checklists').where({ user_id: userId, checklist_date: date }).first('status', 'answered_items', 'total_items', 'completion_percent'),
  ]);

  const time = (v: any) => DateTime.fromJSDate(new Date(v)).setZone(tz).toFormat('hh:mm a');
  const line = (a: any) => {
    const direct = a.participants.filter((p: any) => !p.via).map((p: any) => p.name);
    const who = [...direct, ...a.departments.map((d: string) => `${d} team`)];
    const bits = [
      who.length ? `with ${who.join(', ')}` : null,
      a.project_name ? `[${a.project_name}]` : null,
      a.duration_minutes ? `(${a.duration_minutes >= 60 ? `${+(a.duration_minutes / 60).toFixed(1)} h` : `${a.duration_minutes} min`})` : null,
      a.bugs_found ? `${a.bugs_found} bug${a.bugs_found > 1 ? 's' : ''} found` : null,
      a.issue_resolved === true ? 'resolved' : a.issue_resolved === false ? 'not yet resolved' : null,
      a.status !== 'completed' ? a.status.replace('_', ' ') : null,
    ].filter(Boolean);
    return { id: a.id, time: time(a.occurred_at), category: a.category, text: a.description, details: bits.join(' · '), status: a.status };
  };

  const bySection = (secs: ReportSection[], filter: (a: any) => boolean = () => true) => activities.filter((a: any) => secs.includes(a.section) && filter(a)).map(line);
  const completed = (a: any) => a.status === 'completed';
  const assistedMap = new Map<number, { name: string; count: number }>();
  for (const a of activities) {
    if (!['guidance', 'coordination', 'issue_resolution', 'review', 'updates', 'follow_up', 'assignment'].includes(a.section)) continue;
    for (const p of a.participants) if (!p.via) assistedMap.set(p.id, { name: p.name, count: (assistedMap.get(p.id)?.count ?? 0) + 1 });
  }
  const tested = activities.filter((a: any) => a.section === 'testing');
  const sections = [
    { key: 'coordination', title: 'Team coordination completed', items: bySection(['coordination', 'meeting']) },
    { key: 'updates', title: REPORT_SECTION_LABELS.updates, items: bySection(['updates']) },
    { key: 'assignment', title: REPORT_SECTION_LABELS.assignment, items: bySection(['assignment']) },
    { key: 'guidance', title: REPORT_SECTION_LABELS.guidance, items: bySection(['guidance']) },
    { key: 'assisted', title: 'Employees assisted', items: [...assistedMap.values()].sort((a, b) => b.count - a.count).map((p) => ({ text: `${p.name}${p.count > 1 ? ` (${p.count} times)` : ''}` })) },
    { key: 'issue_resolution', title: REPORT_SECTION_LABELS.issue_resolution, items: activities.filter((a: any) => a.section === 'issue_resolution' || a.issue_resolved === true).map(line) },
    { key: 'testing', title: REPORT_SECTION_LABELS.testing, items: tested.map(line) },
    { key: 'bugs', title: 'Bugs identified', items: activities.filter((a: any) => a.bugs_found > 0).map((a: any) => ({ ...line(a), text: `${a.bugs_found} bug${a.bugs_found > 1 ? 's' : ''} — ${a.description}` })) },
    { key: 'missing_functionality', title: REPORT_SECTION_LABELS.missing_functionality, items: bySection(['missing_functionality']) },
    { key: 'improvements', title: REPORT_SECTION_LABELS.improvements, items: bySection(['improvements']) },
    { key: 'review', title: REPORT_SECTION_LABELS.review, items: bySection(['review']) },
    { key: 'client_meeting', title: REPORT_SECTION_LABELS.client_meeting, items: bySection(['client_meeting']) },
    { key: 'client_requirements', title: 'Client requirements & coordination', items: bySection(['client_requirements', 'client_coordination']) },
    { key: 'development', title: 'Development activities completed', items: bySection(['development', 'documentation'], completed) },
    { key: 'follow_up', title: REPORT_SECTION_LABELS.follow_up, items: bySection(['follow_up'], completed) },
    { key: 'other', title: REPORT_SECTION_LABELS.other, items: bySection(['other']) },
    { key: 'tasks_done', title: 'Personal tasks completed', items: tasksDone.map((t: any) => ({ text: `${t.title}${t.project_name ? ` [${t.project_name}]` : ''}${t.completion_note ? ` — ${t.completion_note}` : ''}` })) },
    { key: 'assigned_done', title: 'Assigned tasks completed', items: assignedDone.map((t: any) => ({ text: `${t.task_key} ${t.title}` })) },
    {
      key: 'pending', title: 'Pending activities',
      items: [
        ...activities.filter((a: any) => a.status !== 'completed').map((a: any) => ({ ...line(a), text: `${a.category}: ${a.description}` })),
        ...followUps.map((f: any) => ({ text: `Follow-up${f.people ? ` with ${f.people}` : ''}: ${f.follow_up_note || f.description}${f.follow_up_due ? ` (due ${f.follow_up_due})` : ''}` })),
        ...tasksPending.map((t: any) => ({ text: `${t.title}${t.project_name ? ` [${t.project_name}]` : ''}${t.due_date && t.due_date < date ? ` (overdue since ${t.due_date})` : ''}` })),
      ],
    },
  ].filter((x) => x.items.length);

  const summary = {
    activities: activities.length,
    employees_assisted: assistedMap.size,
    client_meetings: activities.filter((a: any) => a.section === 'client_meeting').length,
    projects_tested: new Set(tested.map((a: any) => a.project_name ?? a.description)).size,
    bugs_found: activities.reduce((n: number, a: any) => n + (a.bugs_found ?? 0), 0),
    tasks_completed: tasksDone.length + assignedDone.length,
    pending: activities.filter((a: any) => a.status !== 'completed').length + followUps.length + tasksPending.length,
    minutes_logged: activities.reduce((n: number, a: any) => n + (a.duration_minutes ?? 0), 0),
  };

  return {
    user: { id: userId, name: user?.name, designations, department_name: user?.department_name ?? null, company_name: user?.company_name ?? null },
    date, timezone: tz, summary, sections,
    timeline: activities.map(line),
    scheduled_tomorrow: tasksTomorrow.map((t: any) => t.title),
    checklist: checklist ? { status: checklist.status, answered: checklist.answered_items, total: checklist.total_items, completion: checklist.completion_percent } : null,
  };
}
export type PersonalEodData = Awaited<ReturnType<typeof buildPersonalEodData>>;

/** Plain text, ready to paste (Bitrix24 accepts it as-is; the UI can add BBCode on copy). */
export function personalEodText(d: PersonalEodData, nextDayPriorities?: string | null) {
  const L: string[] = [];
  L.push(`Daily Work Report — ${d.user.name}`);
  if (d.user.designations.length) L.push(d.user.designations.join(' · '));
  L.push(`Date: ${DateTime.fromISO(d.date).toFormat('cccc, dd LLLL yyyy')}`);
  L.push('');
  const s = d.summary;
  if (!s.activities && !s.tasks_completed && !d.sections.length) {
    L.push('No activities or tasks were recorded for this date.');
  } else {
    const parts = [
      `${s.activities} activit${s.activities === 1 ? 'y' : 'ies'} recorded`,
      s.employees_assisted ? `${s.employees_assisted} employee${s.employees_assisted > 1 ? 's' : ''} assisted` : null,
      s.client_meetings ? `${s.client_meetings} client meeting${s.client_meetings > 1 ? 's' : ''}` : null,
      s.tasks_completed ? `${s.tasks_completed} task${s.tasks_completed > 1 ? 's' : ''} completed` : null,
      s.minutes_logged ? `${+(s.minutes_logged / 60).toFixed(1)} h logged` : null,
    ].filter(Boolean);
    L.push(`Summary: ${parts.join(' · ')}`);
    L.push('');
    for (const sec of d.sections) {
      L.push(sec.title.toUpperCase());
      for (const it of sec.items as any[]) L.push(`• ${it.time ? `${it.time} — ` : ''}${it.text}${it.details ? ` (${it.details})` : ''}`);
      L.push('');
    }
  }
  if (d.checklist) L.push(`Daily checklist: ${d.checklist.status === 'submitted' ? 'submitted' : `${d.checklist.answered}/${d.checklist.total} answered (not submitted)`}`, '');
  const prio = (nextDayPriorities ?? '').split('\n').map((x) => x.replace(/^[•\-*]\s*/, '').trim()).filter(Boolean);
  if (prio.length || d.scheduled_tomorrow.length) {
    L.push("NEXT DAY'S PRIORITIES");
    for (const p of prio) L.push(`• ${p}`);
    for (const t of d.scheduled_tomorrow) if (!prio.some((p) => p.toLowerCase() === t.toLowerCase())) L.push(`• ${t} (scheduled)`);
    L.push('');
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
