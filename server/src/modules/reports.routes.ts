import { Router, Response } from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { db } from '../db/knex';
import { AuthUser, can, me, requirePerm } from '../auth/middleware';
import { scopeProjects, scopeTasks, supervisedUserIds } from '../auth/scope';
import { audit } from '../lib/audit';
import { forbidden } from '../lib/errors';
import { parse, zDate, zId } from '../lib/http';
import { userKpis } from '../lib/kpi';
import { getSetting } from '../lib/settings';

export const router = Router();

const q = z.object({
  period: z.enum(['daily', 'weekly', 'monthly', 'custom']).default('monthly'),
  date: zDate.optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  department_id: zId.optional(),
  project_id: zId.optional(),
  format: z.enum(['json', 'xlsx', 'pdf']).default('json'),
});

function window(f: z.infer<typeof q>, tz: string) {
  if (f.period === 'custom') {
    const to = f.to ?? DateTime.now().setZone(tz).toISODate()!;
    return { from: f.from ?? DateTime.fromISO(to).minus({ days: 30 }).toISODate()!, to };
  }
  const a = DateTime.fromISO(f.date ?? DateTime.now().setZone(tz).toISODate()!);
  const unit = f.period === 'daily' ? 'day' : f.period === 'weekly' ? 'week' : 'month';
  return { from: a.startOf(unit).toISODate()!, to: a.endOf(unit).toISODate()! };
}

interface Report { title: string; from: string; to: string; summary?: Record<string, any>; columns: { key: string; header: string; width?: number }[]; rows: any[]; charts?: any }

async function employeeReport(u: AuthUser, f: any, w: any): Promise<Report> {
  let ids = can(u, 'analytics.view_all') ? null : await supervisedUserIds(u);
  if (!can(u, 'monitoring.employees') && !can(u, 'analytics.view_all')) ids = [u.id];
  const rows = await userKpis({ from: w.from, to: w.to, userIds: ids, departmentId: f.department_id, projectId: f.project_id });
  return {
    title: 'Employee performance report', ...w,
    summary: {
      employees: rows.length, completed: sum(rows, 'completed'), overdue_open: sum(rows, 'overdue_open'), open: sum(rows, 'open'),
      avg_on_time_rate: avg(rows.map((r) => r.on_time_rate)), avg_score: avg(rows.map((r) => r.performance_score)),
    },
    columns: [
      { key: 'employee_code', header: 'Code', width: 10 }, { key: 'name', header: 'Employee', width: 22 }, { key: 'department_name', header: 'Department', width: 18 },
      { key: 'assigned', header: 'Assigned' }, { key: 'completed', header: 'Completed (approved)' }, { key: 'on_time_rate', header: 'On-time %' },
      { key: 'open', header: 'Open' }, { key: 'overdue_open', header: 'Overdue' }, { key: 'revision_rate', header: 'Revision %' },
      { key: 'avg_quality', header: 'Avg quality' }, { key: 'weighted_output', header: 'Weighted output' }, { key: 'hours_logged', header: 'Hours' },
      { key: 'open_estimated_hours', header: 'Open est. h' }, { key: 'performance_score', header: 'Score' },
    ],
    rows,
  };
}

