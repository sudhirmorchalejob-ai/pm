import request from 'supertest';
import { createApp } from '../src/app';
import { db } from '../src/db/knex';

export const app = createApp();
export const PASSWORD = 'Password@123';

const tokens = new Map<string, string>();

/** Log in (cached per email) and return an authenticated supertest agent factory. */
export async function as(email: string) {
  if (!tokens.has(email)) {
    const r = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
    tokens.set(email, r.body.accessToken);
  }
  const t = tokens.get(email)!;
  const wrap = (m: 'get' | 'post' | 'patch' | 'put' | 'delete') => (url: string) => request(app)[m](`/api${url}`).set('Authorization', `Bearer ${t}`);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), put: wrap('put'), del: wrap('delete') };
}

export const userId = async (email: string) => (await db('users').where({ email }).first('id')).id as number;
export const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
