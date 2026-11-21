import { Queue } from 'bullmq';
import { config } from '../config';
import { redis } from '../lib/redis';

export const QUEUE = {
  schedules: 'orgpm-schedules',     // fires custom reminders at their exact time
  deliveries: 'orgpm-deliveries',   // one job per notification_logs row (per channel), with retries
  maintenance: 'orgpm-maintenance', // repeatable: sweep, escalations, recurring tasks
} as const;

export const DELIVERY_ATTEMPTS = 5;

let queues: { schedules: Queue; deliveries: Queue; maintenance: Queue } | null = null;

export function getQueues() {
  if (!queues) {
    const connection = redis();
    queues = {
      schedules: new Queue(QUEUE.schedules, { connection, prefix: config.QUEUE_PREFIX, defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000, attempts: 3, backoff: { type: 'exponential', delay: 5000 } } }),
      deliveries: new Queue(QUEUE.deliveries, { connection, prefix: config.QUEUE_PREFIX, defaultJobOptions: { removeOnComplete: 5000, removeOnFail: 10000, attempts: DELIVERY_ATTEMPTS, backoff: { type: 'exponential', delay: 30_000 } } }),
      maintenance: new Queue(QUEUE.maintenance, { connection, prefix: config.QUEUE_PREFIX, defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 } }),
    };
  }
  return queues;
}

/**
 * Enqueue the firing of a schedule occurrence. The job id embeds the occurrence time,
 * so re-arming the same occurrence is a no-op (duplicate prevention), while a
 * rescheduled reminder gets a new job and the stale one is ignored by the worker.
 */
export async function enqueueScheduleFire(scheduleId: number, runAt: Date) {
  const delay = Math.max(0, runAt.getTime() - Date.now());
  await getQueues().schedules.add('fire', { scheduleId, runAt: runAt.toISOString() }, { jobId: `s-${scheduleId}-${runAt.getTime()}`, delay });
}

export async function removeScheduleJob(scheduleId: number, runAt: Date | null) {
  if (!runAt) return;
  const job = await getQueues().schedules.getJob(`s-${scheduleId}-${new Date(runAt).getTime()}`);
  if (job) await job.remove().catch(() => undefined);
}

export async function enqueueDeliveries(logIds: number[]) {
  if (!logIds.length) return;
  await getQueues().deliveries.addBulk(logIds.map((id) => ({ name: 'deliver', data: { logId: id }, opts: { jobId: `d-${id}` } })));
}
