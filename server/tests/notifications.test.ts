import { afterAll, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db/knex';
import { channelHandlers } from '../src/notifications/channels';
import { generateRecurringTasks, markOverdue, runEscalations } from '../src/notifications/escalation';
import { getQueues } from '../src/notifications/queues';
import { deliverLog, fireSchedule, sweepSchedules } from '../src/notifications/service';
import { redis } from '../src/lib/redis';
import { as, inHours, userId } from './helpers';

afterAll(async () => {
  const q = getQueues();
  for (const k of ['schedules', 'deliveries', 'maintenance'] as const) await q[k].obliterate({ force: true });
  await Promise.all([q.schedules.close(), q.deliveries.close(), q.maintenance.close()]);
  await redis().quit();
  await db.destroy();
});

const zoned = (d: Date, tz: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};

describe('custom reminder scheduler', () => {
  it('stores any custom local date/time in the right UTC instant and enqueues a persistent job', async () => {
    const hod = await as('hod.it@orgpm.dev');
    const r = await hod.post('/notifications/schedules').send({
      title: 'Check project progress', schedule_type: 'one_time', date: '2030-03-15', time: '10:00', timezone: 'Asia/Kolkata', channels: ['in_app', 'email'],
      recipient_ids: [await userId('employee@orgpm.dev')],
    });
    expect(r.status).toBe(201);
    expect(new Date(r.body.next_run_at).toISOString()).toBe('2030-03-15T04:30:00.000Z');
    const job = await getQueues().schedules.getJob(`s-${r.body.id}-${new Date('2030-03-15T04:30:00Z').getTime()}`);
    expect(job).toBeTruthy();
    expect(await job!.getState()).toBe('delayed');
  });

  it('rejects times in the past and out-of-scope recipients', async () => {
    const hod = await as('hod.it@orgpm.dev');
    expect((await hod.post('/notifications/schedules').send({ title: 'Past', schedule_type: 'one_time', date: '2020-01-01', time: '10:00', timezone: 'UTC' })).status).toBe(400);
    expect((await hod.post('/notifications/schedules').send({ title: 'Other dept', schedule_type: 'one_time', date: '2030-01-01', time: '10:00', timezone: 'UTC', recipient_ids: [await userId('tanvi@orgpm.dev')] })).status).toBe(403);
    const emp = await as('employee@orgpm.dev');
    expect((await emp.post('/notifications/schedules').send({ title: 'For boss', schedule_type: 'one_time', date: '2030-01-01', time: '10:00', timezone: 'UTC', recipient_ids: [await userId('hod.it@orgpm.dev')] })).status).toBe(403);
  });

  it('fires once at the due time, delivers in-app, and prevents duplicates', async () => {
    const emp = await as('employee@orgpm.dev');
    const me = await userId('employee@orgpm.dev');
    const soon = new Date(Date.now() + 61_000);
    const local = zoned(soon, 'Europe/London');
    const r = await emp.post('/notifications/schedules').send({ title: 'Stand-up prep', message: 'Prepare notes', schedule_type: 'one_time', date: local.date, time: local.time, timezone: 'Europe/London', channels: ['in_app', 'email'] });
    expect(r.status).toBe(201);
    const id = r.body.id;
    expect((await fireSchedule(id)).fired).toBe(false); // not due yet
    await db('notification_schedules').where({ id }).update({ next_run_at: new Date(Date.now() - 1000) }); // simulate time passing
    const due = (await db('notification_schedules').where({ id }).first()).next_run_at;
    const [a, b] = await Promise.all([fireSchedule(id, new Date(due)), fireSchedule(id, new Date(due))]); // concurrent workers
    expect([a.fired, b.fired].filter(Boolean)).toHaveLength(1);
    const logs = await db('notification_logs').where({ schedule_id: id });
    expect(logs).toHaveLength(2); // in_app + email, exactly once
    for (const l of logs) await deliverLog(l.id, 1);
    const after = await db('notification_logs').where({ schedule_id: id }).orderBy('channel');
    expect(after.find((l) => l.channel === 'in_app').status).toBe('delivered');
    expect(after.find((l) => l.channel === 'email')).toMatchObject({ status: 'skipped' }); // SMTP not configured → honest status
    const s = await db('notification_schedules').where({ id }).first();
    expect(s.status).toBe('completed');
    expect(s.run_count).toBe(1);
    // appears in the inbox and can be marked read
    const inbox = await emp.get('/notifications/inbox');
    const n = inbox.body.items.find((i: any) => i.title === 'Stand-up prep');
    expect(n).toBeTruthy();
    expect((await emp.post(`/notifications/inbox/${n.id}/read`)).status).toBe(200);
    expect((await db('notification_logs').where({ id: n.id }).first()).status).toBe('read');
    expect(me).toBeGreaterThan(0);
  });

  it('recurring reminders advance to the next occurrence', async () => {
    const emp = await as('employee@orgpm.dev');
    const r = await emp.post('/notifications/schedules').send({
      title: 'Weekly review', schedule_type: 'recurring', date: '2026-01-05', time: '09:00', timezone: 'Asia/Kolkata', recurrence: { freq: 'weekly', interval: 1, by_weekday: [1] },
    });
    expect(r.status).toBe(201);
    const first = new Date(r.body.next_run_at);
    expect(first.getUTCDay()).toBe(1);
    expect(first.getUTCHours()).toBe(3);
    expect(first.getUTCMinutes()).toBe(30);
    await db('notification_schedules').where({ id: r.body.id }).update({ next_run_at: new Date(Date.now() - 1000) });
    const res = await fireSchedule(r.body.id);
    expect(res.fired).toBe(true);
    expect(res.nextRun!.getTime()).toBeGreaterThan(Date.now());
    expect(res.nextRun!.getUTCDay()).toBe(1);
    expect((await db('notification_schedules').where({ id: r.body.id }).first()).status).toBe('active');
  });

  it('pause, resume, reschedule and cancel', async () => {
    const emp = await as('employee@orgpm.dev');
    const r = await emp.post('/notifications/schedules').send({ title: 'Follow up', schedule_type: 'one_time', date: '2031-01-01', time: '13:30', timezone: 'Asia/Kolkata' });
    const id = r.body.id;
    expect((await emp.post(`/notifications/schedules/${id}/pause`)).status).toBe(200);
    expect((await fireSchedule(id)).fired).toBe(false);
    expect((await emp.post(`/notifications/schedules/${id}/resume`)).status).toBe(200);
    const re = await emp.patch(`/notifications/schedules/${id}`).send({ date: '2031-02-01', time: '16:00' });
    expect(new Date(re.body.next_run_at).toISOString()).toBe('2031-02-01T10:30:00.000Z');
    expect(await getQueues().schedules.getJob(`s-${id}-${new Date('2031-01-01T08:00:00Z').getTime()}`)).toBeFalsy(); // old job removed
    expect((await emp.post(`/notifications/schedules/${id}/cancel`).send({ reason: 'No longer needed' })).status).toBe(200);
    expect((await db('notification_schedules').where({ id }).first()).status).toBe('cancelled');
    const other = await as('aditya@orgpm.dev');
    expect((await other.post(`/notifications/schedules/${id}/pause`)).status).toBe(403);
    expect((await db('audit_logs').where({ entity_type: 'notification_schedule', entity_id: id }).pluck('action'))).toEqual(expect.arrayContaining(['notification.scheduled', 'notification.rescheduled', 'notification.cancelled']));
  });

  it('sweeper fires overdue schedules if a job was lost', async () => {
    const emp = await as('employee@orgpm.dev');
    const r = await emp.post('/notifications/schedules').send({ title: 'Lost job', schedule_type: 'one_time', date: '2032-01-01', time: '10:00', timezone: 'UTC' });
    await db('notification_schedules').where({ id: r.body.id }).update({ next_run_at: new Date(Date.now() - 120_000) });
    await sweepSchedules();
    expect((await db('notification_schedules').where({ id: r.body.id }).first()).status).toBe('completed');
  });
});

describe('delivery retries & failure alerts', () => {
  it('marks retried, then failed after max attempts and alerts admins', async () => {
    const me = await userId('employee@orgpm.dev');
    const [log] = await db('notification_logs').insert({ dedupe_key: `t:${Date.now()}`, user_id: me, channel: 'email', title: 'Retry me', body: 'x', occurrence_at: new Date() }).returning('*');
    const spy = vi.spyOn(channelHandlers, 'email').mockRejectedValue(new Error('SMTP timeout'));
    await expect(deliverLog(log.id, 1)).rejects.toThrow('SMTP timeout');
    expect((await db('notification_logs').where({ id: log.id }).first())).toMatchObject({ status: 'retried', attempts: 1 });
    await expect(deliverLog(log.id, 5)).rejects.toThrow();
    expect((await db('notification_logs').where({ id: log.id }).first())).toMatchObject({ status: 'failed', attempts: 5, last_error: 'SMTP timeout' });
    const admin = await userId('admin@orgpm.dev');
    expect(await db('notification_logs').where({ user_id: admin, category: 'system' }).where('title', 'like', 'Notification delivery failed%').first()).toBeTruthy();
    spy.mockRestore();
  });

  it('respects user channel preferences', async () => {
    const emp = await as('aditya@orgpm.dev');
    await emp.put('/notifications/preferences').send({ email: false });
    const me = await userId('aditya@orgpm.dev');
    const [log] = await db('notification_logs').insert({ dedupe_key: `p:${Date.now()}`, user_id: me, channel: 'email', title: 'Pref', body: 'x', occurrence_at: new Date() }).returning('*');
    expect(await deliverLog(log.id, 1)).toBe('skipped');
    expect((await db('notification_logs').where({ id: log.id }).first()).last_error).toMatch(/preferences/);
  });
});

describe('deadline & escalation engine', () => {
  it('marks overdue and escalates each level exactly once per deadline', async () => {
    const hod = await as('hod.it@orgpm.dev');
    const c = await hod.post('/tasks').send({ title: 'Escalate me', priority: 'high', assignee_ids: [await userId('aditya@orgpm.dev')], deadline: inHours(2) });
    const id = c.body.id;
    await db('tasks').where({ id }).update({ deadline: new Date(Date.now() - 26 * 3600_000) }); // 26h overdue
    await markOverdue();
    expect((await db('tasks').where({ id }).first()).is_overdue).toBe(true);
    await runEscalations();
    const levels = (await db('escalation_history').where({ task_id: id }).orderBy('level')).map((h) => h.level);
    expect(levels).toEqual(expect.arrayContaining([1, 2, 3])); // missed → HOD (24h) → high-priority PM rule (12h)
    expect(levels).not.toContain(4); // admin only after 7 days
    const count = levels.length;
    await runEscalations();
    expect(await db('escalation_history').where({ task_id: id }).count({ c: '*' }).first()).toMatchObject({ c: count });
    const hodId = await userId('hod.it@orgpm.dev');
    expect(await db('notification_logs').where({ user_id: hodId, category: 'escalation' }).where('title', 'like', '%Escalate me%').first()).toBeTruthy();
    // moving the deadline and missing it again re-arms escalation
    await db('tasks').where({ id }).update({ deadline: new Date(Date.now() - 3600_000) });
    await runEscalations();
    expect(Number((await db('escalation_history').where({ task_id: id }).count({ c: '*' }).first())!.c)).toBeGreaterThan(count);
  });

  it('does not escalate completed or submitted work', async () => {
    const t = await db('tasks').where({ status: 'completed' }).first();
    await runEscalations();
    const h = await db('escalation_history').where({ task_id: t.id }).where('escalated_at', '>', new Date(Date.now() - 60_000));
    expect(h).toHaveLength(0);
  });
});

describe('recurring tasks', () => {
  it('generates an instance before each occurrence without duplicates', async () => {
    const hod = await as('hod.it@orgpm.dev');
    const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    const r = await hod.post('/tasks').send({ title: 'Daily backup check', assignee_ids: [await userId('aditya@orgpm.dev')],
      recurrence: { freq: 'daily', interval: 1, time_of_day: '00:30', timezone: 'Asia/Kolkata', starts_on: tomorrow } });
    expect(r.status).toBe(201);
    expect(r.body.is_recurring_template).toBe(true);
    await generateRecurringTasks();
    await generateRecurringTasks();
    const instances = await db('tasks').where({ recurrence_parent_id: r.body.id });
    expect(instances.length).toBeGreaterThanOrEqual(1);
    expect(new Set(instances.map((i) => new Date(i.deadline).getTime())).size).toBe(instances.length);
    expect(await db('task_assignees').where({ task_id: instances[0].id }).first()).toBeTruthy();
  });
});
