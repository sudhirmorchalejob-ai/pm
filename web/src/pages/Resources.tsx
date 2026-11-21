import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { fmtDate, humanize } from '../lib/format';
import { useApi } from '../lib/hooks';
import { BarsChart, Meter } from '../components/charts';
import { Card, DataTable, Empty, Loading, PageHeader, SearchInput, Select, Stat, Tabs } from '../components/ui';

export default function Resources() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [dept, setDept] = useState('');
  const [skill, setSkill] = useState('');
  const [tab, setTab] = useState('people');
  const { data: depts = [] } = useApi<any[]>(['departments'], can('org.view') ? '/org/departments' : null);
  const { data: skills = [] } = useApi<any[]>(['skills'], '/org/skills');
  const { data, isLoading } = useApi<any>(['resources'], '/resources', { department_id: dept || undefined, skill: skill || undefined });
  return (
    <div>
      <PageHeader title="Resource planning" subtitle="Skills, availability, current load and future demand" />
      <Card className="mb-4"><div className="grid gap-2 sm:grid-cols-2 lg:w-2/3">
        {depts.length > 0 && <Select value={dept} onChange={setDept} placeholder="All departments" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} />}
        <Select value={skill} onChange={setSkill} placeholder="Any skill" options={skills.map((s: any) => ({ value: s.name, label: `${s.name} (${s.people})` }))} />
      </div></Card>
      {isLoading ? <Loading /> : <>
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="People" value={data.people.length} />
          <Stat label="Overloaded" value={data.overloaded.length} tone={data.overloaded.length ? 'danger' : 'default'} icon={AlertTriangle} hint={`> ${data.threshold}% of capacity`} />
          <Stat label="Under-utilised (<40%)" value={data.underutilized.length} />
          <Stat label="Open resource needs" value={data.shortages.length} tone={data.shortages.length ? 'warn' : 'default'} />
        </div>
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'people', label: 'People & availability' }, { value: 'departments', label: 'Department capacity' }, { value: 'shortages', label: 'Shortages & demand', count: data.shortages.length }]} />
        {tab === 'people' && <Card pad={false}><div className="px-4 sm:px-0"><DataTable rows={data.people} onRowClick={(p: any) => nav(`/monitoring/employees/${p.id}`)} columns={[
          { key: 'name', header: 'Employee', render: (p: any) => <span><span className="block font-medium">{p.name}</span><span className="muted text-xs">{p.designation} · {p.department_name ?? '—'}</span></span> },
          { key: 'skills', header: 'Skills', render: (p: any) => <span className="flex max-w-xs flex-wrap gap-1">{p.skills.map((s: any) => <span key={s.name} className="badge bg-slate-100 dark:bg-slate-800">{s.name} {s.level}</span>)}</span> },
          { key: 'status', header: 'Availability', render: (p: any) => p.employment_status === 'on_leave' ? <span className="text-amber-600">On leave</span> : `${p.available_hours} h free` },
          { key: 'open_tasks', header: 'Open tasks' }, { key: 'load', header: 'Load h/wk', render: (p: any) => Math.round(p.load_hours_week) },
          { key: 'utilization', header: 'Utilisation', render: (p: any) => <Meter value={Math.min(p.utilization, 300)} /> },
          { key: 'project_allocation', header: 'Project alloc.', render: (p: any) => <span className={p.project_allocation > 100 ? 'text-rose-600' : ''}>{p.project_allocation}%</span> },
          { key: 'projects', header: 'Assignments', render: (p: any) => <span className="text-xs">{p.projects.map((x: any) => x.name).join(', ') || '—'}</span> },
        ]} /></div></Card>}
        {tab === 'departments' && <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Capacity vs. load (hours / week)"><BarsChart data={data.departments} x="department" series={[{ key: 'capacity', label: 'Capacity' }, { key: 'load', label: 'Current load' }]} /></Card>
          <Card pad={false}><DataTable rows={data.departments.map((d: any, i: number) => ({ ...d, id: i }))} columns={[{ key: 'department', header: 'Department' }, { key: 'people', header: 'People' }, { key: 'capacity', header: 'Capacity h' }, { key: 'load', header: 'Load h' }, { key: 'utilization', header: 'Utilisation', render: (d: any) => <Meter value={d.utilization} /> }, { key: 'overloaded', header: 'Overloaded' }]} /></Card>
        </div>}
        {tab === 'shortages' && <Card pad={false}><div className="px-4 sm:px-0"><DataTable rows={data.shortages} empty={<Empty title="No unfilled resource requirements" />} columns={[
          { key: 'project', header: 'Project', render: (r: any) => <Link className="text-brand-600" to={`/projects/${r.project_id}?tab=resources`}>{r.project_code} {r.project_name}</Link> },
          { key: 'need', header: 'Need', render: (r: any) => `${r.required_count} × ${r.skill_name ?? r.department_name ?? 'resource'}` },
          { key: 'hours_per_week', header: 'h/week' }, { key: 'period', header: 'From', render: (r: any) => fmtDate(r.start_date) },
          { key: 'skilled_people', header: 'Skilled people (≥3)', render: (r: any) => r.skill_id ? <span className={r.skilled_people < r.required_count ? 'font-medium text-rose-600' : ''}>{r.skilled_people}</span> : '—' },
          { key: 'status', header: 'Status', render: (r: any) => humanize(r.status) }, { key: 'future', header: '', render: (r: any) => r.is_future ? <span className="badge bg-indigo-100 text-indigo-700">future</span> : null },
        ]} /></div><p className="muted px-4 pb-4 text-xs">See also the <Link className="text-brand-600" to="/future-projects">future project resource forecast</Link>.</p></Card>}
      </>}
    </div>
  );
}
export { SearchInput };
