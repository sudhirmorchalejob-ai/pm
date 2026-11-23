import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { MulterError } from 'multer';
import { config } from './config';
import { db } from './db/knex';
import { authenticate } from './auth/middleware';
import { HttpError } from './lib/errors';
import { logger } from './lib/logger';
import { buildOpenApi, registerMount } from './openapi';
import { router as auth } from './modules/auth.routes';
import { router as org } from './modules/org.routes';
import { router as projects } from './modules/projects.routes';
import { router as future } from './modules/future.routes';
import { router as tasks } from './modules/tasks.routes';
import { router as dailyReports } from './modules/daily-reports.routes';
import { router as monitoring } from './modules/monitoring.routes';
import { router as notifications } from './modules/notifications.routes';
import { router as agenda } from './modules/agenda.routes';
import { router as approvals } from './modules/approvals.routes';
import { router as dashboard } from './modules/dashboard.routes';
import { router as reports } from './modules/reports.routes';
import { router as planning } from './modules/planning.routes';
import { router as misc } from './modules/misc.routes';
import { router as files } from './modules/files';
import { router as questions } from './modules/questions.routes';
import { router as checklists } from './modules/checklists.routes';
import { router as eod } from './modules/eod.routes';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
  const origins = config.CORS_ORIGINS.split(',').map((s) => s.trim());
  app.use(cors({ origin: (o, cb) => cb(null, !o || origins.includes(o)), credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  if (config.NODE_ENV !== 'test') app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: config.NODE_ENV === 'test' ? 100000 : 600, standardHeaders: 'draft-7', legacyHeaders: false }));

  app.get('/api/health', async (_req, res) => {
    let dbOk = false;
    try { await db.raw('select 1'); dbOk = true; } catch { /* reported below */ }
    res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'degraded', db: dbOk, time: new Date().toISOString() });
  });

  const mount = (prefix: string, router: express.Router, tag: string, auth = true) => {
    registerMount(prefix, router, tag, auth);
    if (auth) app.use(prefix, authenticate, router);
    else app.use(prefix, router);
  };
  mount('/api/auth', auth, 'Auth', false);
  mount('/api/org', org, 'Organization');
  mount('/api/projects', projects, 'Projects');
  mount('/api/future-projects', future, 'Future projects');
  mount('/api/tasks', tasks, 'Tasks');
  mount('/api/daily-reports', dailyReports, 'Daily reports');
  mount('/api/monitoring', monitoring, 'Monitoring');
  mount('/api/notifications', notifications, 'Notifications');
  mount('/api/agenda', agenda, 'Agenda');
  mount('/api/approvals', approvals, 'Approvals');
  mount('/api/dashboard', dashboard, 'Dashboard');
  mount('/api/reports', reports, 'Reports');
  mount('/api/files', files, 'Files');
  mount('/api/questions', questions, 'Question builder');
  mount('/api/checklists', checklists, 'Daily checklists');
  mount('/api/eod', eod, 'EOD reports');
  mount('/api', planning, 'Planning');
  mount('/api', misc, 'Misc');

  const spec = buildOpenApi();
  app.get('/api/openapi.json', (_req, res) => res.json(spec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'OrgPM API' }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err instanceof MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${config.MAX_UPLOAD_MB} MB)` : err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
    if (err?.code === '23505') return res.status(409).json({ error: 'Duplicate value violates a unique constraint', details: err.detail });
    if (err?.code === '23503') return res.status(400).json({ error: 'Referenced record does not exist', details: err.detail });
    if (err?.code === '23514') return res.status(400).json({ error: 'Value violates a data constraint', details: err.constraint });
    logger.error({ err, url: req.url }, 'unhandled error');
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
