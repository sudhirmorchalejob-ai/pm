import { describe, expect, it } from 'vitest';
import { describeRule, firstOccurrence, localToUtc, nextOccurrence, occurrencesBetween, RecurrenceRule } from '../src/lib/recurrence';

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe('timezone conversion', () => {
  it('converts local wall-clock time to UTC', () => {
    expect(localToUtc('2026-11-23', '10:00', 'Asia/Kolkata').toISOString()).toBe('2026-11-23T04:30:00.000Z');
    expect(localToUtc('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z'); // EDT
    expect(localToUtc('2026-12-01', '09:00', 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z'); // EST
  });
  it('shifts non-existent DST times forward instead of failing', () => {
    // 2026-03-08 02:30 does not exist in New York (spring forward)
    expect(localToUtc('2026-03-08', '02:30', 'America/New_York').toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
});

describe('recurrence rules', () => {
  const weeklyMon: RecurrenceRule = { freq: 'weekly', interval: 1, by_weekday: [1], time_of_day: '10:00', timezone: 'Asia/Kolkata', starts_on: '2026-11-02' };

  it('every Monday 10:00 IST', () => {
    const n = nextOccurrence(weeklyMon, new Date('2026-11-21T00:00:00Z'));
    expect(iso(n)).toBe('2026-11-23T04:30:00.000Z');
    expect(iso(nextOccurrence(weeklyMon, n!))).toBe('2026-11-30T04:30:00.000Z');
  });

  it('keeps local time stable across DST changes', () => {
    const r: RecurrenceRule = { freq: 'daily', interval: 1, time_of_day: '09:00', timezone: 'America/New_York', starts_on: '2026-10-30' };
    const occ = occurrencesBetween(r, new Date('2026-10-30T00:00:00Z'), new Date('2026-11-03T00:00:00Z'));
    expect(occ.map((d) => d.toISOString())).toEqual([
      '2026-10-30T13:00:00.000Z', '2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z',
    ]);
  });

  it('weekly on several weekdays with interval 2', () => {
    const r: RecurrenceRule = { freq: 'weekly', interval: 2, by_weekday: [1, 3], time_of_day: '08:00', timezone: 'UTC', starts_on: '2026-11-02' };
    const occ = occurrencesBetween(r, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-30T00:00:00Z'));
    expect(occ.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-11-02', '2026-11-04', '2026-11-16', '2026-11-18']);
  });

  it('monthly on day 31 clamps to the last day of short months', () => {
    const r: RecurrenceRule = { freq: 'monthly', interval: 1, by_month_day: 31, time_of_day: '12:00', timezone: 'UTC', starts_on: '2026-01-31' };
    const occ = occurrencesBetween(r, new Date('2026-01-01T00:00:00Z'), new Date('2026-04-30T23:00:00Z'));
    expect(occ.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('hourly / minutely custom intervals', () => {
    const r: RecurrenceRule = { freq: 'minutely', interval: 30, time_of_day: '09:00', timezone: 'UTC', starts_on: '2026-11-21' };
    expect(iso(nextOccurrence(r, new Date('2026-11-21T09:10:00Z')))).toBe('2026-11-21T09:30:00.000Z');
    const h: RecurrenceRule = { ...r, freq: 'hourly', interval: 4 };
    expect(iso(nextOccurrence(h, new Date('2026-11-21T09:00:00Z')))).toBe('2026-11-21T13:00:00.000Z');
  });

  it('respects end date and max count', () => {
    const r: RecurrenceRule = { freq: 'daily', interval: 1, time_of_day: '10:00', timezone: 'UTC', starts_on: '2026-11-20', ends_on: '2026-11-22' };
    expect(iso(nextOccurrence(r, new Date('2026-11-22T10:00:00Z')))).toBeNull();
    expect(nextOccurrence({ ...r, ends_on: null, max_count: 3 }, new Date('2026-11-21T00:00:00Z'), 3)).toBeNull();
  });

  it('first occurrence never precedes the start date', () => {
    expect(iso(firstOccurrence({ ...weeklyMon, starts_on: '2027-01-01' }, new Date('2026-11-21T00:00:00Z')))).toBe('2027-01-04T04:30:00.000Z');
  });

  it('yearly on Feb 29 falls back to Feb 28', () => {
    const r: RecurrenceRule = { freq: 'yearly', interval: 1, time_of_day: '00:00', timezone: 'UTC', starts_on: '2028-02-29' };
    expect(iso(nextOccurrence(r, new Date('2028-03-01T00:00:00Z')))).toBe('2029-02-28T00:00:00.000Z');
  });

  it('describes rules in words', () => {
    expect(describeRule(weeklyMon)).toBe('Every week on Mon at 10:00 (Asia/Kolkata)');
  });
});
