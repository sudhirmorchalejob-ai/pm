import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { format, subDays } from 'date-fns';
import { AlertTriangle, Building2, CheckCircle2, Clock, Eye, UserCheck, UserX } from 'lucide-react';
import { fmtDate, fmtDateTime, humanize, pct } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { HBarChart, LinesChart } from '../../components/charts';
import { Card, DataTable, Empty, ErrorState, Field, KV, Loading, Modal, PageHeader, Progress, SearchInput, Select, Stat, StatusBadge, Tabs, UserPicker } from '../../components/ui';
import { FileChips } from './answers';
import { RevisionsModal } from './MyChecklist';

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

export default function Compliance() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'overview';
  return (
    <div>
      <PageHeader title="Checklist compliance" subtitle="Daily questionnaire submissions across departments and employees." />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} tabs={[{ value: 'overview', label: 'Dashboard' }, { value: 'day', label: 'Submissions by day' }]} />
      {tab === 'overview' ? <Overview /> : <ByDay />}
    </div>
  );
}

function Overview() {
  const [from, setFrom] = useState(iso(subDays(new Date(), 6)));
  const [to, setTo] = useState(iso(new Date()));
  const [dept, setDept] = useState('');
  const [user, setUser] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [history, setHistory] = useState<number | null>(null);
  const [company, setCompany] = useState('');
  const { data: depts = [] } = useApi<any[]>(['departments'], '/org/departments');
  const { data: companies = [] } = useApi<any[]>(['companies'], '/org/companies');
  const { data, isLoading, error, refetch } = useApi<any>(['compliance', from, to, dept, company, user, status], '/checklists/dashboard', { from, to, department_id: dept, company_id: company || undefined, user_id: user, status });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Field label="From"><input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Department"><Select value={dept} onChange={setDept} placeholder="All departments" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} /></Field>
        {companies.length > 0 && <Field label="Company"><Select value={company} onChange={setCompany} placeholder="All companies" options={companies.map((c: any) => ({ value: c.id, label: c.name }))} /></Field>}
        <Field label="Status"><Select value={status} onChange={setStatus} placeholder="Any status" options={[{ value: 'submitted', label: 'Completed' }, { value: 'in_progress', label: 'In progress' }, { value: 'pending', label: 'Not started' }, { value: 'overdue', label: 'Overdue' }, { value: 'late', label: 'Completed late' }]} /></Field>
        <Field label="Employee" className="col-span-2 md:col-span-1"><UserPicker value={user} onChange={setUser} placeholder="All employees" departmentId={dept ? Number(dept) : null} /></Field>
      </div>
      {isLoading ? <Loading /> : error ? <ErrorState error={error} onRetry={refetch} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Stat label="Active employees" value={data.people.active_employees} icon={UserCheck} />
            <Stat label="Deactivated employees" value={data.people.deactivated_employees} icon={UserX} />
            <Stat label="Departments" value={data.people.departments} icon={Building2} />
            <Stat label="Compliance today" value={pct(data.daily.compliance)} hint={`${data.daily.completed}/${data.daily.total} complete`} tone="brand" />
            <Stat label="Compliance, last 7 days" value={pct(data.weekly.compliance)} hint={`${data.weekly.completed}/${data.weekly.total} complete`} tone="brand" />
            <Stat label="Completed (range)" value={data.totals.completed} hint={`${data.totals.late} late`} tone="good" icon={CheckCircle2} />
            <Stat label="Pending (range)" value={data.totals.pending} icon={Clock} tone={data.totals.pending ? 'warn' : 'default'} />
            <Stat label="Overdue now" value={data.totals.overdue} icon={AlertTriangle} tone={data.totals.overdue ? 'danger' : 'default'} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Daily compliance (%)"><LinesChart data={data.by_day.map((d: any) => ({ ...d, day: fmtDate(d.date).slice(0, 6) }))} x="day" series={[{ key: 'compliance', label: 'Compliance %' }]} yMax={100} /></Card>
            <Card title="Compliance by department (%)"><HBarChart data={data.by_department.filter((d: any) => d.compliance !== null)} label="department_name" value="compliance" valueLabel="Compliance %" format={(v) => `${v}%`} /></Card>
          </div>
          <Card title="Department-wise submissions" pad={false}>
            <div className="px-4 sm:px-0">
              <DataTable rows={data.by_department.map((d: any) => ({ ...d, id: d.department_id ?? 'none' }))} empty={<Empty title="No checklists in this range" />} columns={[
                { key: 'department_name', header: 'Department' },
                { key: 'total', header: 'Checklists' },
                { key: 'completed', header: 'Completed' },
                { key: 'pending', header: 'Pending' },
                { key: 'overdue', header: 'Overdue', render: (r: any) => (r.overdue ? <span className="text-rose-600">{r.overdue}</span> : 0) },
                { key: 'late', header: 'Late' },
                { key: 'avg_completion', header: 'Avg completion', render: (r: any) => <div className="w-28"><Progress value={r.avg_completion} /></div> },
                { key: 'compliance', header: 'Compliance', render: (r: any) => pct(r.compliance) },
              ]} />
            </div>
          </Card>
          <Card title="Employee-wise submissions" pad={false}>
            <div className="px-4 sm:px-0">
              <DataTable rows={data.by_employee.map((e: any) => ({ ...e, id: e.user_id }))} onRowClick={(r: any) => setHistory(r.user_id)} empty={<Empty title="No checklists in this range" />} columns={[
                { key: 'name', header: 'Employee', render: (r: any) => <span>{r.name}{!r.is_active && <span className="muted"> (deactivated)</span>}</span> },
                { key: 'department_name', header: 'Department', render: (r: any) => r.department_name ?? '—' },
                { key: 'total', header: 'Checklists' },
                { key: 'completed', header: 'Completed' },
                { key: 'late', header: 'Late' },
                { key: 'missed', header: 'Missed', render: (r: any) => (r.missed ? <span className="text-rose-600">{r.missed}</span> : 0) },
                { key: 'compliance', header: 'Compliance', render: (r: any) => pct(r.compliance) },
                { key: 'last_submitted_at', header: 'Last completed', render: (r: any) => (r.last_submitted_at ? fmtDateTime(r.last_submitted_at) : '—') },
              ]} />
            </div>
          </Card>
          <Card title={`Overdue responses (${data.overdue.length})`} pad={false}>
            <div className="px-4 sm:px-0">
              <DataTable rows={data.overdue} onRowClick={(r: any) => setHistory(r.user_id)} empty={<Empty icon={CheckCircle2} title="Nothing overdue" />} columns={[
                { key: 'date', header: 'Date', render: (r: any) => fmtDate(r.date) },
                { key: 'name', header: 'Employee' },
                { key: 'department_name', header: 'Department', render: (r: any) => r.department_name ?? '—' },
                { key: 'missing', header: 'Mandatory unanswered', render: (r: any) => r.required_items - r.required_answered },
                { key: 'due_at', header: 'Deadline', render: (r: any) => fmtDateTime(r.due_at) },
                { key: 'completion_percent', header: 'Completion', render: (r: any) => <div className="w-28"><Progress value={r.completion_percent} /></div> },
              ]} />
            </div>
          </Card>
        </>
      )}
      {history && <EmployeeHistory userId={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function ByDay() {
  const [date, setDate] = useState(iso(new Date()));
  const [dept, setDept] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [view, setView] = useState<{ userId: number; date: string } | null>(null);
  const [company, setCompany] = useState('');
  const { data: depts = [] } = useApi<any[]>(['departments'], '/org/departments');
  const { data: companies = [] } = useApi<any[]>(['companies'], '/org/companies');
  const { data, isLoading } = useApi<any>(['checklist-team', date, dept, company, status, q], '/checklists/team', { date, department_id: dept, company_id: company || undefined, status, q });
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Department"><Select value={dept} onChange={setDept} placeholder="All departments" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} /></Field>
        <Field label="Company"><Select value={company} onChange={setCompany} placeholder="All companies" options={companies.map((c: any) => ({ value: c.id, label: c.name }))} /></Field>
        <Field label="Status"><Select value={status} onChange={setStatus} placeholder="Any status" options={[{ value: 'submitted', label: 'Completed' }, { value: 'in_progress', label: 'In progress' }, { value: 'pending', label: 'Not started' }, { value: 'overdue', label: 'Overdue' }, { value: 'none', label: 'No checklist' }]} /></Field>
        <Field label="Search"><SearchInput value={q} onChange={setQ} placeholder="Employee name" /></Field>
      </div>
      <Card pad={false}>
        {isLoading ? <Loading /> : (
          <div className="px-4 sm:px-0">
            <DataTable rows={(data?.rows ?? []).map((r: any) => ({ ...r, id: r.user_id }))} onRowClick={(r: any) => r.checklist_id && setView({ userId: r.user_id, date })} empty={<Empty title="Nobody matches these filters" />} columns={[
              { key: 'name', header: 'Employee', render: (r: any) => <span>{r.name}{!r.is_active && <span className="muted"> (deactivated)</span>}</span> },
              { key: 'department_name', header: 'Department', render: (r: any) => r.department_name ?? '—' },
              { key: 'status', header: 'Status', render: (r: any) => !r.checklist_id ? <span className="muted text-xs">No questions</span> : r.status === 'submitted' ? <StatusBadge status={r.is_late ? 'late' : 'completed'} label={r.is_late ? 'Complete (late)' : 'Complete'} /> : r.overdue ? <StatusBadge status="missed" label="Overdue" /> : <StatusBadge status={r.status === 'in_progress' ? 'in_progress' : 'pending'} label={r.status === 'in_progress' ? 'In progress' : 'Not started'} /> },
              { key: 'answered', header: 'Answered', render: (r: any) => (r.checklist_id ? `${r.answered_items}/${r.total_items}` : '—') },
              { key: 'mandatory', header: 'Mandatory left', render: (r: any) => (r.checklist_id ? r.required_items - r.required_answered : '—') },
              { key: 'completion_percent', header: 'Completion', render: (r: any) => (r.checklist_id ? <div className="w-28"><Progress value={r.completion_percent} /></div> : '—') },
              { key: 'due_at', header: 'Deadline', render: (r: any) => (r.due_at ? fmtDateTime(r.due_at) : '—') },
              { key: 'view', header: '', render: (r: any) => (r.checklist_id ? <Eye className="h-4 w-4 text-slate-400" aria-label="View answers" /> : null) },
            ]} />
          </div>
        )}
      </Card>
      {view && <ChecklistView userId={view.userId} date={view.date} onClose={() => setView(null)} />}
    </div>
  );
}

/** Read-only view of one employee's checklist (answers, unanswered, revisions). */
export function ChecklistView({ userId, date, onClose }: { userId: number; date: string; onClose: () => void }) {
  const { data, isLoading } = useApi<any>(['checklist-user', userId, date], `/checklists/users/${userId}`, { date });
  const [rev, setRev] = useState<any>(null);
  const cl = data?.checklist;
  return (
    <Modal open onClose={onClose} title={data ? `${data.employee.name} — ${fmtDate(date)}` : 'Checklist'} size="xl">
      {isLoading ? <Loading /> : !cl ? <Empty title="No checklist on this date" /> : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <StatusBadge status={cl.status === 'submitted' ? (cl.is_late ? 'late' : 'completed') : cl.overdue ? 'missed' : cl.status === 'in_progress' ? 'in_progress' : 'pending'}
              label={cl.status === 'submitted' ? (cl.is_late ? 'Complete (late)' : 'Complete') : cl.overdue ? 'Overdue' : cl.status === 'in_progress' ? 'In progress' : 'Not started'} />
            <span className="muted">{cl.answered_items}/{cl.total_items} answered · due {fmtDateTime(cl.due_at)}</span>
            <div className="w-40"><Progress value={cl.completion_percent} /></div>
          </div>
          <ul className="divide-y rounded-lg border dark:divide-slate-800 dark:border-slate-800">
            {cl.items.filter((i: any) => i.applicable || i.status === 'submitted').map((i: any) => (
              <li key={i.id} className="px-3 py-2.5 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">{i.question_text}{i.is_required && <span className="text-rose-600">*</span>}<span className="muted ml-2 text-xs font-normal">{i.section_name}</span></span>
                  {i.status === 'submitted' ? <span className="muted text-xs">{i.is_late ? 'late · ' : ''}{fmtDateTime(i.submitted_at)}{i.revision > 1 && <button className="ml-2 text-brand-600 hover:underline" onClick={() => setRev(i)}>{i.revision} versions</button>}</span>
                    : <span className="text-xs text-rose-600">{i.status === 'draft' ? 'Draft only — not submitted' : 'Not answered'}</span>}
                </div>
                {i.status === 'submitted' && <p className="mt-1 whitespace-pre-wrap break-words">{i.answer_text}</p>}
                {i.note && i.status === 'submitted' && <p className="muted mt-0.5 text-xs">Note: {i.note}</p>}
                {i.status === 'submitted' && <FileChips ids={i.file_ids} names={cl.files} />}
              </li>
            ))}
          </ul>
          {rev && <RevisionsModal item={rev} onClose={() => setRev(null)} />}
        </div>
      )}
    </Modal>
  );
}

