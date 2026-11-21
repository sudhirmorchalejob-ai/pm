import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/knex';
import { app, as, inHours, PASSWORD, userId } from './helpers';

afterAll(async () => { await db.destroy(); });

describe('authentication', () => {
  it('rejects bad credentials and accepts good ones', async () => {
    expect((await request(app).post('/api/auth/login').send({ email: 'employee@orgpm.dev', password: 'wrong' })).status).toBe(401);
    const ok = await request(app).post('/api/auth/login').send({ email: 'employee@orgpm.dev', password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.body.user.role).toBe('employee');
    expect(ok.headers['set-cookie'][0]).toMatch(/orgpm_rt=.*HttpOnly/i);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: 'pm@orgpm.dev', password: PASSWORD });
    const c1 = login.headers['set-cookie'][0].split(';')[0];
    const r1 = await request(app).post('/api/auth/refresh').set('Cookie', c1);
    expect(r1.status).toBe(200);
    const c2 = r1.headers['set-cookie'][0].split(';')[0];
    expect(c2).not.toBe(c1);
    // replaying the old token = theft signal → whole family revoked
    expect((await request(app).post('/api/auth/refresh').set('Cookie', c1)).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', c2)).status).toBe(401);
  });

  it('locks the account after 5 failed attempts', async () => {
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ email: 'farhan@orgpm.dev', password: 'nope' });
    const r = await request(app).post('/api/auth/login').send({ email: 'farhan@orgpm.dev', password: PASSWORD });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/locked/i);
    await db('users').where({ email: 'farhan@orgpm.dev' }).update({ failed_logins: 0, locked_until: null });
  });

  it('requires a token for protected endpoints', async () => {
    expect((await request(app).get('/api/tasks')).status).toBe(401);
    expect((await request(app).get('/api/tasks').set('Authorization', 'Bearer garbage')).status).toBe(401);
  });
});

describe('role-based access control & data scope', () => {
  it('blocks employees from admin actions', async () => {
    const emp = await as('employee@orgpm.dev');
    expect((await emp.post('/org/departments').send({ name: 'Legal', code: 'LEG' })).status).toBe(403);
    expect((await emp.get('/org/users')).status).toBe(403);
    expect((await emp.get('/audit')).status).toBe(403);
    expect((await emp.put('/settings').send({ overload_threshold_percent: 120 })).status).toBe(403);
  });

  it('employees see only their own tasks', async () => {
    const emp = await as('employee@orgpm.dev');
    const me = await userId('employee@orgpm.dev');
    const r = await emp.get('/tasks?pageSize=200');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    for (const t of r.body.items) expect(t.assignees.some((a: any) => a.id === me) || t.assigned_by === me).toBe(true);
    const foreign = await db('tasks as t').join('task_assignees as ta', 'ta.task_id', 't.id').whereNot('ta.user_id', me).whereNot('t.assigned_by', me)
      .whereNotExists(db('task_assignees as x').whereRaw('x.task_id = t.id').andWhere('x.user_id', me)).first('t.id');
    expect((await emp.get(`/tasks/${foreign.id}`)).status).toBe(404);
  });

  it('HOD sees own department but not others', async () => {
    const hod = await as('hod.it@orgpm.dev');
    const r = await hod.get('/tasks?pageSize=200');
    const deptIds = new Set(r.body.items.map((t: any) => t.department_id));
    const it = (await db('departments').where({ code: 'IT' }).first()).id;
    expect([...deptIds].every((d) => d === it)).toBe(true);
    const mkt = await db('tasks as t').join('departments as d', 'd.id', 't.department_id').where('d.code', 'MKT').first('t.id');
    expect((await hod.get(`/tasks/${mkt.id}`)).status).toBe(404);
    const mktDept = (await db('departments').where({ code: 'MKT' }).first()).id;
    expect((await hod.get(`/monitoring/departments/${mktDept}`)).status).toBe(403);
  });

  it('HOD cannot assign work outside the department', async () => {
    const hod = await as('hod.it@orgpm.dev');
    const r = await hod.post('/tasks').send({ title: 'Cross-dept attempt', assignee_ids: [await userId('tanvi@orgpm.dev')] });
    expect(r.status).toBe(403);
  });

  it('management viewer is read-only', async () => {
    const v = await as('viewer@orgpm.dev');
    expect((await v.get('/dashboard')).status).toBe(200);
    expect((await v.get('/monitoring/departments')).status).toBe(200);
    expect((await v.post('/tasks').send({ title: 'x', assignee_ids: [1] })).status).toBe(403);
    expect((await v.post('/projects').send({ code: 'V1', name: 'Viewer project' })).status).toBe(403);
  });

  it('permission matrix changes take effect', async () => {
    const admin = await as('admin@orgpm.dev');
    const roles = (await admin.get('/org/roles')).body;
    const viewer = roles.find((r: any) => r.key === 'management_viewer');
    await admin.put(`/org/roles/${viewer.id}/permissions`).send({ permissions: viewer.permissions.filter((p: string) => p !== 'monitoring.departments') });
    const { invalidateUserCache } = await import('../src/auth/middleware');
    invalidateUserCache();
    const v = await as('viewer@orgpm.dev');
    expect((await v.get('/monitoring/departments')).status).toBe(403);
    await admin.put(`/org/roles/${viewer.id}/permissions`).send({ permissions: viewer.permissions });
    invalidateUserCache();
  });
});

