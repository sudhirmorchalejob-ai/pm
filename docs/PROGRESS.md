# Progress checklist, verification status & assumptions

Status as of 2026-11-21. ✅ implemented and verified by automated tests and/or a live run · ☑️ implemented, verified
manually in the running app · ⚠️ implemented, not verifiable here (needs external credentials/infrastructure) · ❌ not done.

## Delivery steps
| Step | Status |
|---|---|
| 1. Inspect repository (was empty) | ✅ |
| 2. Architecture + PostgreSQL schema + migrations | ✅ `server/migrations/001_init.sql`, docs/ARCHITECTURE.md |
| 3. Design system + responsive shell (sidebar / rail / bottom nav, light/dark) | ✅ e2e overflow checks desktop + Pixel 7; all 21 routes checked at 375 px |
| 4. Authentication + RBAC (7 roles, 37 permissions, 5 data scopes) | ✅ |
| 5. Organization (departments, teams, employees, designations, skills, hierarchy history, exit status) | ✅ |
| 6. Projects (all fields/statuses/tabs) + future project planning (readiness, approval, calendar, pipeline, roadmap, forecast, one-click conversion) | ✅ |
| 7. Tasks (assign/reassign, multi-assignee, subtasks, checklists, comments + mentions, files, dependencies, history, recurring, extensions, time tracking) + daily reports | ✅ |
| 8. Employee & HOD/department monitoring with balanced KPIs | ✅ |
| 9. Persistent notification scheduler (BullMQ + Redis + PostgreSQL) | ✅ incl. live run: reminder fired on time; reminder due during server downtime delivered after restart |
| 10. Escalations, approvals (task + project-level), reports & Excel/PDF exports | ✅ |
| 11. Calendar (day/week/month), Gantt with dependencies, resource planning | ✅ / ☑️ |
| 12. Tests | ✅ 47 Vitest unit/integration tests, 4 Playwright e2e tests (desktop + mobile) — all passing |
| 13. Production deployment (Dockerfiles, compose, nginx, env examples, backup/restore, monitoring docs) | ⚠️ written; Docker was not available on this machine, so images were not built here. The same production builds (`npm run build` for server and web) were run successfully. |

## Notification channels
| Channel | Status |
|---|---|
| In-app (notification centre + live Socket.IO toasts) | ✅ |
| Email (SMTP) | ⚠️ implemented; without `SMTP_HOST` deliveries are logged as *skipped* (verified). Retry/backoff/failure-alert path verified with a simulated SMTP failure. |
| Browser push (Web Push + service worker) | ⚠️ implemented; needs VAPID keys (`npx web-push generate-vapid-keys`) and HTTPS (or localhost) |
| Mobile push (FCM HTTP v1) | ⚠️ implemented server-side + device registration endpoint; requires a Firebase project and a native/mobile wrapper app that registers tokens (not part of this repo) |
| WhatsApp (Meta Cloud API) | ⚠️ implemented; requires a WhatsApp Business number, access token and approved template |

## Known limitations / follow-ups
* Quiet hours: columns exist in `user_notification_preferences` but are not yet enforced or exposed in the UI.
* Gantt and calendar are read-only views (no drag-to-reschedule); rescheduling happens on the task/project forms.
* OpenAPI document is generated from the mounted routes (all endpoints listed, auth + error responses), but request
  bodies are documented generically; exact schemas live in the zod validators of each module.
* The AI layer is a deterministic rule engine with a documented provider hook (docs/AI.md); no LLM is called.
* `npm audit --omit=dev`: web 0 findings; server 3 moderate findings, all the transitive `uuid` advisory via BullMQ/ExcelJS
  (affects only `uuid` v3/v5/v6 with a caller-supplied buffer, which is not used).

## Assumptions made
* One role per user; data scope is a property of the role (configurable permissions, fixed scope levels).
* A task counts as completed only when a reviewer approves it; progress is capped at 99% until then.
* HODs and Team Leaders can assign only within their department/team; Project Managers can assign across departments
  for their projects; Directors and Super Admins anywhere.
* Default organization timezone `Asia/Kolkata`, working days Mon–Fri, currency display INR (formatting only).
* Default reminder policy on task completion/cancellation: cancel pending reminders (configurable).
* Recurring tasks: the recurrence time is the instance deadline; instances are generated 24 h ahead.
* Agenda reminders for recurring items fire at each occurrence (the "minutes before" offset applies to one-time items).
* Escalation rules created later do not retro-fire for triggers more than 7 days old.
