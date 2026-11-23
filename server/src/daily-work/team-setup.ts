import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { baseDb, db, withSavepoint } from '../db/knex';
import { AuthUser } from '../auth/middleware';
import { recordDepartmentChange, recordStatusChange } from '../lib/employees';
import { getSetting } from '../lib/settings';
import { applyTemplate } from '../questionnaire/templates';

/**
 * Administrative setup of a company structure (companies, departments, designations, employees)
 * from a JSON description. Idempotent: existing records are matched (companies, departments and
 * designations by name; employees by email, then by exact name) and kept as they are; only empty
 * fields of existing employees are filled in. A dry run returns the plan without writing anything.
 */

const nameStr = z.string().trim().min(1).max(120);
export const structureSchema = z.object({
  description: z.string().optional(),
  companies: z.array(z.object({ name: nameStr, code: z.string().trim().max(30).optional(), description: z.string().max(500).optional() })).max(50).default([]),
  departments: z.array(z.object({
    name: nameStr, code: z.string().trim().max(30).optional(), description: z.string().max(500).optional(),
    hod: nameStr.optional(), template: z.string().trim().max(60).nullable().optional(),
  })).max(100).default([]),
  employees: z.array(z.object({
    name: nameStr,
    email: z.union([z.string().trim().email().max(200), z.literal('')]).optional(),
    department: nameStr.optional(),
    company: nameStr.optional(),
    role: z.string().trim().max(40).optional(),
    designations: z.array(nameStr).max(10).optional(),
    manager: nameStr.optional(),
  })).min(1).max(500),
});
export type Structure = z.infer<typeof structureSchema>;

export const optionsSchema = z.object({
  dry_run: z.boolean().default(true),
  email_domain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter a domain such as example.com').optional().or(z.literal('').transform(() => undefined)),
  temporary_password: z.string().min(8).max(128).optional().or(z.literal('').transform(() => undefined)),
  apply_templates: z.boolean().default(true),
});
export type SetupOptions = z.infer<typeof optionsSchema>;

export function loadStarterStructure(): Structure {
  const file = path.resolve(__dirname, '../../setup/starter-team.json');
  return structureSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

const lower = (s?: string | null) => (s ?? '').trim().toLowerCase();
const codeFrom = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12) || 'X';
const firstToken = (name: string) => name.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');

async function uniqueCode(table: 'companies' | 'departments', wanted: string) {
  let code = wanted; let i = 2;
  while (await db(table).whereRaw('lower(code) = lower(?)', [code]).first('id')) code = `${wanted}${i++}`;
  return code;
}

async function nextEmployeeCodes(n: number) {
  const codes: string[] = await db('users').whereILike('employee_code', 'EMP-%').pluck('employee_code');
  let max = codes.reduce((m, c) => Math.max(m, Number(String(c).replace(/^EMP-/i, '')) || 0), 0);
  const out: string[] = [];
  while (out.length < n) {
    const c = `EMP-${String(++max).padStart(3, '0')}`;
    if (!(await db('users').where({ employee_code: c }).first('id'))) out.push(c);
  }
  return out;
}

export interface PlanRow { kind: 'company' | 'department' | 'designation' | 'employee'; name: string; action: 'create' | 'exists' | 'update' | 'skip'; details: string[]; error?: string; email?: string | null }

