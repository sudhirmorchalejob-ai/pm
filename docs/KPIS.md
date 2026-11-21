# KPI definitions

All completion metrics count only tasks **approved by an authorised reviewer** (`status = completed`, `completed_at`
set by the review endpoint). Recurring-task templates and deleted tasks are excluded. Window = selected date range.
Implementation: `server/src/lib/kpi.ts`, `server/src/modules/reports.routes.ts`.

| KPI | Definition |
|---|---|
| Assigned | tasks the person is assigned to that were created or due in the window |
| Completed | approved tasks with `completed_at` in the window |
| On-time | completed where `completed_at ≤ deadline` (or no deadline) |
| On-time rate | on-time ÷ completed |
| Open | assigned tasks not completed/cancelled (current) |
| Overdue (open) | open tasks whose deadline has passed |
| Revision rate | tasks sent back at least once ÷ tasks reviewed in the window |
| Avg quality | mean reviewer quality rating (1–5) on completed tasks |
| Weighted output | Σ complexity (1–5) of completed tasks — rewards difficult work, not task count |
| Estimate accuracy | Σ estimated hours ÷ Σ actual hours on completed tasks (1.0 = perfect) |
| Hours logged | Σ time entries in the window |
| Open estimated hours | Σ max(estimate − actual, 0) over open tasks (remaining effort) |
| **Performance score** | 0–100 = 35% on-time rate + 25% (quality ÷ 5, default 3 if unrated) + 20% (1 − revision rate) + 20% throughput, where throughput = weighted output ÷ median weighted output of the people in the report (capped at 1). Not shown when nothing was completed. |
| Utilisation (resources) | (remaining effort due within 7 days + ¼ of later remaining effort, default 4 h per unestimated task) ÷ weekly capacity; overloaded above the configurable threshold (default 110%) or project allocation > 100% |
| Project progress | Σ estimated hours of completed tasks ÷ Σ estimated hours of non-cancelled top-level tasks (1 h for unestimated) |
| Department productivity | completed in window ÷ active employees |
| Daily-report compliance | reports submitted ÷ working days elapsed in the period |

The score is a conversation starter for managers, not an automatic judgement; it is always shown next to its components.
