import { DateTime } from 'luxon';
import { afterCommit, currentOrgId, db, withSavepoint } from '../db/knex';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import { getSetting } from '../lib/settings';
import { Channel } from '../notifications/channels';
import { getQueues } from '../notifications/queues';
import { notify } from '../notifications/service';
import { conditionMet } from './answers';
import { dueAtFor, occursOn } from './schedule';

/** Employment statuses that receive checklists (active employees, including those serving notice). */
export const CHECKLIST_STATUSES = ['active', 'notice'];

export const localDateIn = (tz: string, at = new Date()) => DateTime.fromJSDate(at).setZone(tz || 'UTC').toISODate()!;

export interface QuestionCtx { qs: any[]; assigns: any[]; workingDays: number[] }

/** Active questions (in active sections) with their assignments. */
export async function loadQuestionCtx(): Promise<QuestionCtx> {
  const qs = await db('questions as q').leftJoin('question_sections as s', 's.id', 'q.section_id')
    .whereNull('q.deleted_at').where('q.is_active', true)
    .where((w) => w.whereNull('q.section_id').orWhere((w2) => w2.where('s.is_active', true).whereNull('s.deleted_at')))
    .select('q.*', 's.name as section_name', db.raw('coalesce(s.sort_order, 999999) as section_order'));
  const assigns = qs.length ? await db('question_assignments').whereIn('question_id', qs.map((q) => q.id)) : [];
  const workingDays: number[] = await getSetting('working_days');
  return { qs, assigns, workingDays };
}

/** Questions that apply to this employee on this local date (most specific assignment wins). */
export function applicableQuestions(user: { id: number; department_id: number | null }, date: string, ctx: QuestionCtx) {
  const out: { q: any; assignment: any }[] = [];
  for (const q of ctx.qs) {
    const mine = ctx.assigns.filter((a) => a.question_id === q.id);
    const assignment = mine.find((a) => a.target_type === 'user' && a.user_id === user.id)
      ?? mine.find((a) => a.target_type === 'department' && user.department_id && a.department_id === user.department_id)
      ?? mine.find((a) => a.target_type === 'all');
    if (!assignment) continue;
    if (!occursOn(q, date, ctx.workingDays)) continue;
    out.push({ q, assignment });
  }
  return out;
}

const snapshot = (q: any) => ({
  section_name: q.section_name ?? null, question_text: q.text, help_text: q.help_text, answer_type: q.answer_type,
  options: JSON.stringify(q.options ?? {}), is_required: q.is_required, priority: q.priority, report_tag: q.report_tag,
  sort_order: q.sort_order, section_order: Number(q.section_order ?? 999999),
  condition_question_id: q.condition_question_id, condition_operator: q.condition_operator,
  condition_value: q.condition_value === null || q.condition_value === undefined ? null : JSON.stringify(q.condition_value),
  reminder_offsets: q.reminder_offsets ?? [],
});

/**
 * Create or refresh one employee's checklist for a local date. Idempotent:
 *  - unique (user, date) and (checklist, question) make duplicate generation impossible;
 *  - questions that no longer apply are removed only while unanswered (no draft, not submitted);
 *  - unanswered items pick up edits to their question; answered items keep their snapshot.
 */
