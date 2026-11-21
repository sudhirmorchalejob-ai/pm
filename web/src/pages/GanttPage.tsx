import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { humanize } from '../lib/format';
import { useApi } from '../lib/hooks';
import { Gantt } from '../components/Gantt';
import { Card, Chips, Loading, PageHeader, Select, UserPicker } from '../components/ui';

export default function GanttPage() {
  const { can } = useAuth();
  const [projectId, setProjectId] = useState('');
  const [deptId, setDeptId] = useState('');
  const [employee, setEmployee] = useState<number | null>(null);
  const [status, setStatus] = useState<string[]>([]);
  const [future, setFuture] = useState(true);
  const { data: projects } = useApi<any>(['projects-mini'], '/projects', { pageSize: 200 });
  const { data: depts = [] } = useApi<any[]>(['departments'], can('org.view') ? '/org/departments' : null);
  const { data, isLoading } = useApi<any>(['gantt-page'], '/gantt', { project_id: projectId || undefined, department_id: deptId || undefined, employee_id: employee ?? undefined, status, include_future: future ? 'true' : 'false' });
  const statuses = projectId ? ['not_started', 'in_progress', 'blocked', 'submitted', 'completed'] : ['planned', 'in_progress', 'on_hold', 'completed', 'proposed'];
  return (
    <div>
      <PageHeader title="Gantt & timeline" subtitle={projectId ? 'Tasks, dependencies and milestones' : 'Portfolio timeline — select a project for task-level detail'} />
      <Card className="mb-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Select value={projectId} onChange={(v) => { setProjectId(v); setStatus([]); }} placeholder="All projects (portfolio)" options={(projects?.items ?? []).map((p: any) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} />
          {depts.length > 0 && <Select value={deptId} onChange={setDeptId} placeholder="All departments" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} />}
          {projectId && <UserPicker value={employee} onChange={setEmployee} placeholder="Filter by employee…" />}
          {!projectId && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={future} onChange={(e) => setFuture(e.target.checked)} /> Include future projects</label>}
        </div>
        <div className="mt-3"><Chips multi value={status} onChange={setStatus} options={statuses.map((s) => ({ value: s, label: humanize(s) }))} /></div>
      </Card>
      <Card>{isLoading ? <Loading /> : <Gantt items={data.items} dependencies={data.dependencies} milestones={data.milestones} />}</Card>
    </div>
  );
}
