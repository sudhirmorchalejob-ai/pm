import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CalendarRange, CheckCircle2, Plus, Rocket } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, humanize, money } from '../../lib/format';
import { useAction, useApi } from '../../lib/hooks';
import { BarsChart } from '../../components/charts';
import { Card, Chips, confirm, DataTable, Empty, ErrorState, Loading, PageHeader, Progress, Select, Stat, StatusBadge, Tabs } from '../../components/ui';
import { ProjectForm } from './ProjectForm';

const CHECKS: [string, string][] = [
  ['chk_requirements', 'Requirements completed'], ['chk_budget_approved', 'Budget approved'], ['chk_resources_identified', 'Resources identified'],
  ['chk_team_allocated', 'Team allocated'], ['chk_technology_selected', 'Technology selected'], ['chk_dependencies_resolved', 'Dependencies resolved'],
  ['chk_documentation', 'Documentation completed'], ['chk_management_approval', 'Management approval received'],
];

/** Readiness checklist + approval + one-click conversion (used on the project page). */
export function ReadinessPanel({ project, onChanged }: { project: any; onChanged?: () => void }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const fp = project.future;
  const inv = [['project', project.id], ['future']];
  const toggle = useAction((body: any) => api(`/future-projects/${project.id}`, { method: 'PATCH', body }), { invalidate: inv, onSuccess: onChanged });
  const convert = useAction((force: boolean) => api(`/future-projects/${project.id}/convert`, { body: { force, status: 'ready_to_start' } }),
    { invalidate: [...inv, ['projects']], success: 'Converted to an active project', onSuccess: () => { onChanged?.(); nav(`/projects/${project.id}`); } });
  if (!fp) return null;
  const manage = project.can_manage;
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Rocket className="h-4 w-4 text-brand-500" /> Future project readiness</span>}
      actions={<StatusBadge status={fp.approval_status} label={`Approval: ${humanize(fp.approval_status)}`} />}>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div><p className="muted text-xs">Expected start</p><p className="font-medium">{fmtDate(fp.expected_start_date)}</p></div>
        <div><p className="muted text-xs">Expected completion</p><p className="font-medium">{fmtDate(fp.expected_end_date)}</p></div>
        <div><p className="muted text-xs">Headcount · skills</p><p className="font-medium">{fp.required_employees} · {fp.required_skills.join(', ') || '—'}</p></div>
      </div>
      <div className="mb-3"><Progress value={fp.readiness_percent} tone={fp.readiness_percent === 100 ? 'bg-emerald-500' : 'bg-brand-500'} /></div>
      <ul className="grid gap-1 sm:grid-cols-2">
        {CHECKS.map(([k, l]) => {
          const locked = !manage || (k === 'chk_management_approval' && !can('approvals.decide'));
          return (
            <li key={k}><label className={clsx('flex min-h-[36px] items-center gap-2 rounded px-2 text-sm', !locked && 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800')}>
              <input type="checkbox" className="h-4 w-4" checked={fp[k]} disabled={locked || !!fp.converted_at} onChange={(e) => toggle.mutate({ [k]: e.target.checked })} />{l}
            </label></li>
          );
        })}
      </ul>
      {fp.expected_deliverables && <p className="mt-3 text-sm"><b>Expected deliverables:</b> {fp.expected_deliverables}</p>}
      {fp.converted_at ? <p className="mt-4 text-sm text-emerald-600"><CheckCircle2 className="mr-1 inline h-4 w-4" />Converted on {fmtDate(fp.converted_at)}</p> : manage && (
        <div className="mt-4 flex flex-wrap gap-2">
          {fp.approval_status === 'draft' && <button className="btn-secondary" onClick={() => toggle.mutate({ approval_status: 'pending' })}>Submit for approval</button>}
          {can('approvals.decide') && fp.approval_status !== 'approved' && <button className="btn-success" onClick={() => toggle.mutate({ approval_status: 'approved' })}>Approve</button>}
          {can('approvals.decide') && fp.approval_status === 'pending' && <button className="btn-danger" onClick={() => toggle.mutate({ approval_status: 'rejected' })}>Reject</button>}
          {can('future_projects.convert') && (
            <button className="btn-primary" onClick={async () => {
              const force = fp.readiness_percent < 100;
              if (await confirm({ title: 'Convert to active project?', confirmLabel: 'Convert', message: force ? `Readiness is ${fp.readiness_percent}%. Convert anyway? All planning data is kept.` : 'All planning data, members, risks and milestones are preserved.' })) convert.mutate(force);
            }}><Rocket className="h-4 w-4" /> Convert to active project</button>
          )}
        </div>
      )}
    </Card>
  );
}

