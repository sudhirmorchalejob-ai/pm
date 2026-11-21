import bcrypt from 'bcryptjs';
import { DateTime } from 'luxon';
import { db } from './knex';
import { migrate } from './migrate';
import { PERMISSIONS, ROLE_DEFS } from '../auth/permissions';
import { logger } from '../lib/logger';

/**
 * seedBase(): required reference data for every environment (roles, permissions,
 * default notification & escalation rules). Idempotent.
 * seedDemo(): realistic development data. Run with `npm run seed -- --demo [--reset]`.
 * Demo accounts all use the password in DEMO_PASSWORD (default "Password@123").
 */
export async function seedBase() {
  for (const [key, [module, description]] of Object.entries(PERMISSIONS)) {
    await db('permissions').insert({ key, module, description }).onConflict('key').merge(['module', 'description']);
  }
  for (const r of ROLE_DEFS) {
    const [role] = await db('roles').insert({ key: r.key, name: r.name, description: r.description, scope_level: r.scope, rank: r.rank })
      .onConflict('key').merge(['name', 'description', 'scope_level', 'rank']).returning('*');
    const existing = await db('role_permissions').where({ role_id: role.id }).count({ c: '*' }).first();
    // Only set defaults for roles that have never been configured (preserve admin edits), but super admin always gets everything.
    if (Number(existing?.c) === 0 || r.key === 'super_admin') {
      const ids = await db('permissions').whereIn('key', r.permissions).pluck('id');
      await db('role_permissions').insert(ids.map((pid: number) => ({ role_id: role.id, permission_id: pid }))).onConflict(['role_id', 'permission_id']).ignore();
    }
  }

  if (!(await db('notification_rules').first())) {
    const T = (event_type: string, name: string, roles: string[], title: string, msg: string, channels = ['in_app', 'email', 'browser_push']) =>
      ({ event_type, name, recipient_roles: roles, title_template: title, message_template: msg, channels });
    await db('notification_rules').insert([
      T('task.assigned', 'Notify assignee on assignment', ['assignee'], 'New task: {{task.title}}', '{{actor.name}} assigned you {{task.task_key}} "{{task.title}}" (priority {{task.priority}}).'),
      T('task.submitted', 'Notify reviewer on submission', ['assigner', 'hod'], 'Review needed: {{task.title}}', '{{actor.name}} submitted {{task.task_key}} for review. {{note}}'),
      T('task.approved', 'Notify assignee on approval', ['assignee'], 'Approved: {{task.title}}', '{{actor.name}} approved {{task.task_key}}. {{comments}}'),
      T('task.revision_required', 'Notify assignee on revision', ['assignee'], 'Revision requested: {{task.title}}', '{{actor.name}} requested changes on {{task.task_key}}: {{comments}}'),
      T('task.rejected', 'Notify assignee on rejection', ['assignee'], 'Submission rejected: {{task.title}}', '{{actor.name}} rejected the submission for {{task.task_key}}: {{comments}}'),
      T('task.blocked', 'Notify managers on blocker', ['assigner', 'hod', 'team_leader'], 'Blocked: {{task.title}}', '{{actor.name}} reported a blocker on {{task.task_key}}: {{blocker}}'),
      T('task.deadline_changed', 'Notify assignee on deadline change', ['assignee'], 'Deadline changed: {{task.title}}', '{{actor.name}} changed the deadline of {{task.task_key}}. {{reason}}'),
      T('task.comment', 'Notify mentioned users', ['mentioned'], '{{actor.name}} mentioned you', '{{task.task_key}} {{task.title}}: "{{comment.body}}"', ['in_app', 'email']),
      T('task.extension_requested', 'Notify reviewer on extension request', ['assigner', 'hod'], 'Extension requested: {{task.title}}', '{{actor.name}} requested an extension for {{task.task_key}}: {{reason}}'),
      T('task.extension_decided', 'Notify requester on extension decision', ['requester'], 'Extension {{decision}}: {{task.title}}', '{{actor.name}} {{decision}} your extension request for {{task.task_key}}. {{comments}}'),
      T('project.status_changed', 'Notify PM on project status', ['project_manager', 'hod'], 'Project status: {{project.name}}', '{{actor.name}} changed status from {{from}} to {{to}}.', ['in_app']),
      T('project.converted', 'Notify on future project activation', ['project_manager', 'hod', 'director'], 'Project activated: {{project.name}}', '{{actor.name}} converted {{project.name}} into an active project.', ['in_app', 'email']),
      T('approval.requested', 'Notify approvers', ['director', 'admin'], 'Approval requested', '{{actor.name}}: {{approval.title}}', ['in_app', 'email']),
      T('approval.decided', 'Notify requester on approval decision', ['requester'], 'Approval {{approval.status}}', '{{approval.title}} was {{approval.status}} by {{actor.name}}. {{comments}}', ['in_app', 'email']),
      T('daily_report.reviewed', 'Notify employee on report review', ['requester'], 'Daily report reviewed', '{{actor.name}} reviewed your report for {{report.date}} ({{report.status}}). {{comment}}', ['in_app']),
      T('meeting.scheduled', 'Notify attendees of meetings', ['attendees'], 'Meeting: {{meeting.title}}', '{{actor.name}} scheduled "{{meeting.title}}" on {{meeting.when}} {{meeting.location}}', ['in_app', 'email']),
    ]);
  }
  if (!(await db('escalation_rules').first())) {
    await db('escalation_rules').insert([
      { name: 'Deadline approaching (24h)', level: 1, offset_minutes: -24 * 60, notify_roles: ['assignee'], channels: ['in_app', 'email'] },
      { name: 'Deadline approaching (1h)', level: 1, offset_minutes: -60, notify_roles: ['assignee'], channels: ['in_app', 'browser_push'] },
      { name: 'Deadline missed', level: 1, offset_minutes: 0, notify_roles: ['assignee', 'assigner'], channels: ['in_app', 'email'] },
      { name: 'Overdue 24h → HOD', level: 2, offset_minutes: 24 * 60, notify_roles: ['hod', 'team_leader'], channels: ['in_app', 'email'] },
      { name: 'Critical delay → Project Manager', level: 3, offset_minutes: 72 * 60, notify_roles: ['project_manager', 'hod'], channels: ['in_app', 'email'] },
      { name: 'High priority overdue 12h → PM', level: 3, offset_minutes: 12 * 60, notify_roles: ['project_manager'], channels: ['in_app', 'email'], priority_filter: ['high', 'critical'] },
      { name: 'Extended delay → Admin', level: 4, offset_minutes: 7 * 24 * 60, notify_roles: ['admin', 'director'], channels: ['in_app', 'email'] },
    ]);
  }

  // Bootstrap super admin (production) when the database has no users.
  if (!(await db('users').first())) {
    const email = process.env.ADMIN_EMAIL;
    const password = process.env.ADMIN_PASSWORD;
    if (email && password) {
      const role = await db('roles').where({ key: 'super_admin' }).first();
      const [u] = await db('users').insert({ employee_code: 'ADMIN', name: 'System Administrator', email, password_hash: await bcrypt.hash(password, 12), role_id: role.id, timezone: process.env.DEFAULT_TIMEZONE ?? 'Asia/Kolkata' }).returning('id');
      await db('user_notification_preferences').insert({ user_id: u.id });
      logger.info({ email }, 'bootstrap super admin created');
    }
  }
}

