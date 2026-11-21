# OrgPM — Enterprise Project & Organizational Management

A full-stack platform for running an organization's work in one place: departments, HODs, teams and employees;
active and **future** projects; tasks with an approval-gated workflow; daily work reports; employee and department
monitoring; a **persistent server-side notification scheduler** (any date, any time, any timezone, recurring,
deadline-relative); escalations; approvals; reports with Excel/PDF export; calendar, Gantt and resource planning;
meetings; and a complete audit trail. Responsive from phones to large monitors, light and dark themes.

| Layer | Technology |
|---|---|
| Web | React 18, TypeScript, Vite 6, Tailwind CSS 3, TanStack Query 5, React Router 7, Recharts 2, Socket.IO client |
| API | Node.js 22, Express 5, TypeScript, Zod validation, JWT access + rotating refresh tokens, Socket.IO, Swagger UI |
| Data | PostgreSQL (16–18 tested on 18), Knex query builder, forward-only SQL migrations |
| Jobs | Redis + BullMQ 5 (delayed jobs, retries with exponential backoff, job schedulers), separate worker process |
| Channels | In-app (live), Email (SMTP/Nodemailer), Browser push (Web Push/VAPID), Mobile push (FCM HTTP v1), WhatsApp (Meta Cloud API) |
| Tests | Vitest + Supertest (unit + integration), Playwright (end-to-end, desktop + mobile) |
| Deploy | Docker, docker compose (postgres, redis, api, worker, nginx web) |

Exact dependency versions are pinned in `server/package-lock.json` and `web/package-lock.json`; see [docs/VERSIONS.md](docs/VERSIONS.md).

## Repository layout

```
server/                 API + background worker (TypeScript)
  migrations/001_init.sql   complete relational schema (40+ tables, FKs, indexes, constraints, audit trigger)
  src/auth/             JWT, refresh-token rotation, RBAC permission catalogue, row-level data scoping
  src/modules/          REST routers (org, projects, future projects, tasks, daily reports, monitoring,
                        notifications, agenda, approvals, dashboard, reports, calendar/gantt/resources, meetings, audit)
  src/notifications/    scheduler service, channels, event rules, escalation engine, BullMQ queues & workers
  src/lib/recurrence.ts timezone/DST-correct recurrence engine
  tests/                Vitest unit + integration tests
web/                    React SPA (mobile-first), Playwright e2e tests in web/e2e
docs/                   architecture, ERD, notifications, KPIs, deployment, AI, progress checklist
docker-compose.yml      production-style stack
```

## Quick start (local development)

Prerequisites: Node 22+, PostgreSQL 14+, Redis 6.2+.

```bash
createdb orgpm
cd server && cp .env.example .env      # adjust DATABASE_URL / REDIS_URL / secrets
npm install
npm run seed -- --reset --demo         # migrate + roles/rules + demo organization
npm run dev                            # API on :4000 (RUN_WORKERS_IN_API=true runs the scheduler in-process)
```

```bash
cd web && npm install && npm run dev   # http://localhost:5173 (proxies /api and /socket.io to :4000)
```

Demo accounts (development seed only) all use the password defined by `DEMO_PASSWORD` in the seed (default `Password@123`):
`admin@orgpm.dev` (Super Admin), `director@orgpm.dev`, `pm@orgpm.dev`, `hod.it@orgpm.dev`, `tl.dev@orgpm.dev`,
`employee@orgpm.dev`, `viewer@orgpm.dev` (Management Viewer). Never run `--demo` against production.

API documentation (Swagger UI): http://localhost:4000/api/docs — raw spec at `/api/openapi.json`.

To run the worker as its own process (recommended in production): set `RUN_WORKERS_IN_API=false` and run `npm run worker:dev` / `npm run start:worker`.

## Tests

```bash
cd server && npm test                       # 47 unit + integration tests (needs Postgres DB "orgpm_test" + Redis)
cd web && npx playwright install chromium   # once
E2E_BASE_URL=http://localhost:5173 npx playwright test   # e2e against a running, demo-seeded stack
```

Test coverage includes authentication (refresh rotation + reuse detection, lockout), RBAC and data scoping per role,
organization CRUD, the full assign → progress → submit → revision → approve workflow, extensions, dependencies and
cycle detection, future project approval + conversion, budget approvals, daily reports, KPI reports and exports,
custom reminders (timezone conversion, exact-once firing under concurrency, recurring advance, pause/resume/reschedule/cancel,
sweeper recovery), delivery retries + failure alerts, preference handling, escalation levels firing once per deadline,
recurring task generation, audit-log immutability, recurrence/DST unit tests, and responsive layout (no horizontal overflow)
on desktop and a Pixel 7 viewport.

## Production

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): Render Blueprint (`render.yaml`) or Docker compose on Linux, TLS, backups/restore, monitoring, scaling.

## Documentation

- [Architecture & data model (ERD)](docs/ARCHITECTURE.md)
- [Notification scheduler & escalations](docs/NOTIFICATIONS.md)
- [KPI definitions](docs/KPIS.md)
- [Security](docs/SECURITY.md)
- [AI integration design](docs/AI.md)
- [Progress checklist & assumptions](docs/PROGRESS.md)
