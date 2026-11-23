import { activeOrgIds, db, runInOrg } from '../db/knex';
import { audit } from '../lib/audit';
import { logger } from '../lib/logger';
import { nextOccurrence } from '../lib/recurrence';
import { Channel } from './channels';
import { render, resolveRecipients } from './events';
import { loadRule, notify } from './service';

const OPEN_STATUSES = ['not_started', 'in_progress', 'on_hold', 'blocked', 'revision_required'];

/** Mark tasks whose deadline has passed as overdue (and clear the flag when moved forward). */
export const markOverdue = () => forEachOrg(markOverdueInOrg);
async function markOverdueInOrg() {
  const newly = await db('tasks').whereNull('deleted_at').where('is_overdue', false).where('is_recurring_template', false)
    .whereIn('status', OPEN_STATUSES).where('deadline', '<', new Date()).update({ is_overdue: true, updated_at: db.fn.now() }).returning('id');
  for (const r of newly) {
    await audit({ actorId: null }, { action: 'task.marked_overdue', entityType: 'task', entityId: r.id, summary: 'Deadline passed; marked overdue by system' });
  }
  await db('tasks').where('is_overdue', true).where((w) => w.where('deadline', '>=', new Date()).orWhereIn('status', ['completed', 'cancelled']))
    .update({ is_overdue: false });
  return newly.length;
}

/**
 * Deadline & escalation engine. For each active rule, finds open tasks whose
 * (deadline + offset) has been reached and that have not yet been escalated for
 * that rule at the current deadline. escalation_history's unique key
 * (task, rule, deadline_snapshot) guarantees each level fires exactly once per deadline —
 * and fires again if the deadline is later moved and missed again.
 */
export const runEscalations = () => forEachOrg(runEscalationsInOrg);
async function runEscalationsInOrg() {
  const rules = await db('escalation_rules').where({ is_active: true }).orderBy('level');
  let count = 0;
  for (const rule of rules) {
    const q = db('tasks as t').whereNull('t.deleted_at').where('t.is_recurring_template', false).whereNotNull('t.deadline')
      .whereIn('t.status', OPEN_STATUSES)
      .whereRaw(`t.deadline + make_interval(mins => ?) <= now()`, [rule.offset_minutes])
      .whereNotExists(db('escalation_history as h').whereRaw('h.task_id = t.id').andWhere('h.rule_id', rule.id).whereRaw('h.deadline_snapshot = t.deadline'))
      .select('t.id', 't.task_key', 't.title', 't.deadline', 't.priority', 't.project_id', 't.department_id')
      .limit(500);
    // "Before deadline" reminders are pointless once the deadline has passed.
    if (rule.offset_minutes < 0) q.where('t.deadline', '>', new Date());
    // Don't retro-fire very old reminders when a rule is created: only within 7 days of trigger time.
    q.whereRaw(`t.deadline + make_interval(mins => ?) > now() - interval '7 days'`, [rule.offset_minutes]);
    if (rule.priority_filter?.length) q.whereIn('t.priority', rule.priority_filter);
    if (rule.department_id) q.where('t.department_id', rule.department_id);
    if (rule.project_id) q.where('t.project_id', rule.project_id);
    if (rule.task_type) q.where('t.task_type', rule.task_type);

    for (const task of await q) {
      const recipients = await resolveRecipients(rule.notify_roles, { taskId: task.id });
      const [hist] = await db('escalation_history').insert({
        task_id: task.id, rule_id: rule.id, level: rule.level, deadline_snapshot: task.deadline, notified_user_ids: recipients,
        note: rule.name,
      }).onConflict(['task_id', 'rule_id', 'deadline_snapshot']).ignore().returning('id');
      if (!hist) continue; // another worker got there first
      count++;
      const mins = Math.round((Date.now() - new Date(task.deadline).getTime()) / 60000);
      const when = mins < 0 ? `due in ${fmtDur(-mins)}` : mins < 5 ? 'due now' : `overdue by ${fmtDur(mins)}`;
      const vars = { task, when, level: rule.level, rule: rule.name };
      const body = rule.message_template ? render(rule.message_template, vars) : `${task.task_key} "${task.title}" is ${when}.`;
      await notify({
        userIds: recipients, channels: rule.channels as Channel[], category: rule.offset_minutes < 0 ? 'reminder' : 'escalation',
        title: rule.offset_minutes < 0 ? `Deadline approaching: ${task.title}` : `Escalation L${rule.level}: ${task.title}`,
        body, link: `/tasks/${task.id}`, dedupePrefix: `esc:${hist.id}`, escalationId: hist.id, occurrenceAt: new Date(),
      });
      await audit({ actorId: null }, { action: 'task.escalated', entityType: 'task', entityId: task.id, summary: `${rule.name} (L${rule.level}) → ${recipients.length} recipient(s)` });
    }
  }
  return count;
}

