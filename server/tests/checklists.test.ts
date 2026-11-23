import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, runInOrg } from '../src/db/knex';
import { getQueues } from '../src/notifications/queues';
import { redis } from '../src/lib/redis';
import { generateChecklistsInOrg, localDateIn, runChecklistEscalationsInOrg, runChecklistRemindersInOrg } from '../src/questionnaire/engine';
import { autoGenerateEodInOrg } from '../src/questionnaire/eod';
import { app, as, PASSWORD, userId } from './helpers';

afterAll(async () => {
  const q = getQueues();
  for (const k of ['schedules', 'deliveries', 'maintenance'] as const) await q[k].obliterate({ force: true });
  await Promise.all([q.schedules.close(), q.deliveries.close(), q.maintenance.close()]);
  await redis().quit();
  await db.destroy();
});

const TZ = 'Asia/Kolkata';
const today = () => localDateIn(TZ);
type Client = Awaited<ReturnType<typeof as>>;

/**
 * Uses a dedicated department and employees so assertions don't depend on the weekday
 * (the demo's template questions are "working days only").
 */
describe('department & employee management', () => {
  let admin: Client;
  let deptId: number;
  let otherDeptId: number;
  let qaUser: number;
  let qa2User: number;

  beforeAll(async () => {
    admin = await as('admin@orgpm.dev');
    const roles = (await admin.get('/org/roles')).body;
    const emp = roles.find((r: any) => r.key === 'employee').id;
    deptId = (await admin.post('/org/departments').send({ name: 'Quality Lab', code: 'QLAB' })).body.id;
    otherDeptId = (await admin.post('/org/departments').send({ name: 'Support Desk', code: 'SDESK' })).body.id;
    const mk = async (code: string, name: string, email: string) => (await admin.post('/org/users').send({ employee_code: code, name, email, role_id: emp, department_id: deptId, timezone: TZ, password: PASSWORD })).body.id;
    qaUser = await mk('Q001', 'Quinn Tester', 'quinn@orgpm.dev');
    qa2User = await mk('Q002', 'Riya Checker', 'riya@orgpm.dev');
  });

  it('records history when employees are assigned and transferred between departments', async () => {
    const r = await admin.post(`/org/users/${qa2User}/transfer`).send({ department_id: otherDeptId, reason: 'Moved to support rotation' });
    expect(r.status).toBe(200);
    const detail = (await admin.get(`/org/users/${qa2User}`)).body;
    expect(detail.department_name).toBe('Support Desk');
    expect(detail.department_history[0]).toMatchObject({ department_name: 'Support Desk', reason: 'Moved to support rotation', effective_to: null });
    expect(detail.department_history[1].department_name).toBe('Quality Lab');
    expect(detail.department_history[1].effective_to).not.toBeNull();
    // bulk assignment back into the original department
    expect((await admin.post(`/org/departments/${deptId}/members`).send({ user_ids: [qa2User], reason: 'Rotation ended' })).body.moved).toBe(1);
    const dept = (await admin.get(`/org/departments/${deptId}`)).body;
    expect(dept.members.map((m: any) => m.id).sort()).toEqual([qaUser, qa2User].sort());
    expect(dept.history.some((h: any) => h.user_id === qa2User && h.effective_to)).toBe(true);
  });

  it('deactivation keeps history, blocks new assignments and notifications; reactivation restores', async () => {
    const tmp = (await admin.post('/org/users').send({ employee_code: 'Q099', name: 'Temp Worker', email: 'temp@orgpm.dev', role_id: (await admin.get('/org/roles')).body.find((r: any) => r.key === 'employee').id, department_id: deptId, timezone: TZ, password: PASSWORD })).body.id;
    expect((await admin.post(`/org/users/${tmp}/deactivate`).send({})).status).toBe(400); // reason required
    expect((await admin.post(`/org/users/${tmp}/deactivate`).send({ reason: 'Contract ended' })).status).toBe(200);
    const d = (await admin.get(`/org/users/${tmp}`)).body;
    expect(d.is_active).toBe(false);
    expect(d.status_history[0]).toMatchObject({ is_active: false, reason: 'Contract ended' });
    expect((await admin.get('/org/users?active=false&pageSize=200')).body.items.some((u: any) => u.id === tmp)).toBe(true);
    // no new questions, team or project assignments
    const q = await admin.post('/questions').send({ text: 'Should fail', answer_type: 'text', assignment: { mode: 'users', user_ids: [tmp] } });
    expect(q.status).toBe(400);
    expect(q.body.error).toMatch(/Deactivated/);
    expect((await admin.post(`/org/departments/${deptId}/members`).send({ user_ids: [tmp] })).status).toBe(400);
    // notifications are never created for deactivated employees
    const { notify } = await import('../src/notifications/service');
    expect(await runInOrg(1, () => notify({ userIds: [tmp], channels: ['in_app'], title: 'x', body: 'y', dedupePrefix: `t:${Date.now()}` }))).toEqual([]);
    // tasks they worked on are untouched (soft state only)
    expect((await admin.post(`/org/users/${tmp}/activate`).send({ reason: 'Rehired' })).status).toBe(200);
    expect((await admin.get(`/org/users/${tmp}`)).body.status_history.map((h: any) => h.is_active).slice(0, 2)).toEqual([true, false]);
  });

  describe('question builder, checklists and EOD', () => {
    let qA: number; // yes/no controlling question
    let qB: number; // conditional follow-up
    let qC: number; // number metric
    let qD: number; // optional url list
    let emp: Client;
    let checklistId: number;

    it('validates questions and creates assigned, conditional questions', async () => {
      expect((await admin.post('/questions').send({ text: 'Pick', answer_type: 'single_choice', options: { choices: ['one'] } })).status).toBe(400);
      expect((await admin.post('/questions').send({ text: 'Weekly', answer_type: 'text', frequency: 'weekly', frequency_config: {} })).status).toBe(400);
      const section = (await admin.post('/questions/sections').send({ name: 'QA daily' })).body;
      const base = { section_id: section.id, frequency: 'daily', frequency_config: {}, deadline_time: '23:59', assignment: { mode: 'departments', department_ids: [deptId] } };
      qA = (await admin.post('/questions').send({ ...base, text: 'Did you find blockers today?', answer_type: 'yes_no', report_tag: 'other' })).body.id;
      qB = (await admin.post('/questions').send({ ...base, text: 'Describe the blockers', answer_type: 'long_text', report_tag: 'blocker', condition_question_id: qA, condition_operator: 'equals', condition_value: true })).body.id;
      qC = (await admin.post('/questions').send({ ...base, text: 'Test cases executed', answer_type: 'number', report_tag: 'metric', options: { min: 0, unit: 'cases' }, priority: 'high' })).body.id;
      qD = (await admin.post('/questions').send({ ...base, text: 'Bug report links', answer_type: 'url_list', report_tag: 'url', is_required: false })).body.id;
      expect([qA, qB, qC, qD].every(Boolean)).toBe(true);
      // a cycle is rejected
      expect((await admin.patch(`/questions/${qA}`).send({ condition_question_id: qB, condition_operator: 'answered' })).status).toBe(400);
      const list = (await admin.get(`/questions?department_id=${deptId}`)).body;
      expect(list.find((q: any) => q.id === qB)).toMatchObject({ assignment_label: 'Quality Lab', frequency_label: 'Daily' });
      // audit trail records who created it
      const detail = (await admin.get(`/questions/${qA}`)).body;
      expect(detail.history[0]).toMatchObject({ action: 'question.created', actor_name: 'Aarav Mehta' });
      // employees cannot use the builder
      expect((await (await as('employee@orgpm.dev')).get('/questions')).status).toBe(403);
    });

    it('generates each checklist once (idempotent) and only for active employees', async () => {
      await runInOrg(1, () => generateChecklistsInOrg());
      await runInOrg(1, () => generateChecklistsInOrg());
      const rows = await db('checklists').where({ user_id: qaUser, checklist_date: today() });
      expect(rows).toHaveLength(1);
      checklistId = rows[0].id;
      const items = await db('checklist_items').where({ checklist_id: checklistId });
      expect(items.map((i: any) => i.question_id).sort()).toEqual([qA, qB, qC, qD].sort());
      const tmp = await userId('temp@orgpm.dev');
      await admin.post(`/org/users/${tmp}/deactivate`).send({ reason: 'Leaving again' });
      const before = await db('checklists').where({ user_id: tmp }).count({ c: '*' }).first();
      await runInOrg(1, () => generateChecklistsInOrg());
      expect(await db('checklists').where({ user_id: tmp }).count({ c: '*' }).first()).toEqual(before);
      expect(Number(before!.c)).toBe(0); // untouched open checklist was dropped on deactivation
    });

    it('lets the employee save drafts, validates answers and evaluates conditions', async () => {
      emp = await as('quinn@orgpm.dev');
      const mine = (await emp.get('/checklists/mine')).body;
      expect(mine.checklist.id).toBe(checklistId);
      const item = (q: number) => mine.checklist.items.find((i: any) => i.question_id === q);
      // follow-up hidden until the controlling answer is "yes"
      expect(item(qB).applicable).toBe(false);
      const bad = await emp.put(`/checklists/${checklistId}/draft`).send({ items: [{ item_id: item(qC).id, value: -5 }] });
      expect(bad.status).toBe(400);
      expect(bad.body.details.items[item(qC).id]).toMatch(/at least 0/);
      const saved = (await emp.put(`/checklists/${checklistId}/draft`).send({ items: [{ item_id: item(qA).id, value: true }] })).body;
      expect(saved.items.find((i: any) => i.question_id === qB).applicable).toBe(true);
      expect(saved.status).toBe('in_progress');
      expect(saved.answered_items).toBe(0); // drafts are not answers
    });

    it('submits answered questions and reports mandatory ones still missing', async () => {
      const mine = (await emp.get('/checklists/mine')).body.checklist;
      const item = (q: number) => mine.items.find((i: any) => i.question_id === q);
      const r = await emp.post(`/checklists/${checklistId}/submit`).send({ items: [{ item_id: item(qC).id, value: 37 }] });
      expect(r.status).toBe(200);
      expect(r.body.submitted).toBe(2); // qA (draft) + qC
      expect(r.body.unanswered_required.map((u: any) => u.question_text)).toEqual(['Describe the blockers']);
      expect(r.body.checklist.status).toBe('in_progress');
      // submitted answers are protected from accidental overwrite
      const again = await emp.put(`/checklists/${checklistId}/draft`).send({ items: [{ item_id: item(qC).id, value: 1 }] });
      expect(again.status).toBe(409);
      const done = await emp.post(`/checklists/${checklistId}/submit`).send({ items: [{ item_id: item(qB).id, value: 'Staging DB was down for 2 hours' }, { item_id: item(qD).id, value: [{ url: 'https://bugs.example.com/QA-1', published_at: `${today()}T11:00` }] }] });
      expect(done.body.checklist.status).toBe('submitted');
      expect(done.body.checklist.completion_percent).toBe(100);
      expect(done.body.unanswered_required).toEqual([]);
    });

    it('keeps every revision and rejects stale edits', async () => {
      const it0 = await db('checklist_items').where({ checklist_id: checklistId, question_id: qC }).first();
      expect(it0.revision).toBe(1);
      expect((await emp.post(`/checklists/items/${it0.id}/revise`).send({ value: 40, reason: 'Recounted', expected_revision: 5 })).status).toBe(409);
      expect((await emp.post(`/checklists/items/${it0.id}/revise`).send({ value: 40, expected_revision: 1 })).status).toBe(400); // reason required
      expect((await emp.post(`/checklists/items/${it0.id}/revise`).send({ value: 40, reason: 'Recounted', expected_revision: 1 })).status).toBe(200);
      const revs = (await emp.get(`/checklists/items/${it0.id}/revisions`)).body.revisions;
      expect(revs.map((r: any) => [r.revision, r.answer_text])).toEqual([[2, '40 cases'], [1, '37 cases']]);
      expect(revs[0].reason).toBe('Recounted');
      await expect(db('checklist_answer_revisions').where({ item_id: it0.id }).update({ answer_text: 'tampered' })).rejects.toThrow(/append-only/);
      // other employees can't read it; the admin can
      expect((await (await as('employee@orgpm.dev')).get(`/checklists/items/${it0.id}/revisions`)).status).toBe(404);
      expect((await admin.get(`/checklists/items/${it0.id}/revisions`)).status).toBe(200);
    });

    it('scopes monitoring: HOD of another department sees nothing, admin sees all', async () => {
      const hod = await as('hod.it@orgpm.dev');
      expect((await hod.get(`/checklists/users/${qaUser}`)).status).toBe(404);
      const team = (await hod.get('/checklists/team')).body.rows;
      expect(team.some((r: any) => r.user_id === qaUser)).toBe(false);
      expect((await (await as('employee@orgpm.dev')).get('/checklists/dashboard')).status).toBe(403);
      const dash = (await admin.get(`/checklists/dashboard?department_id=${deptId}&from=${today()}&to=${today()}`)).body;
      expect(dash.totals).toMatchObject({ total: 2, completed: 1, pending: 1 });
      expect(dash.totals.compliance).toBe(50);
      expect(dash.by_employee.find((e: any) => e.user_id === qaUser)).toMatchObject({ completed: 1, compliance: 100 });
      expect(dash.people.active_employees).toBeGreaterThanOrEqual(2);
      const hist = (await admin.get(`/checklists/history/${qaUser}`)).body;
      expect(hist.summary).toMatchObject({ checklists: 1, completed: 1 });
      expect(hist.department_history.length).toBeGreaterThanOrEqual(1);
    });

    it('sends consolidated reminders once and escalates incomplete checklists once', async () => {
      const cl2 = await db('checklists').where({ user_id: qa2User, checklist_date: today() }).first();
      expect(cl2.status).not.toBe('submitted');
      // pretend the deadline is 45 minutes away: the 60-min reminder became due 15 minutes ago
      await db('checklist_items').where({ checklist_id: cl2.id }).update({ due_at: new Date(Date.now() + 45 * 60_000), reminder_offsets: [60] });
      await runInOrg(1, () => runChecklistRemindersInOrg());
      await runInOrg(1, () => runChecklistRemindersInOrg());
      const rem = await db('notification_logs').where({ user_id: qa2User, channel: 'in_app' }).where('dedupe_key', 'like', `ckrem:${cl2.id}:%`);
      expect(rem).toHaveLength(1);
      expect(rem[0].title).toMatch(/checklist questions? due in 1 h/);
      // now the deadline passed 4 hours ago → employee (L1) and, with an HOD set, HOD (L3) are told — once each
      const hod = await userId('hod.ops@orgpm.dev');
      await db('departments').where({ id: deptId }).update({ hod_id: hod });
      await db('checklists').where({ id: cl2.id }).update({ due_at: new Date(Date.now() - 4 * 3600_000) });
      await runInOrg(1, () => runChecklistEscalationsInOrg());
      await runInOrg(1, () => runChecklistEscalationsInOrg());
      const esc = await db('checklist_escalations').where({ checklist_id: cl2.id });
      expect(esc.length).toBe(3); // employee, team leader (none → recorded with no recipients), HOD
      const own = await db('notification_logs').where({ user_id: qa2User, channel: 'in_app' }).where('dedupe_key', 'like', 'ckesc:%');
      expect(own).toHaveLength(1);
      const toHod = await db('notification_logs').where({ user_id: hod, channel: 'in_app' }).where('dedupe_key', 'like', 'ckesc:%').whereLike('body', '%Riya Checker%');
      expect(toHod).toHaveLength(1);
    });

    it('builds EOD reports from real answers and flags who did not submit', async () => {
      expect((await (await as('employee@orgpm.dev')).post('/eod/generate').send({})).status).toBe(403);
      const gen = await admin.post('/eod/generate').send({ date: today() });
      expect(gen.status).toBe(201);
      const r = (await admin.get(`/eod?date=${today()}&department_id=${deptId}`)).body;
      expect(r.live).toBe(false);
      expect(r.report_id).toBe(gen.body.id);
      const live = (await admin.get(`/eod?date=${today()}&live=true`)).body;
      expect(live).toMatchObject({ live: true, report_id: null });
      expect(live.versions.map((v: any) => v.id)).toContain(gen.body.id);
      const dept = r.report.departments.find((d: any) => d.id === deptId);
      expect(dept).toMatchObject({ expected: 2, submitted: 1, compliance: 50 });
      expect(dept.metrics).toEqual([{ question: 'Test cases executed', unit: 'cases', total: 40, reported: 1, asked: 2 }]);
      expect(dept.blockers.some((b: any) => b.employee === 'Quinn Tester' && b.text.includes('Staging DB'))).toBe(true);
      expect(dept.urls[0]).toMatchObject({ employee: 'Quinn Tester', url: 'https://bugs.example.com/QA-1' });
      expect(r.report.not_submitted.map((n: any) => n.name)).toEqual(['Riya Checker']);
      const riya = r.report.employees.find((e: any) => e.name === 'Riya Checker');
      expect(riya.answers).toEqual([]); // nothing invented
      expect(riya.unanswered.length).toBeGreaterThan(0);
      expect(r.text).toContain('Riya Checker (Quality Lab) — nothing submitted');
      const emp = (await admin.get(`/eod?date=${today()}&user_id=${qaUser}&view=employee`)).body;
      expect(emp.text).toContain('Test cases executed: 40 cases (revised ×1)');
      const xlsx = await admin.get(`/eod?date=${today()}&format=xlsx`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
      expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');
      const pdf = await admin.get(`/eod?date=${today()}&view=employee&format=pdf`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      // HOD of IT sees only their own people in the same report
      const hodView = (await (await as('hod.it@orgpm.dev')).get(`/eod?date=${today()}`)).body;
      expect(hodView.report.employees.some((e: any) => e.name === 'Quinn Tester')).toBe(false);
      expect(hodView.report.employees.length).toBeGreaterThan(0);
      // history lists both the stored report and its date
      expect((await admin.get('/eod/history')).body.reports.some((x: any) => x.id === gen.body.id)).toBe(true);
    });

    it('auto-generates the EOD report once per day after the configured time', async () => {
      await admin.put('/eod/settings').send({ eod_auto_enabled: true, eod_generation_time: '11:00' });
      await admin.put('/settings').send({ working_days: [1, 2, 3, 4, 5, 6, 7] });
      const noon = new Date(`${today()}T06:30:00Z`); // 12:00 in Asia/Kolkata
      const first = await runInOrg(1, () => autoGenerateEodInOrg(noon));
      const second = await runInOrg(1, () => autoGenerateEodInOrg(noon));
      expect([first, second]).toEqual([1, 0]);
      expect(await db('eod_reports').where({ report_date: today(), trigger: 'auto' }).count({ c: '*' }).first()).toEqual({ c: 1 });
      await admin.put('/settings').send({ working_days: [1, 2, 3, 4, 5] });
    });

    it('applies an editable template to a department', async () => {
      const tpls = (await admin.get('/questions/templates')).body;
      expect(tpls.map((t: any) => t.key).sort()).toEqual(['data_scrapper', 'development', 'digital_marketing', 'implementation']);
      const dm = tpls.find((t: any) => t.key === 'digital_marketing');
      expect(dm.items.find((i: any) => i.answer_type === 'url_list').text).toBe('All published URLs with publication timings');
      const added = await admin.post(`/questions/templates/${dm.id}/items`).send({ text: 'Ad spend today', answer_type: 'number', report_tag: 'metric', options: { unit: 'INR' } });
      expect(added.status).toBe(201);
      const applied = await admin.post(`/questions/templates/${dm.id}/apply`).send({ mode: 'departments', department_ids: [otherDeptId], section_name: 'Support marketing', frequency: 'weekly', frequency_config: { weekdays: [1, 2, 3, 4, 5, 6, 7] } });
      expect(applied.status).toBe(201);
      expect(applied.body.questionIds).toHaveLength(dm.items.length + 1);
      const preview = (await admin.get(`/questions/preview?user_id=${qa2User}&date=${today()}`)).body;
      expect(preview.questions.every((q: any) => q.section_name !== 'Support marketing')).toBe(true); // qa2 is in Quality Lab
    });
  });
});

describe('questionnaire tenancy', () => {
  it('a new organization gets its own templates and sees none of the demo questions', async () => {
    const r = await request(app).post('/api/auth/register').send({ organization_name: 'Initech', name: 'Owner', email: 'owner@initech.test', password: 'Str0ngPass!', timezone: 'UTC' });
    expect(r.status).toBe(201);
    const t = r.body.accessToken;
    const get = (u: string) => request(app).get(`/api${u}`).set('Authorization', `Bearer ${t}`);
    expect((await get('/questions')).body).toEqual([]);
    expect((await get('/questions/templates')).body).toHaveLength(4);
    expect((await get('/questions/escalation-rules')).body).toHaveLength(3);
    expect((await get(`/eod?date=${today()}`)).body.report.employees.map((e: any) => e.name)).toEqual(['Owner']);
  });
});