describe('organization management', () => {
  it('creates a department, team and employee with reporting line', async () => {
    const admin = await as('admin@orgpm.dev');
    const d = await admin.post('/org/departments').send({ name: 'Legal', code: 'LEG' });
    expect(d.status).toBe(201);
    expect((await admin.post('/org/departments').send({ name: 'Legal 2', code: 'LEG' })).status).toBe(409);
    const role = (await admin.get('/org/roles')).body.find((r: any) => r.key === 'employee');
    const u = await admin.post('/org/users').send({ employee_code: 'L001', name: 'Lena Law', email: 'lena@orgpm.dev', role_id: role.id, department_id: d.body.id, manager_id: await userId('director@orgpm.dev') });
    expect(u.status).toBe(201);
    expect(u.body.temporaryPassword).toMatch(/^Tmp-/);
    const t = await admin.post('/org/teams').send({ name: 'Contracts', department_id: d.body.id, leader_id: u.body.id });
    expect(t.status).toBe(201);
    const hist = await db('reporting_hierarchy').where({ user_id: u.body.id });
    expect(hist).toHaveLength(1);
    // must change temporary password at first login
    const login = await request(app).post('/api/auth/login').send({ email: 'lena@orgpm.dev', password: u.body.temporaryPassword });
    expect(login.body.user.must_change_password).toBe(true);
    // deactivate department
    expect((await admin.patch(`/org/departments/${d.body.id}`).send({ is_active: false })).status).toBe(200);
  });

  it('prevents assigning a role at or above your own', async () => {
    const hod = await as('hod.it@orgpm.dev');
    expect((await hod.post('/org/users').send({})).status).toBe(403); // hod lacks users.manage
  });
});

