import { z } from 'zod';

export const ANSWER_TYPES = ['text', 'long_text', 'number', 'date', 'time', 'yes_no', 'url', 'url_list', 'single_choice', 'multiple_choice', 'file', 'rating', 'email'] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];
export const REPORT_TAGS = ['work_done', 'plan', 'pending', 'blocker', 'delay', 'progress', 'deadline', 'campaign', 'url', 'metric', 'other'] as const;
export const CONDITION_OPS = ['equals', 'not_equals', 'contains', 'gt', 'lt', 'answered', 'not_answered'] as const;

/** Options per answer type, validated when a question is saved. */
export const optionsSchema = z.object({
  choices: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  unit: z.string().trim().max(30).optional(),
  placeholder: z.string().trim().max(200).optional(),
}).strict();

export function validateOptions(type: AnswerType, options: any): string | null {
  const r = optionsSchema.safeParse(options ?? {});
  if (!r.success) return r.error.issues[0]?.message ?? 'Invalid options';
  const o = r.data;
  if ((type === 'single_choice' || type === 'multiple_choice') && (!o.choices || o.choices.length < 2)) return 'Choice questions need at least two options';
  if (o.choices && new Set(o.choices.map((c) => c.toLowerCase())).size !== o.choices.length) return 'Choices must be unique';
  if (o.min !== undefined && o.max !== undefined && o.min > o.max) return 'Minimum cannot be greater than maximum';
  return null;
}

const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const isUrl = (s: unknown) => typeof s === 'string' && s.length <= 2000 && URL_RE.test(s.trim());

/** Is this value an actual answer (not blank)? Unanswered questions are never treated as done. */
export function isAnswered(type: string, v: any): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (type === 'yes_no') return typeof v === 'boolean';
  if (typeof v === 'number') return Number.isFinite(v);
  return true;
}

/** Validate & normalise an answer for a question. Returns the clean value or an error message. */
export function validateAnswer(type: string, options: any, v: any): { ok: true; value: any } | { ok: false; error: string } {
  const o = options ?? {};
  const fail = (error: string) => ({ ok: false as const, error });
  switch (type) {
    case 'text':
    case 'long_text': {
      if (typeof v !== 'string') return fail('Expected text');
      const max = type === 'text' ? 2000 : 20000;
      if (v.length > max) return fail(`Too long (max ${max} characters)`);
      return { ok: true, value: v.trim() };
    }
    case 'email':
      if (typeof v !== 'string' || !z.string().email().safeParse(v.trim()).success) return fail('Enter a valid email address');
      return { ok: true, value: v.trim().toLowerCase() };
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return fail('Enter a number');
      if (o.min !== undefined && n < o.min) return fail(`Must be at least ${o.min}`);
      if (o.max !== undefined && n > o.max) return fail(`Must be at most ${o.max}`);
      return { ok: true, value: n };
    }
    case 'rating': {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 5) return fail('Choose a rating from 1 to 5');
      return { ok: true, value: n };
    }
    case 'date':
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) return fail('Enter a valid date');
      return { ok: true, value: v };
    case 'time':
      if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return fail('Enter a valid time (HH:mm)');
      return { ok: true, value: v };
    case 'yes_no':
      if (typeof v !== 'boolean') return fail('Choose yes or no');
      return { ok: true, value: v };
    case 'url':
      if (!isUrl(v)) return fail('Enter a valid http(s) URL');
      return { ok: true, value: v.trim() };
    case 'url_list': {
      if (!Array.isArray(v) || v.length > 100) return fail('Expected a list of up to 100 links');
      const out = [];
      for (const [i, e] of v.entries()) {
        const url = typeof e === 'string' ? e : e?.url;
        if (!isUrl(url)) return fail(`Link ${i + 1} is not a valid http(s) URL`);
        const published_at = typeof e === 'object' && e?.published_at ? String(e.published_at) : null;
        if (published_at && Number.isNaN(Date.parse(published_at))) return fail(`Link ${i + 1} has an invalid publication time`);
        const label = typeof e === 'object' && e?.label ? String(e.label).slice(0, 200) : null;
        out.push({ url: url.trim(), published_at, label });
      }
      return { ok: true, value: out };
    }
    case 'single_choice':
      if (typeof v !== 'string' || !(o.choices ?? []).includes(v)) return fail('Choose one of the options');
      return { ok: true, value: v };
    case 'multiple_choice':
      if (!Array.isArray(v) || v.some((x) => !(o.choices ?? []).includes(x))) return fail('Choose from the listed options');
      return { ok: true, value: [...new Set(v)] };
    case 'file':
      if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x) || x <= 0) || v.length > 10) return fail('Attach up to 10 files');
      return { ok: true, value: v };
    default:
      return fail(`Unsupported answer type ${type}`);
  }
}

/** Human-readable rendering for reports, revisions and clipboard text. */
export function formatAnswer(type: string, v: any, files: Record<number, string> = {}, unit?: string): string {
  if (!isAnswered(type, v)) return '';
  switch (type) {
    case 'yes_no': return v ? 'Yes' : 'No';
    case 'number': return `${Number(v).toLocaleString('en-US')}${unit ? ` ${unit}` : ''}`;
    case 'rating': return `${v}/5`;
    case 'multiple_choice': return (v as string[]).join(', ');
    case 'url_list': return (v as any[]).map((e) => `${e.url}${e.published_at ? ` (published ${String(e.published_at).replace('T', ' ').slice(0, 16)})` : ''}${e.label ? ` — ${e.label}` : ''}`).join('\n');
    case 'file': return (v as number[]).map((id) => files[id] ?? `file #${id}`).join(', ');
    default: return String(v);
  }
}

/** Evaluate a conditional question's display rule against the controlling answer. */
export function conditionMet(op: string | null | undefined, expected: any, actual: any, actualType: string): boolean {
  if (!op) return true;
  const answered = isAnswered(actualType, actual);
  switch (op) {
    case 'answered': return answered;
    case 'not_answered': return !answered;
    case 'equals': return answered && norm(actual) === norm(expected);
    case 'not_equals': return !answered || norm(actual) !== norm(expected);
    case 'contains':
      if (!answered) return false;
      if (Array.isArray(actual)) return actual.some((a) => norm(typeof a === 'object' ? a.url : a) === norm(expected));
      return String(actual).toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'gt': return answered && Number(actual) > Number(expected);
    case 'lt': return answered && Number(actual) < Number(expected);
    default: return true;
  }
}
const norm = (x: any) => (typeof x === 'string' ? x.trim().toLowerCase() : typeof x === 'boolean' ? String(x) : JSON.stringify(x));
