import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/knex';
import { app, as } from './helpers';
import { ALL_PERMISSIONS } from '../src/auth/permissions';

afterAll(async () => { await db.destroy(); });

const PW = 'Str0ngPass!';

async function registerOrg(org: string, email: string) {
  const r = await request(app).post('/api/auth/register').send({ organization_name: org, name: `${org} Owner`, email, password: PW, timezone: 'Europe/Berlin' });
  return r;
}

function client(token: string) {
  const w = (m: 'get' | 'post' | 'patch' | 'put' | 'delete') => (url: string) => request(app)[m](`/api${url}`).set('Authorization', `Bearer ${token}`);
  return { get: w('get'), post: w('post'), patch: w('patch'), put: w('put'), del: w('delete') };
}

describe('multi-tenant registration & isolation', () => {
  let a: ReturnType<typeof client>;
  let b: ReturnType<typeof client>;
  let orgA: number;
  let orgB: number;

  it('registers a new organization and signs the owner in as Super Admin', async () => {
    const r = await registerOrg('Globex Ltd', 'owner@globex.test');
    expect(r.status).toBe(201);
    expect(r.body.accessToken).toBeTruthy();
    expect(r.headers['set-cookie'][0]).toMatch(/orgpm_rt=/);
    expect(r.body.user).toMatchObject({ role: 'super_admin', organization_name: 'Globex Ltd', organization_slug: 'globex-ltd', timezone: 'Europe/Berlin' });
    expect(r.body.user.permissions.length).toBe(ALL_PERMISSIONS.length);
    orgA = r.body.user.organization_id;
    a = client(r.body.accessToken);
    // tenant defaults were created for the new org
    const rules = await db('notification_rules').where({ organization_id: orgA }).count({ c: '*' }).first();
    expect(Number(rules!.c)).toBeGreaterThan(10);
    expect(Number((await db('escalation_rules').where({ organization_id: orgA }).count({ c: '*' }).first())!.c)).toBe(7);
    const login = await request(app).post('/api/auth/login').send({ email: 'owner@globex.test', password: PW });
    expect(login.status).toBe(200);
  });

  it('validates registration and rejects duplicate emails', async () => {
    expect((await registerOrg('Dup', 'admin@orgpm.dev')).status).toBe(409);
    expect((await request(app).post('/api/auth/register').send({ organization_name: 'X', name: 'Y', email: 'bad', password: 'short' })).status).toBe(400);
    const r = await registerOrg('Globex Ltd', 'second@globex.test'); // same name → unique slug
    expect(r.status).toBe(201);
    expect(r.body.user.organization_slug).toBe('globex-ltd-2');
    orgB = r.body.user.organization_id;
    b = client(r.body.accessToken);
    expect(orgB).not.toBe(orgA);
  });

  it('a new organization starts empty and cannot see the demo tenant', async () => {
    expect((await a.get('/org/users')).body.items.map((u: any) => u.email)).toEqual(['owner@globex.test']);
    expect((await a.get('/tasks?pageSize=200')).body.total).toBe(0);
    expect((await a.get('/projects?pageSize=200')).body.total).toBe(0);
    expect((await a.get('/org/departments')).body).toHaveLength(0);
    expect((await a.get('/org/directory')).body).toHaveLength(1);
    expect((await a.get('/audit')).body.items.every((x: any) => x.action.startsWith('organization.') || x.actor_id !== null)).toBe(true);
    const demoTask = await db('tasks').where({ organization_id: 1 }).first('id');
    const demoProject = await db('projects').where({ organization_id: 1 }).first('id');
    const demoUser = await db('users').where({ organization_id: 1 }).first('id');
    expect((await a.get(`/tasks/${demoTask.id}`)).status).toBe(404);
    expect((await a.get(`/projects/${demoProject.id}`)).status).toBe(404);
    expect((await a.get(`/org/users/${demoUser.id}`)).status).toBe(404);
    expect((await a.patch(`/tasks/${demoTask.id}`).send({ title: 'hijack' })).status).toBe(404);
    expect((await a.get('/search?q=ERP')).body.projects).toHaveLength(0);
  });

  it('data created in one organization is invisible to another', async () => {
    const d = await a.post('/org/departments').send({ name: 'Engineering', code: 'ENG' });
    expect(d.status).toBe(201);
    // the same department code can exist in another tenant
    expect((await b.post('/org/departments').send({ name: 'Engineering', code: 'ENG' })).status).toBe(201);
    const owner = (await a.get('/auth/me')).body.id;
    const t = await a.post('/tasks').send({ title: 'Globex secret task', assignee_ids: [owner], deadline: new Date(Date.now() + 86400_000).toISOString() });
    expect(t.status).toBe(201);
    expect((await db('tasks').where({ id: t.body.id }).first()).organization_id).toBe(orgA);
    expect((await b.get(`/tasks/${t.body.id}`)).status).toBe(404);
    expect((await b.get('/tasks?pageSize=200')).body.items.some((x: any) => x.id === t.body.id)).toBe(false);
    // cannot assign work to, or remind, people in another tenant
    const demoUser = await db('users').where({ organization_id: 1 }).first('id');
    expect((await b.post('/tasks').send({ title: 'Cross tenant', assignee_ids: [demoUser.id] })).status).toBe(400);
    // notifications land only in the owning tenant
    const logs = await db('notification_logs').where({ organization_id: orgB });
    expect(logs.every((l) => l.organization_id === orgB)).toBe(true);
  });

  it('role permission changes are per organization', async () => {
    const roles = (await a.get('/org/roles')).body;
    const viewer = roles.find((r: any) => r.key === 'management_viewer');
    await a.put(`/org/roles/${viewer.id}/permissions`).send({ permissions: ['org.view'] });
    const inB = (await b.get('/org/roles')).body.find((r: any) => r.key === 'management_viewer');
    expect(inB.permissions.length).toBeGreaterThan(1);
    const demo = await as('admin@orgpm.dev');
    const inDemo = (await demo.get('/org/roles')).body.find((r: any) => r.key === 'management_viewer');
    expect(inDemo.permissions.length).toBeGreaterThan(1);
  });

  it('settings are per organization', async () => {
    await a.put('/settings').send({ organization_name: 'Globex Holdings', overload_threshold_percent: 150 });
    expect((await a.get('/settings')).body.overload_threshold_percent).toBe(150);
    expect((await b.get('/settings')).body.overload_threshold_percent).toBe(110);
    expect((await a.get('/auth/me')).body.organization_name).toBe('Globex Holdings');
  });

  it('dashboards count only the own tenant', async () => {
    const dash = (await a.get('/dashboard')).body;
    expect(dash.org.counts.employees).toBe(1);
    expect(dash.org.counts.departments).toBe(1);
  });
});