export async function seedDemo() {
  if (await db('users').where({ email: 'admin@orgpm.dev' }).first()) { logger.info('demo data already present'); return; }
  const pw = await bcrypt.hash(process.env.DEMO_PASSWORD ?? 'Password@123', 10);
  const role = Object.fromEntries((await db('roles').select('id', 'key')).map((r) => [r.key, r.id]));
  const tz = 'Asia/Kolkata';
  const now = DateTime.now().setZone(tz);
  const d = (days: number) => now.plus({ days }).toISODate()!;
  const at = (days: number, hour = 18) => now.plus({ days }).set({ hour, minute: 0, second: 0, millisecond: 0 }).toUTC().toJSDate();

  const depts = await db('departments').insert([
    { name: 'Information Technology', code: 'IT', description: 'Software, infrastructure and support' },
    { name: 'Human Resources', code: 'HR', description: 'People operations' },
    { name: 'Finance', code: 'FIN', description: 'Accounts, budgeting, payroll' },
    { name: 'Marketing', code: 'MKT', description: 'Brand, campaigns, digital' },
    { name: 'Operations', code: 'OPS', description: 'Delivery and facilities' },
  ]).returning('*');
  const D = Object.fromEntries(depts.map((x) => [x.code, x.id]));
  const desigs = await db('designations').insert([
    { title: 'Director', level: 9 }, { title: 'Project Manager', level: 7 }, { title: 'Head of Department', level: 8 },
    { title: 'Team Lead', level: 6 }, { title: 'Senior Engineer', level: 5 }, { title: 'Engineer', level: 4 }, { title: 'Executive', level: 3 },
    { title: 'Analyst', level: 4 }, { title: 'Designer', level: 4 },
  ]).returning('*');
  const G = Object.fromEntries(desigs.map((x) => [x.title, x.id]));

  const mk = (code: string, name: string, email: string, r: string, dept: string | null, desig: string, extra: any = {}) =>
    ({ employee_code: code, name, email, password_hash: pw, role_id: role[r], department_id: dept ? D[dept] : null, designation_id: G[desig], timezone: tz, joining_date: d(-400 - Math.floor(Math.random() * 600)), ...extra });
  const users = await db('users').insert([
    mk('E001', 'Aarav Mehta', 'admin@orgpm.dev', 'super_admin', null, 'Director'),
    mk('E002', 'Priya Sharma', 'director@orgpm.dev', 'director', null, 'Director'),
    mk('E003', 'Rohan Verma', 'pm@orgpm.dev', 'project_manager', 'IT', 'Project Manager'),
    mk('E004', 'Neha Kapoor', 'pm2@orgpm.dev', 'project_manager', 'MKT', 'Project Manager'),
    mk('E005', 'Vikram Singh', 'hod.it@orgpm.dev', 'hod', 'IT', 'Head of Department'),
    mk('E006', 'Anjali Rao', 'hod.hr@orgpm.dev', 'hod', 'HR', 'Head of Department'),
    mk('E007', 'Suresh Iyer', 'hod.fin@orgpm.dev', 'hod', 'FIN', 'Head of Department'),
    mk('E008', 'Kavya Nair', 'hod.mkt@orgpm.dev', 'hod', 'MKT', 'Head of Department'),
    mk('E009', 'Arjun Patel', 'hod.ops@orgpm.dev', 'hod', 'OPS', 'Head of Department'),
    mk('E010', 'Meera Joshi', 'tl.dev@orgpm.dev', 'team_leader', 'IT', 'Team Lead'),
    mk('E011', 'Karan Malhotra', 'tl.infra@orgpm.dev', 'team_leader', 'IT', 'Team Lead'),
    mk('E012', 'Ishita Gupta', 'employee@orgpm.dev', 'employee', 'IT', 'Senior Engineer'),
    mk('E013', 'Aditya Kumar', 'aditya@orgpm.dev', 'employee', 'IT', 'Engineer'),
    mk('E014', 'Sneha Reddy', 'sneha@orgpm.dev', 'employee', 'IT', 'Engineer'),
    mk('E015', 'Rahul Das', 'rahul@orgpm.dev', 'employee', 'IT', 'Engineer'),
    mk('E016', 'Pooja Menon', 'pooja@orgpm.dev', 'employee', 'IT', 'Senior Engineer'),
    mk('E017', 'Nikhil Bose', 'nikhil@orgpm.dev', 'employee', 'HR', 'Executive'),
    mk('E018', 'Divya Pillai', 'divya@orgpm.dev', 'employee', 'HR', 'Executive'),
    mk('E019', 'Manish Agarwal', 'manish@orgpm.dev', 'employee', 'FIN', 'Analyst'),
    mk('E020', 'Ritika Saxena', 'ritika@orgpm.dev', 'employee', 'FIN', 'Analyst'),
    mk('E021', 'Tanvi Shah', 'tanvi@orgpm.dev', 'employee', 'MKT', 'Designer'),
    mk('E022', 'Yash Chopra', 'yash@orgpm.dev', 'employee', 'MKT', 'Executive'),
    mk('E023', 'Farhan Ali', 'farhan@orgpm.dev', 'employee', 'OPS', 'Executive'),
    mk('E024', 'Lakshmi Narayan', 'lakshmi@orgpm.dev', 'employee', 'OPS', 'Executive', { employment_status: 'on_leave' }),
    mk('E025', 'Gaurav Tiwari', 'viewer@orgpm.dev', 'management_viewer', null, 'Analyst'),
  ]).returning('*');
  const U = Object.fromEntries(users.map((x) => [x.email.split('@')[0], x.id]));
  await db('user_notification_preferences').insert(users.map((u) => ({ user_id: u.id })));

  for (const [code, hod] of [['IT', 'hod.it'], ['HR', 'hod.hr'], ['FIN', 'hod.fin'], ['MKT', 'hod.mkt'], ['OPS', 'hod.ops']]) {
    await db('departments').where({ id: D[code] }).update({ hod_id: U[hod] });
  }
  const [tDev, tInfra] = await db('teams').insert([
    { name: 'Application Development', department_id: D.IT, leader_id: U['tl.dev'] },
    { name: 'Infrastructure & Security', department_id: D.IT, leader_id: U['tl.infra'] },
  ]).returning('id');
  await db('users').whereIn('id', [U['tl.dev'], U.employee, U.aditya, U.sneha]).update({ team_id: tDev.id });
  await db('users').whereIn('id', [U['tl.infra'], U.rahul, U.pooja]).update({ team_id: tInfra.id });
  // reporting hierarchy
  const mgr: [string, string][] = [['director', 'admin'], ['pm', 'director'], ['pm2', 'director'], ['hod.it', 'director'], ['hod.hr', 'director'], ['hod.fin', 'director'],
    ['hod.mkt', 'director'], ['hod.ops', 'director'], ['tl.dev', 'hod.it'], ['tl.infra', 'hod.it'], ['employee', 'tl.dev'], ['aditya', 'tl.dev'], ['sneha', 'tl.dev'],
    ['rahul', 'tl.infra'], ['pooja', 'tl.infra'], ['nikhil', 'hod.hr'], ['divya', 'hod.hr'], ['manish', 'hod.fin'], ['ritika', 'hod.fin'], ['tanvi', 'hod.mkt'],
    ['yash', 'hod.mkt'], ['farhan', 'hod.ops'], ['lakshmi', 'hod.ops'], ['viewer', 'director']];
  for (const [u, m] of mgr) {
    await db('users').where({ id: U[u] }).update({ manager_id: U[m] });
    await db('reporting_hierarchy').insert({ user_id: U[u], manager_id: U[m], changed_by: U.admin });
  }

  const skills = await db('skills').insert(['React', 'Node.js', 'PostgreSQL', 'DevOps', 'Kubernetes', 'Security', 'UI/UX', 'Recruitment', 'Payroll', 'Financial Analysis', 'SEO', 'Content', 'Logistics', 'Python', 'Data Analytics']
    .map((name) => ({ name }))).returning('*');
  const S = Object.fromEntries(skills.map((s) => [s.name, s.id]));
  const us: [string, string, number][] = [['employee', 'React', 5], ['employee', 'Node.js', 4], ['aditya', 'React', 3], ['aditya', 'PostgreSQL', 3], ['sneha', 'Node.js', 4], ['sneha', 'Python', 3],
    ['rahul', 'DevOps', 4], ['rahul', 'Kubernetes', 3], ['pooja', 'Security', 5], ['pooja', 'DevOps', 3], ['tl.dev', 'React', 5], ['tl.dev', 'Node.js', 5], ['tl.infra', 'Kubernetes', 5],
    ['nikhil', 'Recruitment', 4], ['divya', 'Recruitment', 3], ['manish', 'Financial Analysis', 4], ['ritika', 'Payroll', 4], ['tanvi', 'UI/UX', 5], ['yash', 'SEO', 4], ['yash', 'Content', 3],
    ['farhan', 'Logistics', 4], ['manish', 'Data Analytics', 3]];
  await db('user_skills').insert(us.map(([u, s, l]) => ({ user_id: U[u], skill_id: S[s], level: l })));

  // ----- projects
  const P = async (p: any, members: string[]) => {
    const [row] = await db('projects').insert({ ...p, created_by: U.admin }).returning('*');
    await db('project_members').insert(members.map((m) => ({ project_id: row.id, user_id: U[m], role_in_project: U[m] === p.manager_id ? 'manager' : 'member', allocation_percent: 50 })));
    return row;
  };
  const erp = await P({ code: 'ERP-2026', name: 'ERP Modernization', description: 'Replace legacy ERP with cloud platform', business_objective: 'Reduce operating cost by 20%', client_name: 'Internal',
    manager_id: U.pm, department_id: D.IT, hod_id: U['hod.it'], start_date: d(-60), end_date: d(90), priority: 'critical', estimated_budget: 2500000, status: 'in_progress' },
    ['pm', 'tl.dev', 'employee', 'aditya', 'sneha', 'pooja', 'manish']);
  const portal = await P({ code: 'HRP-01', name: 'Employee Self-Service Portal', description: 'Leave, payslips and onboarding portal', business_objective: 'Cut HR ticket volume by 40%', client_name: 'HR Department',
    manager_id: U.pm, department_id: D.IT, hod_id: U['hod.it'], start_date: d(-30), end_date: d(-2), priority: 'high', estimated_budget: 800000, status: 'in_progress' },
    ['pm', 'tl.dev', 'aditya', 'nikhil', 'divya']);
  const brand = await P({ code: 'MKT-BR', name: 'Brand Refresh Campaign', description: 'New brand identity and launch campaign', business_objective: 'Increase inbound leads 30%', client_name: 'Marketing',
    manager_id: U.pm2, department_id: D.MKT, hod_id: U['hod.mkt'], start_date: d(-20), end_date: d(45), priority: 'medium', estimated_budget: 600000, status: 'in_progress' },
    ['pm2', 'tanvi', 'yash']);
  const infra = await P({ code: 'INF-SEC', name: 'Zero-Trust Security Rollout', description: 'SSO, MFA and network segmentation', business_objective: 'Pass ISO 27001 audit',
    manager_id: U.pm, department_id: D.IT, hod_id: U['hod.it'], start_date: d(-120), end_date: d(-10), priority: 'high', estimated_budget: 1200000, status: 'completed', progress: 100 },
    ['pm', 'tl.infra', 'rahul', 'pooja']);

  const fut1 = await P({ code: 'AI-ASSIST', name: 'AI Customer Assistant', description: 'Conversational assistant for customer support', business_objective: 'Deflect 35% of L1 tickets',
    manager_id: U.pm, department_id: D.IT, hod_id: U['hod.it'], start_date: d(45), end_date: d(200), priority: 'high', estimated_budget: 1800000, status: 'under_evaluation', is_future: true }, ['pm']);
  const fut2 = await P({ code: 'WH-AUTO', name: 'Warehouse Automation', description: 'Barcode + WMS rollout across warehouses', business_objective: 'Cut picking errors by 50%',
    manager_id: U.pm2, department_id: D.OPS, hod_id: U['hod.ops'], start_date: d(120), end_date: d(300), priority: 'medium', estimated_budget: 3200000, status: 'proposed', is_future: true }, ['pm2']);
  const fut3 = await P({ code: 'FIN-BI', name: 'Finance BI Dashboards', description: 'Self-service analytics for finance', business_objective: 'Monthly close in 3 days',
    manager_id: U.pm, department_id: D.FIN, hod_id: U['hod.fin'], start_date: d(10), end_date: d(80), priority: 'medium', estimated_budget: 450000, status: 'approved', is_future: true }, ['pm', 'manish']);
  await db('future_projects').insert([
    { project_id: fut1.id, expected_start_date: d(45), expected_end_date: d(200), planning_horizon: 'next_quarter', required_employees: 6, required_skills: ['Python', 'Node.js', 'React', 'Data Analytics'],
      expected_deliverables: 'Chat widget, knowledge base integration, analytics', approval_status: 'pending', chk_requirements: true, chk_resources_identified: true, chk_technology_selected: true },
    { project_id: fut2.id, expected_start_date: d(120), expected_end_date: d(300), planning_horizon: 'six_months', required_employees: 8, required_skills: ['Logistics', 'DevOps', 'Kubernetes'],
      expected_deliverables: 'WMS, handheld scanners, training', approval_status: 'draft', chk_requirements: true },
    { project_id: fut3.id, expected_start_date: d(10), expected_end_date: d(80), planning_horizon: 'next_month', required_employees: 3, required_skills: ['Data Analytics', 'PostgreSQL', 'Financial Analysis'],
      expected_deliverables: 'P&L, cashflow and budget dashboards', approval_status: 'approved', chk_requirements: true, chk_budget_approved: true, chk_resources_identified: true,
      chk_team_allocated: true, chk_technology_selected: true, chk_dependencies_resolved: true, chk_documentation: false, chk_management_approval: true },
  ]);

  const ms = await db('project_milestones').insert([
    { project_id: erp.id, title: 'Requirements sign-off', due_date: d(-40), status: 'completed', completed_at: at(-41) },
    { project_id: erp.id, title: 'Data migration dry run', due_date: d(10), status: 'in_progress' },
    { project_id: erp.id, title: 'UAT complete', due_date: d(60), status: 'pending' },
    { project_id: erp.id, title: 'Go-live', due_date: d(90), status: 'pending' },
    { project_id: portal.id, title: 'Leave module live', due_date: d(-5), status: 'in_progress' },
    { project_id: brand.id, title: 'Brand guidelines approved', due_date: d(7), status: 'in_progress' },
  ]).returning('*');
  await db('project_deliverables').insert([
    { project_id: erp.id, title: 'Migration runbook', due_date: d(8), status: 'in_progress' },
    { project_id: brand.id, title: 'Logo & typography kit', due_date: d(5), status: 'in_progress' },
  ]);
  await db('project_risks').insert([
    { project_id: erp.id, title: 'Legacy data quality', description: 'Duplicate vendor records may block migration', probability: 'high', impact: 'high', mitigation: 'Dedup sprint before dry run', owner_id: U.aditya },
    { project_id: erp.id, title: 'Key-person dependency', probability: 'medium', impact: 'critical', mitigation: 'Pair Ishita with Sneha on integrations', owner_id: U['tl.dev'] },
    { project_id: portal.id, title: 'Payroll API delays', probability: 'medium', impact: 'medium', owner_id: U.nikhil },
  ]);
  await db('project_dependencies').insert([{ project_id: fut3.id, depends_on_project_id: erp.id, description: 'Needs ERP general-ledger data feed' }]);
  await db('project_resources').insert([
    { project_id: fut1.id, skill_id: S.Python, required_count: 2, hours_per_week: 40, start_date: d(45), end_date: d(200), status: 'required' },
    { project_id: fut1.id, skill_id: S['Data Analytics'], required_count: 1, hours_per_week: 20, start_date: d(45), end_date: d(200), status: 'required' },
    { project_id: erp.id, skill_id: S.PostgreSQL, user_id: U.aditya, required_count: 1, hours_per_week: 20, start_date: d(-60), end_date: d(90), status: 'allocated' },
  ]);

  // ----- tasks
  type T = { title: string; who: string[]; by: string; project?: any; dept: string; status: string; priority: string; deadline: Date | null; est?: number; act?: number; progress?: number;
    complexity?: number; quality?: number; completedDaysAgo?: number; milestone?: number; created?: number; revisions?: number; blocker?: string };
  const tasks: T[] = [
    { title: 'Design ERP data model', who: ['employee'], by: 'tl.dev', project: erp, dept: 'IT', status: 'completed', priority: 'high', deadline: at(-45), est: 24, act: 26, complexity: 4, quality: 5, completedDaysAgo: 46, created: -58, milestone: 0 },
    { title: 'Vendor master data cleanup', who: ['aditya'], by: 'tl.dev', project: erp, dept: 'IT', status: 'in_progress', priority: 'critical', deadline: at(3), est: 30, act: 12, progress: 45, complexity: 4, created: -20, milestone: 1 },
    { title: 'Write migration scripts', who: ['employee', 'sneha'], by: 'tl.dev', project: erp, dept: 'IT', status: 'in_progress', priority: 'high', deadline: at(6), est: 40, act: 15, progress: 35, complexity: 5, created: -15, milestone: 1 },
    { title: 'Integration with payroll system', who: ['sneha'], by: 'pm', project: erp, dept: 'IT', status: 'blocked', priority: 'high', deadline: at(-1), est: 16, act: 6, progress: 30, complexity: 4, created: -18, blocker: 'Waiting for payroll vendor API credentials' },
    { title: 'Set up staging environment', who: ['rahul'], by: 'tl.infra', project: erp, dept: 'IT', status: 'submitted', priority: 'medium', deadline: at(1), est: 10, act: 9, progress: 100, complexity: 3, created: -10 },
    { title: 'Security review of ERP roles', who: ['pooja'], by: 'hod.it', project: erp, dept: 'IT', status: 'not_started', priority: 'medium', deadline: at(14), est: 12, complexity: 3, created: -3 },
    { title: 'UAT test plan', who: ['employee'], by: 'pm', project: erp, dept: 'IT', status: 'not_started', priority: 'medium', deadline: at(30), est: 16, complexity: 3, created: -2, milestone: 2 },
    { title: 'Leave approval workflow', who: ['aditya'], by: 'tl.dev', project: portal, dept: 'IT', status: 'revision_required', priority: 'high', deadline: at(-3), est: 20, act: 22, progress: 90, complexity: 4, created: -25, revisions: 1 },
    { title: 'Payslip PDF generation', who: ['employee'], by: 'tl.dev', project: portal, dept: 'IT', status: 'completed', priority: 'medium', deadline: at(-8), est: 12, act: 10, complexity: 3, quality: 4, completedDaysAgo: 9, created: -24 },
    { title: 'Onboarding checklist content', who: ['nikhil'], by: 'hod.hr', project: portal, dept: 'HR', status: 'completed', priority: 'low', deadline: at(-6), est: 6, act: 8, complexity: 2, quality: 4, completedDaysAgo: 4, created: -20 },
    { title: 'Leave policy document update', who: ['divya'], by: 'hod.hr', project: portal, dept: 'HR', status: 'in_progress', priority: 'medium', deadline: at(-2), est: 8, act: 5, progress: 60, complexity: 2, created: -12 },
    { title: 'Brand guideline draft', who: ['tanvi'], by: 'pm2', project: brand, dept: 'MKT', status: 'under_review', priority: 'high', deadline: at(2), est: 30, act: 28, progress: 100, complexity: 4, created: -15 },
    { title: 'Campaign SEO keyword research', who: ['yash'], by: 'hod.mkt', project: brand, dept: 'MKT', status: 'in_progress', priority: 'medium', deadline: at(4), est: 12, act: 4, progress: 30, complexity: 3, created: -8 },
    { title: 'Social media calendar', who: ['yash'], by: 'hod.mkt', project: brand, dept: 'MKT', status: 'completed', priority: 'low', deadline: at(-4), est: 6, act: 7, complexity: 2, quality: 3, completedDaysAgo: 3, created: -14 },
    { title: 'Q3 budget variance analysis', who: ['manish'], by: 'hod.fin', dept: 'FIN', status: 'completed', priority: 'high', deadline: at(-12), est: 16, act: 14, complexity: 4, quality: 5, completedDaysAgo: 13, created: -25 },
    { title: 'Payroll reconciliation – November', who: ['ritika'], by: 'hod.fin', dept: 'FIN', status: 'in_progress', priority: 'critical', deadline: at(0, 17), est: 10, act: 6, progress: 70, complexity: 3, created: -6 },
    { title: 'Vendor payment audit', who: ['manish', 'ritika'], by: 'hod.fin', dept: 'FIN', status: 'not_started', priority: 'medium', deadline: at(9), est: 14, complexity: 3, created: -1 },
    { title: 'Warehouse safety inspection', who: ['farhan'], by: 'hod.ops', dept: 'OPS', status: 'in_progress', priority: 'high', deadline: at(-4), est: 8, act: 3, progress: 40, complexity: 2, created: -10 },
    { title: 'Fleet maintenance schedule', who: ['farhan'], by: 'hod.ops', dept: 'OPS', status: 'completed', priority: 'medium', deadline: at(-15), est: 6, act: 9, complexity: 2, quality: 3, completedDaysAgo: 10, created: -30 },
    { title: 'SSO rollout for all apps', who: ['rahul', 'pooja'], by: 'tl.infra', project: infra, dept: 'IT', status: 'completed', priority: 'high', deadline: at(-30), est: 40, act: 44, complexity: 5, quality: 4, completedDaysAgo: 28, created: -100 },
    { title: 'MFA enforcement', who: ['pooja'], by: 'tl.infra', project: infra, dept: 'IT', status: 'completed', priority: 'high', deadline: at(-20), est: 16, act: 15, complexity: 4, quality: 5, completedDaysAgo: 21, created: -80 },
    { title: 'Kubernetes cluster upgrade', who: ['rahul'], by: 'tl.infra', dept: 'IT', status: 'in_progress', priority: 'medium', deadline: at(5), est: 12, act: 4, progress: 30, complexity: 4, created: -5 },
    { title: 'Code review guidelines', who: ['tl.dev'], by: 'hod.it', dept: 'IT', status: 'on_hold', priority: 'low', deadline: at(20), est: 4, complexity: 1, created: -7 },
  ];
  const ids: number[] = [];
  for (const t of tasks) {
    const completedAt = t.completedDaysAgo != null ? now.minus({ days: t.completedDaysAgo }).toUTC().toJSDate() : null;
    const [row] = await db('tasks').insert({
      title: t.title, department_id: D[t.dept], project_id: t.project?.id ?? null, assigned_by: U[t.by], status: t.status, priority: t.priority, deadline: t.deadline,
      estimated_hours: t.est ?? null, actual_hours: t.act ?? 0, progress: t.status === 'completed' ? 100 : t.progress ?? 0, complexity: t.complexity ?? 3,
      quality_rating: t.quality ?? null, completed_at: completedAt, approved_by: completedAt ? U[t.by] : null, revision_count: t.revisions ?? 0, blocker_note: t.blocker ?? null,
      milestone_id: t.milestone != null ? ms[t.milestone].id : null, submitted_at: ['submitted', 'under_review'].includes(t.status) ? at(-1, 12) : completedAt,
      start_date: now.plus({ days: t.created ?? -5 }).toISODate(), created_at: now.plus({ days: t.created ?? -5 }).toUTC().toJSDate(),
      is_overdue: !!t.deadline && t.deadline < new Date() && !['completed', 'cancelled', 'submitted', 'under_review'].includes(t.status),
    }).returning('id');
    ids.push(row.id);
    await db('task_assignees').insert(t.who.map((w, i) => ({ task_id: row.id, user_id: U[w], is_primary: i === 0, assigned_by: U[t.by] })));
    await db('task_updates').insert({ task_id: row.id, user_id: U[t.by], kind: 'status', status_to: 'not_started', note: 'Task created', created_at: now.plus({ days: t.created ?? -5 }).toUTC().toJSDate() });
    if (t.status !== 'not_started') await db('task_updates').insert({ task_id: row.id, user_id: U[t.who[0]], kind: 'progress', status_from: 'not_started', status_to: t.status, progress: t.progress ?? 100, note: t.blocker ?? 'Progress update', created_at: now.minus({ hours: 6 + Math.floor(Math.random() * 60) }).toUTC().toJSDate() });
    if (['submitted', 'under_review'].includes(t.status)) await db('task_approvals').insert({ task_id: row.id, approval_type: 'completion', requested_by: U[t.who[0]], request_note: 'Ready for review', reviewer_id: t.status === 'under_review' ? U[t.by] : null });
    if (completedAt) await db('task_approvals').insert({ task_id: row.id, approval_type: 'completion', requested_by: U[t.who[0]], reviewer_id: U[t.by], decision: 'approved', quality_rating: t.quality, decided_at: completedAt, requested_at: completedAt });
    if (t.act) await db('time_entries').insert({ task_id: row.id, user_id: U[t.who[0]], entry_date: now.minus({ days: 2 }).toISODate(), hours: Math.min(t.act, 8), note: 'Logged work' });
  }
  await db('task_dependencies').insert([{ task_id: ids[2], depends_on_task_id: ids[1] }, { task_id: ids[6], depends_on_task_id: ids[2] }]);
  await db('subtasks').insert([
    { task_id: ids[2], title: 'Customers table', is_done: true }, { task_id: ids[2], title: 'Invoices table' }, { task_id: ids[2], title: 'GL entries' },
    { task_id: ids[1], title: 'Identify duplicates', is_done: true }, { task_id: ids[1], title: 'Merge records' },
  ]);
  await db('task_checklist_items').insert([{ task_id: ids[4], label: 'Provision DB', is_done: true }, { task_id: ids[4], label: 'Deploy services', is_done: true }, { task_id: ids[4], label: 'Smoke tests', is_done: true }]);
  await db('task_comments').insert([
    { task_id: ids[3], author_id: U.sneha, body: 'Still waiting on credentials from the payroll vendor. @Rohan can you escalate?', mentions: [U.pm] },
    { task_id: ids[7], author_id: U['tl.dev'], body: 'Please handle the half-day leave edge case and add tests.', is_feedback: true },
  ]);
  await db('task_approvals').insert({ task_id: ids[10], approval_type: 'extension', requested_by: U.divya, request_note: 'Legal review of the new policy is pending', previous_deadline: tasks[10].deadline, requested_deadline: at(4) });

  // daily reports for the last few working days
  const reporters = ['employee', 'aditya', 'sneha', 'rahul', 'pooja', 'nikhil', 'divya', 'manish', 'ritika', 'tanvi', 'yash', 'farhan', 'tl.dev', 'tl.infra'];
  for (let back = 1; back <= 6; back++) {
    const day = now.minus({ days: back });
    if (day.weekday > 5) continue;
    for (const r of reporters) {
      if (Math.random() < 0.15) continue;
      await db('daily_reports').insert({ user_id: U[r], report_date: day.toISODate(), work_planned: 'Continue assigned tasks', work_completed: 'Progressed on current sprint items and resolved review comments',
        work_pending: 'Remaining test cases', hours_spent: 7 + Math.round(Math.random() * 2), challenges: Math.random() < 0.3 ? 'Environment instability' : null,
        next_actions: 'Pick up next item', support_required: Math.random() < 0.15 ? 'Need access to staging DB' : null, status: back > 2 ? 'reviewed' : 'submitted', reviewer_id: back > 2 ? U['hod.it'] : null });
    }
  }
  await db('management_agenda').insert([
    { owner_id: U.director, title: 'Check IT department progress', due_at: at(1, 10), timezone: tz, priority: 'high', notes: 'Focus on ERP data migration risk' },
    { owner_id: U.director, title: 'Review future project plan', due_at: at(3, 15), timezone: tz, priority: 'medium' },
    { owner_id: U.admin, title: 'Follow up with HOD Finance on budget', due_at: at(2, 13), timezone: tz, priority: 'medium' },
  ]);
  await db('meetings').insert({ title: 'ERP weekly steering', project_id: erp.id, organizer_id: U.pm, starts_at: at(2, 11), ends_at: at(2, 12), location: 'Board room / Teams', agenda: 'Migration status, risks, decisions' });
  const [mtg] = await db('meetings').select('id').limit(1);
  await db('meeting_attendees').insert([U.pm, U['hod.it'], U['tl.dev'], U.director].map((id) => ({ meeting_id: mtg.id, user_id: id })));
  await db('approval_requests').insert({ approval_type: 'budget_change', project_id: erp.id, title: 'Increase ERP budget for extra data-migration contractor', details: 'Two-month contractor to clean vendor data', payload: JSON.stringify({ estimated_budget: 2750000 }), requested_by: U.pm });
  for (const p of [erp.id, portal.id, brand.id]) {
    const r = await db('tasks').where({ project_id: p }).whereNot('status', 'cancelled').first(db.raw('sum(coalesce(estimated_hours,1)) AS t'), db.raw(`sum(coalesce(estimated_hours,1)) FILTER (WHERE status='completed') AS d`));
    await db('projects').where({ id: p }).update({ progress: Math.round((Number(r.d ?? 0) / Number(r.t)) * 100) });
  }
  logger.info('demo data seeded');
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.includes('--reset')) {
      await db.raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      logger.info('database reset');
    }
    await migrate();
    await seedBase();
    if (args.includes('--demo')) await seedDemo();
    await db.destroy();
  })().catch((e) => { console.error(e); process.exit(1); });
}