export async function syncUserChecklist(user: any, date: string, ctx: QuestionCtx, opts: { notify?: boolean } = {}) {
  const tz = user.timezone || 'UTC';
  const applicable = applicableQuestions(user, date, ctx);
  let cl = await db('checklists').where({ user_id: user.id, checklist_date: date }).first();
  if (!applicable.length && !cl) return null;
  const isNew = !cl;
  if (!cl) {
    [cl] = await db('checklists').insert({ user_id: user.id, checklist_date: date, department_id: user.department_id, timezone: tz })
      .onConflict(['user_id', 'checklist_date']).ignore().returning('*');
    if (!cl) cl = await db('checklists').where({ user_id: user.id, checklist_date: date }).first();
  }
  const items = await db('checklist_items').where({ checklist_id: cl.id });
  const have = new Map(items.map((i: any) => [i.question_id, i]));
  const wanted = new Set(applicable.map((a) => a.q.id));

  const toInsert = applicable.filter((a) => !have.has(a.q.id)).map(({ q, assignment }) => ({
    checklist_id: cl.id, question_id: q.id, assignment_id: assignment.id, assigned_by: assignment.created_by ?? q.created_by,
    ...snapshot(q), due_at: dueAtFor(date, String(q.deadline_time), tz),
  }));
  const inserted = toInsert.length
    ? await db('checklist_items').insert(toInsert).onConflict(['checklist_id', 'question_id']).ignore().returning(['id', 'question_id', 'question_text'])
    : [];

  const untouched = (i: any) => ['pending', 'skipped'].includes(i.status) && !i.draft && !i.revision;
  const stale = items.filter((i: any) => i.question_id && !wanted.has(i.question_id) && untouched(i)).map((i: any) => i.id);
  if (stale.length) await db('checklist_items').whereIn('id', stale).del();
  for (const { q } of applicable) {
    const it: any = have.get(q.id);
    if (it && untouched(it) && new Date(q.updated_at) > new Date(it.updated_at)) {
      await db('checklist_items').where({ id: it.id }).update({ ...snapshot(q), due_at: dueAtFor(date, String(q.deadline_time), tz), updated_at: db.fn.now() });
    }
  }
  await recomputeChecklist(cl.id);

  if (opts.notify && inserted.length && (await getSetting('checklist_notify_new_questions'))) {
    // Only questions this employee has never had before count as "new" (not every daily repeat).
    const seen: number[] = await db('checklist_items as ci').join('checklists as c', 'c.id', 'ci.checklist_id')
      .where('c.user_id', user.id).where('c.checklist_date', '<', date).whereIn('ci.question_id', inserted.map((r: any) => r.question_id))
      .distinct('ci.question_id').pluck('ci.question_id');
    const fresh = inserted.filter((r: any) => !seen.includes(r.question_id));
    if (fresh.length) {
      const channels: Channel[] = await getSetting('checklist_channels');
      const first = fresh.slice(0, 3).map((r: any) => `• ${r.question_text}`).join('\n');
      await notify({
        userIds: [user.id], channels, category: 'event',
        title: fresh.length === 1 ? 'New question assigned to you' : `${fresh.length} new questions assigned to you`,
        body: `Your checklist for ${date} ${isNew ? 'includes' : 'now includes'}:\n${first}${fresh.length > 3 ? `\n…and ${fresh.length - 3} more` : ''}`,
        link: `/checklist?date=${date}`, dedupePrefix: `cknew:${cl.id}:${fresh.map((r: any) => r.question_id).sort((a: number, b: number) => a - b).join('-')}`,
      });
    }
  }
  return cl.id as number;
}