function fmtDur(mins: number) {
  if (mins < 60) return `${mins} min`;
  if (mins < 1440) return `${Math.round(mins / 60)} h`;
  return `${Math.round(mins / 1440)} day(s)`;
}

/**
 * Recurring tasks: each template spawns an instance 24h before its next occurrence
 * (the occurrence time is the instance deadline). Unique (parent, deadline) prevents duplicates.
 */
export const generateRecurringTasks = () => forEachOrg(generateRecurringTasksInOrg);
async function generateRecurringTasksInOrg() {
  const templates = await db('tasks').where({ is_recurring_template: true }).whereNull('deleted_at').whereNot('status', 'cancelled')
    .whereNotNull('recurrence_next_at').where('recurrence_next_at', '<=', new Date(Date.now() + 24 * 3600_000));
  let created = 0;
  for (const t of templates) {
    const rule = await loadRule(t.recurring_schedule_id);
    if (!rule) continue;
    const due = new Date(t.recurrence_next_at);
    await db.transaction(async (trx) => {
      const [inst] = await trx('tasks').insert({
        title: t.title, description: t.description, department_id: t.department_id, project_id: t.project_id, assigned_by: t.assigned_by,
        priority: t.priority, complexity: t.complexity, task_type: t.task_type, estimated_hours: t.estimated_hours,
        start_date: due.toISOString().slice(0, 10), deadline: due, recurrence_parent_id: t.id, remarks: t.remarks,
      }).onConflict(trx.raw('(recurrence_parent_id, deadline) WHERE recurrence_parent_id IS NOT NULL')).ignore().returning('id');
      if (inst) {
        const assignees = await trx('task_assignees').where({ task_id: t.id });
        if (assignees.length) await trx('task_assignees').insert(assignees.map((a: any) => ({ task_id: inst.id, user_id: a.user_id, is_primary: a.is_primary, assigned_by: t.assigned_by })));
        const checklist = await trx('task_checklist_items').where({ task_id: t.id });
        if (checklist.length) await trx('task_checklist_items').insert(checklist.map((c: any) => ({ task_id: inst.id, label: c.label, sort_order: c.sort_order })));
        created++;
      }
      const count = t.recurrence_count + 1;
      const next = nextOccurrence(rule, due, count);
      await trx('tasks').where({ id: t.id }).update({ recurrence_next_at: next, recurrence_count: count });
    });
  }
  return created;
}

export async function runMaintenanceSafely(name: string, fn: () => Promise<unknown>) {
  try {
    const r = await fn();
    logger.debug({ name, r }, 'maintenance done');
    return r;
  } catch (e) {
    logger.error({ e, name }, 'maintenance failed');
    throw e;
  }
}

/**
 * Run a maintenance function once per active organization, each inside its own
 * org-scoped transaction (RLS + default organization_id), and sum the results.
 * A failure in one tenant does not stop the others.
 */
export async function forEachOrg(fn: () => Promise<number>): Promise<number> {
  let total = 0;
  for (const orgId of await activeOrgIds()) {
    try { total += await runInOrg(orgId, fn); } catch (e) { logger.error({ e, orgId }, 'tenant maintenance failed'); }
  }
  return total;
}
