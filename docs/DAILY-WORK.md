# My Daily Work & Activities, companies and team setup

This page covers personal daily work tracking: quick activities, personal tasks, the personal EOD report and coordination history. It is designed for a person who is both a head of department (HOD) and an individual contributor. It also covers companies (business entities), additional designations and the one-time team setup.

Everything here is part of the existing application. It reuses the tenant/RLS model, RBAC, the notification pipeline, file uploads, the audit log and the company EOD report.

## Migration strategy (existing data is preserved)

`server/migrations/004_daily_work.sql` only adds tables and one column. Nothing existing is changed or dropped.

| Step | What happens |
|---|---|
| New tables | `companies`, `user_designations`, `activity_categories`, `activities`, `activity_participants`, `activity_revisions`, `personal_task_series`, `personal_tasks`, `personal_eod_reports` |
| New column | `users.company_id` (nullable) |
| Tenancy | Every new table has `organization_id DEFAULT app_current_org()` with forced row-level security, like migrations 002 and 003 |
| Per-organization defaults | On startup `seedBase()` adds the 20 built-in quick categories that an organization does not have yet (matched by key or name). It also grants the two new permissions once to their default roles; permissions an admin removes later are not re-granted |
| Rollout | The migration runs in one transaction under an advisory lock |

The Render database gets this on the next deploy.

## Initial team structure (administrative setup, not hard-coded)

The starter records from the requirements are kept as data in `server/setup/starter-team.json`:
- 2 companies
- 5 departments, each with Sudhir as HOD and the matching checklist template
- 11 employees (Sudhir: Super Admin with three designations; everyone else: Employee, reporting to Sudhir; Renuka and Rohini each assigned to their company)

To apply them, go to **Organization → Team setup**. You need both *users.manage* and *org.manage*.
1. Every record is editable before applying: names, emails, departments, companies, roles, designations, HODs and templates.
2. Enter an email domain to fill blank emails (e.g. `neha@yourdomain.com`). Optionally enter one temporary password; if left blank, a password is generated per person and shown once.
3. **Preview** shows exactly what will be created, updated, kept or skipped, and why.
4. **Apply** writes it in the request transaction and records an audit entry. New accounts must change their password at first sign-in.

It is idempotent:
- Companies, departments and designations are matched by name; employees by email, then by exact name.
- Existing records are kept. For existing employees, only empty fields are filled (department, company, primary designation, manager) and missing designations are added.
- A name that matches several employees is skipped with an explanation rather than guessed.
- Re-applying creates nothing new.

After setup, everything is edited in the normal screens:
- **Companies:** Organization → Companies.
- **Employees:** company and additional designations in the employee form.
- **Departments:** department HODs.

## Permissions

| Permission | Default roles |
|---|---|
| `activities.log`: own activities, personal tasks, personal EOD report | every role except Management Viewer |
| `activities.view_team`: activities and coordination history of people in scope | Super Admin, Director, HOD, Team Leader, Management Viewer |

Quick categories are managed with `settings.manage` (Settings → Activity categories). Companies use `org.manage`.

Visibility:
- A person always sees their own activities.
- Others' activities need `activities.view_team`, and the performer must be inside the viewer's data scope.
- Only the author can edit or delete an activity.
- An employee does not see the notes a supervisor recorded about them unless they have team visibility. This is a management log, not a performance score.

## Quick activity entry

**+ Add Daily Activity** is the first thing on the dashboard. On phones it is also a floating button above the bottom navigation. It opens a bottom sheet where only two things are required: a **category** (one tap) and **what you did**. Everything else is optional:
- **Employees:** a searchable picker over active employees, loaded from the database. Select one, several, none, or **whole departments** (their active members are recorded as participants "via department").
- **Project:** any project the person can see.
- **Status:** completed (default), in progress or pending.
- **Time:** defaults to *now*; can be backdated, never set after today.
- **Duration:** one tap.
- **Follow-up:** note and due date.
- **Issue resolved?** Shown for guidance, issue and review categories.
- **Bugs found:** shown for testing categories.
- **Attachments.**

Entries save immediately. *Save & add another* keeps the category, and Ctrl+Enter saves. Each person's most-used categories (last 60 days) come first, and all categories are a tap away, grouped. Admins can add, rename, regroup, reorder, re-map and deactivate categories. Categories in use are deactivated rather than deleted.

**Revision history:** every edit increments `revision` and writes the previous state to `activity_revisions`. That table is append-only (a database trigger rejects updates and deletes). Edits carry `expected_revision`, so a stale screen gets a 409 instead of overwriting. Deleting is a soft delete with its own revision entry and optional reason.

