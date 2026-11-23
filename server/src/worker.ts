import { checkTenantSafety, migrate } from './db/migrate';
import { logger } from './lib/logger';
import { startWorkers } from './notifications/worker';

/**
 * Dedicated background-worker process: fires scheduled reminders, delivers
 * notifications with retries, runs the escalation engine, recurring-task
 * generation and daily-report reminders. Scale horizontally — BullMQ guarantees
 * each job is processed by one worker; row locks + dedupe keys prevent duplicates.
 */
async function main() {
  await migrate();
  await checkTenantSafety();
  const workers = await startWorkers();
  const shutdown = async () => {
    logger.info('worker shutting down');
    await Promise.all(workers.map((w) => w.close()));
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { logger.error(e); process.exit(1); });
