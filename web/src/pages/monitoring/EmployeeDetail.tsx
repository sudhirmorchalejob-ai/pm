import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { fmtDate, fmtDateTime, fromNow, humanize, pct } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { BarsChart, LinesChart, Meter } from '../../components/charts';
import { TaskList } from '../../components/TaskBits';
import { Card, Chips, DataTable, ErrorState, KV, Loading, PageHeader, Stat, StatusBadge, Tabs } from '../../components/ui';
import { defaultRange, RangeFilters } from './EmployeesMonitor';
import { useAuth } from '../../lib/auth';
import { EmployeeWorkTabs } from '../mywork/admin';

export default function EmployeeDetail() {
  const id = Number(useParams().id);
  const [f, setF] = useState(defaultRange());
  const [status, setStatus] = useState<string[]>([]);
  const [priority, setPriority] = useState<string[]>([]);
  const [tab, setTab] = useState('tasks');
  const { can } = useAuth();
  const { data, isLoading, error } = useApi<any>(['monitor-emp', id], `/monitoring/employees/${id}`, { ...f, department_id: undefined, project_id: f.project_id || undefined, status, priority });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} />;
  const k = data.kpi;
  const util = data.workload.capacity_hours_per_week ? Math.round((data.workload.open_estimated_hours / data.workload.capacity_hours_per_week) * 100) : 0;
  return (
    <div className="space-y-5">
      <PageHeader back="/monitoring" title={data.profile.name} subtitle={[data.profile.designation, data.profile.department_name, data.profile.team_name].filter(Boolean).join(' · ')} />
      <Card><RangeFilters f={f} setF={setF} showDept={false} />
        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          <Chips multi value={status} onChange={setStatus} options={['not_started', 'in_progress', 'blocked', 'submitted', 'revision_required', 'completed'].map((s) => ({ value: s, label: humanize(s) }))} />
          <Chips multi value={priority} onChange={setPriority} options={['low', 'medium', 'high', 'critical'].map((s) => ({ value: s, label: humanize(s) }))} />
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <Stat label="Assigned" value={k.assigned} /><Stat label="Completed" value={k.completed} tone="good" /><Stat label="Open" value={k.open} />
        <Stat label="Overdue" value={k.overdue_open} tone={k.overdue_open ? 'danger' : 'default'} /><Stat label="On-time" value={pct(k.on_time_rate)} />
        <Stat label="Quality" value={k.avg_quality ?? '—'} /><Stat label="Revision rate" value={pct(k.revision_rate)} /><Stat label="Score" value={k.performance_score ?? '—'} tone="brand" />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Workload & time">
          <KV items={[['Open tasks', data.workload.open_tasks], ['Remaining estimate', `${Math.round(data.workload.open_estimated_hours)} h`], ['Capacity', `${data.workload.capacity_hours_per_week} h/week`],
            ['Utilisation', <Meter value={util} />], ['Hours logged (range)', k.hours_logged], ['Estimate accuracy', k.estimate_accuracy ?? '—'], ['Weighted output', k.weighted_output]]} />
        </Card>
        <Card title="Weekly trend (12 weeks)" className="lg:col-span-2">
          <LinesChart data={data.trend.map((t: any) => ({ ...t, week: fmtDate(t.week).slice(0, 6) }))} x="week" series={[{ key: 'completed', label: 'Completed' }, { key: 'on_time', label: 'On time' }]} />
        </Card>
      </div>
      <Card title="Time logged per day"><BarsChart data={data.time_by_day.map((t: any) => ({ ...t, day: fmtDate(t.entry_date).slice(0, 6) }))} x="day" series={[{ key: 'hours', label: 'Hours' }]} height={180} /></Card>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'tasks', label: 'Current & pending', count: data.tasks.current.length + data.tasks.pending.length }, { value: 'overdue', label: 'Overdue', count: data.tasks.overdue.length },
        { value: 'submitted', label: 'Submitted', count: data.tasks.submitted.length }, { value: 'completed', label: 'Completed', count: data.tasks.completed.length },
        { value: 'updates', label: 'Work updates' }, { value: 'approvals', label: 'Approval history' }, { value: 'reports', label: 'Daily reports' },
      ]} />
      {tab === 'tasks' && <Card><TaskList tasks={[...data.tasks.current, ...data.tasks.pending]} /></Card>}
      {tab === 'overdue' && <Card><TaskList tasks={data.tasks.overdue} empty="No overdue work" /></Card>}
      {tab === 'submitted' && <Card><TaskList tasks={data.tasks.submitted} /></Card>}
      {tab === 'completed' && <Card pad={false}><DataTable rows={data.tasks.completed} columns={[
        { key: 'title', header: 'Task', render: (t: any) => <span>{t.task_key} {t.title}</span> }, { key: 'completed_at', header: 'Completed', render: (t: any) => fmtDate(t.completed_at) },
        { key: 'ontime', header: 'On time', render: (t: any) => !t.deadline || new Date(t.completed_at) <= new Date(t.deadline) ? '✓' : <span className="text-rose-600">late</span> },
        { key: 'complexity', header: 'Complexity' }, { key: 'quality_rating', header: 'Quality' }, { key: 'revision_count', header: 'Revisions' },
        { key: 'h', header: 'Est / actual h', render: (t: any) => `${t.estimated_hours ?? '—'} / ${t.actual_hours}` }]} /></Card>}
      {tab === 'updates' && <Card><ul className="divide-y text-sm">{data.updates.map((u: any) => <li key={u.id} className="py-2"><b>{u.task_key}</b> {u.title} — {humanize(u.kind)}{u.status_to && <> → <StatusBadge status={u.status_to} /></>}{u.progress != null && ` ${u.progress}%`}{u.note && <p className="muted">{u.note}</p>}<p className="muted text-xs">{fmtDateTime(u.created_at)}</p></li>)}{!data.updates.length && <li className="muted py-4">No updates in this range</li>}</ul></Card>}
      {tab === 'approvals' && <Card pad={false}><DataTable rows={data.approvals} columns={[
        { key: 'task', header: 'Task', render: (a: any) => `${a.task_key} ${a.title}` }, { key: 'approval_type', header: 'Type', render: (a: any) => humanize(a.approval_type) },
        { key: 'decision', header: 'Decision', render: (a: any) => <StatusBadge status={a.decision} /> }, { key: 'reviewer_name', header: 'Reviewer' },
        { key: 'requested_at', header: 'Requested', render: (a: any) => fromNow(a.requested_at) }, { key: 'comments', header: 'Comments' }]} /></Card>}
      {tab === 'reports' && <Card pad={false}><DataTable rows={data.daily_reports} columns={[
        { key: 'report_date', header: 'Date', render: (r: any) => fmtDate(r.report_date) }, { key: 'work_completed', header: 'Completed', render: (r: any) => <span className="line-clamp-2 text-sm">{r.work_completed}</span> },
        { key: 'hours_spent', header: 'Hours' }, { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> }]} /></Card>}
      {can('activities.log', 'activities.view_team') && <EmployeeWorkTabs userId={id} />}
    </div>
  );
}