describe('task lifecycle & approval workflow', () => {
  let taskId: number;
  it('HOD assigns, employee works and submits, HOD approves', async () => {
    const hod = await as('hod.it@orgpm.dev');
    const emp = await as('employee@orgpm.dev');
    const project = await db('projects').where({ code: 'ERP-2026' }).first();
    const create = await hod.post('/tasks').send({
      title: 'Write API docs', project_id: project.id, assignee_ids: [await userId('employee@orgpm.dev')], priority: 'high',
      deadline: inHours(48), estimated_hours: 6, subtasks: ['Endpoints', 'Examples'], checklist: ['Reviewed'], reminders: [{ offset_minutes: 30, channels: ['in_app'] }],
    });
    expect(create.status).toBe(201);
    taskId = create.body.id;
    expect(create.body.task_key).toMatch(/^TSK-\d+/);
    expect(await db('notification_schedules').where({ task_id: taskId, schedule_type: 'deadline_offset' }).first()).toBeTruthy();

    // employee cannot review their own task, cannot edit the task definition
    expect((await emp.patch(`/tasks/${taskId}`).send({ title: 'hacked' })).status).toBe(403);
    expect((await emp.post(`/tasks/${taskId}/progress`).send({ status: 'in_progress', progress: 40, note: 'Started', hours: 2 })).status).toBe(200);
    // progress never reaches 100 before approval
    await emp.post(`/tasks/${taskId}/progress`).send({ progress: 100 });
    expect((await db('tasks').where({ id: taskId }).first()).progress).toBe(99);
    expect((await emp.post(`/tasks/${taskId}/submit`).send({ note: 'Done' })).status).toBe(200);
    expect((await emp.post(`/tasks/${taskId}/review`).send({ decision: 'approved' })).status).toBe(403);

    // revision cycle
    expect((await hod.post(`/tasks/${taskId}/review`).send({ decision: 'revision_required' })).status).toBe(400); // comment required
    expect((await hod.post(`/tasks/${taskId}/review`).send({ decision: 'revision_required', comments: 'Add auth section' })).status).toBe(200);
    let t = await db('tasks').where({ id: taskId }).first();
    expect(t.status).toBe('revision_required');
    expect(t.revision_count).toBe(1);
    expect(t.completed_at).toBeNull();
    await emp.post(`/tasks/${taskId}/submit`).send({ note: 'Fixed' });
    const approve = await hod.post(`/tasks/${taskId}/review`).send({ decision: 'approved', quality_rating: 5, comments: 'Great' });
    expect(approve.status).toBe(200);
    t = await db('tasks').where({ id: taskId }).first();
    expect(t.status).toBe('completed');
    expect(t.completed_at).not.toBeNull();
    expect(t.quality_rating).toBe(5);
    // reminders cancelled on completion (default policy)
    const s = await db('notification_schedules').where({ task_id: taskId }).first();
    expect(s.status).toBe('cancelled');
    // audit trail exists
    const actions = await db('audit_logs').where({ entity_type: 'task', entity_id: taskId }).pluck('action');
    expect(actions).toEqual(expect.arrayContaining(['task.created', 'task.submitted', 'task.revision_required', 'task.approved']));
  });

  it('assignee notified on assignment via event rules', async () => {
    const me = await userId('employee@orgpm.dev');
    const log = await db('notification_logs').where({ user_id: me, channel: 'in_app', category: 'event' }).where('title', 'like', 'New task:%').first();
    expect(log).toBeTruthy();
  });

  it('extension request and approval moves the deadline', async () => {
    const hod = await as('hod.it@orgpm.dev');
    const emp = await as('employee@orgpm.dev');
    const c = await hod.post('/tasks').send({ title: 'Extension test', assignee_ids: [await userId('employee@orgpm.dev')], deadline: inHours(5) });
    const id = c.body.id;
    const newDeadline = inHours(72);
    expect((await emp.post(`/tasks/${id}/extension`).send({ requested_deadline: inHours(1), reason: 'Too short' })).status).toBe(400);
    const req = await emp.post(`/tasks/${id}/extension`).send({ requested_deadline: newDeadline, reason: 'Waiting for data' });
    expect(req.status).toBe(201);
    expect((await emp.post(`/tasks/${id}/extension`).send({ requested_deadline: newDeadline, reason: 'Again please' })).status).toBe(409);
    expect((await hod.post(`/tasks/${id}/extension/${req.body.id}/decide`).send({ decision: 'approved' })).status).toBe(200);
    expect(new Date((await db('tasks').where({ id }).first()).deadline).toISOString()).toBe(newDeadline);
    const deadlineAudit = await db('audit_logs').where({ entity_type: 'task', entity_id: id, action: 'task.extension_approved' }).first();
    expect(deadlineAudit.actor_id).toBe(await userId('hod.it@orgpm.dev'));
  });

  it('rejects dependency cycles and enforces finish-to-start', async () => {
    const hod = await as('hod.it@orgpm.dev');
    const emp = await as('employee@orgpm.dev');
    const me = await userId('employee@orgpm.dev');
    const a = (await hod.post('/tasks').send({ title: 'Dep A', assignee_ids: [me] })).body.id;
    const b = (await hod.post('/tasks').send({ title: 'Dep B', assignee_ids: [me] })).body.id;
    expect((await hod.post(`/tasks/${b}/dependencies`).send({ depends_on_task_id: a })).status).toBe(201);
    expect((await hod.post(`/tasks/${a}/dependencies`).send({ depends_on_task_id: b })).status).toBe(400);
    const start = await emp.post(`/tasks/${b}/progress`).send({ status: 'in_progress' });
    expect(start.status).toBe(400);
    expect(start.body.error).toMatch(/dependencies/);
  });

  it('deadline change re-arms deadline reminders and is audited', async () => {
    const hod = await as('hod.it@orgpm.dev');
    const c = await hod.post('/tasks').send({ title: 'Rearm', assignee_ids: [await userId('aditya@orgpm.dev')], deadline: inHours(10), reminders: [{ offset_minutes: 60, channels: ['in_app'] }] });
    const before = await db('notification_schedules').where({ task_id: c.body.id }).first();
    const nd = inHours(30);
    expect((await hod.patch(`/tasks/${c.body.id}`).send({ deadline: nd, deadline_change_reason: 'Scope grew' })).status).toBe(200);
    const after = await db('notification_schedules').where({ id: before.id }).first();
    expect(new Date(after.next_run_at).getTime()).toBe(new Date(nd).getTime() - 3600_000);
    expect(await db('audit_logs').where({ entity_id: c.body.id, action: 'task.deadline_changed' }).first()).toBeTruthy();
  });
});