export default function FutureProjects() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState('upcoming');
  const [creating, setCreating] = useState(false);
  const [horizon, setHorizon] = useState('');
  const { data, isLoading, error } = useApi<any>(['future'], '/future-projects', { horizon: horizon || undefined });
  return (
    <div>
      <PageHeader title="Future project planning" subtitle="Pipeline, roadmap and resource forecast — kept separate from active projects"
        actions={can('future_projects.manage') && <button className="btn-primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Plan future project</button>} />
      {data && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Planned projects" value={data.summary.total} icon={Rocket} />
          <Stat label="Starting ≤ 30 days" value={data.summary.starting_30_days} tone={data.summary.starting_30_days ? 'warn' : 'default'} />
          <Stat label="Approved" value={data.summary.approved} tone="good" />
          <Stat label="100% ready" value={data.summary.ready} />
          <Stat label="Avg readiness" value={`${data.summary.avg_readiness}%`} />
          <Stat label="Pipeline budget" value={money(data.summary.total_budget)} />
        </div>
      )}
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'upcoming', label: 'Upcoming' }, { value: 'pipeline', label: 'Pipeline' }, { value: 'roadmap', label: 'Quarterly roadmap' }, { value: 'calendar', label: 'Calendar' }, { value: 'forecast', label: 'Resource forecast' }]} />
      {error && <ErrorState error={error} />}
      {tab === 'upcoming' && (isLoading ? <Loading /> : (
        <Card pad={false}>
          <div className="border-b p-3"><Chips value={horizon} onChange={setHorizon} options={[{ value: '', label: 'All' }, { value: 'next_week', label: 'Next week' }, { value: 'next_month', label: 'Next month' }, { value: 'next_quarter', label: 'Next quarter' }, { value: 'six_months', label: '6 months' }, { value: 'next_year', label: 'Next year' }, { value: 'custom', label: 'Custom' }]} /></div>
          <div className="px-4 sm:px-0">
            <DataTable rows={data.items.map((i: any) => ({ ...i, id: i.project_id }))} onRowClick={(p: any) => nav(`/projects/${p.project_id}`)} empty={<Empty icon={Rocket} title="No future projects" />}
              columns={[
                { key: 'name', header: 'Project', render: (p: any) => <div><p className="font-medium">{p.name}</p><p className="muted text-xs">{p.code} · {humanize(p.planning_horizon)}</p></div> },
                { key: 'expected_start_date', header: 'Expected start', render: (p: any) => fmtDate(p.expected_start_date) },
                { key: 'manager_name', header: 'Tentative PM' }, { key: 'department_name', header: 'Department' },
                { key: 'approval_status', header: 'Approval', render: (p: any) => <StatusBadge status={p.approval_status} /> },
                { key: 'readiness_percent', header: 'Readiness', render: (p: any) => <div className="w-28"><Progress value={p.readiness_percent} /></div> },
                { key: 'required_employees', header: 'Headcount' },
                { key: 'estimated_budget', header: 'Budget', render: (p: any) => money(p.estimated_budget) },
              ]}
              card={(p: any) => (
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2"><p className="font-medium">{p.name}</p><StatusBadge status={p.approval_status} /></div>
                  <p className="muted text-xs">Starts {fmtDate(p.expected_start_date)} · {p.department_name ?? '—'} · {p.required_employees} people</p>
                  <Progress value={p.readiness_percent} />
                </div>
              )} />
          </div>
        </Card>
      ))}
      {tab === 'pipeline' && <Pipeline />}
      {tab === 'roadmap' && <Roadmap />}
      {tab === 'calendar' && <FutureCalendar items={data?.items ?? []} />}
      {tab === 'forecast' && <Forecast />}
      <ProjectForm open={creating} onClose={() => setCreating(false)} future />
    </div>
  );
}

