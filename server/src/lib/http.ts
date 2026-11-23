import { Request } from 'express';
import { z, ZodTypeAny } from 'zod';
import { badRequest } from './errors';

/**
 * Schema for PATCH bodies: every field optional and *without* its create-time default.
 * (zod's .partial() keeps defaults, so an omitted field would silently be reset to its default.)
 */
export function patchOf<T extends z.ZodObject<any>>(schema: T): ReturnType<T['partial']> {
  const shape: Record<string, ZodTypeAny> = {};
  for (const [k, v] of Object.entries(schema.shape as Record<string, ZodTypeAny>)) {
    shape[k] = (v instanceof z.ZodDefault ? (v as any).removeDefault() : v).optional();
  }
  return z.object(shape) as unknown as ReturnType<T['partial']>;
}

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('Validation failed', r.error.flatten());
  return r.data;
}

export const idParam = (req: Request, name = 'id'): number => {
  const v = Number(req.params[name]);
  if (!Number.isInteger(v) || v <= 0) throw badRequest(`Invalid ${name}`);
  return v;
};

export const zPage = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(25),
};

export const zId = z.coerce.number().int().positive();
export const zOptId = zId.nullable().optional();
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const zTime = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Expected HH:mm');
export const zPriority = z.enum(['low', 'medium', 'high', 'critical']);
export const zOptStr = z.string().trim().max(20000).nullable().optional();
export const zCsv = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : (Array.isArray(v) ? v : v.split(',')).filter(Boolean)));
export const zCsvIds = zCsv.transform((v) => v?.map(Number).filter((n) => Number.isInteger(n) && n > 0));
export const zBoolQ = z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true'));

/** Apply a whitelisted sort (`field:asc|desc`) to a knex query. */
export function applySort(q: any, sort: string | undefined, allowed: Record<string, string>, fallback: string) {
  const [field, dir] = (sort || fallback).split(':');
  const [ff, fd] = fallback.split(':');
  const col = allowed[field] ?? allowed[ff];
  return q.orderBy(col, (allowed[field] ? dir : fd) === 'asc' ? 'asc' : 'desc');
}

export async function paginate<T = any>(q: any, page: number, pageSize: number) {
  const countQ = q.clone().clearSelect().clearOrder().count({ c: '*' }).first();
  const [items, cnt] = await Promise.all([q.limit(pageSize).offset((page - 1) * pageSize), countQ]);
  return { items: items as T[], total: Number(cnt?.c ?? 0), page, pageSize };
}