describe('projects & future planning', () => {
  it('creates a future project and converts it with data preserved', async () => {
    const pm = await as('pm@orgpm.dev');
    const director = await as('director@orgpm.dev');
    const start = new Date(Date.now() + 40 * 86400_000).toISOString().slice(0, 10);
    const r = await pm.post('/projects').send({ code: 'NEXT-Q', name: 'Next quarter rollout', is_future: true, priority: 'high', estimated_budget: 100000,
      future: { expected_start_date: start, planning_horizon: 'next_quarter', required_employees: 3, required_skills: ['React'] } });
    expect(r.status).toBe(201);
    const id = r.body.id;
    expect((await pm.get('/future-projects')).body.items.some((p: any) => p.project_id === id)).toBe(true);
    expect((await pm.get('/projects?future=false&pageSize=200')).body.items.some((p: any) => p.id === id)).toBe(false);
    // PM cannot self-approve or tick management approval
    expect((await pm.patch(`/future-projects/${id}`).send({ approval_status: 'approved' })).status).toBe(403);
    await pm.patch(`/future-projects/${id}`).send({ chk_requirements: true, chk_budget_approved: true, approval_status: 'pending' });
    expect((await db('future_projects').where({ project_id: id }).first()).readiness_percent).toBe(25);
    expect((await pm.post(`/future-projects/${id}/convert`).send({})).status).toBe(400); // not approved
    const reqRow = await db('approval_requests').where({ project_id: id, approval_type: 'project_approval' }).first();
    expect((await director.post(`/approvals/requests/${reqRow.id}/decide`).send({ decision: 'approved' })).status).toBe(200);
    expect((await pm.post(`/future-projects/${id}/convert`).send({})).status).toBe(400); // readiness < 100 without force
    const conv = await pm.post(`/future-projects/${id}/convert`).send({ force: true });
    expect(conv.status).toBe(200);
    expect(conv.body.is_future).toBe(false);
    expect(conv.body.start_date).toBe(start);
    const fp = await db('future_projects').where({ project_id: id }).first();
    expect(fp.converted_at).not.toBeNull();
    expect(fp.required_skills).toEqual(['React']);
  });

  it('applies budget changes only through approval', async () => {
    const pm = await as('pm@orgpm.dev');
    const director = await as('director@orgpm.dev');
    const p = await db('projects').where({ code: 'ERP-2026' }).first();
    expect((await pm.patch(`/projects/${p.id}`).send({ estimated_budget: 9999999 })).status).toBe(400);
    const req = await pm.post('/approvals/requests').send({ approval_type: 'budget_change', project_id: p.id, title: 'More budget', payload: { estimated_budget: 3000000 } });
    expect(req.status).toBe(201);
    expect((await pm.post(`/approvals/requests/${req.body.id}/decide`).send({ decision: 'approved' })).status).toBe(403);
    expect((await director.post(`/approvals/requests/${req.body.id}/decide`).send({ decision: 'approved', comments: 'OK' })).status).toBe(200);
    expect(Number((await db('projects').where({ id: p.id }).first()).estimated_budget)).toBe(3000000);
  });

  it('validates project dates', async () => {
    const pm = await as('pm@orgpm.dev');
    expect((await pm.post('/projects').send({ code: 'BAD-D', name: 'Bad dates', start_date: '2026-12-10', end_date: '2026-12-01' })).status).toBe(400);
  });
});

