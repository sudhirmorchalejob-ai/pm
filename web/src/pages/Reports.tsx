import { useState } from 'react';
import { FileSpreadsheet, FileText } from 'lucide-react';
import { download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, humanize, money, todayIso } from '../lib/format';
import { useApi } from '../lib/hooks';
import { BarsChart, HBarChart } from '../components/charts';
import { Card, Chips, DataTable, ErrorState, Field, Loading, PageHeader, Select, Stat, StatusBadge } from '../components/ui';
import { toast } from '../components/Toast';

const TYPES = [
  { value: 'employees', label: 'Employee performance', perm: 'analytics.view' }, { value: 'departments', label: 'Department productivity', perm: 'monitoring.departments' },
  { value: 'projects', label: 'Project portfolio', perm: 'analytics.view' }, { value: 'tasks', label: 'Task detail', perm: 'analytics.view' }, { value: 'pipeline', label: 'Future pipeline', perm: 'analytics.view' },
];

export default function Reports() {
  const { can, user } = useAuth();
  const types = TYPES.filter((t) => can(t.perm) || (t.value === 'departments' && can('analytics.view_all')));
  const [type, setType] = useState(types[0]?.value ?? 'employees');
  const [period, setPeriod] = useState('monthly');
  const [date, setDate] = useState(todayIso());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(todayIso());
  const [dept, setDept] = useState('');
  const [project, setProject] = useState('');
  const { data: depts = [] } = useApi<any[]>(['departments'], can('org.view') ? '/org/departments' : null);
  const { data: projects } = useApi<any>(['projects-mini'], '/projects', { pageSize: 200 });
  const q = { period, date: period !== 'custom' ? date : undefined, from: period === 'custom' ? from || undefined : undefined, to: period === 'custom' ? to : undefined, department_id: dept || undefined, project_id: project || undefined };
  const { data, isLoading, error } = useApi<any>(['report', type], `/reports/${type}`, q);
  const exp = async (format: 'xlsx' | 'pdf') => { try { await download(`/reports/${type}`, { ...q, format }); } catch (e: any) { toast.error(e.message); } };
  const fmt = (k: string, v: any) => v == null ? '—' : k.includes('budget') ? money(v) : k.endsWith('_at') ? fmtDateTime(v) : /date|deadline|end$|start/.test(k) && typeof v === 'string' ? fmtDate(v) : k === 'status' || k === 'schedule' || k === 'approval_status' ? <StatusBadge status={v} /> : k.endsWith('rate') ? `${v}%` : typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10) / 10 : String(v);
  return (
    <div>
      <PageHeader title="Reports & analytics" subtitle="KPIs are computed from approved task records — see docs/KPIS.md for definitions"
        actions={can('reports.export') && <><button className="btn-secondary" onClick={() => exp('xlsx')}><FileSpreadsheet className="h-4 w-4" /> Excel</button><button className="btn-secondary" onClick={() => exp('pdf')}><FileText className="h-4 w-4" /> PDF</button></>} />
      <Card className="mb-4">
        <Chips value={type} onChange={setType} options={types} />
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Period"><Select value={period} onChange={setPeriod} options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }, { value: 'custom', label: 'Custom range' }]} /></Field>
          {period !== 'custom' ? <Field label="Reference date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field> : <>
            <Field label="From"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></>}
          {depts.length > 0 && user?.scope === 'organization' && <Field label="Department"><Select value={dept} onChange={setDept} placeholder="All" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} /></Field>}
          <Field label="Project"><Select value={project} onChange={setProject} placeholder="All" options={(projects?.items ?? []).map((p: any) => ({ value: p.id, label: p.name }))} /></Field>
        </div>
      </Card>
      {isLoading ? <Loading /> : error ? <ErrorState error={error} /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-lg font-semibold">{data.title}</h2><span className="muted text-sm">{fmtDate(data.from)} – {fmtDate(data.to)}</span></div>
          {data.summary && <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">{Object.entries(data.summary).map(([k, v]: any) => <Stat key={k} label={humanize(k)} value={k.includes('budget') ? money(v) : k.includes('rate') && v != null ? `${v}%` : v ?? '—'} />)}</div>}
          {type === 'employees' && data.rows.length > 0 && <Card title="Top 12 by weighted output (complexity of approved work)"><HBarChart data={[...data.rows].sort((a: any, b: any) => b.weighted_output - a.weighted_output).slice(0, 12)} label="name" value="weighted_output" valueLabel="Weighted output" /></Card>}
          {type === 'departments' && <Card title="Completed vs. pending"><BarsChart data={data.rows} x="name" series={[{ key: 'completed', label: 'Completed' }, { key: 'pending', label: 'Pending' }, { key: 'delayed', label: 'Delayed' }]} /></Card>}
          {type === 'projects' && <Card title="Progress by project"><HBarChart data={data.rows.filter((r: any) => !r.is_future)} label="name" value="progress" valueLabel="Progress %" /></Card>}
          <Card pad={false}><div className="px-4 sm:px-0">
            <DataTable rows={data.rows.map((r: any, i: number) => ({ ...r, id: r.id ?? i }))} columns={data.columns.map((c: any) => ({ key: c.key, header: c.header, render: (r: any) => fmt(c.key, r[c.key]) }))} />
          </div></Card>
        </div>
      )}
    </div>
  );
}
