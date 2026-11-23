import http from 'http';
import path from 'path';
import fs from 'fs';
import express from 'express';
import { createApp } from './app';
import { config } from './config';
import { checkTenantSafety, migrate } from './db/migrate';
import { seedBase } from './db/seed';
import { logger } from './lib/logger';
import { attachRealtime } from './lib/realtime';
import { startWorkers } from './notifications/worker';

async function main() {
  await migrate();
  await checkTenantSafety();
  // Idempotent: ensures roles/permissions/default rules exist and bootstraps the first
  // Super Admin from ADMIN_EMAIL / ADMIN_PASSWORD when the users table is empty.
  if (process.env.SEED_BASE_ON_START !== 'false') await seedBase();
  const app = createApp();
  // Optionally serve the built SPA from the same origin (single-container deployments).
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (process.env.SERVE_WEB === 'true' && fs.existsSync(webDist)) {
    app.use(express.static(webDist, { maxAge: '1h', index: false }));
    app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }
  const server = http.createServer(app);
  attachRealtime(server);
  if (config.RUN_WORKERS_IN_API) await startWorkers();
  server.listen(config.PORT, () => logger.info(`API listening on :${config.PORT}`));
  const shutdown = () => { logger.info('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { logger.error(e); process.exit(1); });
