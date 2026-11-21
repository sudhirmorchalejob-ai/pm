import { DateTime, IANAZone } from 'luxon';

/**
 * Timezone-correct recurrence calculation.
 * Occurrences are defined in the rule's local wall-clock time (e.g. "every Monday 10:00
 * Asia/Kolkata") and converted to UTC instants, so DST transitions keep the local time
 * stable. Non-existent local times (DST spring-forward gap) are shifted forward by luxon.
 */
export interface RecurrenceRule {
  freq: 'minutely' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  by_weekday?: number[] | null;  // ISO 1=Mon..7=Sun
  by_month_day?: number | null;
  time_of_day: string;           // HH:mm[:ss]
  timezone: string;
  starts_on: string;             // YYYY-MM-DD (local)
  ends_on?: string | null;       // YYYY-MM-DD inclusive (local)
  max_count?: number | null;
}

export const isValidTimezone = (tz: string) => IANAZone.isValidZone(tz);

export function localToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss] = time.split(':').map(Number);
  const dt = DateTime.fromObject({ year: y, month: m, day: d, hour: hh, minute: mm, second: ss || 0 }, { zone: tz });
  if (!dt.isValid) throw new Error(`Invalid local date/time ${date} ${time} ${tz}`);
  return dt.toUTC().toJSDate();
}

export function utcToLocalParts(at: Date, tz: string) {
  const dt = DateTime.fromJSDate(at).setZone(tz);
  return { date: dt.toISODate()!, time: dt.toFormat('HH:mm'), weekday: dt.weekday };
}

function at(day: DateTime, rule: RecurrenceRule): DateTime {
  const [hh, mm, ss] = rule.time_of_day.split(':').map(Number);
  return DateTime.fromObject({ year: day.year, month: day.month, day: day.day, hour: hh, minute: mm, second: ss || 0 }, { zone: rule.timezone });
}

function clampDay(year: number, month: number, day: number, zone: string) {
  const first = DateTime.fromObject({ year, month, day: 1 }, { zone });
  return first.set({ day: Math.min(day, first.daysInMonth!) });
}

/**
 * Returns the first occurrence strictly after `after`, or null when the series has ended.
 * `occurrencesSoFar` lets callers enforce max_count.
 */
export function nextOccurrence(rule: RecurrenceRule, after: Date, occurrencesSoFar = 0): Date | null {
  if (rule.max_count && occurrencesSoFar >= rule.max_count) return null;
  const zone = rule.timezone;
  const start = DateTime.fromISO(rule.starts_on, { zone }).startOf('day');
  const end = rule.ends_on ? DateTime.fromISO(rule.ends_on, { zone }).endOf('day') : null;
  const afterDt = DateTime.fromJSDate(after).setZone(zone);
  const interval = Math.max(1, rule.interval || 1);
  const ok = (c: DateTime) => c.toMillis() > afterDt.toMillis() && c >= at(start, rule);
  const result = (c: DateTime | null) => (!c || (end && c > end) ? null : c.toUTC().toJSDate());
  const MAX_ITER = 2000;

  switch (rule.freq) {
    case 'minutely':
    case 'hourly': {
      const unitMs = (rule.freq === 'hourly' ? 3600_000 : 60_000) * interval;
      const first = at(start, rule).toMillis();
      const k = Math.max(0, Math.floor((afterDt.toMillis() - first) / unitMs) + 1);
      return result(DateTime.fromMillis(first + k * unitMs, { zone }));
    }
    case 'daily': {
      const diff = Math.max(0, Math.floor(afterDt.startOf('day').diff(start, 'days').days));
      let k = Math.max(0, Math.floor(diff / interval) - 1);
      for (let i = 0; i < MAX_ITER; i++, k++) {
        const c = at(start.plus({ days: k * interval }), rule);
        if (end && c > end) return null;
        if (ok(c)) return result(c);
      }
      return null;
    }
    case 'weekly': {
      const days = [...new Set(rule.by_weekday?.length ? rule.by_weekday : [start.weekday])].sort((a, b) => a - b);
      const week0 = start.startOf('week'); // ISO week starts Monday
      const weeksDiff = Math.max(0, Math.floor(afterDt.startOf('week').diff(week0, 'weeks').weeks));
      let w = Math.max(0, Math.floor(weeksDiff / interval) - 1) * interval;
      for (let i = 0; i < MAX_ITER; i++, w += interval) {
        for (const wd of days) {
          const c = at(week0.plus({ weeks: w, days: wd - 1 }), rule);
          if (c < at(start, rule)) continue;
          if (end && c > end) return null;
          if (ok(c)) return result(c);
        }
      }
      return null;
    }
    case 'monthly': {
      const dom = rule.by_month_day || start.day;
      const monthsDiff = Math.max(0, Math.floor(afterDt.diff(start.startOf('month'), 'months').months));
      let k = Math.max(0, Math.floor(monthsDiff / interval) - 1) * interval;
      for (let i = 0; i < MAX_ITER; i++, k += interval) {
        const m = start.startOf('month').plus({ months: k });
        const c = at(clampDay(m.year, m.month, dom, zone), rule);
        if (end && c > end) return null;
        if (ok(c)) return result(c);
      }
      return null;
    }
    case 'yearly': {
      let k = Math.max(0, Math.floor((afterDt.year - start.year) / interval) - 1) * interval;
      for (let i = 0; i < MAX_ITER; i++, k += interval) {
        const c = at(clampDay(start.year + k, start.month, start.day, zone), rule);
        if (end && c > end) return null;
        if (ok(c)) return result(c);
      }
      return null;
    }
  }
}

/** First occurrence on/after the rule start (used when a schedule is created). */
export function firstOccurrence(rule: RecurrenceRule, notBefore: Date = new Date()): Date | null {
  return nextOccurrence(rule, new Date(notBefore.getTime() - 1), 0);
}

/** Expand occurrences inside a window (calendar views). */
export function occurrencesBetween(rule: RecurrenceRule, from: Date, to: Date, limit = 500): Date[] {
  const out: Date[] = [];
  let cursor = new Date(from.getTime() - 1);
  while (out.length < limit) {
    const n = nextOccurrence(rule, cursor, 0);
    if (!n || n > to) break;
    out.push(n);
    cursor = n;
  }
  return out;
}

export function describeRule(r: RecurrenceRule): string {
  const names = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const every = r.interval > 1 ? `Every ${r.interval} ` : 'Every ';
  const unit = { minutely: 'minute', hourly: 'hour', daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.freq];
  let s = `${every}${unit}${r.interval > 1 ? 's' : ''}`;
  if (r.freq === 'weekly' && r.by_weekday?.length) s += ` on ${r.by_weekday.map((d) => names[d]).join(', ')}`;
  if (r.freq === 'monthly' && r.by_month_day) s += ` on day ${r.by_month_day}`;
  if (!['minutely', 'hourly'].includes(r.freq)) s += ` at ${r.time_of_day.slice(0, 5)}`;
  return `${s} (${r.timezone})`;
}