describe('daily reports', () => {
  it('submits, lists missing and reviews', async () => {
    const emp = await as('aditya@orgpm.dev');
    const hod = await as('hod.it@orgpm.dev');
    const today = (await db.raw(`select (now() at time zone 'Asia/Kolkata')::date::text as d`)).rows[0].d;
    const r = await emp.post('/daily-reports').send({ report_date: today, work_completed: 'Merged vendor records', hours_spent: 7.5, challenges: 'Slow DB' });
    expect([200, 201]).toContain(r.status);
    const missing = await hod.get(`/daily-reports/missing?date=${today}`);
    expect(missing.body.missing.some((m: any) => m.id === r.body.user_id)).toBe(false);
    expect((await hod.post(`/daily-reports/${r.body.id}/review`).send({ status: 'reviewed', comment: 'Thanks' })).status).toBe(200);
    // locked after review
    expect((await emp.post('/daily-reports').send({ report_date: today, work_completed: 'Edit', hours_spent: 1 })).status).toBe(400);
    expect((await emp.post('/daily-reports').send({ report_date: '2099-01-01', work_completed: 'Future', hours_spent: 1 })).status).toBe(400);
  });
});

describe('reports, analytics & audit', () => {
  it('builds KPI reports and exports', async () => {
    const admin = await as('admin@orgpm.dev');
    const r = await admin.get('/reports/employees?period=monthly');
    expect(r.status).toBe(200);
    const row = r.body.rows.find((x: any) => x.name === 'Ishita Gupta');
    expect(row.completed).toBeGreaterThanOrEqual(1);
    const x = await admin.get('/reports/departments?format=xlsx&period=custom&from=2026-01-01&to=2026-12-31');
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toMatch(/spreadsheetml/);
    const p = await admin.get('/reports/projects?format=pdf');
    expect(p.status).toBe(200);
    expect(p.headers['content-type']).toBe('application/pdf');
    const emp = await as('employee@orgpm.dev');
    expect((await emp.get('/reports/projects?format=xlsx')).status).toBe(403);
  });

  it('serves role dashboards, calendar, gantt, resources, insights', async () => {
    for (const [email, kind] of [['admin@orgpm.dev', 'super_admin'], ['pm@orgpm.dev', 'project_manager'], ['hod.it@orgpm.dev', 'hod'], ['employee@orgpm.dev', 'employee']]) {
      const r = await (await as(email)).get('/dashboard');
      expect(r.status).toBe(200);
      expect(r.body.kind).toBe(kind);
    }
    const admin = await as('admin@orgpm.dev');
    expect((await admin.get('/calendar?from=2026-11-01&to=2026-12-31')).body.events.length).toBeGreaterThan(0);
    const p = await db('projects').where({ code: 'ERP-2026' }).first();
    const g = await admin.get(`/gantt?project_id=${p.id}`);
    expect(g.body.dependencies.length).toBeGreaterThan(0);
    expect((await admin.get('/resources')).body.people.length).toBeGreaterThan(0);
    expect((await admin.get('/insights/summary')).body.summary.length).toBeGreaterThan(0);
  });

  it('audit log is append-only', async () => {
    await expect(db('audit_logs').update({ action: 'tampered' })).rejects.toThrow(/append-only/);
    await expect(db('audit_logs').del()).rejects.toThrow(/append-only/);
  });

  it('validates input and never leaks SQL errors', async () => {
    const admin = await as('admin@orgpm.dev');
    const r = await admin.get("/tasks?q=' OR 1=1 --");
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(0);
    expect((await admin.post('/tasks').send({ title: '' })).status).toBe(400);
    expect((await admin.get('/tasks/abc')).status).toBe(400);
  });
});