/** Re-evaluate conditions, counts, completion and status of a checklist. */
export async function recomputeChecklist(checklistId: number) {
  const cl = await db('checklists').where({ id: checklistId }).first();
  if (!cl) return null;
  const items = await db('checklist_items').where({ checklist_id: checklistId }).orderBy(['section_order', 'sort_order', 'id']);
  const byQ = new Map(items.filter((i: any) => i.question_id).map((i: any) => [i.question_id, i]));
  const memo = new Map<number, boolean>();
  const applicable = (it: any, depth = 0): boolean => {
    if (memo.has(it.id)) return memo.get(it.id)!;
    let ok = true;
    if (it.condition_operator && it.condition_question_id && depth < 10) {
      const ctl: any = byQ.get(it.condition_question_id);
      // A condition on a question this employee doesn't have can't be evaluated → show the question.
      if (ctl) {
        const ctlApplicable = applicable(ctl, depth + 1);
        const value = !ctlApplicable ? null : ctl.status === 'submitted' ? ctl.answer : ctl.draft?.value;
        ok = conditionMet(it.condition_operator, it.condition_value, value, ctl.answer_type);
      }
    }
    memo.set(it.id, ok);
    return ok;
  };
  let total = 0, required = 0, answered = 0, requiredAnswered = 0, anyActivity = false;
  let dueAt: Date | null = null;
  let lastRequiredSubmit: Date | null = null;
  for (const it of items) {
    const ok = applicable(it);
    if (!ok && it.status === 'pending') await db('checklist_items').where({ id: it.id }).update({ status: 'skipped', updated_at: db.fn.now() });
    if (ok && it.status === 'skipped') await db('checklist_items').where({ id: it.id }).update({ status: it.draft ? 'draft' : 'pending', updated_at: db.fn.now() });
    if (it.status === 'draft' || it.status === 'submitted') anyActivity = true;
    if (!ok) continue;
    total++;
    const submitted = it.status === 'submitted';
    if (submitted) answered++;
    if (it.is_required) {
      required++;
      if (submitted) { requiredAnswered++; if (!lastRequiredSubmit || new Date(it.submitted_at) > lastRequiredSubmit) lastRequiredSubmit = new Date(it.submitted_at); }
      if (!dueAt || new Date(it.due_at) < dueAt) dueAt = new Date(it.due_at);
    }
  }
  if (!dueAt) for (const it of items) if (memo.get(it.id) && (!dueAt || new Date(it.due_at) < dueAt)) dueAt = new Date(it.due_at);
  const complete = total > 0 && requiredAnswered === required && (required > 0 || answered > 0);
  const completion = total ? Math.round((answered / total) * 100) : 0;
  const completedAt = complete ? (lastRequiredSubmit ?? new Date(Math.max(...items.filter((i: any) => i.submitted_at).map((i: any) => new Date(i.submitted_at).getTime())))) : null;
  const patch = {
    total_items: total, required_items: required, answered_items: answered, required_answered: requiredAnswered, completion_percent: completion,
    status: complete ? 'submitted' : anyActivity ? 'in_progress' : 'pending', due_at: dueAt,
    submitted_at: complete ? (cl.submitted_at ?? completedAt) : null,
    first_submitted_at: cl.first_submitted_at ?? (complete ? completedAt : null),
    is_late: complete && dueAt && completedAt ? completedAt > dueAt : false,
    updated_at: db.fn.now(),
  };
  await db('checklists').where({ id: checklistId }).update(patch);
  return { ...cl, ...patch };
}

/** Active employees eligible for checklists. */
export const eligibleUsersQuery = () => db('users').where('is_active', true).whereNull('deleted_at').whereIn('employment_status', CHECKLIST_STATUSES);

/** Generate / refresh today's checklists (employee-local date) for every eligible employee of the current org. */
export async function generateChecklistsInOrg(now = new Date(), userIds?: number[]): Promise<number> {
  const ctx = await loadQuestionCtx();
  const q = eligibleUsersQuery().select('id', 'department_id', 'timezone');
  if (userIds) q.whereIn('id', userIds);
  const users = await q;
  let n = 0;
  for (const u of users) {
    try {
      // savepoint per employee: one bad row must not abort the whole tenant run
      await withSavepoint(async () => { if (await syncUserChecklist(u, localDateIn(u.timezone, now), ctx, { notify: true })) n++; });
    } catch (e) { logger.error({ e, userId: u.id }, 'checklist generation failed for user'); }
  }
  return n;
}

/** Ask the worker to regenerate this organization's checklists soon (after commit; coalesced per 10 s). */
export async function requestChecklistSync() {
  const orgId = currentOrgId();
  if (!orgId) return;
  await afterCommit(async () => {
    try {
      await getQueues().maintenance.add('generate-checklists', { orgId }, { jobId: `gen-${orgId}-${Math.floor(Date.now() / 10_000)}`, removeOnComplete: true, removeOnFail: 100 });
    } catch (e) { logger.warn({ e }, 'could not enqueue checklist sync'); }
  });
}

