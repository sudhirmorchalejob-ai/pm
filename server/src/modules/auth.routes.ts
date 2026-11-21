import bcrypt from 'bcryptjs';
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../db/knex';
import { authenticate, invalidateUserCache, me } from '../auth/middleware';
import { issueRefreshToken, revokeAllForUser, revokeRefreshToken, rotateRefreshToken, signAccessToken } from '../auth/tokens';
import { audit } from '../lib/audit';
import { badRequest, unauthorized } from '../lib/errors';
import { parse } from '../lib/http';

export const router = Router();
const COOKIE = 'orgpm_rt';

const cookieOpts = () => ({
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/api/auth',
  maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86400_000,
});

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: config.NODE_ENV === 'test' ? 1000 : 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' } });

export const passwordSchema = z.string().min(8, 'At least 8 characters').max(128)
  .regex(/[A-Za-z]/, 'Must contain a letter').regex(/\d/, 'Must contain a number');

async function profile(userId: number) {
  const u = await db('users as u').join('roles as r', 'r.id', 'u.role_id')
    .leftJoin('departments as d', 'd.id', 'u.department_id').leftJoin('teams as t', 't.id', 'u.team_id')
    .leftJoin('designations as g', 'g.id', 'u.designation_id')
    .where('u.id', userId)
    .first('u.id', 'u.name', 'u.email', 'u.employee_code', 'u.phone', 'u.timezone', 'u.avatar_url', 'u.must_change_password',
      'u.department_id', 'd.name as department_name', 'u.team_id', 't.name as team_name', 'g.title as designation',
      'r.key as role', 'r.name as role_name', 'r.scope_level as scope', 'r.id as role_id');
  const permissions = await db('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id')
    .where('rp.role_id', u.role_id).pluck('p.key');
  return { ...u, permissions };
}

async function sendSession(req: Request, res: Response, userId: number, refreshToken: string) {
  res.cookie(COOKIE, refreshToken, cookieOpts());
  res.json({ accessToken: signAccessToken(userId), user: await profile(userId) });
}

/**
 * @openapi POST /api/auth/login — email + password → access token (body) + refresh token (httpOnly cookie)
 */
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
  const user = await db('users').where({ email }).whereNull('deleted_at').first();
  const fail = async () => {
    if (user) {
      const failed = user.failed_logins + 1;
      await db('users').where({ id: user.id }).update({
        failed_logins: failed, locked_until: failed >= 5 ? new Date(Date.now() + 15 * 60_000) : user.locked_until,
      });
    }
    throw unauthorized('Invalid email or password');
  };
  if (!user || !user.is_active || user.employment_status === 'exited') {
    await bcrypt.compare(password, '$2a$10$CwTycUXWue0Thq9StjUM0uJ8.2pW4O5sVZ3fF2ZnN0cXKX2v8T1yW'); // equalize timing
    return fail();
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) throw unauthorized('Account temporarily locked after repeated failures. Try again in 15 minutes.');
  if (!(await bcrypt.compare(password, user.password_hash))) return fail();
  await db('users').where({ id: user.id }).update({ failed_logins: 0, locked_until: null, last_login_at: db.fn.now() });
  const { token } = await issueRefreshToken(user.id, { ua: req.headers['user-agent'], ip: req.ip });
  (req as any).user = { id: user.id };
  await audit(req, { action: 'auth.login', entityType: 'user', entityId: user.id });
  await sendSession(req, res, user.id, token);
});

router.post('/refresh', async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (!token) throw unauthorized('No refresh token');
  try {
    const { userId, refreshToken } = await rotateRefreshToken(token, { ua: req.headers['user-agent'], ip: req.ip });
    await sendSession(req, res, userId, refreshToken);
  } catch (e) {
    res.clearCookie(COOKIE, { path: '/api/auth' });
    throw e;
  }
});

router.post('/logout', async (req, res) => {
  const token = req.cookies?.[COOKIE];
  if (token) await revokeRefreshToken(token);
  res.clearCookie(COOKIE, { path: '/api/auth' });
  res.json({ ok: true });
});

router.get('/me', authenticate, async (req, res) => {
  res.json(await profile(me(req).id));
});

router.patch('/me', authenticate, async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    timezone: z.string().max(64).optional(),
  }), req.body);
  if (body.timezone && !Intl.supportedValuesOf('timeZone').includes(body.timezone) && body.timezone !== 'UTC') throw badRequest('Unknown timezone');
  await db('users').where({ id: me(req).id }).update({ ...body, updated_at: db.fn.now() });
  invalidateUserCache(me(req).id);
  res.json(await profile(me(req).id));
});

router.post('/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = parse(z.object({ currentPassword: z.string(), newPassword: passwordSchema }), req.body);
  const u = await db('users').where({ id: me(req).id }).first('password_hash');
  if (!(await bcrypt.compare(currentPassword, u.password_hash))) throw badRequest('Current password is incorrect');
  await db('users').where({ id: me(req).id }).update({ password_hash: await bcrypt.hash(newPassword, 12), must_change_password: false, updated_at: db.fn.now() });
  await revokeAllForUser(me(req).id);
  await audit(req, { action: 'auth.password_changed', entityType: 'user', entityId: me(req).id });
  const { token } = await issueRefreshToken(me(req).id, { ua: req.headers['user-agent'], ip: req.ip });
  await sendSession(req, res, me(req).id, token);
});

router.get('/sessions', authenticate, async (req, res) => {
  res.json(await db('refresh_tokens').where({ user_id: me(req).id }).whereNull('revoked_at').where('expires_at', '>', new Date())
    .orderBy('created_at', 'desc').select('id', 'user_agent', 'ip', 'created_at', 'expires_at'));
});

router.post('/sessions/revoke-all', authenticate, async (req, res) => {
  await revokeAllForUser(me(req).id);
  res.clearCookie(COOKIE, { path: '/api/auth' });
  res.json({ ok: true });
});