## Personal tasks

- **One-off tasks:** priority, due date and optional time, a reminder (minutes before the due time, or an exact time), optional project, description, and complete/reopen with a completion note.
- **Repeating tasks:** a series (`personal_task_series`) with daily, working-day, weekly, monthly, specific-date or custom frequency. This reuses the questionnaire's DST-safe frequency rules.
  - A worker job (every 5 minutes, and whenever the person opens their day) creates **one row per occurrence**, with `UNIQUE (series_id, due_date)`.
  - Every occurrence has its own status; nothing is completed automatically.
  - Pausing or deleting a series stops future occurrences and keeps past ones.
- **Reminders:** sent in-app and by browser push when the reminder time has passed within the last 30 minutes (no flood after downtime). They go through the existing notification pipeline with a dedupe key, so each reminder is sent once.

## Dashboard (home screen)

| Block | Who |
|---|---|
| My Daily Work & Activities, with a prominent **Add Daily Activity** button | `activities.log` |
| My daily tasks (overdue, today, undated; one-tap complete) | `activities.log` |
| My reminders (personal task reminders, scheduled reminders I receive, my checklist deadline; next 24 h) | `activities.log` |
| My activity timeline (today) | `activities.log` |
| My EOD report (status and link) | `activities.log` |
| Today's team updates (checklist submissions, daily reports, colleagues' activities) | `checklists.monitor` or `activities.view_team`, in scope |
| Pending employee checklists (today, with mandatory items left and overdue flag) | `checklists.monitor`, in scope |
| Department progress (today's checklist completion, open / overdue / completed-today tasks) | supervisors, in scope |

The full page is **My daily work** (`/my-work`), with these tabs:
- **Today:** timeline with edit, delete and history; tasks; reminders; open follow-ups.
- **My tasks:** search, status filters, repeating tasks.
- **EOD report.**
- **Coordination.**
- **History:** date range, category, employee and text filters.
- **Past reports.**

## Personal EOD report

The report is generated only from what the person recorded:
- that day's activities
- personal tasks completed that day, plus tasks completed in the task system
- pending activities, open follow-ups and pending personal tasks
- the daily checklist status
- the **next day's priorities** they type (tasks already scheduled for tomorrow are added and marked *scheduled*)

Empty sections are left out; nothing is inferred.

Sections, in order:
1. Team coordination completed
2. Employee updates collected
3. Tasks assigned
4. Technical guidance provided
5. Employees assisted (with counts)
6. Issues resolved
7. Projects tested
8. Bugs identified
9. Missing functionality
10. Improvements
11. Reviews
12. Client meetings
13. Client requirements & coordination
14. Development activities completed
15. Follow-ups completed
16. Other
17. Personal / assigned tasks completed
18. Pending activities
19. Next day's priorities

Workflow:
1. **Generate.** Creates a draft from the entries.
2. **Edit.** The text is editable, and saving is protected by a revision number.
3. **Finalize.** If new entries were recorded after generating, a notice offers to regenerate.
4. **Reopen** if needed.
5. **Copy.** Plain text, or *Copy for Bitrix24* (BBCode: bold headings and `[LIST]` bullets).

In the **company EOD report**, each employee's activities appear in the employee-wise view and in a "Daily activities & coordination" section per department. A **finalized** personal report is included in full; a draft is only flagged. The HOD is always included in employee-wise reporting, like everyone else. Excel exports gain *Activities* and *Companies* sheets.

## Coordination history

Every employee selected on an activity is stored in `activity_participants`. The history is visible from both sides:
- **The performer** (*My daily work → Coordination*) sees per-employee counts: entries (direct vs. via department), coordination, guidance, open follow-ups, resolved/unresolved issues, and the last contact. Clicking an employee opens the full list, where follow-ups can be closed and issues marked resolved (each is a new revision).
- **The employee's profile** (*Employee monitoring → employee → Daily work & coordination*) shows the entries involving them that the viewer may see, and the activities they recorded themselves.

## Companies (business entities)

Organization → **Companies**: create, rename and deactivate companies, and see active employee counts. Each employee can belong to one company (employee form). There are company filters on:
- the employee list
- the compliance dashboard (overview and by day)
- the EOD report, which also shows a per-company breakdown

## Audit trail

`audit_logs` records:
- `activity.created`, `activity.updated`, `activity.follow_up_updated` and `activity.deleted`
- `activity_category.*`
- `personal_task.*`, including the `series_*` actions
- `personal_eod.generated`, `.saved`, `.finalized` and `.reopened`
- `company.*`
- `org.team_structure_applied`, with the full plan
