import { DateTime } from 'luxon';
import { z } from 'zod';

/**
 * Question frequency. A question "occurs" on a local calendar date of the employee;
 * its deadline is `deadline_time` on that date in the employee's timezone (DST-safe via luxon).
 *
 *   daily           { interval?: n, working_days_only?: bool }            every n days from the start date
 *   weekly          { weekdays: [1..7], interval?: n }                     ISO weekdays, every n weeks
 *   monthly         { month_days: [1..31 | -1 (last day)], interval?: n }  every n months
 *   specific_dates  { dates: ['YYYY-MM-DD', ...] }
 *   custom          { every: n, unit: 'day'|'week'|'month', weekdays?, month_days?, working_days_only? }
 */
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'specific_dates' | 'custom';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const weekdays = z.array(z.number().int().min(1).max(7)).min(1).max(7);
const monthDays = z.array(z.number().int().min(-1).max(31).refine((n) => n !== 0, 'Day 0 is invalid')).min(1).max(31);
const interval = z.number().int().min(1).max(365).optional();

export const FREQUENCY_SCHEMAS: Record<Frequency, z.ZodTypeAny> = {
  daily: z.object({ interval, working_days_only: z.boolean().optional() }).strict(),
  weekly: z.object({ weekdays, interval }).strict(),
  monthly: z.object({ month_days: monthDays, interval }).strict(),
  specific_dates: z.object({ dates: z.array(isoDate).min(1).max(366) }).strict(),
  custom: z.object({
    every: z.number().int().min(1).max(365),
    unit: z.enum(['day', 'week', 'month']),
    weekdays: weekdays.optional(),
    month_days: monthDays.optional(),
    working_days_only: z.boolean().optional(),
  }).strict(),
};

export function validateFrequency(frequency: Frequency, config: unknown): { ok: true; config: any } | { ok: false; error: string } {
  const schema = FREQUENCY_SCHEMAS[frequency];
  if (!schema) return { ok: false, error: `Unknown frequency ${frequency}` };
  const r = schema.safeParse(config ?? {});
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || 'frequency'}: ${i.message}`).join('; ') };
  return { ok: true, config: r.data };
}

export interface ScheduleSpec {
  frequency: Frequency;
  frequency_config: any;
  start_date?: string | null;
  end_date?: string | null;
  created_at?: Date | string | null;
}

const toDay = (iso: string) => DateTime.fromISO(iso, { zone: 'UTC' }).startOf('day');

/** Does the question occur on this local date? `workingDays` are ISO weekdays (org setting). */
export function occursOn(q: ScheduleSpec, date: string, workingDays: number[] = [1, 2, 3, 4, 5]): boolean {
  if (q.start_date && date < q.start_date) return false;
  if (q.end_date && date > q.end_date) return false;
  const d = toDay(date);
  const anchorIso = q.start_date ?? (q.created_at ? DateTime.fromJSDate(new Date(q.created_at)).toUTC().toISODate()! : date);
  const anchor = toDay(anchorIso);
  const c = q.frequency_config ?? {};
  const working = () => workingDays.includes(d.weekday);
  const dayMatch = (days: number[]) => days.includes(d.day) || (days.includes(-1) && d.day === d.daysInMonth);
  const daysSince = Math.round(d.diff(anchor, 'days').days);
  const weeksSince = Math.floor(Math.round(d.startOf('week').diff(anchor.startOf('week'), 'days').days) / 7);
  const monthsSince = (d.year - anchor.year) * 12 + (d.month - anchor.month);

  switch (q.frequency) {
    case 'daily': {
      const n = c.interval ?? 1;
      if (c.working_days_only && !working()) return false;
      return n === 1 || (daysSince >= 0 && daysSince % n === 0);
    }
    case 'weekly': {
      const n = c.interval ?? 1;
      if (!(c.weekdays ?? []).includes(d.weekday)) return false;
      return n === 1 || (weeksSince >= 0 && weeksSince % n === 0);
    }
    case 'monthly': {
      const n = c.interval ?? 1;
      if (!dayMatch(c.month_days ?? [])) return false;
      return n === 1 || (monthsSince >= 0 && monthsSince % n === 0);
    }
    case 'specific_dates':
      return (c.dates ?? []).includes(date);
    case 'custom': {
      const n = c.every ?? 1;
      if (c.working_days_only && !working()) return false;
      if (c.unit === 'day') return daysSince >= 0 && daysSince % n === 0;
      if (c.unit === 'week') {
        const wd: number[] = c.weekdays?.length ? c.weekdays : [anchor.weekday];
        return wd.includes(d.weekday) && weeksSince >= 0 && weeksSince % n === 0;
      }
      if (c.unit === 'month') {
        const md: number[] = c.month_days?.length ? c.month_days : [anchor.day];
        return dayMatch(md) && monthsSince >= 0 && monthsSince % n === 0;
      }
      return false;
    }
    default:
      return false;
  }
}

/** The deadline instant for a local date + local time in a timezone. */
export function dueAtFor(date: string, time: string, tz: string): Date {
  const [hh, mm] = String(time).split(':').map(Number);
  const [y, m, d] = date.split('-').map(Number);
  return DateTime.fromObject({ year: y, month: m, day: d, hour: hh, minute: mm }, { zone: tz }).toUTC().toJSDate();
}

/** Human description used in the builder list. */
export function describeFrequency(q: ScheduleSpec): string {
  const c = q.frequency_config ?? {};
  const W = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const days = (a: number[]) => a.map((x) => (x === -1 ? 'last day' : String(x))).join(', ');
  switch (q.frequency) {
    case 'daily': return `${c.interval > 1 ? `Every ${c.interval} days` : 'Daily'}${c.working_days_only ? ' (working days)' : ''}`;
    case 'weekly': return `${c.interval > 1 ? `Every ${c.interval} weeks` : 'Weekly'} on ${(c.weekdays ?? []).map((d: number) => W[d]).join(', ')}`;
    case 'monthly': return `${c.interval > 1 ? `Every ${c.interval} months` : 'Monthly'} on day ${days(c.month_days ?? [])}`;
    case 'specific_dates': return `On ${(c.dates ?? []).length} specific date(s)`;
    case 'custom': return `Every ${c.every} ${c.unit}(s)${c.weekdays?.length ? ` on ${c.weekdays.map((d: number) => W[d]).join(', ')}` : ''}${c.month_days?.length ? ` on day ${days(c.month_days)}` : ''}${c.working_days_only ? ' (working days)' : ''}`;
    default: return q.frequency;
  }
}
