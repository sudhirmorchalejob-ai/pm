import { Knex } from 'knex';
import { db } from '../db/knex';

/**
 * KPI definitions (documented in docs/KPIS.md). All completion-based metrics count only
 * tasks that were APPROVED (status = completed, completed_at set by a reviewer).
 *
 *  assigned          tasks (non-template, not deleted) the person is assigned to, created or due in the window
 *  completed         approved tasks with completed_at in the window
 *  on_time           completed where completed_at <= deadline (or no deadline)
 *  on_time_rate      on_time / completed
 *  overdue_open      open tasks currently past deadline
 *  revision_rate     tasks with ≥1 revision / tasks reviewed in window
 *  avg_quality       mean reviewer quality rating (1–5) on completed tasks
 *  weighted_output   Σ complexity(1–5) of completed tasks — rewards hard work over raw counts
 *  estimate_accuracy Σ estimated / Σ actual hours on completed tasks (1.0 = perfect)
 *  performance_score 0–100 composite = 35% on-time rate + 25% quality + 20% (1 − revision rate)
 *                    + 20% throughput (weighted output vs. team median, capped at 100%)
 */
export interface KpiFilter { from: string; to: string; userIds?: number[] | null; departmentId?: number; projectId?: number; includeInactive?: boolean }

export async function userKpis(f: KpiFilter) {
  const base = db('users as u').whereNull('u.deleted_at');
  if (!f.includeInactive) base.where('u.is_active', true);
  if (f.userIds) base.whereIn('u.id', f.userIds);
  if (f.departmentId) base.where('u.department_id', f.departmentId);
  const proj = f.projectId ? 'AND t.project_id = ' + Number(f.projectId) : '';
  const rows = await base.leftJoin('departments as d', 'd.id', 'u.department_id').select('u.id', 'u.name', 'u.employee_code', 'd.name as department_name', 'u.capacity_hours_per_week',
    db.raw(`(SELECT json_build_object(
        'assigned', count(*) FILTER (WHERE t.created_at::date BETWEEN :from AND :to OR t.deadline::date BETWEEN :from AND :to),
        'completed', count(*) FILTER (WHERE t.status = 'completed' AND t.completed_at::date BETWEEN :from AND :to),
        'on_time', count(*) FILTER (WHERE t.status = 'completed' AND t.completed_at::date BETWEEN :from AND :to AND (t.deadline IS NULL OR t.completed_at <= t.deadline)),
        'overdue_open', count(*) FILTER (WHERE t.is_overdue AND t.status NOT IN ('completed','cancelled')),
        'open', count(*) FILTER (WHERE t.status NOT IN ('completed','cancelled')),
        'in_progress', count(*) FILTER (WHERE t.status = 'in_progress'),
        'submitted', count(*) FILTER (WHERE t.status IN ('submitted','under_review')),
        'revised', count(*) FILTER (WHERE t.revision_count > 0 AND t.updated_at::date BETWEEN :from AND :to),
        'reviewed', count(*) FILTER (WHERE (t.status = 'completed' AND t.completed_at::date BETWEEN :from AND :to) OR (t.revision_count > 0 AND t.updated_at::date BETWEEN :from AND :to)),
        'avg_quality', avg(t.quality_rating) FILTER (WHERE t.status = 'completed' AND t.completed_at::date BETWEEN :from AND :to),
        'weighted_output', coalesce(sum(t.complexity) FILTER (WHERE t.status = 'completed' AND t.completed_at::date BETWEEN :from AND :to), 0),
        'est_hours', coalesce(sum(t.estimated_hours) FILTER (WHERE t.status = 'completed' AND t.completed_at::date BETWEEN :from AND :to), 0),
        'act_hours', coalesce(sum(t.actual_hours) FILTER (WHERE t.status = 'completed' AND t.completed_at::date BETWEEN :from AND :to), 0),
        'open_estimated_hours', coalesce(sum(greatest(coalesce(t.estimated_hours,0) - t.actual_hours, 0)) FILTER (WHERE t.status NOT IN ('completed','cancelled')), 0)
      ) FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id
      WHERE ta.user_id = u.id AND t.deleted_at IS NULL AND NOT t.is_recurring_template ${proj}) AS k`, { from: f.from, to: f.to }),
    db.raw(`(SELECT coalesce(sum(hours),0) FROM time_entries te WHERE te.user_id = u.id AND te.entry_date BETWEEN :from AND :to)::float AS hours_logged`, { from: f.from, to: f.to }))
    .orderBy('u.name');
  const outputs = rows.map((r: any) => Number(r.k.weighted_output)).filter((n: number) => n > 0).sort((a: number, b: number) => a - b);
  const median = outputs.length ? outputs[Math.floor(outputs.length / 2)] : 0;
  return rows.map((r: any) => computeScores(r, median));
}

function computeScores(r: any, median: number) {
  const k = r.k;
  const completed = Number(k.completed);
  const onTimeRate = completed ? Number(k.on_time) / completed : null;
  const revisionRate = Number(k.reviewed) ? Number(k.revised) / Number(k.reviewed) : null;
  const quality = k.avg_quality == null ? null : Number(k.avg_quality);
  const throughput = median ? Math.min(1, Number(k.weighted_output) / median) : completed ? 1 : 0;
  const score = completed
    ? Math.round(100 * (0.35 * (onTimeRate ?? 0) + 0.25 * ((quality ?? 3) / 5) + 0.2 * (1 - (revisionRate ?? 0)) + 0.2 * throughput))
    : null;
  return {
    id: r.id, name: r.name, employee_code: r.employee_code, department_name: r.department_name,
    assigned: Number(k.assigned), completed, on_time: Number(k.on_time), on_time_rate: pct(onTimeRate),
    overdue_open: Number(k.overdue_open), open: Number(k.open), in_progress: Number(k.in_progress), submitted: Number(k.submitted),
    revision_rate: pct(revisionRate), avg_quality: quality == null ? null : Math.round(quality * 10) / 10,
    weighted_output: Number(k.weighted_output), estimate_accuracy: Number(k.act_hours) ? Math.round((Number(k.est_hours) / Number(k.act_hours)) * 100) / 100 : null,
    hours_logged: r.hours_logged, open_estimated_hours: Number(k.open_estimated_hours), capacity_hours_per_week: Number(r.capacity_hours_per_week),
    performance_score: score,
  };
}

const pct = (v: number | null) => (v == null ? null : Math.round(v * 100));

export async function taskTotals(q: Knex.QueryBuilder) {
  return q.first(
    db.raw('count(*)::int AS total'),
    db.raw(`count(*) FILTER (WHERE t.status = 'completed')::int AS completed`),
    db.raw(`count(*) FILTER (WHERE t.status NOT IN ('completed','cancelled'))::int AS open`),
    db.raw(`count(*) FILTER (WHERE t.is_overdue AND t.status NOT IN ('completed','cancelled'))::int AS overdue`),
    db.raw(`count(*) FILTER (WHERE t.status IN ('submitted','under_review'))::int AS pending_review`),
    db.raw(`count(*) FILTER (WHERE t.status = 'blocked')::int AS blocked`),
    db.raw(`count(*) FILTER (WHERE t.status = 'in_progress')::int AS in_progress`),
    db.raw(`count(*) FILTER (WHERE t.status = 'revision_required')::int AS revision_required`),
  );
}