async function departmentReport(u: AuthUser, f: any, w: any): Promise<Report> {
  const qb = db('departments as d').where('d.is_active', true).whereNull('d.deleted_at').leftJoin('users as h', 'h.id', 'd.hod_id');
  if (!can(u, 'analytics.view_all')) qb.where('d.id', u.departmentId ?? 0);
  if (f.department_id) qb.where('d.id', f.department_id);
  const rows = await qb.select('d.id', 'd.name', 'h.name as hod_name',
    db.raw(`(SELECT count(*) FROM users x WHERE x.department_id = d.id AND x.is_active AND x.deleted_at IS NULL)::int AS employees`),
    db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.deleted_at IS NULL AND NOT t.is_recurring_template AND (t.created_at::date BETWEEN :from AND :to OR t.deadline::date BETWEEN :from AND :to))::int AS assigned`, w),
    db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.status = 'completed' AND t.completed_at::date BETWEEN :from AND :to)::int AS completed`, w),
    db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.status = 'completed' AND t.completed_at::date BETWEEN :from AND :to AND (t.deadline IS NULL OR t.completed_at <= t.deadline))::int AS on_time`, w),
    db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.deleted_at IS NULL AND t.status NOT IN ('completed','cancelled') AND NOT t.is_recurring_template)::int AS pending`),
    db.raw(`(SELECT count(*) FROM tasks t WHERE t.department_id = d.id AND t.deleted_at IS NULL AND t.is_overdue AND t.status NOT IN ('completed','cancelled'))::int AS delayed`),
    db.raw(`(SELECT round(avg(t.quality_rating),1)::float FROM tasks t WHERE t.department_id = d.id AND t.status = 'completed' AND t.completed_at::date BETWEEN :from AND :to) AS avg_quality`, w),
    db.raw(`(SELECT coalesce(sum(te.hours),0)::float FROM time_entries te JOIN users x ON x.id = te.user_id WHERE x.department_id = d.id AND te.entry_date BETWEEN :from AND :to) AS hours`, w))
    .orderBy('d.name');
  const out = rows.map((r: any) => ({ ...r, on_time_rate: r.completed ? Math.round((r.on_time / r.completed) * 100) : null, productivity: r.employees ? Math.round((r.completed / r.employees) * 10) / 10 : 0 }));
  return {
    title: 'Department productivity report', ...w,
    summary: { departments: out.length, completed: sum(out, 'completed'), pending: sum(out, 'pending'), delayed: sum(out, 'delayed') },
    columns: [{ key: 'name', header: 'Department', width: 22 }, { key: 'hod_name', header: 'HOD', width: 18 }, { key: 'employees', header: 'Employees' },
      { key: 'assigned', header: 'Assigned' }, { key: 'completed', header: 'Completed' }, { key: 'on_time_rate', header: 'On-time %' }, { key: 'pending', header: 'Pending' },
      { key: 'delayed', header: 'Delayed' }, { key: 'avg_quality', header: 'Avg quality' }, { key: 'hours', header: 'Hours' }, { key: 'productivity', header: 'Completed / employee' }],
    rows: out,
  };
}

async function projectReport(u: AuthUser, f: any, w: any): Promise<Report> {
  const qb = scopeProjects(db('projects as p'), u).whereNull('p.deleted_at').leftJoin('users as m', 'm.id', 'p.manager_id').leftJoin('departments as d', 'd.id', 'p.department_id');
  if (f.project_id) qb.where('p.id', f.project_id);
  if (f.department_id) qb.where('p.department_id', f.department_id);
  const rows = await qb.select('p.id', 'p.code', 'p.name', 'p.status', 'p.priority', 'p.is_future', 'p.progress', 'p.start_date', 'p.end_date', 'p.estimated_budget', 'm.name as manager_name', 'd.name as department_name',
    db.raw(`(SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND NOT t.is_recurring_template)::int AS tasks`),
    db.raw(`(SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'completed')::int AS completed_tasks`),
    db.raw(`(SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL AND t.is_overdue AND t.status NOT IN ('completed','cancelled'))::int AS delayed_tasks`),
    db.raw(`(SELECT count(*) FROM project_milestones m WHERE m.project_id = p.id)::int AS milestones`),
    db.raw(`(SELECT count(*) FROM project_milestones m WHERE m.project_id = p.id AND m.status = 'completed')::int AS milestones_done`),
    db.raw(`(SELECT count(*) FROM project_milestones m WHERE m.project_id = p.id AND m.status <> 'completed' AND m.due_date < current_date)::int AS milestones_missed`),
    db.raw(`(SELECT count(*) FROM project_risks r WHERE r.project_id = p.id AND r.status IN ('open','mitigating'))::int AS open_risks`),
    db.raw(`(SELECT count(*) FROM project_risks r WHERE r.project_id = p.id AND r.status IN ('open','mitigating') AND r.impact IN ('high','critical'))::int AS high_risks`))
    .orderBy('p.name');
  const today = DateTime.now().toISODate()!;
  const out: any[] = rows.map((r: any) => ({ ...r, schedule: r.status === 'completed' ? 'done' : r.end_date && r.end_date < today ? 'late' : r.delayed_tasks > 0 || r.milestones_missed > 0 ? 'at_risk' : 'on_track' }));
  return {
    title: 'Project portfolio report', ...w,
    summary: { projects: out.length, active: out.filter((r) => !r.is_future && ['in_progress', 'ready_to_start', 'planned', 'approved'].includes(r.status)).length,
      future: out.filter((r) => r.is_future).length, late: out.filter((r) => r.schedule === 'late').length, at_risk: out.filter((r) => r.schedule === 'at_risk').length,
      budget: out.reduce((s, r) => s + Number(r.estimated_budget ?? 0), 0) },
    columns: [{ key: 'code', header: 'Code' }, { key: 'name', header: 'Project', width: 26 }, { key: 'status', header: 'Status' }, { key: 'manager_name', header: 'PM', width: 16 },
      { key: 'department_name', header: 'Department', width: 16 }, { key: 'progress', header: 'Progress %' }, { key: 'tasks', header: 'Tasks' }, { key: 'delayed_tasks', header: 'Delayed' },
      { key: 'milestones_done', header: 'Milestones done' }, { key: 'milestones_missed', header: 'Missed' }, { key: 'open_risks', header: 'Risks' }, { key: 'schedule', header: 'Schedule' },
      { key: 'end_date', header: 'End' }, { key: 'estimated_budget', header: 'Budget' }],
    rows: out,
  };
}

