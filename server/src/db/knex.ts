import { AsyncLocalStorage } from 'async_hooks';
import knexFactory, { Knex } from 'knex';
import pg from 'pg';
import { config } from '../config';

// bigint ids / counts as JS numbers (ids stay far below 2^53), numerics as floats.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => parseFloat(v));
// Keep DATE columns as 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);

/**
 * TLS: 'true' forces SSL, 'false' disables it, 'auto' (default) enables it for managed hosts
 * that require it (e.g. Render external URLs, *.render.com) or when the URL has sslmode=require.
 */
function sslOption() {
  const mode = config.DATABASE_SSL;
  const url = config.DATABASE_URL;
  const want = mode === 'true' || (mode === 'auto' && (/\.render\.com|sslmode=require/i.test(url)));
  return want ? { rejectUnauthorized: config.DATABASE_SSL_REJECT_UNAUTHORIZED } : false;
}

export const baseDb: Knex = knexFactory({
  client: 'pg',
  connection: { connectionString: config.DATABASE_URL.replace(/[?&]sslmode=[^&]*/i, ''), ssl: sslOption() },
  pool: { min: 0, max: config.DATABASE_POOL_MAX },
});

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------
interface TenantStore { trx: Knex.Transaction; orgId: number; after: (() => Promise<unknown>)[] }
export const tenantContext = new AsyncLocalStorage<TenantStore>();

/**
 * `db` is a transparent proxy: inside a tenant context (an authenticated request or an
 * org-scoped background job) every query runs on that context's transaction, where
 * `app.org_id` is set — so PostgreSQL row-level security confines it to one organization
 * and inserts get organization_id automatically. Outside a context it is the plain pool.
 */
export const db: Knex = new Proxy(baseDb, {
  apply(_target, _this, args) {
    const c: any = tenantContext.getStore()?.trx ?? baseDb;
    return c(...args);
  },
  get(_target, prop) {
    const c: any = tenantContext.getStore()?.trx ?? baseDb;
    const v = c[prop];
    return typeof v === 'function' ? v.bind(c) : v;
  },
}) as Knex;

export type Tx = Knex | Knex.Transaction;

export const currentOrgId = (): number | null => tenantContext.getStore()?.orgId ?? null;

/** Run `fn` after the current tenant transaction commits (or immediately when there is none). */
export async function afterCommit(fn: () => Promise<unknown>) {
  const s = tenantContext.getStore();
  if (s) s.after.push(fn);
  else await fn();
}

async function setOrg(trx: Knex.Transaction, orgId: number) {
  await trx.raw(`select set_config('app.org_id', ?, true)`, [String(orgId)]);
}

/** Execute `fn` inside an org-scoped transaction (background jobs, registration, seeding). */
export async function runInOrg<T>(orgId: number, fn: () => Promise<T>): Promise<T> {
  const cur = tenantContext.getStore();
  if (cur && cur.orgId === orgId) return fn();
  const after: TenantStore['after'] = [];
  const result = await baseDb.transaction(async (trx) => {
    await setOrg(trx, orgId);
    return tenantContext.run({ trx, orgId, after }, fn);
  });
  for (const f of after) await f().catch((e) => console.error('afterCommit hook failed', e));
  return result;
}

/**
 * Run `fn` in a savepoint of the current tenant transaction (queries through `db` included),
 * so a failure inside it rolls back only its own work. Outside a context it is a plain transaction.
 */
export async function withSavepoint<T>(fn: () => Promise<T>): Promise<T> {
  const s = tenantContext.getStore();
  if (!s) return baseDb.transaction(() => fn());
  return s.trx.transaction((trx) => tenantContext.run({ ...s, trx }, fn));
}

/** Open a tenant transaction for an HTTP request; caller must finish it with `finishRequestTenant`. */
export async function beginRequestTenant(orgId: number): Promise<TenantStore> {
  const trx = await baseDb.transaction(undefined, { doNotRejectOnRollback: true } as any);
  await setOrg(trx, orgId);
  return { trx, orgId, after: [] };
}

export async function finishRequestTenant(store: TenantStore, ok: boolean) {
  if (store.trx.isCompleted()) return;
  if (ok) {
    await store.trx.commit();
    for (const f of store.after) await f().catch((e) => console.error('afterCommit hook failed', e));
  } else {
    await store.trx.rollback();
  }
}

/** All active organizations (used by background jobs that iterate tenants). */
export const activeOrgIds = async (): Promise<number[]> => baseDb('organizations').where({ is_active: true }).pluck('id');
