# OrgPM — Enterprise Project & Organizational Management

A multi-tenant full-stack platform — any number of organizations register from the sign-in page and get isolated
workspaces (PostgreSQL row-level security) — for running an organization's work in one place: departments, HODs, teams and employees;
active and **future** projects; tasks with an approval-gated workflow; daily work reports; employee and department
monitoring; a **dynamic daily questionnaire** (question builder, department templates, automated checklists with revisions, compliance dashboard and automatic **End-of-Day reports**); **My Daily Work & Activities** (few-second quick activity entry from the dashboard or phone, personal and repeating tasks, coordination history, an editable personal EOD report to paste into Bitrix24); companies (business entities) with company-wise reporting; a **persistent server-side notification scheduler** (any date, any time, any timezone, recurring,
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

The app must connect as a **non-superuser** role (superusers bypass the row-level security that isolates tenants):

```bash
psql -U postgres -c "CREATE ROLE orgpm_app LOGIN" -c "CREATE DATABASE orgpm OWNER orgpm_app" -c "CREATE DATABASE orgpm_test OWNER orgpm_app"
cd server && cp .env.example .env      # DATABASE_URL=postgres://orgpm_app@localhost:5432/orgpm, REDIS_URL, secrets
npm install
npm run seed -- --reset --demo         # migrate + roles/rules + demo organization (tenant #1)
npm run dev                            # API on :4000 (RUN_WORKERS_IN_API=true runs the scheduler in-process)
```

```bash
cd web && npm install && npm run dev   # http://localhost:5173 (proxies /api and /socket.io to :4000)
```

Use **Register organization** on the sign-in page to create a new, empty tenant. Demo accounts (development seed only, all in the demo tenant) all use the password defined by `DEMO_PASSWORD` in the seed (default `Password@123`):
`admin@orgpm.dev` (Super Admin), `director@orgpm.dev`, `pm@orgpm.dev`, `hod.it@orgpm.dev`, `tl.dev@orgpm.dev`,
`employee@orgpm.dev`, `viewer@orgpm.dev` (Management Viewer). Never run `--demo` against production.

API documentation (Swagger UI): http://localhost:4000/api/docs — raw spec at `/api/openapi.json`.

To run the worker as its own process (recommended in production): set `RUN_WORKERS_IN_API=false` and run `npm run worker:dev` / `npm run start:worker`.

## Tests

```bash
cd server && npm test                       # 88 unit + integration tests (needs DB "orgpm_test" owned by orgpm_app + Redis)
cd web && npx playwright install chromium   # once
E2E_BASE_URL=http://localhost:5173 npx playwright test   # e2e against a running, demo-seeded stack
```

Test coverage includes daily work (idempotent team setup with preview, quick activities with department participants, append-only activity revisions and stale-edit protection, coordination history visibility, recurring personal tasks with per-occurrence status, reminders sent once, personal EOD generated only from entries then finalized, company filters in the EOD report), the questionnaire (frequency/DST rules, answer validation, conditional questions, idempotent checklist generation, drafts/submission, append-only revisions with stale-edit protection, scoped monitoring, one-time reminders and escalations, EOD consolidation/exports, automatic EOD once per day, department transfers and deactivation), organization registration and cross-tenant isolation (data, settings, permission matrix, dashboards), authentication (refresh rotation + reuse detection, lockout), RBAC and data scoping per role,
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
- [Daily questionnaire, checklists & EOD reports](docs/CHECKLISTS.md) — incl. the data-preserving migration strategy
- [My Daily Work & Activities, companies & team setup](docs/DAILY-WORK.md) — incl. migration 004
- [Notification scheduler & escalations](docs/NOTIFICATIONS.md)
- [KPI definitions](docs/KPIS.md)
- [Security](docs/SECURITY.md)
- [AI integration design](docs/AI.md)
- [Progress checklist & assumptions](docs/PROGRESS.md)
