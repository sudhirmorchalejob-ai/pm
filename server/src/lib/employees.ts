import { db } from '../db/knex';
import { badRequest } from './errors';

/** Deactivated employees cannot receive new assignments of any kind. */
export async function assertActiveUsers(ids: (number | null | undefined)[], what = 'this assignment') {
  const want = [...new Set(ids.filter((x): x is number => !!x))];
  if (!want.length) return;
  const rows = await db('users').whereIn('id', want).whereNull('deleted_at').select('id', 'name', 'is_active');
  const missing = want.filter((id) => !rows.some((r: any) => r.id === id));
  if (missing.length) throw badRequest(`Unknown employee(s): ${missing.join(', ')}`);
  const inactive = rows.filter((r: any) => !r.is_active);
  if (inactive.length) throw badRequest(`Deactivated employees cannot receive ${what}: ${inactive.map((r: any) => r.name).join(', ')}`);
}

/** Close the employee's current department record and open a new one (department transfer history). */
export async function recordDepartmentChange(userId: number, departmentId: number | null, teamId: number | null, actorId: number | null, reason?: string | null) {
  const cur = await db('department_history').where({ user_id: userId }).whereNull('effective_to').first();
  if (cur && cur.department_id === departmentId && cur.team_id === teamId) return false;
  if (cur) await db('department_history').where({ id: cur.id }).update({ effective_to: db.fn.now() });
  await db('department_history').insert({ user_id: userId, department_id: departmentId, team_id: teamId, changed_by: actorId, reason: reason ?? null });
  return true;
}

export async function recordStatusChange(userId: number, isActive: boolean, employmentStatus: string, actorId: number | null, reason?: string | null) {
  await db('employee_status_history').insert({ user_id: userId, is_active: isActive, employment_status: employmentStatus, changed_by: actorId, reason: reason ?? null });
}
