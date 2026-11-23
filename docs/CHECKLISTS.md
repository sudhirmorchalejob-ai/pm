# Daily questionnaire, checklists & EOD reports

This module covers department and employee history, the dynamic question builder, daily checklists, checklist reminders and escalations, the compliance dashboard and End-of-Day (EOD) reports. It extends the existing system: it reuses the tenant/RLS model, RBAC, notification pipeline (`notification_logs` + BullMQ deliveries), audit log, file uploads and the Excel/PDF stack.

## Migration strategy (existing data is preserved)

`server/migrations/003_questionnaire_eod.sql` only adds tables. No existing table, column or row is changed or dropped.

| Step | What happens |
|---|---|
| New tables | `department_history`, `employee_status_history`, `question_sections`, `questions`, `question_assignments`, `question_templates`, `question_template_items`, `checklists`, `checklist_items`, `checklist_answer_revisions`, `checklist_escalation_rules`, `checklist_escalations`, `eod_reports` |
| Backfill | Every existing employee gets one *current* department record (from `users.department_id/team_id`) and one status record (from `is_active/employment_status`), so history starts accurate |
| Tenancy | All 13 tables carry `organization_id DEFAULT app_current_org()` with forced row-level security, exactly like migration 002 |
| Per-organization defaults | On startup `seedBase()` adds, once per organization: the 4 starter templates, 3 checklist escalation rules, and the 5 new permissions for their default roles. Permissions an admin later removes are not re-granted; the `seeded_permission_keys` setting records what has been offered |
| Rollout | Migrations run inside a single transaction under an advisory lock, so a failed deploy leaves the database unchanged |

The Render database picks this up on the next deploy. Locally: `npm run seed -- --demo` applies it, and on the demo organization it also applies the templates to IT (Development), Data Research (Data Scrapper; a small new department with 2 employees), Marketing (Digital Marketing) and Operations (Implementation). No answers are invented.

## Permissions

| Permission | Default roles |
|---|---|
| `questions.manage`: builder, sections, templates, assignments, escalation rules | Super Admin |
| `checklists.submit`: answer own checklist | all roles except Management Viewer |
| `checklists.monitor`: compliance dashboard, submissions in scope | Super Admin, Director, HOD, Team Leader, Management Viewer |
| `eod.view`: EOD reports, limited to the viewer's scope | Super Admin, Director, PM, HOD, Team Leader, Management Viewer |
| `eod.generate`: generate on demand, set the automatic schedule | Super Admin, Director |

Data scope follows the role's existing scope:
- Organization roles see everyone.
- HODs see their department.
- Team leaders see their team (plus direct reports).
- Employees see only themselves.

Out-of-scope records return 404. EOD snapshots are stored organization-wide and filtered for each viewer when read.

## Questions

- **Answer types:** short text, long text, number (min/max/unit), date, time, yes/no, URL, URL list (each link with a publication time), single choice, multiple choice, file upload, rating 1–5 and email. Values are validated on the server per type.
- **Frequency:**
  - daily (every *n* days, optionally working days only)
  - weekly (weekdays, every *n* weeks)
  - monthly (days of the month, including "last")
  - specific dates
  - custom (every *n* days/weeks/months)
  - optional start and end dates
- **Deadline and reminders:** the deadline is a local time, applied in each employee's own timezone (DST-safe). Reminders are sent a chosen number of minutes before the deadline (up to 5 offsets).
- **Assignment:** to individual employees, several employees, departments, or all active employees. The most specific assignment wins. Deactivated employees and inactive departments are rejected.
- **Conditions:** a question can be shown only when another answer equals, doesn't equal, contains, is greater or less than a value, or is (not) answered. Cycles are rejected. Hidden questions never count as required.
- **Lifecycle:** questions can be edited, duplicated (the copy starts inactive), activated or deactivated, reordered (within and across sections) and soft-deleted. Deleting never removes submitted answers.
- **EOD tag:** each question chooses where its answer appears in the EOD report: completed work, plans, pending work, blockers, delays, progress, deadlines, campaigns, URLs, *metric* (numbers are summed per department), or other.
- **Templates** (Development, Data Scrapper, Digital Marketing, Implementation) are ordinary rows in the organization's own template tables. Admins edit them freely. Applying a template copies its questions into a new section, so they stay editable afterwards.

## Checklists

