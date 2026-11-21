import { useEffect, useState } from 'react';
import { CheckCircle2, MessageSquareWarning, UserX } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, todayIso } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { BarsChart } from '../components/charts';
import { Card, Chips, confirm, DataTable, Empty, Field, Loading, Modal, PageHeader, Pagination, Stat, StatusBadge, Tabs } from '../components/ui';

export default function DailyReports() {
  const { can } = useAuth();
  const [tab, setTab] = useState(can('reports.daily.submit') ? 'submit' : 'team');
  return (
    <div>
      <PageHeader title="Daily work reports" />
      <Tabs value={tab} onChange={setTab} tabs={[
        ...(can('reports.daily.submit') ? [{ value: 'submit', label: 'My report' }, { value: 'history', label: 'My history' }] : []),
        ...(can('reports.daily.review', 'monitoring.employees') ? [{ value: 'team', label: 'Team reports' }, { value: 'missing', label: 'Not submitted' }] : []),
        { value: 'summary', label: 'Summaries' },
      ]} />
      {tab === 'submit' && <SubmitForm />}
      {tab === 'history' && <History />}
      {tab === 'team' && <TeamReports />}
      {tab === 'missing' && <Missing />}
      {tab === 'summary' && <Summary />}
    </div>
  );
}

const FIELDS: [string, string, boolean][] = [
  ['work_planned', 'Work planned', false], ['work_completed', 'Work completed *', true], ['work_pending', 'Work pending', false],
  ['delay_reason', 'Reason for delays', false], ['challenges', 'Challenges', false], ['next_actions', 'Next actions', false], ['support_required', 'Support required', false],
];

function SubmitForm() {
  const [date, setDate] = useState(todayIso());
  const { data: mine } = useApi<any>(['dr-mine'], '/daily-reports/mine', { pageSize: 30 });
  const existing = mine?.items?.find((r: any) => r.report_date === date);
  const [f, setF] = useState<any>({});
  useEffect(() => { setF(existing ? { ...existing } : { hours_spent: 8 }); }, [existing?.id, date]);
  const save = useAction(() => api('/daily-reports', { body: {
    report_date: date, hours_spent: Number(f.hours_spent), ...Object.fromEntries(FIELDS.map(([k]) => [k, f[k] || (k === 'work_completed' ? '' : null)])),
  } }), { invalidate: [['dr-mine'], ['dr-summary']], success: existing ? 'Report updated' : 'Report submitted' });
  const locked = existing?.status === 'reviewed';
  return (
    <Card title={<span className="flex flex-wrap items-center gap-2">Report for <input type="date" className="input w-auto min-h-[32px] py-1" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} /></span>}
      actions={existing && <StatusBadge status={existing.status} />}>
      {existing?.review_comment && <p className="mb-4 rounded-lg bg-violet-50 p-3 text-sm dark:bg-violet-900/20"><b>{existing.reviewer_name}:</b> {existing.review_comment}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {FIELDS.map(([k, l, req]) => (
          <Field key={k} label={l} className={k === 'work_completed' ? 'md:col-span-2' : ''}><textarea className="input" rows={k === 'work_completed' ? 4 : 2} disabled={locked} required={req} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
        ))}
        <Field label="Time spent (hours)"><input className="input" type="number" min={0} max={24} step={0.5} disabled={locked} value={f.hours_spent ?? ''} onChange={(e) => setF({ ...f, hours_spent: e.target.value })} /></Field>
      </div>
      {!locked && <button className="btn-primary mt-4" disabled={!f.work_completed || String(f.work_completed).trim().length < 3 || save.isPending} onClick={() => save.mutate(undefined)}>{existing ? 'Update report' : 'Submit report'}</button>}
      {locked && <p className="muted mt-4 text-sm">This report has been reviewed and is locked.</p>}
    </Card>
  );
}

function History() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useApi<any>(['dr-mine', page], '/daily-reports/mine', { page });
  if (isLoading) return <Loading />;
  return (
    <Card pad={false}><div className="px-4 sm:px-0">
      <DataTable rows={data.items} empty={<Empty title="No reports yet" />} columns={[
        { key: 'report_date', header: 'Date', render: (r: any) => fmtDate(r.report_date) },
        { key: 'work_completed', header: 'Completed', render: (r: any) => <span className="line-clamp-2 max-w-md text-sm">{r.work_completed}</span> },
        { key: 'hours_spent', header: 'Hours' }, { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
        { key: 'review_comment', header: 'Feedback', render: (r: any) => <span className="text-xs">{r.review_comment ?? '—'}</span> },
      ]} />
      <div className="pb-4"><Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></div>
    </div></Card>
  );
}

