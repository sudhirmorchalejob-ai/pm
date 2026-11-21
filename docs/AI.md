# AI-ready design

`GET /api/insights/summary` already produces a **deterministic, rule-based** management summary from live, scoped data
(overdue/blocked counts, stale reviews, delayed projects, high-impact risks, workload imbalance via load vs. capacity,
top performer by balanced score, update activity). It returns:

```json
{ "engine": "rules-v1", "summary": ["…human-readable lines…"], "signals": { "delayed_projects": [], "overloaded": [], "idle": [], "high_risks": [], "blocked": [] } }
```

## Plugging in an LLM
1. Add a provider module (e.g. `server/src/lib/ai.ts`) exposing `summarize(signals, audience): Promise<string>`.
2. In `misc.routes.ts`, after building `signals`, call the provider when `AI_PROVIDER` is configured and return its text
   alongside the rule-based lines (keep `engine` to indicate the source).
3. Natural extensions that reuse existing endpoints as structured inputs: daily management digest (scheduled job),
   department performance narrative (`/monitoring/departments/:id`), weekly report drafting (`/reports/*`),
   summarising daily reports (`/daily-reports/summary`), risk detection (`project_risks` + overdue tasks).

## Guardrails (by construction)
* The AI layer receives **read-only, already-scoped** data — it calls the same scoped queries as the requesting user.
* There is no AI code path that writes. Approvals, deadline changes, reassignments and task completion are only possible
  through the authenticated human endpoints that check permissions, forbid self-approval and write audit entries.
* Any future “suggested action” must be rendered as a proposal the user confirms in the UI, executing the normal endpoint.
