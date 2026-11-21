import crypto from 'crypto';
import { db } from '../db/knex';
import { logger } from '../lib/logger';
import { pushRealtime } from '../lib/realtime';
import { Channel } from './channels';
import { createNotificationLogs } from './service';
import { enqueueDeliveries } from './queues';

export const EVENT_TYPES = {
  'task.assigned': 'Task assigned / reassigned',
  'task.submitted': 'Task submitted for review',
  'task.approved': 'Task approved (completed)',
  'task.revision_required': 'Revision requested',
  'task.rejected': 'Submission rejected',
  'task.blocked': 'Task blocked',
  'task.deadline_changed': 'Task deadline changed',
  'task.comment': 'Comment / mention on task',
  'task.extension_requested': 'Deadline extension requested',
  'task.extension_decided': 'Extension approved / rejected',
  'project.status_changed': 'Project status changed',
  'project.converted': 'Future project converted to active',
  'approval.requested': 'Approval requested',
  'approval.decided': 'Approval decided',
  'daily_report.reviewed': 'Daily report reviewed',
  'meeting.scheduled': 'Meeting scheduled',
} as const;
export type EventType = keyof typeof EVENT_TYPES;

export const RECIPIENT_ROLES = ['assignee', 'assigner', 'hod', 'team_leader', 'project_manager', 'admin', 'director', 'mentioned', 'requester', 'reviewer', 'attendees'] as const;

/** Resolve abstract recipient roles (relative to a task/project) to user ids. */
export async function resolveRecipients(roles: string[], ctx: { taskId?: number; projectId?: number; extraUserIds?: Record<string, number[]> }) {
  const out = new Set<number>();
  let task: any = null;
  if (ctx.taskId) task = await db('tasks').where({ id: ctx.taskId }).first('id', 'assigned_by', 'department_id', 'project_id');
  const projectId = ctx.projectId ?? task?.project_id;
  const assignees: number[] = task ? await db('task_assignees').where({ task_id: task.id }).pluck('user_id') : [];

  for (const role of roles) {
    switch (role) {
      case 'assignee': assignees.forEach((a) => out.add(a)); break;
      case 'assigner': if (task?.assigned_by) out.add(task.assigned_by); break;
      case 'hod': {
        const deptIds = new Set<number>();
        if (task?.department_id) deptIds.add(task.department_id);
        if (assignees.length) (await db('users').whereIn('id', assignees).pluck('department_id')).forEach((d: number) => d && deptIds.add(d));
        if (!task && projectId) { const p = await db('projects').where({ id: projectId }).first('department_id', 'hod_id'); if (p?.hod_id) out.add(p.hod_id); if (p?.department_id) deptIds.add(p.department_id); }
        if (deptIds.size) (await db('departments').whereIn('id', [...deptIds]).whereNotNull('hod_id').pluck('hod_id')).forEach((h: number) => out.add(h));
        break;
      }
      case 'team_leader': {
        if (!assignees.length) break;
        (await db('users as u').join('teams as t', 't.id', 'u.team_id').whereIn('u.id', assignees).whereNotNull('t.leader_id').pluck('t.leader_id'))
          .forEach((l: number) => out.add(l));
        break;
      }
      case 'project_manager': {
        if (!projectId) break;
        const p = await db('projects').where({ id: projectId }).first('manager_id');
        if (p?.manager_id) out.add(p.manager_id);
        break;
      }
      case 'admin':
      case 'director': {
        const key = role === 'admin' ? 'super_admin' : 'director';
        (await db('users as u').join('roles as r', 'r.id', 'u.role_id').where('r.key', key).andWhere('u.is_active', true).whereNull('u.deleted_at').pluck('u.id'))
          .forEach((id: number) => out.add(id));
        break;
      }
      default:
        (ctx.extraUserIds?.[role] ?? []).forEach((id) => out.add(id));
    }
  }
  return [...out];
}

export function render(tpl: string, vars: Record<string, any>) {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const v = path.split('.').reduce((o: any, k) => (o == null ? undefined : o[k]), vars);
    return v == null ? '' : String(v);
  });
}

export interface EmitInput {
  type: EventType;
  actorId: number | null;
  taskId?: number;
  projectId?: number;
  link?: string;
  vars?: Record<string, any>;
  extraUserIds?: Record<string, number[]>; // e.g. { mentioned: [..], requester: [..] }
  eventId?: string;
}

/**
 * Event-triggered notifications. Matching active notification_rules decide who is
 * told and through which channels. The acting user is never notified of their own action.
 */
export async function emitEvent(e: EmitInput) {
  try {
    let task: any = null;
    if (e.taskId) task = await db('tasks as t').leftJoin('projects as p', 'p.id', 't.project_id').where('t.id', e.taskId)
      .first('t.*', 'p.name as project_name');
    const rules = await db('notification_rules').where({ event_type: e.type, is_active: true });
    const eventId = e.eventId ?? crypto.randomUUID();
    const allIds: number[] = [];
    const touched = new Set<number>();
    for (const r of rules) {
      if (r.priority_filter?.length && task && !r.priority_filter.includes(task.priority)) continue;
      if (r.department_id && task && task.department_id !== r.department_id) continue;
      if (r.project_id && (task?.project_id ?? e.projectId) !== r.project_id) continue;
      const recipients = (await resolveRecipients(r.recipient_roles, { taskId: e.taskId, projectId: e.projectId, extraUserIds: e.extraUserIds }))
        .filter((id) => id !== e.actorId);
      if (!recipients.length) continue;
      const actor = e.actorId ? await db('users').where({ id: e.actorId }).first('name') : null;
      const vars = { task: task ?? {}, actor: actor ?? { name: 'System' }, ...e.vars };
      const ids = await createNotificationLogs({
        userIds: recipients, channels: r.channels as Channel[], category: 'event',
        title: render(r.title_template, vars), body: render(r.message_template, vars),
        link: e.link ?? (e.taskId ? `/tasks/${e.taskId}` : e.projectId ? `/projects/${e.projectId}` : null),
        dedupePrefix: `evt:${r.id}:${eventId}`, ruleId: r.id,
      });
      allIds.push(...ids);
      recipients.forEach((id) => touched.add(id));
    }
    await enqueueDeliveries(allIds);
    // Lightweight live refresh signal for open screens
    if (touched.size) await pushRealtime([...touched], 'data:changed', { type: e.type, taskId: e.taskId, projectId: e.projectId });
  } catch (err) {
    logger.error({ err, type: e.type }, 'emitEvent failed');
  }
}