function Pipeline() {
  const { data, isLoading } = useApi<any[]>(['future', 'pipeline'], '/future-projects/pipeline');
  if (isLoading) return <Loading />;
  return (
    <div className="scrollbar-thin -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-3 sm:mx-0 sm:grid sm:grid-cols-2 sm:px-0 xl:grid-cols-4">
      {data!.map((col) => (
        <div key={col.stage} className="w-[80vw] shrink-0 snap-start rounded-xl bg-slate-100 p-2 dark:bg-slate-900/60 sm:w-auto">
          <div className="flex items-center justify-between px-1.5 pb-2"><StatusBadge status={col.stage} /><span className="muted text-xs">{col.items.length}</span></div>
          <div className="space-y-2">
            {col.items.map((p: any) => (
              <Link key={p.project_id} to={`/projects/${p.project_id}`} className="card block p-3 hover:shadow-md">
                <p className="text-sm font-medium">{p.name}</p><p className="muted text-xs">Starts {fmtDate(p.expected_start_date)} · {money(p.estimated_budget)}</p>
                <div className="mt-2"><Progress value={p.readiness_percent} /></div>
              </Link>
            ))}
            {!col.items.length && <p className="muted px-2 py-3 text-center text-xs">Empty</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Roadmap() {
  const [year, setYear] = useState(new Date().getFullYear());
  const { data, isLoading } = useApi<any>(['future', 'roadmap', year], '/future-projects/roadmap', { year });
  return (
    <Card title={<span className="inline-flex items-center gap-2"><CalendarRange className="h-4 w-4" /> Roadmap {year}</span>}
      actions={<Select className="w-auto" value={year} onChange={(v) => setYear(Number(v))} options={[-1, 0, 1, 2].map((d) => ({ value: new Date().getFullYear() + d, label: String(new Date().getFullYear() + d) }))} />}>
      {isLoading ? <Loading /> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {data.quarters.map((q: any) => (
            <div key={q.quarter} className="rounded-lg border p-3">
              <p className="mb-2 text-sm font-semibold">{q.quarter}</p>
              <ul className="space-y-1.5">
                {q.items.map((p: any) => (
                  <li key={p.id}><Link to={`/projects/${p.id}`} className={clsx('block rounded-md border-l-4 bg-slate-50 px-2 py-1.5 text-xs hover:bg-slate-100 dark:bg-slate-800/60 dark:hover:bg-slate-800', p.is_future ? 'border-indigo-300' : 'border-brand-600')}>
                    <span className="font-medium">{p.name}</span><span className="muted block">{p.is_future ? `Planned · ${p.readiness_percent}% ready` : `${humanize(p.status)} · ${p.progress}%`}</span>
                  </Link></li>
                ))}
                {!q.items.length && <li className="muted text-xs">Nothing scheduled</li>}
              </ul>
            </div>
          ))}
        </div>
      )}
      <p className="muted mt-3 text-xs">Dark border = active project, light border = future (planned) project.</p>
    </Card>
  );
}

function FutureCalendar({ items }: { items: any[] }) {
  const byMonth = new Map<string, any[]>();
  for (const i of [...items].sort((a, b) => a.expected_start_date.localeCompare(b.expected_start_date))) {
    const k = i.expected_start_date.slice(0, 7);
    byMonth.set(k, [...(byMonth.get(k) ?? []), i]);
  }
  return (
    <Card title="Future project calendar">
      {!items.length ? <Empty /> : (
        <ol className="space-y-4">
          {[...byMonth.entries()].map(([m, list]) => (
            <li key={m}><p className="section-title mb-1">{new Date(`${m}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</p>
              <ul className="divide-y rounded-lg border">{list.map((p) => <li key={p.project_id}><Link to={`/projects/${p.project_id}`} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-800"><span className="w-16 shrink-0 font-semibold">{fmtDate(p.expected_start_date).slice(0, 6)}</span><span className="flex-1 truncate">{p.name}</span><StatusBadge status={p.approval_status} /></Link></li>)}</ul>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function Forecast() {
  const [months, setMonths] = useState(6);
  const { data, isLoading } = useApi<any>(['future', 'forecast', months], '/future-projects/forecast', { months });
  if (isLoading) return <Loading />;
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2"><span className="text-sm">Horizon</span><Chips value={String(months)} onChange={(v) => setMonths(Number(v))} options={['3', '6', '12', '24'].map((m) => ({ value: m, label: `${m} months` }))} /></div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3"><Stat label="Projects starting" value={data.projects} /><Stat label="Headcount required" value={data.headcount_required} /><Stat label="Skills with a gap" value={data.skills.filter((s: any) => s.gap > 0).length} tone="warn" /></div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Headcount required by start month"><BarsChart data={data.headcount_by_month} x="month" series={[{ key: 'required', label: 'People required' }]} /></Card>
        <Card title="Skill demand vs. available people (level ≥ 3)" pad={false}>
          <DataTable rows={data.skills.map((s: any, i: number) => ({ ...s, id: i }))} empty={<Empty title="No skill requirements recorded" />}
            columns={[{ key: 'skill', header: 'Skill' }, { key: 'required', header: 'Projects needing' }, { key: 'available', header: 'Available people' },
              { key: 'gap', header: 'Gap', render: (s: any) => s.gap ? <span className="font-medium text-rose-600">−{s.gap}</span> : <span className="text-emerald-600">OK</span> },
              { key: 'projects', header: 'Projects', render: (s: any) => <span className="text-xs">{s.projects.join(', ')}</span> }]} />
        </Card>
      </div>
    </div>
  );
}
