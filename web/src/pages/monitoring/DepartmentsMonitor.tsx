import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { fmtDate, fromNow, pct } from '../../lib/format';
import { useApi, useLiveRefresh } from '../../lib/hooks';
import { BarsChart, HBarChart, Meter } from '../../components/charts';
import { TaskList } from '../../components/TaskBits';
import { Card, DataTable, ErrorState, Loading, PageHeader, Select, Stat, Tabs } from '../../components/ui';
import { TaskForm } from '../tasks/TaskForm';
import { defaultRange, RangeFilters } from './EmployeesMonitor';

export default function DepartmentsMonitor() {
  const { user, can } = useAuth();
  const params = useParams();
  const nav = useNavigate();
  const { data: list = [], isLoading: l1 } = useApi<any[]>(['monitor-depts'], '/monitoring/departments');
  const id = params.id ? Number(params.id) : user?.scope !== 'organization' ? user?.department_id : undefined;
  if (l1) return <Loading />;
  if (!id) {
    return (
      <div>
        <PageHeader title="Department monitoring" subtitle="Compare departments — select one for detail" />
        <Card pad={false}><div className="px-4 sm:px-0">
          <DataTable rows={list} onRowClick={(d: any) => nav(`/monitoring/departments/${d.id}`)} columns={[
            { key: 'name', header: 'Department', render: (d: any) => <span className="font-medium">{d.name}<span className="muted block text-xs font-normal">HOD: {d.hod_name ?? '—'}</span></span> },
            { key: 'employees', header: 'People' }, { key: 'open_tasks', header: 'Open' },
            { key: 'overdue', header: 'Overdue', render: (d: any) => <span className={d.overdue ? 'font-medium text-rose-600' : ''}>{d.overdue}</span> },
            { key: 'pending_review', header: 'Pending review' }, { key: 'completed_30d', header: 'Completed (30d)' },
            { key: 'on_time_rate', header: 'On-time', render: (d: any) => pct(d.on_time_rate) }, { key: 'avg_quality', header: 'Quality', render: (d: any) => d.avg_quality ?? '—' },
          ]} />
        </div></Card>
        <Card title="Completed in the last 30 days" className="mt-5"><HBarChart data={list} label="name" value="completed_30d" valueLabel="Completed" /></Card>
      </div>
    );
  }
  return <DepartmentDetail id={id} list={list} canPick={user?.scope === 'organization' || can('analytics.view_all')} />;
}

function DepartmentDetail({ id, list, canPick }: { id: number; list: any[]; canPick: boolean }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const [f, setF] = useState(defaultRange());
  const [tab, setTab] = useState('employees');
  const [assign, setAssign] = useState(false);
  const { data, isLoading, error } = useApi<any>(['monitor-dept', id], `/monitoring/departments/${id}`, { from: f.from, to: f.to, project_id: f.project_id || undefined });
  useLiveRefresh([['monitor-dept', id]]);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} />;
  const t = data.totals;
  return (
    <div className="space-y-5">
      <PageHeader title={data.department.name} subtitle={`HOD: ${data.department.hod_name ?? '—'} · ${data.employees.length} people`} back={canPick ? '/monitoring/departments' : undefined}
        actions={<>
          {canPick && <Select className="w-auto" value={id} onChange={(v) => nav(`/monitoring/departments/${v}`)} options={list.map((d) => ({ value: d.id, label: d.name }))} aria-label="Department" />}
          {can('tasks.assign') && <button className="btn-primary" onClick={() => setAssign(true)}>Assign work</button>}
        </>} />
      <Card><RangeFilters f={f} setF={setF} showDept={false} /></Card>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <Stat label="Assigned (all)" value={t.total} /><Stat label="Open" value={t.open} /><Stat label="Completed" value={t.completed} tone="good" />
        <Stat label="Overdue" value={t.overdue} tone={t.overdue ? 'danger' : 'default'} /><Stat label="Due today" value={data.due_today.length} tone={data.due_today.length ? 'warn' : 'default'} />
        <Stat label="Pending review" value={t.pending_review} /><Stat label="Blocked" value={t.blocked} tone={t.blocked ? 'danger' : 'default'} />
        <Stat label="Reports today" value={`${data.daily_reports_today.submitted}/${data.daily_reports_today.expected}`} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Workload distribution (remaining estimate vs. weekly capacity)" pad={false}>
          <DataTable rows={data.workload} onRowClick={(w: any) => nav(`/monitoring/employees/${w.id}`)} columns={[
            { key: 'name', header: 'Employee' }, { key: 'open', header: 'Open' }, { key: 'open_estimated_hours', header: 'Remaining h', render: (w: any) => Math.round(w.open_estimated_hours) },
            { key: 'utilization', header: 'Utilisation', render: (w: any) => w.utilization == null ? '—' : <Meter value={w.utilization} /> }]} />
        </Card>
        <Card title="Weekly completions"><BarsChart data={data.weekly_trend.map((w: any) => ({ ...w, week: fmtDate(w.week).slice(0, 6) }))} x="week" series={[{ key: 'completed', label: 'Completed' }, { key: 'on_time', label: 'On time' }]} /></Card>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'employees', label: 'Employees' }, { value: 'overdue', label: 'Overdue', count: data.overdue.length }, { value: 'blocked', label: 'Blockers', count: data.blocked.length },
        { value: 'review', label: 'Pending review', count: data.pending_review.length }, { value: 'today', label: 'Due today', count: data.due_today.length },
        { value: 'upcoming', label: 'Upcoming', count: data.upcoming.length }, { value: 'silent', label: 'No updates (48h)', count: data.employees_without_updates.length },
      ]} />
      {tab === 'employees' && <Card pad={false}><div className="px-4 sm:px-0"><DataTable rows={data.employees} onRowClick={(e: any) => nav(`/monitoring/employees/${e.id}`)} columns={[
        { key: 'name', header: 'Employee' }, { key: 'open', header: 'Open' }, { key: 'overdue_open', header: 'Overdue', render: (e: any) => <span className={e.overdue_open ? 'text-rose-600' : ''}>{e.overdue_open}</span> },
        { key: 'completed', header: 'Completed' }, { key: 'on_time_rate', header: 'On-time', render: (e: any) => pct(e.on_time_rate) }, { key: 'avg_quality', header: 'Quality', render: (e: any) => e.avg_quality ?? '—' },
        { key: 'revision_rate', header: 'Revisions', render: (e: any) => pct(e.revision_rate) }, { key: 'performance_score', header: 'Score', render: (e: any) => <b>{e.performance_score ?? '—'}</b> }]} /></div></Card>}
      {tab === 'overdue' && <Card><TaskList tasks={data.overdue} showAssignees empty="No overdue work" /></Card>}
      {tab === 'blocked' && <Card><TaskList tasks={data.blocked} showAssignees empty="No blockers" /></Card>}
      {tab === 'review' && <Card><TaskList tasks={data.pending_review} showAssignees empty="Nothing waiting for review" /></Card>}
      {tab === 'today' && <Card><TaskList tasks={data.due_today} showAssignees /></Card>}
      {tab === 'upcoming' && <Card><TaskList tasks={data.upcoming} showAssignees /></Card>}
      {tab === 'silent' && <Card pad={false}><DataTable rows={data.employees_without_updates} onRowClick={(e: any) => nav(`/monitoring/employees/${e.id}`)} columns={[{ key: 'name', header: 'Employee' }, { key: 'last_update', header: 'Last update', render: (e: any) => e.last_update ? fromNow(e.last_update) : 'never' }]} /></Card>}
      <TaskForm open={assign} onClose={() => setAssign(false)} />
    </div>
  );
}
