import { Link, useNavigate } from 'react-router-dom';
import { AlertOctagon, AlertTriangle, BriefcaseBusiness, Building2, CalendarClock, CheckCircle2, ClipboardCheck, Hourglass, ListTodo, Rocket, Sparkles, Users } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { fmtDate, pct } from '../lib/format';
import { useApi, useLiveRefresh } from '../lib/hooks';
import { BarsChart, HBarChart, Meter } from '../components/charts';
import { TaskList } from '../components/TaskBits';
import { Card, DataTable, ErrorState, Loading, PageHeader, Progress, Stat, StatusBadge } from '../components/ui';
import { MyDayPanel, TeamTodayPanel } from './mywork/DashboardPanels';

export default function Dashboard() {
  const { user, can } = useAuth();
  const nav = useNavigate();
  const { data, isLoading, error, refetch } = useApi<any>(['dashboard'], '/dashboard', undefined, { refetchInterval: 120_000 });
  const insights = useApi<any>(['insights'], can('analytics.view') && user?.scope !== 'self' ? '/insights/summary' : null);
  useLiveRefresh([['dashboard']]);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const p = data.personal;
  const o = data.overview;
  const hour = new Date().getHours();
  const trend = (data.trend ?? []).map((w: any) => ({ week: fmtDate(w.week).slice(0, 6), completed: w.completed, on_time: w.on_time }));

  return (
    <div className="space-y-5">
      <PageHeader title={`Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, ${user!.name.split(' ')[0]}`} subtitle={`${data.role}${user?.department_name ? ` · ${user.department_name}` : ''}`}
        actions={data.pending_approvals > 0 && <Link to="/approvals" className="btn-primary"><ClipboardCheck className="h-4 w-4" /> {data.pending_approvals} pending approval{data.pending_approvals > 1 ? 's' : ''}</Link>} />

      {can('activities.log') && <MyDayPanel />}

      {data.org && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <Stat label="Departments" value={data.org.counts.departments} icon={Building2} to="/organization" />
          <Stat label="Employees" value={data.org.counts.employees} icon={Users} to="/organization?tab=users" />
          <Stat label="Active projects" value={data.org.counts.active_projects} icon={BriefcaseBusiness} to="/projects" tone="brand" />
          <Stat label="Future projects" value={data.org.counts.future_projects} icon={Rocket} to="/future-projects" />
          <Stat label="Completed projects" value={data.org.counts.completed_projects} icon={CheckCircle2} tone="good" />
          <Stat label="Pending approvals" value={data.pending_approvals} icon={ClipboardCheck} to="/approvals" tone={data.pending_approvals ? 'warn' : 'default'} />
        </div>
      )}

      {o && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Open tasks" value={o.totals.open} icon={ListTodo} to="/tasks" />
          <Stat label="Overdue" value={o.totals.overdue} icon={AlertTriangle} tone={o.totals.overdue ? 'danger' : 'default'} to="/tasks?due=overdue" />
          <Stat label="Due today" value={o.totals.due_today} icon={CalendarClock} tone={o.totals.due_today ? 'warn' : 'default'} to="/tasks?due=today" />
          <Stat label="Awaiting review" value={o.totals.pending_review} icon={Hourglass} to="/approvals" />
          <Stat label="Blocked" value={o.totals.blocked} icon={AlertOctagon} tone={o.totals.blocked ? 'danger' : 'default'} to="/tasks?status=blocked" />
          <Stat label="Completed (approved)" value={o.totals.completed} icon={CheckCircle2} tone="good" />
        </div>
      )}

      {!o && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="My open tasks" value={p.totals.open} icon={ListTodo} to="/tasks?mine=true" />
          <Stat label="Due today" value={p.today.length} icon={CalendarClock} tone={p.today.length ? 'warn' : 'default'} />
          <Stat label="Overdue" value={p.totals.overdue} icon={AlertTriangle} tone={p.totals.overdue ? 'danger' : 'default'} />
          <Stat label="In progress" value={p.totals.in_progress} />
          <Stat label="Submitted" value={p.totals.pending_review} icon={Hourglass} />
          <Stat label="Revision requests" value={p.totals.revision_required} tone={p.totals.revision_required ? 'warn' : 'default'} />
        </div>
      )}

      {can('checklists.monitor', 'activities.view_team') && <TeamTodayPanel />}

      {insights.data && (
        <Card title={<span className="inline-flex items-center gap-2"><Sparkles className="h-4 w-4 text-brand-500" /> Management summary</span>} actions={<span className="muted text-xs">rule-based · live data</span>}>
          <ul className="list-disc space-y-1 pl-5 text-sm">{insights.data.summary.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
        </Card>
      )}

      {data.critical_alerts?.length > 0 && (
        <Card title="Critical alerts">
          <ul className="grid gap-2 md:grid-cols-2">
            {data.critical_alerts.map((a: any, i: number) => (
              <li key={i}><Link to={a.link} className="flex items-start gap-3 rounded-lg border p-3 hover:bg-slate-50 dark:hover:bg-slate-800/60">
                <AlertOctagon className={`mt-0.5 h-4 w-4 shrink-0 ${a.severity === 'critical' ? 'text-rose-600' : 'text-amber-600'}`} />
                <span className="min-w-0"><span className="block text-sm font-medium">{a.title} <span className="muted text-xs font-normal">({a.severity})</span></span><span className="muted block truncate text-xs">{a.detail}</span></span>
              </Link></li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        <Card title="My work today" className="xl:col-span-1">
          <TaskList tasks={[...p.today, ...p.overdue.filter((t: any) => !p.today.some((x: any) => x.id === t.id))]} empty="Nothing due today 🎉" />
          {p.revisions.length > 0 && <><h3 className="section-title mt-4 mb-1">Revision requested</h3><TaskList tasks={p.revisions} /></>}
        </Card>
        <Card title={o ? 'Upcoming deadlines (7 days)' : 'My upcoming deadlines'} className="xl:col-span-1">
          <TaskList tasks={o ? o.upcoming : p.upcoming} showAssignees={!!o} empty="No upcoming deadlines" />
        </Card>
        <Card title="Completed per week (approved)" className="xl:col-span-1">
          <BarsChart data={trend} x="week" series={[{ key: 'completed', label: 'Completed' }, { key: 'on_time', label: 'On time' }]} height={220} />
        </Card>
      </div>

      {p.kpi && (
        <Card title="My performance (last 30 days)">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Completed (approved)" value={p.kpi.completed} />
            <Stat label="On-time rate" value={pct(p.kpi.on_time_rate)} />
            <Stat label="Avg quality" value={p.kpi.avg_quality ?? '—'} hint="1–5 reviewer rating" />
            <Stat label="Revision rate" value={pct(p.kpi.revision_rate)} />
            <Stat label="Hours logged" value={p.kpi.hours_logged} />
            <Stat label="Balanced score" value={p.kpi.performance_score ?? '—'} hint="timeliness · quality · complexity" tone="brand" />
          </div>
        </Card>
      )}

      {o && (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card title="Overdue work" actions={<Link className="text-xs font-medium text-brand-600" to="/tasks?due=overdue">View all</Link>}><TaskList tasks={o.overdue} showAssignees empty="No overdue work" /></Card>
          <Card title="Blockers"><TaskList tasks={o.blocked} showAssignees empty="No blocked tasks" /></Card>
        </div>
      )}

      {data.org && (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card title="Department performance (30 days)" pad={false}>
            <DataTable rows={data.org.departments} onRowClick={(d: any) => nav(`/monitoring/departments/${d.id}`)}
              columns={[
                { key: 'name', header: 'Department' }, { key: 'open', header: 'Open' },
                { key: 'overdue', header: 'Overdue', render: (d: any) => <span className={d.overdue ? 'font-medium text-rose-600' : ''}>{d.overdue}</span> },
                { key: 'completed', header: 'Completed' }, { key: 'on_time_rate', header: 'On-time', render: (d: any) => pct(d.on_time_rate) },
              ]} />
          </Card>
          <Card title="Project portfolio by status"><HBarChart data={data.org.project_status} label="status" value="count" valueLabel="Projects" /></Card>
        </div>
      )}

      {data.projects && (
        <div className="grid gap-5 xl:grid-cols-3">
          <Card title="Projects" className="xl:col-span-2" pad={false}>
            <DataTable rows={data.projects.list} onRowClick={(r: any) => nav(`/projects/${r.id}`)}
              columns={[
                { key: 'name', header: 'Project', render: (r: any) => <span className="font-medium">{r.name}</span> },
                { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
                { key: 'progress', header: 'Progress', render: (r: any) => <div className="w-28"><Progress value={r.progress} /></div> },
                { key: 'end_date', header: 'Due', render: (r: any) => fmtDate(r.end_date) },
                { key: 'overdue', header: 'Delayed tasks', render: (r: any) => <span className={r.overdue ? 'text-rose-600' : ''}>{r.overdue}</span> },
              ]} />
          </Card>
          <Card title="Upcoming milestones & deliveries">
            <ul className="space-y-2 text-sm">
              {data.projects.milestones.map((m: any) => <li key={`m${m.id}`} className="flex justify-between gap-2"><span className="truncate">◆ {m.title}<span className="muted block text-xs">{m.project_name}</span></span><span className="muted shrink-0 text-xs">{fmtDate(m.due_date)}</span></li>)}
              {data.projects.deliveries.map((d: any) => <li key={`d${d.id}`} className="flex justify-between gap-2"><span className="truncate">📦 {d.title}<span className="muted block text-xs">{d.project_name}</span></span><span className="muted shrink-0 text-xs">{fmtDate(d.due_date)}</span></li>)}
              {!data.projects.milestones.length && !data.projects.deliveries.length && <li className="muted">Nothing upcoming</li>}
            </ul>
          </Card>
        </div>
      )}

      {data.workload?.length > 0 && (
        <Card title="Employee workload" actions={<Link to="/resources" className="text-xs font-medium text-brand-600">Capacity planning</Link>} pad={false}>
          <DataTable rows={data.workload.slice(0, 12)} onRowClick={(r: any) => nav(`/monitoring/employees/${r.id}`)}
            columns={[
              { key: 'name', header: 'Employee', render: (r: any) => <span className="font-medium">{r.name}<span className="muted block text-xs font-normal">{r.department}</span></span> },
              { key: 'open', header: 'Open' },
              { key: 'overdue', header: 'Overdue', render: (r: any) => <span className={r.overdue ? 'text-rose-600' : ''}>{r.overdue}</span> },
              { key: 'open_hours', header: 'Load (h)', render: (r: any) => Math.round(r.open_hours) },
              { key: 'util', header: 'Utilisation', render: (r: any) => <Meter value={r.capacity ? Math.round((r.open_hours / r.capacity) * 100) : 0} /> },
              { key: 'score', header: 'Score', render: (r: any) => r.score ?? '—' },
            ]} />
        </Card>
      )}
    </div>
  );
}