- **Generation:** a worker job runs every 5 minutes, and an employee opening *My checklist* triggers a run for them. It creates each employee's checklist for their local date.
  - `UNIQUE (user, date)` and `UNIQUE (checklist, question)` make duplicate generation impossible.
  - Questions that no longer apply are removed only while unanswered.
  - Unanswered items pick up question edits; answered items keep the snapshot they were answered against.
- **Who gets a checklist:** active employees with employment status `active` or `notice`. Employees on leave and deactivated employees are skipped. Deactivating someone removes today's checklist only if it is untouched; past checklists stay as missed records.
- **Drafts and submission:** *Save draft* stores answers without counting them. *Submit* turns drafts into answers and returns the mandatory questions still blank.
  - A checklist is **complete** when every applicable mandatory question is submitted (or, if none is mandatory, at least one answer is submitted).
  - Completion % = submitted applicable items ÷ applicable items. Lateness is measured against the deadline.
- **No accidental overwrite:** submitted answers are locked. *Revise answer* requires a reason and the revision number the employee was looking at, so a stale screen gets a 409 instead of overwriting. Every version is kept in `checklist_answer_revisions`, which a database trigger makes append-only.
- **Attachments:** supporting URLs and files can be added to any answer. File downloads are allowed for the employee and for supervisors who can see that employee.
- **Edit window:** answers can be given or revised for 7 days. Older checklists are read-only.

## Notifications & escalation

Everything goes through the existing pipeline, so channel preferences, retries and `dedupe_key` duplicate prevention apply. Deactivated employees never receive anything; this is enforced centrally in `createNotificationLogs`. Channels are set in Settings → General.

| Event | Who | Duplicate guard |
|---|---|---|
| New question(s) in a checklist (first time the employee gets that question) | employee | `cknew:<checklist>:<question ids>` |
| Reminder before deadline (per question offset), one message per checklist × deadline × offset | employee | `ckrem:…`; only sent within 30 min of the reminder time (no flood after downtime) |
| Incomplete after deadline + offset (configurable rules: employee / team leader / HOD / reporting manager / admins / directors, optional department filter) | per rule | `UNIQUE (checklist, rule)`. Supervisors get **one combined message per run** listing their people |
| EOD report generated automatically | roles in `eod_notify_roles` + HODs | `eod:<report id>` |

## Compliance dashboard

The dashboard can be filtered by date range, department, employee and status (completed, in progress, not started, overdue, late). It shows:
- Active and deactivated employees, and departments.
- Compliance today and over the last 7 days.
- Completed, pending and overdue checklists.
- A daily compliance trend and compliance by department.
- Department-wise and employee-wise tables (late, missed, last completed).
- The overdue list.

Clicking an employee opens their performance history: compliance over time, task KPIs, department and activation history, and every day's answers with revisions.

## EOD reports

- **Built from real records for one date:**
  - checklists and answers
  - tasks completed that day (organization timezone)
  - pending, overdue and blocked tasks
  - the employee's daily report
  - active project progress
- **Snapshots:** a report is stored as a JSON snapshot in `eod_reports`, so history stays exactly as generated.
  - Automatic generation runs once per working day after `eod_generation_time` (a unique index enforces once per day).
  - Every manual *Generate now* is kept as an extra version.
  - A *Live — current data* view is always available.
- **Two formats:**
  - **Consolidated:** summary, then not-submitted/incomplete people, then per department: key metrics (sum plus *n of m reported*), completed work, tasks completed, progress and deadlines, campaigns, published URLs with times, blockers and dependencies, delays, pending work, plans. Ends with project progress.
  - **Employee-wise:** each person's answers, unanswered questions (marked, mandatory flagged), completed and pending tasks, and daily report.
- **Missing information is never filled in.** Unanswered questions are listed as *not answered*. People without submissions are listed as *nothing submitted* or *partial*. A metric nobody reported shows *not reported*, never 0.
- **Output:** one-click copy (plain text), PDF and Excel. The workbook has sheets for summary, departments, employees, answers, not submitted, metrics & URLs, tasks and projects. Filters for date, department and employee apply to every format.

## Audit trail

`audit_logs` records:
- `question.*` (created, updated, assigned, activated, deactivated, duplicated, deleted, reordered) and `question_section.*` / `question_template.*`
- `checklist.answers_submitted` and `checklist.answer_revised` (before and after text, plus reason)
- `checklist.escalated`
- `user.deactivated` / `user.activated` (with reason) and `user.department_transferred`
- `eod.generated`, `eod.exported` and `eod.settings_updated`

Department and activation history are also stored in their own tables and shown on the employee, department and history screens.
