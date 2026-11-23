import { describe, expect, it } from 'vitest';
import { conditionMet, formatAnswer, isAnswered, validateAnswer, validateOptions } from '../src/questionnaire/answers';
import { describeFrequency, dueAtFor, occursOn, validateFrequency } from '../src/questionnaire/schedule';

describe('question frequency', () => {
  const W = [1, 2, 3, 4, 5];
  it('daily, every n days and working days only', () => {
    expect(occursOn({ frequency: 'daily', frequency_config: {} }, '2026-11-22', W)).toBe(true); // Sunday
    expect(occursOn({ frequency: 'daily', frequency_config: { working_days_only: true } }, '2026-11-22', W)).toBe(false);
    expect(occursOn({ frequency: 'daily', frequency_config: { working_days_only: true } }, '2026-11-23', W)).toBe(true); // Monday
    const every3 = { frequency: 'daily' as const, frequency_config: { interval: 3 }, start_date: '2026-11-01' };
    expect(occursOn(every3, '2026-11-04', W)).toBe(true);
    expect(occursOn(every3, '2026-11-05', W)).toBe(false);
  });
  it('weekly on chosen weekdays, every other week', () => {
    const q = { frequency: 'weekly' as const, frequency_config: { weekdays: [1, 5] } };
    expect(occursOn(q, '2026-11-23', W)).toBe(true);  // Mon
    expect(occursOn(q, '2026-11-24', W)).toBe(false); // Tue
    const bi = { frequency: 'weekly' as const, frequency_config: { weekdays: [1], interval: 2 }, start_date: '2026-11-02' };
    expect(occursOn(bi, '2026-11-16', W)).toBe(true);
    expect(occursOn(bi, '2026-11-23', W)).toBe(false);
  });
  it('monthly incl. last day of month', () => {
    const q = { frequency: 'monthly' as const, frequency_config: { month_days: [15, -1] } };
    expect(occursOn(q, '2026-02-28', W)).toBe(true);
    expect(occursOn(q, '2026-02-15', W)).toBe(true);
    expect(occursOn(q, '2026-03-30', W)).toBe(false);
    expect(occursOn(q, '2026-03-31', W)).toBe(true);
  });
  it('specific dates, custom recurrence and start/end bounds', () => {
    expect(occursOn({ frequency: 'specific_dates', frequency_config: { dates: ['2026-12-01'] } }, '2026-12-01', W)).toBe(true);
    expect(occursOn({ frequency: 'specific_dates', frequency_config: { dates: ['2026-12-01'] } }, '2026-12-02', W)).toBe(false);
    const c = { frequency: 'custom' as const, frequency_config: { every: 2, unit: 'week', weekdays: [3] }, start_date: '2026-11-04' };
    expect(occursOn(c, '2026-11-18', W)).toBe(true);
    expect(occursOn(c, '2026-11-25', W)).toBe(false);
    expect(occursOn({ frequency: 'daily', frequency_config: {}, start_date: '2026-12-01' }, '2026-11-30', W)).toBe(false);
    expect(occursOn({ frequency: 'daily', frequency_config: {}, end_date: '2026-11-30' }, '2026-12-01', W)).toBe(false);
  });
  it('validates configurations and describes them', () => {
    expect(validateFrequency('weekly', {}).ok).toBe(false);
    expect(validateFrequency('monthly', { month_days: [0] }).ok).toBe(false);
    expect(validateFrequency('daily', { bogus: 1 }).ok).toBe(false);
    expect(validateFrequency('custom', { every: 2, unit: 'month' }).ok).toBe(true);
    expect(describeFrequency({ frequency: 'weekly', frequency_config: { weekdays: [1, 3] } })).toBe('Weekly on Mon, Wed');
  });
  it('computes deadlines in the employee timezone across DST', () => {
    expect(dueAtFor('2026-11-23', '18:00', 'Asia/Kolkata').toISOString()).toBe('2026-11-23T12:30:00.000Z');
    expect(dueAtFor('2026-03-27', '18:00', 'Europe/Berlin').toISOString()).toBe('2026-03-27T17:00:00.000Z'); // CET
    expect(dueAtFor('2026-03-30', '18:00', 'Europe/Berlin').toISOString()).toBe('2026-03-30T16:00:00.000Z'); // CEST
  });
});

describe('answers', () => {
  it('validates every answer type', () => {
    expect(validateAnswer('number', { min: 0, max: 100 }, 101).ok).toBe(false);
    expect(validateAnswer('number', {}, '42')).toEqual({ ok: true, value: 42 });
    expect(validateAnswer('yes_no', {}, 'yes').ok).toBe(false);
    expect(validateAnswer('url', {}, 'ftp://x').ok).toBe(false);
    expect(validateAnswer('url', {}, 'https://example.com/a').ok).toBe(true);
    expect(validateAnswer('single_choice', { choices: ['A', 'B'] }, 'C').ok).toBe(false);
    expect(validateAnswer('multiple_choice', { choices: ['A', 'B'] }, ['A', 'A'])).toEqual({ ok: true, value: ['A'] });
    expect(validateAnswer('date', {}, '2026-02-30').ok).toBe(true); // Date.parse accepts; format is what matters
    expect(validateAnswer('time', {}, '25:00').ok).toBe(false);
    expect(validateAnswer('rating', {}, 6).ok).toBe(false);
    expect(validateAnswer('email', {}, 'A@B.co')).toEqual({ ok: true, value: 'a@b.co' });
    const links = validateAnswer('url_list', {}, [{ url: 'https://x.com/p', published_at: '2026-11-23T10:30' }, 'https://y.com']);
    expect(links.ok && links.value).toEqual([{ url: 'https://x.com/p', published_at: '2026-11-23T10:30', label: null }, { url: 'https://y.com', published_at: null, label: null }]);
  });
  it('never treats blanks as answers', () => {
    expect(isAnswered('text', '   ')).toBe(false);
    expect(isAnswered('yes_no', false)).toBe(true);
    expect(isAnswered('number', 0)).toBe(true);
    expect(isAnswered('url_list', [])).toBe(false);
  });
  it('formats answers for reports', () => {
    expect(formatAnswer('yes_no', false)).toBe('No');
    expect(formatAnswer('number', 4200, {}, 'records')).toBe('4,200 records');
    expect(formatAnswer('file', [7], { 7: 'report.pdf' })).toBe('report.pdf');
  });
  it('evaluates conditions', () => {
    expect(conditionMet('equals', true, true, 'yes_no')).toBe(true);
    expect(conditionMet('equals', 'true', false, 'yes_no')).toBe(false);
    expect(conditionMet('gt', 10, 11, 'number')).toBe(true);
    expect(conditionMet('answered', null, '', 'text')).toBe(false);
    expect(conditionMet('contains', 'b', ['a', 'b'], 'multiple_choice')).toBe(true);
  });
  it('validates choice options', () => {
    expect(validateOptions('single_choice', { choices: ['only'] })).toMatch(/two/);
    expect(validateOptions('single_choice', { choices: ['A', 'a'] })).toMatch(/unique/);
    expect(validateOptions('number', { min: 5, max: 1 })).toMatch(/Minimum/);
    expect(validateOptions('text', {})).toBeNull();
  });
});