function EmployeeHistory({ userId, onClose }: { userId: number; onClose: () => void }) {
  const [from, setFrom] = useState(iso(subDays(new Date(), 29)));
  const [to, setTo] = useState(iso(new Date()));
  const [view, setView] = useState<string | null>(null);
  const { data, isLoading } = useApi<any>(['checklist-history-user', userId, from, to], `/checklists/history/${userId}`, { from, to });
  return (
    <Modal open onClose={onClose} title={data ? `${data.employee.name} — performance history` : 'Performance history'} size="xl">
      {isLoading || !data ? <Loading /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:w-96"><Field label="From"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
          <KV items={[
            ['Department', data.employee.department_name], ['Designation', data.employee.designation], ['Status', data.employee.is_active ? humanize(data.employee.employment_status) : 'Deactivated'],
            ['Checklist compliance', `${pct(data.summary.compliance)} (${data.summary.completed}/${data.summary.checklists})`], ['Late / missed', `${data.summary.late} / ${data.summary.missed}`], ['Average completion', pct(data.summary.avg_completion)],
            ...(data.task_kpis ? [['Tasks completed (approved)', data.task_kpis.completed], ['On-time rate', pct(data.task_kpis.on_time_rate)], ['Performance score', data.task_kpis.performance_score ?? '—']] as [string, any][] : []),
          ]} />
          <div>
            <h3 className="section-title mb-2">Checklists</h3>
            <DataTable rows={data.days} onRowClick={(r: any) => setView(r.date)} empty={<Empty title="No checklists in this range" />} columns={[
              { key: 'date', header: 'Date', render: (r: any) => fmtDate(r.date) },
              { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status === 'submitted' ? (r.is_late ? 'late' : 'completed') : r.date < to ? 'missed' : 'pending'} label={r.status === 'submitted' ? (r.is_late ? 'Late' : 'Complete') : r.status === 'in_progress' ? 'Partial' : 'Not submitted'} /> },
              { key: 'answered', header: 'Answered', render: (r: any) => `${r.answered_items}/${r.total_items}` },
              { key: 'completion_percent', header: 'Completion', render: (r: any) => <div className="w-28"><Progress value={r.completion_percent} /></div> },
              { key: 'department_name', header: 'Department', render: (r: any) => r.department_name ?? '—' },
            ]} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div><h3 className="section-title mb-2">Department history</h3>
              <ul className="space-y-1 text-sm">{data.department_history.map((h: any) => <li key={h.id}><span className="font-medium">{h.department_name ?? 'No department'}</span>{h.team_name ? ` · ${h.team_name}` : ''}<span className="muted block text-xs">{fmtDate(h.effective_from)} – {h.effective_to ? fmtDate(h.effective_to) : 'now'}{h.reason ? ` · ${h.reason}` : ''}{h.changed_by_name ? ` · by ${h.changed_by_name}` : ''}</span></li>)}</ul>
            </div>
            <div><h3 className="section-title mb-2">Activation history</h3>
              <ul className="space-y-1 text-sm">{data.status_history.map((h: any) => <li key={h.id}><span className="font-medium">{h.is_active ? 'Active' : 'Deactivated'}</span> · {humanize(h.employment_status)}<span className="muted block text-xs">{fmtDateTime(h.changed_at)}{h.reason ? ` · ${h.reason}` : ''}{h.changed_by_name ? ` · by ${h.changed_by_name}` : ''}</span></li>)}</ul>
            </div>
          </div>
          {view && <ChecklistView userId={userId} date={view} onClose={() => setView(null)} />}
        </div>
      )}
    </Modal>
  );
}
