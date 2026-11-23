import { NextFunction, Request, Response } from 'express';
import { baseDb, beginRequestTenant, finishRequestTenant, tenantContext } from '../db/knex';
import { forbidden, unauthorized } from '../lib/errors';
import { Permission, ScopeLevel } from './permissions';
import { verifyAccessToken } from './tokens';

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  roleKey: string;
  roleName: string;
  scope: ScopeLevel;
  rank: number;
  departmentId: number | null;
  teamId: number | null;
  timezone: string;
  organizationId: number;
  organizationName: string;
  permissions: Set<string>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

// Short-lived cache so permission changes apply within seconds without a DB hit per request.
const cache = new Map<number, { at: number; user: AuthUser }>();
const TTL = 10_000;
export const invalidateUserCache = (id?: number) => (id ? cache.delete(id) : cache.clear());

export async function loadAuthUser(id: number): Promise<AuthUser | null> {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.user;
  // Runs outside any tenant context (before the request transaction), so filter by org explicitly.
  const u = await baseDb('users as u')
    .join('roles as r', 'r.id', 'u.role_id')
    .join('organizations as o', 'o.id', 'u.organization_id')
    .where('u.id', id).andWhere('u.is_active', true).whereNull('u.deleted_at').andWhere('o.is_active', true)
    .first('u.id', 'u.name', 'u.email', 'u.department_id', 'u.team_id', 'u.timezone', 'r.id as role_id', 'r.key as role_key',
      'r.name as role_name', 'r.scope_level', 'r.rank', 'u.organization_id', 'o.name as organization_name');
  if (!u) return null;
  const perms = await baseDb('role_permissions as rp').join('permissions as p', 'p.id', 'rp.permission_id')
    .where('rp.role_id', u.role_id).andWhere('rp.organization_id', u.organization_id).pluck('p.key');
  const user: AuthUser = {
    id: u.id, name: u.name, email: u.email, roleKey: u.role_key, roleName: u.role_name, scope: u.scope_level, rank: u.rank,
    departmentId: u.department_id, teamId: u.team_id, timezone: u.timezone, organizationId: u.organization_id,
    organizationName: u.organization_name, permissions: new Set(perms),
  };
  cache.set(id, { at: Date.now(), user });
  return user;
}

/**
 * Authenticates the bearer token and opens the request's tenant transaction:
 * all queries made while handling the request run in it with `app.org_id` set,
 * so row-level security limits them to the user's organization. The transaction
 * commits just before the response is sent (status < 400) and rolls back otherwise;
 * work registered with afterCommit (job enqueues) runs after the commit.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  if (req.user && tenantContext.getStore()) return next(); // already authenticated by an earlier mount
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw unauthorized();
  const { sub } = verifyAccessToken(h.slice(7));
  const user = await loadAuthUser(sub);
  if (!user) throw unauthorized('Account not found or disabled');
  req.user = user;
  const store = await beginRequestTenant(user.organizationId);
  const originalEnd = res.end.bind(res) as (...a: any[]) => Response;
  let ending = false;
  (res as any).end = (...args: any[]) => {
    if (ending) return res;
    ending = true;
    finishRequestTenant(store, res.statusCode < 400)
      .catch((e) => console.error('tenant transaction finish failed', e))
      .finally(() => originalEnd(...args));
    return res;
  };
  res.on('close', () => { if (!store.trx.isCompleted()) store.trx.rollback().catch(() => undefined); });
  tenantContext.run(store, () => next());
}

export const can = (u: AuthUser, p: Permission) => u.permissions.has(p);

/** Route guard: requires ANY of the given permissions. */
export const requirePerm = (...perms: Permission[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) throw unauthorized();
  if (!perms.some((p) => req.user!.permissions.has(p))) throw forbidden();
  next();
};

export const me = (req: Request): AuthUser => {
  if (!req.user) throw unauthorized();
  return req.user;
};
