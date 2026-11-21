import { format, formatDistanceToNowStrict, isPast, isToday, isTomorrow, parseISO } from 'date-fns';

const toDate = (v: string | Date) => (v instanceof Date ? v : v.length === 10 ? parseISO(v) : new Date(v));

export const fmtDate = (v?: string | Date | null) => (v ? format(toDate(v), 'dd MMM yyyy') : '—');
export const fmtDateTime = (v?: string | Date | null) => (v ? format(toDate(v), 'dd MMM yyyy, HH:mm') : '—');
export const fmtTime = (v?: string | Date | null) => (v ? format(toDate(v), 'HH:mm') : '');
export const fromNow = (v?: string | Date | null) => (v ? formatDistanceToNowStrict(toDate(v), { addSuffix: true }) : '—');

export function dueLabel(v?: string | null, done = false) {
  if (!v) return { text: 'No deadline', tone: 'muted' as const };
  const d = toDate(v);
  if (done) return { text: fmtDate(d), tone: 'muted' as const };
  if (isPast(d)) return { text: `Overdue · ${formatDistanceToNowStrict(d)}`, tone: 'danger' as const };
  if (isToday(d)) return { text: `Today ${format(d, 'HH:mm')}`, tone: 'warn' as const };
  if (isTomorrow(d)) return { text: `Tomorrow ${format(d, 'HH:mm')}`, tone: 'warn' as const };
  return { text: format(d, 'dd MMM, HH:mm'), tone: 'normal' as const };
}

export const humanize = (s?: string | null) => (s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');
export const money = (v?: number | null) => (v == null ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v));
export const pct = (v?: number | null) => (v == null ? '—' : `${v}%`);
export const initials = (name?: string) => (name ?? '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
export const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Convert a datetime-local input value (browser local time) to ISO with offset. */
export const localInputToIso = (v: string) => (v ? new Date(v).toISOString() : null);
/** Convert ISO → value for <input type="datetime-local"> in browser local time. */
export const isoToLocalInput = (v?: string | null) => (v ? format(new Date(v), "yyyy-MM-dd'T'HH:mm") : '');
export const todayIso = () => format(new Date(), 'yyyy-MM-dd');

/** Wall-clock date (YYYY-MM-DD) / time (HH:mm) of an instant in a given IANA timezone. */
export function zonedDate(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function zonedTime(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
}