async function taskReport(u: AuthUser, f: any, w: any): Promise<Report> {
  const qb = scopeTasks(db('tasks as t'), u).whereNull('t.deleted_at').where('t.is_recurring_template', false)
    .leftJoin('projects as p', 'p.id', 't.project_id').leftJoin('departments as d', 'd.id', 't.department_id')
    .whereRaw('(t.created_at::date BETWEEN :from AND :to OR t.deadline::date BETWEEN :from AND :to OR t.completed_at::date BETWEEN :from AND :to)', w);
  if (f.project_id) qb.where('t.project_id', f.project_id);
  if (f.department_id) qb.where('t.department_id', f.department_id);
  const rows = await qb.orderBy('t.deadline').limit(5000).select('t.task_key', 't.title', 't.status', 't.priority', 't.complexity', 't.progress', 't.deadline', 't.completed_at', 't.estimated_hours', 't.actual_hours',
    't.quality_rating', 't.revision_count', 't.is_overdue', 'p.name as project_name', 'd.name as department_name',
    db.raw(`(SELECT string_agg(u.name, ', ') FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id = t.id) AS assignees`));
  return {
    title: 'Task report', ...w,
    summary: { tasks: rows.length, completed: rows.filter((r: any) => r.status === 'completed').length, overdue: rows.filter((r: any) => r.is_overdue).length },
    columns: [{ key: 'task_key', header: 'ID' }, { key: 'title', header: 'Title', width: 30 }, { key: 'assignees', header: 'Assignees', width: 20 }, { key: 'project_name', header: 'Project', width: 16 },
      { key: 'department_name', header: 'Department', width: 14 }, { key: 'status', header: 'Status' }, { key: 'priority', header: 'Priority' }, { key: 'deadline', header: 'Deadline', width: 18 },
      { key: 'completed_at', header: 'Completed', width: 18 }, { key: 'estimated_hours', header: 'Est h' }, { key: 'actual_hours', header: 'Act h' }, { key: 'quality_rating', header: 'Quality' }],
    rows,
  };
}

async function pipelineReport(u: AuthUser, _f: any, w: any): Promise<Report> {
  const rows = await scopeProjects(db('projects as p'), u).whereNull('p.deleted_at').where('p.is_future', true).join('future_projects as fp', 'fp.project_id', 'p.id')
    .leftJoin('departments as d', 'd.id', 'p.department_id').leftJoin('users as m', 'm.id', 'p.manager_id')
    .orderBy('fp.expected_start_date').select('p.code', 'p.name', 'p.priority', 'p.estimated_budget', 'd.name as department_name', 'm.name as manager_name', 'fp.expected_start_date', 'fp.expected_end_date',
      'fp.approval_status', 'fp.readiness_percent', 'fp.required_employees', db.raw(`array_to_string(fp.required_skills, ', ') AS required_skills`));
  return {
    title: 'Future project pipeline', ...w,
    summary: { projects: rows.length, approved: rows.filter((r: any) => r.approval_status === 'approved').length, headcount: sum(rows, 'required_employees'), budget: rows.reduce((s: number, r: any) => s + Number(r.estimated_budget ?? 0), 0) },
    columns: [{ key: 'code', header: 'Code' }, { key: 'name', header: 'Project', width: 26 }, { key: 'expected_start_date', header: 'Expected start' }, { key: 'expected_end_date', header: 'Expected end' },
      { key: 'department_name', header: 'Department', width: 16 }, { key: 'manager_name', header: 'Tentative PM', width: 16 }, { key: 'approval_status', header: 'Approval' },
      { key: 'readiness_percent', header: 'Readiness %' }, { key: 'required_employees', header: 'Headcount' }, { key: 'required_skills', header: 'Skills', width: 24 }, { key: 'estimated_budget', header: 'Budget' }],
    rows,
  };
}

