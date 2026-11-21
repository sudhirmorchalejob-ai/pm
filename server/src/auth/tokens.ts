import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { db, Tx } from '../db/knex';
import { unauthorized } from '../lib/errors';

export interface AccessClaims { sub: number; tv?: number }

export function signAccessToken(userId: number): string {
  return jwt.sign({ sub: userId }, config.JWT_ACCESS_SECRET, { expiresIn: config.ACCESS_TOKEN_TTL as any, issuer: 'orgpm' });
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const p = jwt.verify(token, config.JWT_ACCESS_SECRET, { issuer: 'orgpm' }) as any;
    return { sub: Number(p.sub) };
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
}

const hash = (t: string) => crypto.createHmac('sha256', config.JWT_REFRESH_SECRET).update(t).digest('hex');

/** Issue a new opaque refresh token (stored hashed). */
export async function issueRefreshToken(userId: number, meta: { ua?: string; ip?: string }, familyId?: string, trx: Tx = db) {
  const token = crypto.randomBytes(48).toString('base64url');
  const [row] = await trx('refresh_tokens')
    .insert({
      user_id: userId,
      token_hash: hash(token),
      family_id: familyId ?? crypto.randomUUID(),
      expires_at: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86400_000),
      user_agent: meta.ua?.slice(0, 300),
      ip: meta.ip,
    })
    .returning(['id']);
  return { token, id: row.id as number };
}

/**
 * Rotate a refresh token. If a token that was already rotated is presented again
 * (reuse => likely theft), the entire token family is revoked.
 */
export async function rotateRefreshToken(token: string, meta: { ua?: string; ip?: string }) {
  let reusedFamily: string | null = null;
  const result = await db.transaction(async (trx) => {
    const row = await trx('refresh_tokens').where({ token_hash: hash(token) }).forUpdate().first();
    if (!row) throw unauthorized('Invalid refresh token');
    if (row.revoked_at) { reusedFamily = row.family_id; return null; }
    if (new Date(row.expires_at) < new Date()) throw unauthorized('Refresh token expired');
    const user = await trx('users').where({ id: row.user_id, is_active: true }).whereNull('deleted_at').first();
    if (!user) throw unauthorized('Account disabled');
    const next = await issueRefreshToken(row.user_id, meta, row.family_id, trx);
    await trx('refresh_tokens').where({ id: row.id }).update({ revoked_at: trx.fn.now(), replaced_by: next.id });
    return { userId: row.user_id as number, refreshToken: next.token };
  });
  if (reusedFamily || !result) {
    // Committed outside the transaction so the revocation is not rolled back by the thrown error.
    await db('refresh_tokens').where({ family_id: reusedFamily }).whereNull('revoked_at').update({ revoked_at: db.fn.now() });
    throw unauthorized('Refresh token reuse detected; please sign in again');
  }
  return result;
}

export async function revokeRefreshToken(token: string) {
  const row = await db('refresh_tokens').where({ token_hash: hash(token) }).first();
  if (row) await db('refresh_tokens').where({ family_id: row.family_id }).whereNull('revoked_at').update({ revoked_at: db.fn.now() });
}

export async function revokeAllForUser(userId: number) {
  await db('refresh_tokens').where({ user_id: userId }).whereNull('revoked_at').update({ revoked_at: db.fn.now() });
}
