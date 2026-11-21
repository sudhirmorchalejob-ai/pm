import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { format, subDays } from 'date-fns';
import { useAuth } from '../../lib/auth';
import { fromNow, pct } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { Card, DataTable, ErrorState, Field, Loading, PageHeader, SearchInput, Select } from '../../components/ui';

export function RangeFilters({ f, setF, showDept = true }: { f: any; setF: (f: any) => void; showDept?: boolean }) {
  const { can } = useAuth();
  const { data: depts = [] } = useApi<any[]>(['departments'], can('org.view') ? '/org/departments' : null);
  const { data: projects } = useApi<any>(['projects-mini'], '/projects', { pageSize: 200 });
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Field label="From"><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
      <Field label="To"><input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
      {showDept && depts.length > 0 && <Field label="Department"><Select value={f.department_id} onChange={(v) => setF({ ...f, department_id: v })} placeholder="All" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} /></Field>}
      <Field label="Project"><Select value={f.project_id} onChange={(v) => setF({ ...f, project_id: v })} placeholder="All" options={(projects?.items ?? []).map((p: any) => ({ value: p.id, label: p.name }))} /></Field>
    </div>
  );
}

export const defaultRange = () => ({ from: format(subDays(new Date(), 30), 'yyyy-MM-dd'), to: format(new Date(), 'yyyy-MM-dd'), department_id: '', project_id: '' });

export default function EmployeesMonitor() {
  const nav = useNavigate();
  const [f, setF] = useState(defaultRange());
  const [q, setQ] = useState('');
  const { data, isLoading, error } = useApi<any>(['monitor-emps'], '/monitoring/employees', { ...f, department_id: f.department_id || undefined, project_id: f.project_id || undefined });
  const rows = (data?.items ?? []).filter((r: any) => !q || r.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <PageHeader title="Employee monitoring" subtitle="Balanced view: timeliness, quality, complexity and workload — not just task counts" />
      <Card className="mb-4"><RangeFilters f={f} setF={setF} /><SearchInput className="mt-3" value={q} onChange={setQ} placeholder="Filter by name…" /></Card>
      {isLoading ? <Loading /> : error ? <ErrorState error={error} /> : (
        <Card pad={false}><div className="px-4 sm:px-0">
          <DataTable rows={rows} onRowClick={(r: any) => nav(`/monitoring/employees/${r.id}`)} columns={[
            { key: 'name', header: 'Employee', render: (r: any) => <div><p className="font-medium">{r.name}</p><p className="muted text-xs">{r.department_name ?? '—'}</p></div> },
            { key: 'open', header: 'Open' }, { key: 'in_progress', header: 'Active' },
            { key: 'overdue_open', header: 'Overdue', render: (r: any) => <span className={r.overdue_open ? 'font-medium text-rose-600' : ''}>{r.overdue_open}</span> },
            { key: 'submitted', header: 'In review' }, { key: 'completed', header: 'Completed' },
            { key: 'on_time_rate', header: 'On-time', render: (r: any) => pct(r.on_time_rate) },
            { key: 'avg_quality', header: 'Quality', render: (r: any) => r.avg_quality ?? '—' },
            { key: 'revision_rate', header: 'Revisions', render: (r: any) => pct(r.revision_rate) },
            { key: 'weighted_output', header: 'Weighted output' },
            { key: 'hours_logged', header: 'Hours' },
            { key: 'last_update', header: 'Last update', render: (r: any) => <span className={!r.last_update || Date.now() - new Date(r.last_update).getTime() > 2 * 86400_000 ? 'text-amber-600' : ''}>{r.last_update ? fromNow(r.last_update) : 'never'}</span> },
            { key: 'reported_today', header: 'Report today', render: (r: any) => r.reported_today ? '✓' : <span className="muted">—</span> },
            { key: 'performance_score', header: 'Score', render: (r: any) => <b>{r.performance_score ?? '—'}</b> },
          ]}
          card={(r: any) => (
            <div className="space-y-1">
              <div className="flex justify-between gap-2"><p className="font-medium">{r.name}</p><b>{r.performance_score ?? '—'}</b></div>
              <p className="muted text-xs">{r.department_name} · open {r.open} · overdue <span className={r.overdue_open ? 'text-rose-600' : ''}>{r.overdue_open}</span> · done {r.completed} · on-time {pct(r.on_time_rate)}</p>
              <p className="muted text-xs">Last update {r.last_update ? fromNow(r.last_update) : 'never'} · {r.reported_today ? 'reported today' : 'no report today'}</p>
            </div>
          )} />
        </div></Card>
      )}
      <p className="muted mt-3 text-xs">Score = 35% on-time rate + 25% reviewer quality + 20% (1 − revision rate) + 20% complexity-weighted throughput vs. team median. Only approved completions count.</p>
    </div>
  );
}