function TeamReports() {
  const [status, setStatus] = useState('submitted');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<any>(null);
  const { can } = useAuth();
  const { data, isLoading } = useApi<any>(['dr-team'], '/daily-reports', { status: status || undefined, page });
  const review = useAction(({ id, status: s, comment }: any) => api(`/daily-reports/${id}/review`, { body: { status: s, comment } }), { invalidate: [['dr-team']], success: 'Review saved', onSuccess: () => setOpen(null) });
  return (
    <>
      <div className="mb-3"><Chips value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[{ value: 'submitted', label: 'Awaiting review' }, { value: 'needs_info', label: 'Needs info' }, { value: 'reviewed', label: 'Reviewed' }, { value: '', label: 'All' }]} /></div>
      <Card pad={false}>{isLoading ? <Loading /> : <div className="px-4 sm:px-0">
        <DataTable rows={data.items} onRowClick={setOpen} empty={<Empty title="No reports" />} columns={[
          { key: 'user_name', header: 'Employee', render: (r: any) => <span className="font-medium">{r.user_name}<span className="muted block text-xs font-normal">{r.department_name}</span></span> },
          { key: 'report_date', header: 'Date', render: (r: any) => fmtDate(r.report_date) },
          { key: 'work_completed', header: 'Completed', render: (r: any) => <span className="line-clamp-2 max-w-md text-sm">{r.work_completed}</span> },
          { key: 'hours_spent', header: 'Hours' },
          { key: 'flags', header: 'Flags', render: (r: any) => <span className="flex gap-1">{r.delay_reason && <span className="badge bg-amber-100 text-amber-800">Delay</span>}{r.support_required && <span className="badge bg-rose-100 text-rose-700">Support</span>}</span> },
          { key: 'status', header: 'Status', render: (r: any) => <StatusBadge status={r.status} /> },
        ]} />
        <div className="pb-4"><Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></div>
      </div>}</Card>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `${open.user_name} — ${fmtDate(open.report_date)}` : ''} size="lg"
        footer={open && can('reports.daily.review') && <>
          <button className="btn-secondary" onClick={async () => { const c = await confirm({ title: 'Ask for more information', input: { label: 'What is missing?', required: true } }); if (c) review.mutate({ id: open.id, status: 'needs_info', comment: c }); }}><MessageSquareWarning className="h-4 w-4" /> Needs info</button>
          <button className="btn-success" onClick={async () => { const c = await confirm({ title: 'Mark as reviewed', input: { label: 'Comment (optional)' }, confirmLabel: 'Mark reviewed' }); if (c) review.mutate({ id: open.id, status: 'reviewed', comment: c === true ? undefined : c }); }}><CheckCircle2 className="h-4 w-4" /> Reviewed</button>
        </>}>
        {open && <dl className="space-y-3 text-sm">{FIELDS.map(([k, l]) => open[k] ? <div key={k}><dt className="muted text-xs">{l.replace(' *', '')}</dt><dd className="whitespace-pre-line">{open[k]}</dd></div> : null)}
          <div><dt className="muted text-xs">Hours</dt><dd>{open.hours_spent}</dd></div><div><dt className="muted text-xs">Submitted</dt><dd>{fmtDateTime(open.submitted_at)}</dd></div>
          {open.review_comment && <div><dt className="muted text-xs">Review ({open.reviewer_name})</dt><dd>{open.review_comment}</dd></div>}</dl>}
      </Modal>
    </>
  );
}

function Missing() {
  const [date, setDate] = useState(todayIso());
  const { data, isLoading } = useApi<any>(['dr-missing', date], '/daily-reports/missing', { date });
  return (
    <Card title={<span className="flex flex-wrap items-center gap-2"><UserX className="h-4 w-4" /> Not submitted on <input type="date" className="input w-auto min-h-[32px] py-1" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} /></span>}>
      {isLoading ? <Loading /> : <DataTable rows={data.missing} empty={<Empty icon={CheckCircle2} title="Everyone has submitted" />} columns={[
        { key: 'name', header: 'Employee' }, { key: 'employee_code', header: 'Code' }, { key: 'department_name', header: 'Department' },
        { key: 'last_report_date', header: 'Last report', render: (r: any) => fmtDate(r.last_report_date) },
      ]} />}
    </Card>
  );
}

function Summary() {
  const [period, setPeriod] = useState('weekly');
  const { data, isLoading } = useApi<any>(['dr-summary', period], '/daily-reports/summary', { period });
  return (
    <div className="space-y-5">
      <Chips value={period} onChange={setPeriod} options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }]} />
      {isLoading ? <Loading /> : <>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Period" value={<span className="text-base">{fmtDate(data.start)} – {fmtDate(data.end)}</span>} />
          <Stat label="Reports" value={data.by_user.reduce((s: number, r: any) => s + r.reports, 0)} />
          <Stat label="Hours reported" value={data.by_user.reduce((s: number, r: any) => s + r.hours, 0)} />
          <Stat label="Working days so far" value={data.expected_days} />
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Reports per day"><BarsChart data={data.by_day.map((d: any) => ({ ...d, day: fmtDate(d.report_date).slice(0, 6) }))} x="day" series={[{ key: 'reports', label: 'Reports' }]} /></Card>
          <Card title="Compliance by person" pad={false}><DataTable rows={data.by_user} columns={[{ key: 'name', header: 'Employee' }, { key: 'reports', header: 'Reports' }, { key: 'hours', header: 'Hours' }, { key: 'compliance', header: 'Compliance', render: (r: any) => r.compliance == null ? '—' : <span className={r.compliance < 80 ? 'text-rose-600' : ''}>{r.compliance}%</span> }, { key: 'delays', header: 'Delays' }, { key: 'support_requests', header: 'Support asks' }]} /></Card>
        </div>
        <Card title="Recent highlights">
          <ul className="divide-y text-sm">{data.recent.slice(0, 15).map((r: any) => <li key={r.id} className="py-2"><b>{r.user_name}</b> <span className="muted text-xs">{fmtDate(r.report_date)}</span><p className="line-clamp-2">{r.work_completed}</p>{r.support_required && <p className="text-xs text-rose-600">Support: {r.support_required}</p>}</li>)}</ul>
        </Card>
      </>}
    </div>
  );
}
