import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Rocket } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { fmtDate, humanize, money } from '../../lib/format';
import { useApi, useDebounced } from '../../lib/hooks';
import { Card, Chips, DataTable, ErrorState, Loading, PageHeader, Pagination, PriorityBadge, Progress, SearchInput, Select, StatusBadge } from '../../components/ui';
import { ProjectForm } from './ProjectForm';

const ACTIVE = 'approved,planned,ready_to_start,in_progress,on_hold';

export default function ProjectsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [status, setStatus] = useState(ACTIVE);
  const [dept, setDept] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('end:asc');
  const [creating, setCreating] = useState(false);
  const { data: depts = [] } = useApi<any[]>(['departments'], can('org.view') ? '/org/departments' : null);
  const { data, isLoading, error } = useApi<any>(['projects'], '/projects', { q: dq, status, future: 'false', department_id: dept || undefined, page, sort });
  return (
    <div>
      <PageHeader title="Projects" subtitle="Active portfolio — future projects are planned separately"
        actions={<>
          <Link to="/future-projects" className="btn-secondary"><Rocket className="h-4 w-4" /> Future projects</Link>
          {can('projects.create') && <button className="btn-primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New project</button>}
        </>} />
      <Card className="mb-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search by name, code or client" />
          {depts.length > 0 && <Select value={dept} onChange={(v) => { setDept(v); setPage(1); }} placeholder="All departments" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} />}
        </div>
        <div className="mt-3"><Chips value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[{ value: ACTIVE, label: 'Active' }, { value: 'in_progress', label: 'In progress' }, { value: 'on_hold', label: 'On hold' }, { value: 'proposed,under_evaluation', label: 'Proposed' }, { value: 'completed', label: 'Completed' }, { value: 'cancelled', label: 'Cancelled' }, { value: '', label: 'All' }]} /></div>
      </Card>
      {isLoading ? <Loading /> : error ? <ErrorState error={error} /> : (
        <Card pad={false}>
          <div className="px-4 sm:px-0">
            <DataTable rows={data.items} sort={sort} onSort={setSort} onRowClick={(p: any) => nav(`/projects/${p.id}`)}
              columns={[
                { key: 'name', header: 'Project', sortable: true, render: (p: any) => <div className="min-w-[180px]"><p className="font-medium">{p.name}</p><p className="muted text-xs">{p.code}{p.client_name ? ` · ${p.client_name}` : ''}</p></div> },
                { key: 'status', header: 'Status', render: (p: any) => <StatusBadge status={p.status} /> },
                { key: 'priority', header: 'Priority', sortable: true, render: (p: any) => <PriorityBadge priority={p.priority} /> },
                { key: 'manager_name', header: 'PM' },
                { key: 'department_name', header: 'Department' },
                { key: 'progress', header: 'Progress', sortable: true, render: (p: any) => <div className="w-28"><Progress value={p.progress} /></div> },
                { key: 'end', header: 'Due', sortable: true, render: (p: any) => fmtDate(p.end_date) },
                { key: 'tasks', header: 'Tasks', render: (p: any) => <span>{p.task_count}{p.overdue_count > 0 && <span className="ml-1 text-xs text-rose-600">({p.overdue_count} late)</span>}</span> },
                { key: 'budget', header: 'Budget', render: (p: any) => money(p.estimated_budget) },
              ]}
              card={(p: any) => (
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2"><div><p className="font-medium">{p.name}</p><p className="muted text-xs">{p.code} · {p.manager_name ?? 'No PM'}</p></div><StatusBadge status={p.status} /></div>
                  <Progress value={p.progress} />
                  <p className="muted text-xs">Due {fmtDate(p.end_date)} · {p.task_count} tasks{p.overdue_count ? ` · ${p.overdue_count} late` : ''} · {humanize(p.priority)}</p>
                </div>
              )} />
            <div className="pb-4"><Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></div>
          </div>
        </Card>
      )}
      <ProjectForm open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
