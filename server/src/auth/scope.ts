import { Knex } from 'knex';
import { db } from '../db/knex';
import { forbidden, notFound } from '../lib/errors';
import { AuthUser, can } from './middleware';

/**
 * Row-level data scoping. Every list/detail query for users, tasks and projects
 * goes through these helpers so that a role only ever sees data inside its scope:
 *   organization → everything
 *   department   → own department
 *   team         → own team
 *   project      → projects they manage / belong to
 *   self         → only their own work
 * Direct reports (users.manager_id = me) are always visible to their manager.
 */

export function scopeUsers(q: Knex.QueryBuilder, u: AuthUser, a = 'u') {
  if (u.scope === 'organization') return q;
  return q.where((w) => {
    w.where(`${a}.id`, u.id).orWhere(`${a}.manager_id`, u.id);
    if (u.scope === 'department' && u.departmentId) w.orWhere(`${a}.department_id`, u.departmentId);
    if (u.scope === 'team' && u.teamId) w.orWhere(`${a}.team_id`, u.teamId);
    if (u.scope === 'project') {
      w.orWhereIn(`${a}.id`, db('project_members as pm').join('projects as p', 'p.id', 'pm.project_id')
        .where('p.manager_id', u.id).select('pm.user_id'));
    }
  });
}

const myProjectIds = (u: AuthUser) =>
  db('projects').where('manager_id', u.id).orWhere('created_by', u.id).select('id')
    .union(db('project_members').where('user_id', u.id).select('project_id'));

export function scopeTasks(q: Knex.QueryBuilder, u: AuthUser, a = 't') {
  if (u.scope === 'organization') return q;
  return q.where((w) => {
    w.where(`${a}.assigned_by`, u.id)
      .orWhereExists(db('task_assignees as ta0').whereRaw(`ta0.task_id = ${a}.id`).andWhere('ta0.user_id', u.id));
    if (u.scope === 'department' && u.departmentId) {
      w.orWhere(`${a}.department_id`, u.departmentId)
        .orWhereExists(db('task_assignees as ta1').join('users as u1', 'u1.id', 'ta1.user_id')
          .whereRaw(`ta1.task_id = ${a}.id`).andWhere('u1.department_id', u.departmentId));
    }
    if (u.scope === 'team' && u.teamId) {
      w.orWhereExists(db('task_assignees as ta2').join('users as u2', 'u2.id', 'ta2.user_id')
        .whereRaw(`ta2.task_id = ${a}.id`).andWhere('u2.team_id', u.teamId));
    }
    if (u.scope === 'project') w.orWhereIn(`${a}.project_id`, myProjectIds(u));
  });
}

export function scopeProjects(q: Knex.QueryBuilder, u: AuthUser, a = 'p') {
  if (u.scope === 'organization') return q;
  return q.where((w) => {
    w.where(`${a}.manager_id`, u.id).orWhere(`${a}.created_by`, u.id).orWhere(`${a}.hod_id`, u.id)
      .orWhereExists(db('project_members as m0').whereRaw(`m0.project_id = ${a}.id`).andWhere('m0.user_id', u.id))
      .orWhereExists(db('tasks as t0').join('task_assignees as ta0', 'ta0.task_id', 't0.id')
        .whereRaw(`t0.project_id = ${a}.id`).andWhere('ta0.user_id', u.id).whereNull('t0.deleted_at'));
    if (u.scope === 'department' && u.departmentId) {
      w.orWhere(`${a}.department_id`, u.departmentId)
        .orWhereExists(db('project_members as m1').join('users as u1', 'u1.id', 'm1.user_id')
          .whereRaw(`m1.project_id = ${a}.id`).andWhere('u1.department_id', u.departmentId));
    }
    if (u.scope === 'team' && u.teamId) {
      w.orWhereExists(db('project_members as m2').join('users as u2', 'u2.id', 'm2.user_id')
        .whereRaw(`m2.project_id = ${a}.id`).andWhere('u2.team_id', u.teamId));
    }
  });
}

export async function assertCanSeeUser(u: AuthUser, userId: number) {
  const row = await scopeUsers(db('users as u').where('u.id', userId).whereNull('u.deleted_at'), u).first('u.id');
  if (!row) throw notFound('Employee not found');
}

export async function loadVisibleTask(u: AuthUser, taskId: number) {
  const t = await scopeTasks(db('tasks as t').where('t.id', taskId).whereNull('t.deleted_at'), u).first('t.*');
  if (!t) throw notFound('Task not found');
  return t;
}

export async function loadVisibleProject(u: AuthUser, projectId: number) {
  const p = await scopeProjects(db('projects as p').where('p.id', projectId).whereNull('p.deleted_at'), u).first('p.*');
  if (!p) throw notFound('Project not found');
  return p;
}

/** Can the user edit / assign / reassign this task? */
export async function canManageTask(u: AuthUser, task: any): Promise<boolean> {
  if (can(u, 'tasks.manage_all')) return true;
  if (task.assigned_by === u.id && can(u, 'tasks.create')) return true;
  if (!can(u, 'tasks.assign')) return false;
  if (u.scope === 'organization') return true;
  if (u.scope === 'department' && u.departmentId && task.department_id === u.departmentId) return true;
  if (task.project_id) {
    const p = await db('projects').where({ id: task.project_id }).first('manager_id', 'hod_id');
    if (p && (p.manager_id === u.id || p.hod_id === u.id)) return true;
  }
  if (u.scope === 'team' && u.teamId) {
    const inTeam = await db('task_assignees as ta').join('users as x', 'x.id', 'ta.user_id')
      .where('ta.task_id', task.id).andWhere('x.team_id', u.teamId).first('ta.user_id');
    if (inTeam) return true;
  }
  return false;
}

export async function assertCanManageTask(u: AuthUser, task: any) {
  if (!(await canManageTask(u, task))) throw forbidden('You cannot manage this task');
}

/** Can the user review (approve/reject) this task? Never their own submission. */
export async function canReviewTask(u: AuthUser, task: any): Promise<boolean> {
  if (!can(u, 'tasks.review')) return false;
  const isAssignee = await db('task_assignees').where({ task_id: task.id, user_id: u.id }).first();
  if (isAssignee && u.roleKey !== 'super_admin') return false;
  if (can(u, 'tasks.manage_all') || u.scope === 'organization') return true;
  return canManageTask(u, task);
}

export function canManageProject(u: AuthUser, p: any): boolean {
  if (can(u, 'projects.manage_all')) return true;
  if (can(u, 'projects.manage') && (p.manager_id === u.id || p.created_by === u.id)) return true;
  if (can(u, 'future_projects.manage') && p.is_future && p.created_by === u.id) return true;
  return false;
}

export function assertCanManageProject(u: AuthUser, p: any) {
  if (!canManageProject(u, p)) throw forbidden('You cannot manage this project');
}

/** Ids of users whose work this person supervises (for monitoring screens). */
export async function supervisedUserIds(u: AuthUser): Promise<number[] | null> {
  if (u.scope === 'organization') return null; // null = everyone
  const rows = await scopeUsers(db('users as u').whereNull('u.deleted_at'), u).pluck('u.id');
  return rows;
}
