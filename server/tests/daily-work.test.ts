import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { baseDb, db, runInOrg } from '../src/db/knex';
import { getQueues } from '../src/notifications/queues';
import { redis } from '../src/lib/redis';
import { materializeSeries, runPersonalTaskRemindersInOrg } from '../src/daily-work/personal-tasks';
import { app, as, PASSWORD } from './helpers';

afterAll(async () => {
  const q = getQueues();
  for (const k of ['schedules', 'deliveries', 'maintenance'] as const) await q[k].obliterate({ force: true });
  await Promise.all([q.schedules.close(), q.deliveries.close(), q.maintenance.close()]);
  await redis().quit();
  await db.destroy();
});

const TZ = 'Asia/Kolkata';
const TEMP = 'Welcome@2026';
type Client = Awaited<ReturnType<typeof as>>;

/**
 * The company structure from the requirements, applied to a freshly registered organization
 * through the administrative team setup, then exercised end to end as the HOD.
 */
describe('team setup, quick activities, personal tasks and personal EOD', () => {
  let owner: Client;
  let sudhir: Client;
  let neha: Client;
  let orgId: number;
  const ids: Record<string, number> = {};
  const today = () => DateTime.now().setZone(TZ).toISODate()!;

  beforeAll(async () => {
    const r = await request(app).post('/api/auth/register').send({ organization_name: 'Rajlaxmi Group (test)', name: 'Group Owner', email: 'owner@rajlaxmi.test', password: PASSWORD, timezone: TZ });
    expect(r.status).toBe(201);
    owner = await as('owner@rajlaxmi.test');
    orgId = (await baseDb('users').where({ email: 'owner@rajlaxmi.test' }).first('organization_id')).organization_id;
  });

  it('previews the starter structure without writing, and asks for emails', async () => {
    const starter = (await owner.get('/org/setup/team-structure/starter')).body;
    expect(starter.employees.map((e: any) => e.name)).toContain('Sudhir');
    const dry = (await owner.post('/org/setup/team-structure').send({ options: { dry_run: true } })).body;
    expect(dry.dry_run).toBe(true);
    expect(dry.summary).toMatchObject({ companies_created: 2, departments_created: 5 });
    expect(dry.plan.filter((p: any) => p.kind === 'employee' && p.error === 'Email needed (enter one, or an email domain)').length).toBe(11);
    const withDomain = (await owner.post('/org/setup/team-structure').send({ options: { dry_run: true, email_domain: 'rajlaxmi.test' } })).body;
    expect(withDomain.summary.employees_created).toBe(11);
    expect(withDomain.plan.find((p: any) => p.name === 'Neha').email).toBe('neha@rajlaxmi.test');
    expect(await runInOrg(orgId, () => db('users').count({ c: '*' }).first()).then((x: any) => Number(x.c))).toBe(1); // nothing written
  });

  it('applies the structure once and never duplicates on re-apply', async () => {
    const r = await owner.post('/org/setup/team-structure').send({ options: { dry_run: false, email_domain: 'rajlaxmi.test', temporary_password: TEMP, apply_templates: true } });
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ companies_created: 2, departments_created: 5, employees_created: 11, skipped: 0 });
    expect(r.body.generated_passwords).toEqual([]);
    const again = (await owner.post('/org/setup/team-structure').send({ options: { dry_run: false, email_domain: 'rajlaxmi.test', temporary_password: TEMP } })).body;
    expect(again.summary).toMatchObject({ companies_created: 0, departments_created: 0, designations_created: 0, employees_created: 0, skipped: 0 });

    await runInOrg(orgId, async () => {
      for (const u of await db('users').select('id', 'name')) ids[u.name] = u.id;
      expect(await db('users').count({ c: '*' }).first().then((x: any) => Number(x.c))).toBe(12);
      const s = await db('users as u').join('roles as r', 'r.id', 'u.role_id').leftJoin('designations as g', 'g.id', 'u.designation_id').where('u.name', 'Sudhir').first('r.key', 'g.title', 'u.must_change_password');
      expect(s).toMatchObject({ key: 'super_admin', title: 'Head of Department', must_change_password: true });
      const extra = await db('user_designations as ud').join('designations as g', 'g.id', 'ud.designation_id').where('ud.user_id', ids.Sudhir).pluck('g.title');
      expect(extra.sort()).toEqual(['Full Stack Developer', 'Project Coordinator']);
      const dev = await db('departments').where({ name: 'Development' }).first();
      expect(dev.hod_id).toBe(ids.Sudhir);
      const companyOf = async (n: string) => (await db('users as u').leftJoin('companies as c', 'c.id', 'u.company_id').where('u.name', n).first('c.name')).name;
      expect(await companyOf('Renuka')).toBe('Rajlaxmi Solutions');
      expect(await companyOf('Rohini')).toBe('Averlon Enterprise Solutions');
      expect((await db('users').where({ id: ids.Neha }).first('manager_id')).manager_id).toBe(ids.Sudhir);
      // Development got the starter checklist template; DevOps (no template) did not
      expect(Number((await db('question_assignments').where({ department_id: dev.id }).count({ c: '*' }).first())!.c)).toBeGreaterThan(0);
      // employees can sign in now (temporary password)
      await db('users').whereIn('id', [ids.Sudhir, ids.Neha]).update({ must_change_password: false, password_hash: (await db('users').where({ email: 'owner@rajlaxmi.test' }).first('password_hash')).password_hash });
    });
    sudhir = await as('sudhir@rajlaxmi.test');
    neha = await as('neha@rajlaxmi.test');
  });

  it('records quick activities with optional employees, departments and projects', async () => {
    const cats = (await sudhir.get('/activities/categories')).body;
    expect(cats).toHaveLength(20);
    const cat = (name: string) => cats.find((c: any) => c.name === name).id;
    const devops = await runInOrg(orgId, async () => (await db('departments').where({ name: 'DevOps' }).first('id')).id);

    const a1 = await sudhir.post('/activities').send({ category_id: cat('Coordinated With Employee'), participant_ids: [ids.Neha], description: 'Coordinated regarding required APIs and explained the implementation approach.' });
    expect(a1.status).toBe(201);
    expect(a1.body.participants.map((p: any) => p.name)).toEqual(['Neha']);
    expect(a1.body.activity_date).toBe(today());
    const a2 = await sudhir.post('/activities').send({ category_id: cat('Guided Employee to Fix Technical Issue'), participant_ids: [ids.Saurabh], department_ids: [devops], description: 'Investigated the HRMS issue and provided guidance for resolution.', issue_resolved: false, follow_up_required: true, follow_up_note: 'Check the fix tomorrow', duration_minutes: 45 });
    expect(a2.status).toBe(201);
    expect(a2.body.participants.map((p: any) => p.name).sort()).toEqual(['Saurabh', 'Utkarsh']);
    expect(a2.body.participants.find((p: any) => p.name === 'Utkarsh').via_department_id).toBe(devops);
    // general work: no employee, no project
    const a3 = await sudhir.post('/activities').send({ category_id: cat('Tested Application'), description: 'Tested the website and mobile app; found missing functionality.', bugs_found: 3 });
    expect(a3.status).toBe(201);
    expect((await sudhir.post('/activities').send({ category_id: cat('Attended Client Meeting'), description: 'Client meeting on pending requirements', occurred_at: DateTime.now().plus({ days: 2 }).toISO() })).status).toBe(400);
    expect((await sudhir.post('/activities').send({ category_id: cat('Other Activity'), description: '' })).status).toBe(400);

    // a deactivated employee can no longer be selected
    await owner.post(`/org/users/${ids.Hardik}/deactivate`).send({ reason: 'Test deactivation' });
    const bad = await sudhir.post('/activities').send({ category_id: cat('Coordinated With Employee'), participant_ids: [ids.Hardik], description: 'Should fail' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Deactivated/);
    await owner.post(`/org/users/${ids.Hardik}/activate`).send({ reason: 'Back' });

    // timeline for today, in time order
    const list = (await sudhir.get(`/activities?date=${today()}&order=asc`)).body;
    expect(list.items.map((a: any) => a.id)).toEqual([a1.body.id, a2.body.id, a3.body.id]);
  });

  it('keeps every version of an edited activity and prevents stale overwrites', async () => {
    const [a] = (await sudhir.get(`/activities?date=${today()}&order=asc`)).body.items;
    const e1 = await sudhir.patch(`/activities/${a.id}`).send({ description: 'Coordinated with Neha on the payment APIs.', reason: 'More precise', expected_revision: 1 });
    expect(e1.status).toBe(200);
    expect(e1.body.revision).toBe(2);
    expect((await sudhir.patch(`/activities/${a.id}`).send({ description: 'stale', expected_revision: 1 })).status).toBe(409);
    const revs = (await sudhir.get(`/activities/${a.id}/revisions`)).body;
    expect(revs.map((r: any) => r.action)).toEqual(['updated', 'created']);
    expect(revs[1].snapshot.description).toMatch(/required APIs/);
    // only the author may edit; history rows are append-only at the database level
    expect((await owner.patch(`/activities/${a.id}`).send({ description: 'not mine' })).status).toBe(403);
    await expect(runInOrg(orgId, () => db('activity_revisions').where({ activity_id: a.id }).update({ reason: 'x' }))).rejects.toThrow(/append-only/);
  });

  it('builds the coordination history from both sides', async () => {
    const summary = (await sudhir.get('/activities/coordination/summary')).body;
    const saurabh = summary.find((r: any) => r.name === 'Saurabh');
    expect(saurabh).toMatchObject({ total: 1, guidance: 1, open_follow_ups: 1, unresolved: 1 });
    expect(summary.find((r: any) => r.name === 'Utkarsh')).toMatchObject({ total: 1, direct: 0 });
    const hist = (await sudhir.get(`/activities/coordination/employee/${ids.Saurabh}`)).body;
    expect(hist.stats).toMatchObject({ total: 1, open_follow_ups: 1 });
    // resolve + close the follow-up
    const act = hist.items[0];
    expect((await sudhir.post(`/activities/${act.id}/follow-up`).send({ done: true, issue_resolved: true })).body).toMatchObject({ issue_resolved: true });
    expect((await sudhir.get(`/activities/coordination/employee/${ids.Saurabh}`)).body.stats).toMatchObject({ open_follow_ups: 0, resolved: 1 });
    // an employee cannot read the HOD's activity log or other people's notes about them
    expect((await neha.get(`/activities?user_id=${ids.Sudhir}`)).status).toBe(404);
    expect((await neha.get(`/activities/coordination/employee/${ids.Neha}`)).body.items).toEqual([]);
  });

  it('personal tasks: one-off with reminder, and recurring occurrences with their own status', async () => {
    const t = (await sudhir.post('/my-work/tasks').send({ title: 'Review HRMS release notes', priority: 'high', due_date: today(), due_time: '23:30', reminder_offset_minutes: 30 })).body.task;
    expect(t.remind_at).not.toBeNull();
    const done = await sudhir.patch(`/my-work/tasks/${t.id}`).send({ status: 'completed', completion_note: 'Shared feedback with Neha' });
    expect(done.body).toMatchObject({ status: 'completed', completion_note: 'Shared feedback with Neha' });

    const series = (await sudhir.post('/my-work/tasks').send({ title: 'Collect team updates', recurrence: { frequency: 'daily', frequency_config: {} }, due_time: '10:00' })).body.series;
    expect(series.id).toBeGreaterThan(0);
    await runInOrg(orgId, async () => {
      await materializeSeries({ userIds: [ids.Sudhir] }); // idempotent
      const tomorrow = DateTime.now().setZone(TZ).plus({ days: 1 }).toISODate()!;
      await materializeSeries({ userIds: [ids.Sudhir], date: tomorrow });
      const occ = await db('personal_tasks').where({ series_id: series.id }).orderBy('due_date');
      expect(occ.map((o: any) => o.due_date)).toEqual([today(), tomorrow]);
    });
    const occToday = (await sudhir.get(`/my-work/tasks?series_id=${series.id}`)).body.items.find((x: any) => x.due_date === today());
    await sudhir.patch(`/my-work/tasks/${occToday.id}`).send({ status: 'completed' });
    const all = (await sudhir.get(`/my-work/tasks?series_id=${series.id}`)).body.items;
    expect(all.filter((x: any) => x.status === 'completed')).toHaveLength(1); // tomorrow's stays pending

    // reminders fire once
    const r = (await sudhir.post('/my-work/tasks').send({ title: 'Call client back', remind_at: new Date(Date.now() - 60_000).toISOString() })).body.task;
    await runInOrg(orgId, async () => {
      expect(await runPersonalTaskRemindersInOrg()).toBe(1);
      expect(await runPersonalTaskRemindersInOrg()).toBe(0);
    });
    await sudhir.del(`/my-work/tasks/${r.id}`);

    const todayView = (await sudhir.get('/my-work/today')).body;
    expect(todayView.timeline).toHaveLength(3);
    expect(todayView.tasks.completed_today.map((x: any) => x.title)).toEqual(expect.arrayContaining(['Review HRMS release notes', 'Collect team updates']));
  });

  it('personal EOD report: generated only from entries, editable, then finalized', async () => {
    const g = await sudhir.post('/my-work/eod/generate').send({ date: today(), next_day_priorities: 'Release HRMS build\nReview Neha\'s API work' });
    expect(g.status).toBe(200);
    const text: string = g.body.report.content;
    expect(text).toMatch(/Daily Work Report — Sudhir/);
    expect(text).toMatch(/Head of Department · Full Stack Developer · Project Coordinator/);
    expect(text).toMatch(/TECHNICAL GUIDANCE PROVIDED/);
    expect(text).toMatch(/EMPLOYEES ASSISTED\n• Neha\n• Saurabh/);
    expect(text).toMatch(/BUGS IDENTIFIED\n• .*3 bugs/);
    expect(text).toMatch(/Collect team updates/); // completed personal task
    expect(text).toMatch(/NEXT DAY'S PRIORITIES\n• Release HRMS build/);
    expect(text).not.toMatch(/CLIENT MEETINGS ATTENDED/); // nothing recorded → no section
    // review & edit
    const edited = `${text}\nExtra note typed by Sudhir.`;
    const saved = await sudhir.put('/my-work/eod').send({ date: today(), content: edited, expected_revision: g.body.report.revision });
    expect(saved.body.report.content).toContain('Extra note typed by Sudhir.');
    expect((await sudhir.put('/my-work/eod').send({ date: today(), content: 'stale', expected_revision: g.body.report.revision })).status).toBe(409);
    const fin = await sudhir.post('/my-work/eod/finalize').send({ date: today() });
    expect(fin.body.report.status).toBe('final');
    expect((await sudhir.put('/my-work/eod').send({ date: today(), content: 'after final' })).status).toBe(409);
    expect((await sudhir.post('/my-work/eod/generate').send({ date: today() })).status).toBe(409);
  });

  it("includes the HOD's activities and finalized personal report in the company EOD report, with company filters", async () => {
    const r = (await sudhir.get('/eod?live=true&view=employee')).body;
    const me = r.report.employees.find((e: any) => e.name === 'Sudhir');
    expect(me.activities).toHaveLength(3);
    expect(me.personal_report).toMatchObject({ status: 'final' });
    expect(me.personal_report.content).toContain('Extra note typed by Sudhir.');
    expect(r.text).toMatch(/Activities \(3\):/);
    const cons = (await sudhir.get('/eod?live=true&view=consolidated')).body;
    expect(cons.text).toMatch(/Daily activities & coordination/);
    expect(cons.report.summary.activities).toBe(3);
    expect(cons.report.companies.map((c: any) => c.name)).toEqual(['Averlon Enterprise Solutions', 'Rajlaxmi Solutions', 'No company']);
    const rajlaxmi = await runInOrg(orgId, async () => (await db('companies').where({ name: 'Rajlaxmi Solutions' }).first('id')).id);
    const filtered = (await sudhir.get(`/eod?live=true&view=employee&company_id=${rajlaxmi}`)).body;
    expect(filtered.report.employees.map((e: any) => e.name)).toEqual(['Renuka']);
    const xlsx = await sudhir.get('/eod?live=true&format=xlsx');
    expect(xlsx.status).toBe(200);
  });

  it('dashboard widgets and company / designation administration', async () => {
    const team = (await sudhir.get('/my-work/team')).body;
    expect(team.departments.map((d: any) => d.name)).toEqual(expect.arrayContaining(['Development', 'DevOps', 'Digital Marketing']));
    expect(Array.isArray(team.pending_checklists)).toBe(true);
    expect((await neha.get('/my-work/team')).status).toBe(403);

    const c = await owner.post('/org/companies').send({ name: 'Third Entity Pvt Ltd', code: 'third' });
    expect(c.status).toBe(201);
    expect(c.body.code).toBe('THIRD');
    expect((await owner.post('/org/companies').send({ name: 'third entity pvt ltd', code: 'X2' })).status).toBe(409);
    const desig = (await owner.get('/org/designations')).body;
    const pc = desig.find((g: any) => g.title === 'Project Coordinator').id;
    // editing one field never resets the others to their create-time defaults
    expect((await owner.patch(`/org/designations/${pc}`).send({ title: 'Project Coordinator' })).body.level).toBe(6);
    expect((await owner.patch(`/org/users/${ids.Neha}`).send({ company_id: c.body.id, additional_designation_ids: [pc] })).status).toBe(200);
    const n = (await owner.get(`/org/users/${ids.Neha}`)).body;
    expect(n).toMatchObject({ company_name: 'Third Entity Pvt Ltd', additional_designations: [{ title: 'Project Coordinator' }] });
    expect((await owner.get(`/org/users?company_id=${c.body.id}`)).body.items.map((u: any) => u.name)).toEqual(['Neha']);
    // admins can add their own quick categories
    const nc = await owner.post('/activities/categories').send({ name: 'Vendor Call', group_name: 'Client coordination', report_section: 'client_coordination' });
    expect(nc.status).toBe(201);
    expect((await sudhir.get('/activities/categories')).body.map((x: any) => x.name)).toContain('Vendor Call');
    expect((await neha.post('/activities/categories').send({ name: 'Nope' })).status).toBe(403);
  });

  it('existing organizations: employees can log activities (permission granted once)', async () => {
    const emp = await as('employee@orgpm.dev');
    const cats = (await emp.get('/activities/categories')).body;
    expect(cats.length).toBeGreaterThanOrEqual(20);
    const r = await emp.post('/activities').send({ category_id: cats.find((x: any) => x.key === 'development').id, description: 'Built the export screen' });
    expect(r.status).toBe(201);
  });
});
