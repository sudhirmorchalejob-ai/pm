# Notification scheduler, event rules & escalations

## Custom reminders (`notification_schedules`)

Created from **Reminders → New reminder**, a task page, or the agenda. Fields: title, description, custom message,
related task / project / department, local **date + time + IANA timezone**, recipients, channels, recurrence,
end date / max occurrences, active/paused.

| Type | Meaning | Example |
|---|---|---|
| `one_time` | fires once at a local date/time | “Remind me at 13:30 to follow up with the HOD” |
| `recurring` | minutely/hourly/daily/weekly/monthly/yearly with interval, weekdays, day-of-month, end date, max count | “Every Monday 10:00 review future projects” |
| `deadline_offset` | N minutes before a task's deadline; re-armed automatically when the deadline changes | “30 minutes before the deadline” |

Multiple reminders per task are supported. Times are stored as UTC instants computed from the local wall-clock time
(`server/src/lib/recurrence.ts`); recurring series keep the same local time across DST changes, non-existent local
times (spring-forward gap) shift forward, day 31 clamps to month end, Feb 29 → Feb 28.

### Execution path
1. API validates, computes `next_run_at`, stores the schedule (PostgreSQL) and enqueues a BullMQ **delayed job**
   with id `s-<scheduleId>-<epochMs>` (re-adding the same occurrence is a no-op).
2. At the due time a worker runs `fireSchedule`: `SELECT … FOR UPDATE` on the schedule, ignores stale jobs (rescheduled,
   paused, cancelled), inserts one `notification_logs` row per recipient × channel with a unique `dedupe_key`
   (`sch:<id>:<occurrence>:<user>:<channel>`), advances `next_run_at` (missed occurrences during downtime are skipped,
   not flooded) and enqueues the next occurrence.
3. Each log row becomes a `deliveries` job: 5 attempts, exponential backoff from 30 s. Status moves
   `scheduled → sent/delivered` or `retried → failed`; permanent provider rejections fail immediately. Final failures
   raise an in-app **failure alert** to Super Admins. Admins can retry failed deliveries from the delivery log.
4. **Sweeper** (every minute): fires active schedules whose time passed (e.g. Redis lost or worker down), re-arms jobs due
   within 15 minutes, re-queues stuck deliveries.

Because all of this happens on the server, reminders are delivered when the user is logged out, the browser is closed
or the computer is off. (Verified: a reminder due while the server was stopped was delivered seconds after restart.)

Cancelling, pausing, resuming and rescheduling are audited (`notification.*` actions). Users may only change their own
reminders (or anyone's with `notifications.rules.manage`). Recipients other than yourself require
`notifications.schedule_others` and must be inside your data scope.

**Task completion/cancellation policy** (Settings → General): `cancel` (default) cancels active reminders of the task
and marks undelivered logs `cancelled`; `keep` leaves them running.

## Channels

| Channel | Implementation | Required configuration | “Delivered” tracking |
|---|---|---|---|
| In-app | DB row + Socket.IO push + notification centre | none | delivered on write; `read` when opened |
| Email | Nodemailer SMTP | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | `sent` (provider message id stored) |
| Browser push | Web Push (VAPID) + `web/public/sw.js` | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; user enables push per device (Profile/Notifications → Preferences) | `sent` when the push service accepts; expired subscriptions are pruned |
| Mobile push | Firebase Cloud Messaging HTTP v1 (service-account JWT → OAuth token) | `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON`; native app registers tokens via `POST /api/notifications/devices` | `sent` |
| WhatsApp | Meta WhatsApp Cloud API (`/{phone_number_id}/messages`) | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, approved `WHATSAPP_TEMPLATE_NAME` (+ language); user opts in with a number | `sent` (message id stored) |

An unconfigured channel is never faked: deliveries are logged as **skipped** with the reason (“Email channel not configured
(SMTP_HOST)”). The UI warns when a selected channel is not configured. User preferences can disable channels; escalation
and system alerts are always recorded in-app.

## Event-triggered rules (`notification_rules`)

Admin-editable (Settings → Notification rules): event type, recipient roles (assignee, assigner, HOD, team leader,
project manager, admin, director, mentioned, requester, attendees), channels, priority/department/project filters and
`{{template}}` title/body. Events: task assigned/submitted/approved/revision/rejected/blocked/deadline changed/comment &
mentions/extension requested & decided, project status changed/converted, approval requested/decided, daily report reviewed,
meeting scheduled. The acting user is never notified of their own action.

## Deadline & escalation engine (`escalation_rules`)

Runs every minute in the worker. Each rule has a level, an offset relative to the deadline (negative = before, 0 = at,
positive = overdue by), recipient roles, channels and optional priority/department/project/task-type filters.
Seeded defaults:

| Level | Trigger | Notifies |
|---|---|---|
| 1 | 24 h and 1 h before deadline | assignee |
| 1 | deadline missed (task flagged overdue) | assignee, assigner |
| 2 | 24 h overdue | HOD, team leader |
| 3 | 12 h overdue for high/critical | project manager |
| 3 | 72 h overdue | project manager, HOD |
| 4 | 7 days overdue | admin, director |

`escalation_history` has a unique key (task, rule, deadline snapshot): each level fires exactly once per deadline, and again
if the deadline is moved and missed again. Submitted / under-review / completed / cancelled tasks are not escalated.
Rules created later do not retro-fire for triggers older than 7 days.

## Other scheduled jobs
* Recurring tasks: a template spawns an instance 24 h before each occurrence (unique per occurrence).
* Daily report reminder: at the configured local time on working days, nudges people in the configured roles who have not submitted.