const sum = (rows: any[], k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
const avg = (vals: (number | null)[]) => { const v = vals.filter((x): x is number => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };

const BUILDERS: Record<string, { fn: (u: AuthUser, f: any, w: any) => Promise<Report>; check: (u: AuthUser) => boolean }> = {
  employees: { fn: employeeReport, check: (u) => can(u, 'analytics.view') },
  departments: { fn: departmentReport, check: (u) => can(u, 'analytics.view_all') || (can(u, 'monitoring.departments') && !!u.departmentId) },
  projects: { fn: projectReport, check: (u) => can(u, 'projects.view') && can(u, 'analytics.view') },
  tasks: { fn: taskReport, check: (u) => can(u, 'analytics.view') },
  pipeline: { fn: pipelineReport, check: (u) => can(u, 'projects.view') && can(u, 'analytics.view') },
};

router.get('/:type', requirePerm('analytics.view'), async (req, res) => {
  const u = me(req);
  const builder = BUILDERS[String(req.params.type)];
  if (!builder || !builder.check(u)) throw forbidden('Report not available for your role');
  const f = parse(q, req.query);
  if (f.format !== 'json' && !can(u, 'reports.export')) throw forbidden('You cannot export reports');
  const report = await builder.fn(u, f, window(f, u.timezone));
  if (f.format === 'json') return res.json(report);
  await audit(req, { action: 'report.exported', entityType: 'report', summary: `${req.params.type} ${f.format} ${report.from}..${report.to}` });
  const orgName = await getSetting('organization_name');
  if (f.format === 'xlsx') return sendXlsx(res, report, orgName);
  return sendPdf(res, report, orgName);
});

function fmt(v: any) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 16);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.replace('T', ' ').slice(0, 16);
  if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 100) / 100;
  return v;
}

async function sendXlsx(res: Response, r: Report, org: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = org;
  const ws = wb.addWorksheet('Report');
  ws.addRow([`${org} — ${r.title}`]).font = { bold: true, size: 14 };
  ws.addRow([`Period: ${r.from} to ${r.to}`, '', `Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`]);
  if (r.summary) ws.addRow(Object.entries(r.summary).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v ?? '—'}`));
  ws.addRow([]);
  const header = ws.addRow(r.columns.map((c) => c.header));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } }; });
  for (const row of r.rows) ws.addRow(r.columns.map((c) => fmt(row[c.key])));
  r.columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? 12; });
  ws.views = [{ state: 'frozen', ySplit: header.number }];
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${r.title.replace(/\W+/g, '_')}_${r.from}_${r.to}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

function sendPdf(res: Response, r: Report, org: string) {
  const doc = new PDFDocument({ size: 'A4', layout: r.columns.length > 8 ? 'landscape' : 'portrait', margin: 32 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${r.title.replace(/\W+/g, '_')}_${r.from}_${r.to}.pdf"`);
  doc.pipe(res);
  doc.fontSize(16).font('Helvetica-Bold').text(`${org} — ${r.title}`);
  doc.fontSize(9).font('Helvetica').fillColor('#555').text(`Period ${r.from} to ${r.to} · Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  doc.moveDown(0.5);
  if (r.summary) doc.fillColor('#000').fontSize(9).text(Object.entries(r.summary).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v ?? '—'}`).join('   ·   '));
  doc.moveDown(0.8);
  const usable = doc.page.width - 64;
  const totalW = r.columns.reduce((s, c) => s + (c.width ?? 10), 0);
  const widths = r.columns.map((c) => ((c.width ?? 10) / totalW) * usable);
  const drawRow = (cells: string[], bold = false) => {
    const y = doc.y;
    let x = 32;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: widths[i] - 4 }))) + 4;
    if (y + h > doc.page.height - 40) { doc.addPage(); return drawRow(cells, bold); }
    if (bold) doc.rect(32, y - 1, usable, h).fill('#E5E7EB').fillColor('#000');
    cells.forEach((c, i) => { doc.text(c, x + 2, y + 1, { width: widths[i] - 4 }); x += widths[i]; });
    doc.y = y + h;
    doc.moveTo(32, doc.y).lineTo(32 + usable, doc.y).strokeColor('#E5E7EB').stroke();
  };
  drawRow(r.columns.map((c) => c.header), true);
  for (const row of r.rows) drawRow(r.columns.map((c) => String(fmt(row[c.key]))));
  if (!r.rows.length) doc.moveDown().fontSize(10).text('No data for this period.');
  doc.end();
}
