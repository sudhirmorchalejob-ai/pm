import bcrypt from 'bcryptjs';
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config';
import { baseDb, db, runInOrg } from '../db/knex';
import { seedOrganization } from '../db/seed';
import { isValidTimezone } from '../lib/recurrence';
import { setSetting } from '../lib/settings';
import { authenticate, invalidateUserCache, me } from '../auth/middleware';
import { issueRefreshToken, revokeAllForUser, revokeRefreshToken, rotateRefreshToken, signAccessToken } from '../auth/tokens';
import { audit } from '../lib/audit';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors';
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
  // May run outside a tenant context (sign-in), so tenant joins are filtered explicitly.
  const u = await db('users as u').join('roles as r', 'r.id', 'u.role_id').join('organizations as o', 'o.id', 'u.organization_id')
    .leftJoin('departments as d', 'd.id', 'u.department_id').leftJoin('teams as t', 't.id', 'u.team_id')
    .leftJoin('designations as g', 'g.id', 'u.designation_id')
    .where('u.id', userId)
    .first('u.id', 'u.name', 'u.email', 'u.employee_code', 'u.phone', 'u.timezone', 'u.avatar_url', 'u.must_change_password',
      'u.department_id', 'd.name as department_name', 'u.team_id', 't.name as team_name', 'g.title as designation',
      'r.key as role', 'r.name as role_name', 'r.scope_level as scope', 'r.id as role_id',
      'u.organization_id', 'o.name as organization_name', 'o.slug as organization_slug');
  const permissions = await db('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id')
    .where('rp.role_id', u.role_id).andWhere('rp.organization_id', u.organization_id).pluck('p.key');
  return { ...u, permissions };
}

const registerLimiter = rateLimit({ windowMs: 60 * 60_000, limit: config.NODE_ENV === 'test' ? 1000 : 5, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many registrations from this address, try again later' } });

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';

/**
 * Self-service registration of a new organization (tenant). Creates the organization,
 * its default role permissions, notification & escalation rules and settings, and the
 * registering person as its first Super Admin, then signs them in.
 */
router.post('/register', registerLimiter, async (req, res) => {
  if (!config.ALLOW_REGISTRATION) throw forbidden('Self-service registration is disabled');
  const b = parse(z.object({
    organization_name: z.string().trim().min(2).max(120),
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email().max(200),
    password: passwordSchema,
    timezone: z.string().max(64).default('Asia/Kolkata'),
  }), req.body);
  if (!isValidTimezone(b.timezone)) throw badRequest('Unknown timezone');
  if (await baseDb('users').where({ email: b.email }).first('id')) throw conflict('An account with this email already exists');
  const base = slugify(b.organization_name);
  let slug = base;
  for (let i = 2; await baseDb('organizations').where({ slug }).first('id'); i++) slug = `${base}-${i}`;
  const passwordHash = await bcrypt.hash(b.password, 12);
  const [org] = await baseDb('organizations').insert({ name: b.organization_name, slug, timezone: b.timezone }).returning('id');
  const orgId = org.id as number;
  let userId: number;
  try {
   userId = await runInOrg(orgId, async () => {
    await seedOrganization(orgId);
    const role = await db('roles').where({ key: 'super_admin' }).first('id');
    const [u] = await db('users').insert({
      employee_code: 'ADMIN-1', name: b.name, email: b.email, password_hash: passwordHash, role_id: role.id, timezone: b.timezone,
      joining_date: new Date().toISOString().slice(0, 10), last_login_at: db.fn.now(),
    }).returning('id');
    await db('user_notification_preferences').insert({ user_id: u.id });
    await setSetting('organization_name', b.organization_name, u.id);
    await setSetting('default_timezone', b.timezone, u.id);
    await audit({ actorId: u.id }, { action: 'organization.registered', entityType: 'organization', entityId: orgId, summary: `${b.organization_name} (${slug}) registered by ${b.email}` });
    return u.id as number;
   });
  } catch (e) {
    await baseDb('organizations').where({ id: orgId }).del(); // no half-created tenants
    throw e;
  }
  const { token } = await issueRefreshToken(userId, { ua: req.headers['user-agent'], ip: req.ip });
  res.status(201);
  await sendSession(req, res, userId, token);
});

router.get('/registration', (_req, res) => res.json({ enabled: config.ALLOW_REGISTRATION }));

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
  (req as any).user = { id: user.id, organizationId: user.organization_id };
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