export async function runTeamSetup(actor: AuthUser, s: Structure, o: SetupOptions) {
  const plan: PlanRow[] = [];
  const roles = Object.fromEntries((await db('roles').select('id', 'key', 'rank')).map((r: any) => [r.key, r]));
  const tz: string = await getSetting('default_timezone');
  const generatedPasswords: { name: string; email: string; password: string }[] = [];

  // ---------------- companies
  const companyIds = new Map<string, number>();
  for (const c of s.companies) {
    const ex = await db('companies').whereRaw('lower(name) = lower(?)', [c.name]).whereNull('deleted_at').first('id');
    if (ex) { companyIds.set(lower(c.name), ex.id); plan.push({ kind: 'company', name: c.name, action: 'exists', details: [] }); continue; }
    const code = await uniqueCode('companies', (c.code || codeFrom(c.name)).toUpperCase());
    plan.push({ kind: 'company', name: c.name, action: 'create', details: [`code ${code}`] });
    if (!o.dry_run) companyIds.set(lower(c.name), (await db('companies').insert({ name: c.name, code, description: c.description ?? null }).returning('id'))[0].id);
  }
  const companyId = async (name?: string) => {
    if (!name) return null;
    if (companyIds.has(lower(name))) return companyIds.get(lower(name))!;
    const ex = await db('companies').whereRaw('lower(name) = lower(?)', [name]).whereNull('deleted_at').first('id');
    return ex?.id ?? null;
  };

  // ---------------- departments
  const deptIds = new Map<string, number>();
  const newDepts: { id: number; template?: string | null }[] = [];
  for (const d of s.departments) {
    const ex = await db('departments').whereRaw('lower(name) = lower(?)', [d.name]).whereNull('deleted_at').first('id', 'hod_id', 'is_active');
    if (ex) {
      deptIds.set(lower(d.name), ex.id);
      plan.push({ kind: 'department', name: d.name, action: 'exists', details: ex.is_active ? [] : ['inactive'] });
      continue;
    }
    const code = await uniqueCode('departments', (d.code || codeFrom(d.name)).toUpperCase());
    const details = [`code ${code}`];
    if (d.template) details.push(o.apply_templates ? `checklist template "${d.template}"` : 'no checklist template (option off)');
    plan.push({ kind: 'department', name: d.name, action: 'create', details });
    if (!o.dry_run) {
      const [row] = await db('departments').insert({ name: d.name, code, description: d.description ?? null }).returning('id');
      deptIds.set(lower(d.name), row.id);
      newDepts.push({ id: row.id, template: d.template });
    }
  }
  const deptId = async (name?: string) => {
    if (!name) return null;
    if (deptIds.has(lower(name))) return deptIds.get(lower(name))!;
    const ex = await db('departments').whereRaw('lower(name) = lower(?)', [name]).whereNull('deleted_at').first('id');
    return ex?.id ?? null;
  };

  // ---------------- designations
  const desigIds = new Map<string, number>();
  const titles = [...new Set(s.employees.flatMap((e) => e.designations ?? []).map((t) => t.trim()))];
  for (const t of titles) {
    const ex = await db('designations').whereRaw('lower(title) = lower(?)', [t]).orderByRaw('department_id NULLS FIRST').first('id');
    if (ex) { desigIds.set(lower(t), ex.id); plan.push({ kind: 'designation', name: t, action: 'exists', details: [] }); continue; }
    plan.push({ kind: 'designation', name: t, action: 'create', details: [] });
    if (!o.dry_run) desigIds.set(lower(t), (await db('designations').insert({ title: t, level: /head|director/i.test(t) ? 8 : /lead|coordinator|manager/i.test(t) ? 6 : 4 }).returning('id'))[0].id);
  }

  // ---------------- employees
  const codes = o.dry_run ? [] : await nextEmployeeCodes(s.employees.length);
  const userIds = new Map<string, number>(); // by lower(name) from this structure
  const pendingManagers: { userId: number; manager: string; onlyIfEmpty: boolean }[] = [];
  let codeIdx = 0;
  for (const e of s.employees) {
    const email = e.email || (o.email_domain ? `${firstToken(e.name)}@${o.email_domain}` : null);
    const row: PlanRow = { kind: 'employee', name: e.name, action: 'create', details: [], email };
    plan.push(row);
    // match: email first, then exact name (only when unambiguous)
    let match = email ? await db('users').whereRaw('lower(email) = lower(?)', [email]).whereNull('deleted_at').first() : null;
    if (!match) {
      const byName = await db('users').whereRaw('lower(name) = lower(?)', [e.name]).whereNull('deleted_at');
      if (byName.length > 1) { row.action = 'skip'; row.error = `${byName.length} employees are already named "${e.name}" — add an email to choose one`; continue; }
      match = byName[0] ?? null;
    }
    const dId = await deptId(e.department);
    const cId = await companyId(e.company);
    const primaryDesig = e.designations?.[0] ? desigIds.get(lower(e.designations[0])) ?? null : null;
    if (e.department && !dId && (!o.dry_run || !s.departments.some((d) => lower(d.name) === lower(e.department)))) { row.action = 'skip'; row.error = `Unknown department "${e.department}"`; continue; }
    if (e.company && !cId && !s.companies.some((c) => lower(c.name) === lower(e.company))) { row.action = 'skip'; row.error = `Unknown company "${e.company}"`; continue; }

    if (match) {
      row.action = 'exists';
      row.email = match.email;
      const patch: any = {};
      if (e.department && !match.department_id) { patch.department_id = dId; row.details.push(`department → ${e.department}`); }
      if (e.company && !match.company_id) { patch.company_id = cId; row.details.push(`company → ${e.company}`); }
      if (e.designations?.length && !match.designation_id) { patch.designation_id = primaryDesig; row.details.push(`designation → ${e.designations[0]}`); }
      const extraTitles = (e.designations ?? []).slice(match.designation_id ? 0 : 1);
      if (extraTitles.length) row.details.push(`designations include ${extraTitles.join(', ')}`);
      if (Object.keys(patch).length || extraTitles.length) row.action = 'update';
      if (!o.dry_run) {
        if (Object.keys(patch).length) {
          await db('users').where({ id: match.id }).update({ ...patch, updated_at: db.fn.now() });
          if (patch.department_id) await recordDepartmentChange(match.id, patch.department_id, match.team_id, actor.id, 'Team setup');
        }
        for (const t of extraTitles) {
          const gid = desigIds.get(lower(t));
          if (gid && gid !== (patch.designation_id ?? match.designation_id)) await db('user_designations').insert({ user_id: match.id, designation_id: gid }).onConflict(['user_id', 'designation_id']).ignore();
        }
      }
      userIds.set(lower(e.name), match.id);
      if (e.manager) pendingManagers.push({ userId: match.id, manager: e.manager, onlyIfEmpty: true });
      if (!Object.keys(patch).length && !extraTitles.length) row.details.push('kept as is');
      continue;
    }

    // create
    const roleKey = e.role || 'employee';
    const role = roles[roleKey];
    if (!role) { row.action = 'skip'; row.error = `Unknown role "${roleKey}"`; continue; }
    if (role.rank >= actor.rank && actor.roleKey !== 'super_admin') { row.action = 'skip'; row.error = `Only a Super Admin can create a ${roleKey.replace('_', ' ')}`; continue; }
    if (!email) { row.action = 'skip'; row.error = 'Email needed (enter one, or an email domain)'; continue; }
    if (!z.string().email().safeParse(email).success) { row.action = 'skip'; row.error = `Invalid email ${email}`; continue; }
    // emails are unique across all organizations (sign-in identifies the tenant), so check globally
    if (await baseDb('users').whereRaw('lower(email) = lower(?)', [email]).first('id')) { row.action = 'skip'; row.error = `${email} is already used by another account`; continue; }
    row.details.push(`role ${role.key.replace('_', ' ')}`);
    if (e.department) row.details.push(e.department);
    if (e.company) row.details.push(e.company);
    if (e.designations?.length) row.details.push(e.designations.join(' · '));
    if (o.dry_run) { userIds.set(lower(e.name), -1); continue; }
    const password = o.temporary_password ?? `Tmp-${crypto.randomBytes(5).toString('hex')}1`;
    try {
      await withSavepoint(async () => {
        const [u] = await db('users').insert({
          employee_code: codes[codeIdx++], name: e.name, email, password_hash: await bcrypt.hash(password, 12), must_change_password: true,
          role_id: role.id, department_id: dId, company_id: cId, designation_id: primaryDesig, timezone: tz,
        }).returning(['id']);
        await db('user_notification_preferences').insert({ user_id: u.id }).onConflict('user_id').ignore();
        for (const t of (e.designations ?? []).slice(1)) {
          const gid = desigIds.get(lower(t));
          if (gid) await db('user_designations').insert({ user_id: u.id, designation_id: gid }).onConflict(['user_id', 'designation_id']).ignore();
        }
        await recordDepartmentChange(u.id, dId, null, actor.id, 'Team setup');
        await recordStatusChange(u.id, true, 'active', actor.id, 'Employee created (team setup)');
        userIds.set(lower(e.name), u.id);
        if (e.manager) pendingManagers.push({ userId: u.id, manager: e.manager, onlyIfEmpty: false });
        if (!o.temporary_password) generatedPasswords.push({ name: e.name, email, password });
      });
    } catch (err: any) { row.action = 'skip'; row.error = `Could not create: ${err.message}`; }
  }

  // ---------------- reporting lines and HODs (after everyone exists)
  const resolveUser = async (name: string) => userIds.get(lower(name)) ?? (await db('users').whereRaw('lower(name) = lower(?)', [name]).whereNull('deleted_at').first('id'))?.id ?? null;
  for (const m of pendingManagers) {
    const mid = await resolveUser(m.manager);
    if (!mid || mid === m.userId || o.dry_run) continue;
    const u = await db('users').where({ id: m.userId }).first('manager_id');
    if (m.onlyIfEmpty && u.manager_id) continue;
    await db('users').where({ id: m.userId }).update({ manager_id: mid });
    await db('reporting_hierarchy').where({ user_id: m.userId }).whereNull('effective_to').update({ effective_to: db.fn.now() });
    await db('reporting_hierarchy').insert({ user_id: m.userId, manager_id: mid, changed_by: actor.id });
  }
  for (const d of s.departments) {
    if (!d.hod) continue;
    const row = plan.find((p) => p.kind === 'department' && p.name === d.name)!;
    const id = await deptId(d.name);
    const current = id ? await db('departments').where({ id }).first('hod_id') : null;
    if (current?.hod_id) { if (row.action === 'exists') row.details.push('HOD already set (kept)'); continue; }
    row.details.push(`HOD ${d.hod}`);
    if (row.action === 'exists') row.action = 'update';
    if (o.dry_run || !id) continue;
    const hod = await resolveUser(d.hod);
    if (hod) await db('departments').where({ id }).update({ hod_id: hod, updated_at: db.fn.now() });
  }

  // ---------------- starter checklist templates for new departments
  if (!o.dry_run && o.apply_templates) {
    for (const d of newDepts) {
      if (!d.template) continue;
      const tpl = await db('question_templates').where({ key: d.template }).first('id');
      if (tpl) await applyTemplate({ templateId: tpl.id, actorId: actor.id, target: { type: 'department', departmentIds: [d.id] }, deadlineTime: '18:30', reminderOffsets: [60] });
    }
  }

  const count = (kind: PlanRow['kind'], action: PlanRow['action']) => plan.filter((p) => p.kind === kind && p.action === action).length;
  const summary = {
    companies_created: count('company', 'create'), departments_created: count('department', 'create'), designations_created: count('designation', 'create'),
    employees_created: count('employee', 'create'), employees_updated: count('employee', 'update'), employees_kept: count('employee', 'exists'), skipped: plan.filter((p) => p.action === 'skip').length,
  };
  return { dry_run: o.dry_run, summary, plan, generated_passwords: generatedPasswords };
}