// =========================================================================== reminders
/**
 * Reminders before item deadlines (per question `reminder_offsets`), consolidated per
 * checklist × deadline × offset so an employee gets one message, not one per question.
 * Only reminders whose time passed within the last 30 minutes are sent (no flood after downtime);
 * notification dedupe keys make repeated runs harmless.
 */
export async function runChecklistRemindersInOrg(): Promise<number> {
  const rows = await db.raw(`
    SELECT i.checklist_id, c.user_id, c.checklist_date::text AS checklist_date, i.due_at, o AS offset_min, count(*)::int AS n,
           (array_agg(i.question_text ORDER BY i.section_order, i.sort_order))[1:3] AS sample
    FROM checklist_items i
    JOIN checklists c ON c.id = i.checklist_id
    JOIN users u ON u.id = c.user_id AND u.is_active AND u.deleted_at IS NULL
    CROSS JOIN LATERAL unnest(i.reminder_offsets) AS o
    WHERE i.status IN ('pending','draft') AND i.due_at > now()
      AND i.due_at - make_interval(mins => o) <= now()
      AND i.due_at - make_interval(mins => o) > now() - interval '30 minutes'
    GROUP BY i.checklist_id, c.user_id, c.checklist_date, i.due_at, o`);
  if (!rows.rows.length) return 0;
  const channels: Channel[] = await getSetting('checklist_channels');
  let sent = 0;
  for (const r of rows.rows) {
    const due = DateTime.fromJSDate(new Date(r.due_at));
    const ids = await notify({
      userIds: [r.user_id], channels, category: 'reminder',
      title: `${r.n} checklist question${r.n > 1 ? 's' : ''} due in ${r.offset_min >= 60 ? `${Math.round(r.offset_min / 60)} h` : `${r.offset_min} min`}`,
      body: `Please answer before the deadline (${due.toUTC().toFormat("yyyy-LL-dd HH:mm 'UTC'")}):\n${r.sample.map((s: string) => `• ${s}`).join('\n')}${r.n > 3 ? `\n…and ${r.n - 3} more` : ''}`,
      link: `/checklist?date=${r.checklist_date}`, dedupePrefix: `ckrem:${r.checklist_id}:${new Date(r.due_at).getTime()}:${r.offset_min}`,
    });
    if (ids.length) sent++;
  }
  return sent;
}

// =========================================================================== escalations
async function recipientsFor(role: string, c: any): Promise<number[]> {
  switch (role) {
    case 'employee': return [c.user_id];
    case 'team_leader': return (await db('teams').where({ id: c.team_id ?? 0 }).whereNotNull('leader_id').pluck('leader_id')) as number[];
    case 'hod': return (await db('departments').where({ id: c.user_department_id ?? c.department_id ?? 0 }).whereNotNull('hod_id').pluck('hod_id')) as number[];
    case 'manager': return c.manager_id ? [c.manager_id] : [];
    case 'admin':
    case 'director':
      return db('users as u').join('roles as r', 'r.id', 'u.role_id').where('r.key', role === 'admin' ? 'super_admin' : 'director')
        .where('u.is_active', true).whereNull('u.deleted_at').pluck('u.id');
    default: return [];
  }
}

/**
 * Configurable escalation of incomplete checklists. Each rule fires at most once per checklist
 * (unique checklist × rule). Employees get one message about their own checklist; supervisors get
 * one consolidated message per rule run listing everyone in their care who is still incomplete.
 */
