import { Request } from 'express';
import { db, Tx } from '../db/knex';

export interface AuditEntry {
  action: string;          // e.g. task.deadline_changed
  entityType: string;      // e.g. task
  entityId?: number | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
}

/** Append an immutable audit record. Pass `req` for actor/IP, or `actorId` from background jobs. */
export async function audit(ctx: Request | { actorId: number | null; orgId?: number | null }, e: AuditEntry, trx: Tx = db) {
  const isReq = 'headers' in ctx;
  // Inside a tenant context organization_id defaults from app.org_id; outside one (sign-in) pass it explicitly.
  const orgId = isReq ? (ctx as Request).user?.organizationId : (ctx as any).orgId;
  await trx('audit_logs').insert({
    ...(orgId ? { organization_id: orgId } : {}),
    actor_id: isReq ? (ctx as Request).user?.id ?? null : (ctx as any).actorId,
    action: e.action,
    entity_type: e.entityType,
    entity_id: e.entityId ?? null,
    summary: e.summary ?? null,
    before: e.before === undefined ? null : JSON.stringify(e.before),
    after: e.after === undefined ? null : JSON.stringify(e.after),
    ip: isReq ? (ctx as Request).ip : null,
    user_agent: isReq ? String((ctx as Request).headers['user-agent'] ?? '').slice(0, 300) : null,
  });
}

/** Return only the keys that changed between two objects (for compact audit diffs). */
export function diff(before: Record<string, any>, after: Record<string, any>) {
  const b: Record<string, any> = {};
  const a: Record<string, any> = {};
  for (const k of Object.keys(after)) {
    const bv = before[k] instanceof Date ? before[k].toISOString() : before[k];
    const av = after[k] instanceof Date ? after[k].toISOString() : after[k];
    if (JSON.stringify(bv) !== JSON.stringify(av)) { b[k] = bv; a[k] = av; }
  }
  return { before: b, after: a, changed: Object.keys(a) };
}