export async function runChecklistEscalationsInOrg(): Promise<number> {
  const rules = await db('checklist_escalation_rules').where({ is_active: true }).orderBy(['level', 'offset_minutes']);
  if (!rules.length) return 0;
  const channels0: Channel[] = await getSetting('checklist_channels');
  let count = 0;
  for (const rule of rules) {
    const q = db('checklists as c').join('users as u', 'u.id', 'c.user_id')
      .where('u.is_active', true).whereNull('u.deleted_at')
      .whereNot('c.status', 'submitted').whereRaw('c.required_answered < c.required_items').whereNotNull('c.due_at')
      .whereRaw('c.due_at + make_interval(mins => ?) <= now()', [rule.offset_minutes])
      .whereRaw(`c.due_at + make_interval(mins => ?) > now() - interval '2 days'`, [rule.offset_minutes])
      .whereNotExists(db('checklist_escalations as e').whereRaw('e.checklist_id = c.id').andWhere('e.rule_id', rule.id))
      .select('c.id', 'c.user_id', 'c.checklist_date', 'c.department_id', 'c.required_items', 'c.required_answered',
        'u.name', 'u.team_id', 'u.manager_id', 'u.department_id as user_department_id')
      .limit(1000);
    if (rule.department_id) q.where('c.department_id', rule.department_id);
    const due = await q;
    const digest = new Map<number, { name: string; date: string; missing: number }[]>();
    const digestIds = new Map<number, number[]>();
    for (const c of due) {
      const recipients = new Set<number>();
      for (const role of rule.notify_roles) for (const id of await recipientsFor(role, c)) recipients.add(id);
      const [esc] = await db('checklist_escalations').insert({ checklist_id: c.id, rule_id: rule.id, level: rule.level, notified_user_ids: [...recipients] })
        .onConflict(['checklist_id', 'rule_id']).ignore().returning('id');
      if (!esc) continue;
      count++;
      const missing = c.required_items - c.required_answered;
      const date = String(c.checklist_date);
      if (recipients.has(c.user_id) && rule.notify_roles.includes('employee')) {
        await notify({
          userIds: [c.user_id], channels: (rule.channels as Channel[]) ?? channels0, category: 'escalation',
          title: `Checklist overdue (${date})`,
          body: `${missing} mandatory question${missing > 1 ? 's are' : ' is'} still unanswered. Please complete your checklist.`,
          link: `/checklist?date=${date}`, dedupePrefix: `ckesc:${rule.id}:${c.id}`,
        });
      }
      for (const r of recipients) {
        if (r === c.user_id) continue;
        if (!digest.has(r)) { digest.set(r, []); digestIds.set(r, []); }
        digest.get(r)!.push({ name: c.name, date, missing });
        digestIds.get(r)!.push(c.id);
      }
      await audit({ actorId: null }, { action: 'checklist.escalated', entityType: 'checklist', entityId: c.id, summary: `${rule.name} (L${rule.level}) → ${recipients.size} recipient(s)` });
    }
    for (const [recipient, people] of digest) {
      const lines = people.slice(0, 15).map((p) => `• ${p.name} — ${p.missing} mandatory unanswered (${p.date})`).join('\n');
      await notify({
        userIds: [recipient], channels: (rule.channels as Channel[]) ?? channels0, category: 'escalation',
        title: `Incomplete checklists: ${people.length} ${people.length === 1 ? 'person' : 'people'} (L${rule.level})`,
        body: `${rule.name}\n${lines}${people.length > 15 ? `\n…and ${people.length - 15} more` : ''}`,
        link: '/compliance', dedupePrefix: `ckesc:${rule.id}:d:${digestIds.get(recipient)!.sort((a, b) => a - b).join('-')}`,
      });
    }
  }
  return count;
}

/** When an employee is deactivated, drop their untouched open checklists (no answers, no drafts). History stays. */
export async function dropUntouchedChecklists(userId: number) {
  const u = await db('users').where({ id: userId }).first('timezone');
  // Only today's and future checklists: missed checklists from earlier days are part of the record.
  const open = await db('checklists').where({ user_id: userId }).where('checklist_date', '>=', localDateIn(u?.timezone ?? 'UTC'))
    .whereNot('status', 'submitted').pluck('id');
  for (const id of open) {
    const touched = await db('checklist_items').where({ checklist_id: id }).where((w) => w.whereNotNull('draft').orWhere('revision', '>', 0)).first('id');
    if (!touched) await db('checklists').where({ id }).del();
  }
}
