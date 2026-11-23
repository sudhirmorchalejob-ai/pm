import { ReactNode, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CalendarClock, ClipboardCopy, FileSpreadsheet, FileText, RefreshCw, Settings2 } from 'lucide-react';
import { api, download } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, humanize, pct, todayIso } from '../../lib/format';
import { useAction, useApi } from '../../lib/hooks';
import { toast } from '../../components/Toast';
import { Card, Chips, clsx, DataTable, Empty, ErrorState, Field, Loading, Modal, PageHeader, Progress, Select, Stat, StatusBadge, UserPicker } from '../../components/ui';

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}

export default function EodReports() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const date = sp.get('date') ?? todayIso();
  const reportId = sp.get('report') ?? '';
  const [dept, setDept] = useState('');
  const [user, setUser] = useState<number | null>(null);
  const [view, setView] = useState<'consolidated' | 'employee'>('consolidated');
  const [settings, setSettings] = useState(false);
  const { data: depts = [] } = useApi<any[]>(['departments'], '/org/departments');
  const live = reportId === 'live';
  const query = { date, report_id: reportId && !live ? reportId : undefined, live: live ? 'true' : undefined, department_id: dept, user_id: user, view };
  const { data, isLoading, error, refetch, isFetching } = useApi<any>(['eod', date, reportId, dept, user, view], '/eod', query);
  const { data: hist } = useApi<any>(['eod-history'], '/eod/history');
  const generate = useAction(() => api('/eod/generate', { method: 'POST', body: { date } }), { invalidate: [['eod'], ['eod-history']], success: 'EOD report generated', onSuccess: () => setSp({ date }, { replace: true }) });
  const r = data?.report;
  const exp = (format: 'pdf' | 'xlsx') => download('/eod', { ...query, format }).catch((e) => toast.error(e.message));

  return (
    <div className="space-y-4">
      <PageHeader title="End-of-Day reports" subtitle="Consolidated from submitted checklists, tasks and daily reports. Nothing is filled in for people who did not submit."
        actions={<>
          {can('eod.generate') && <button className="btn-secondary" onClick={() => setSettings(true)}><Settings2 className="h-4 w-4" /> Schedule</button>}
          {can('eod.generate') && <button className="btn-primary" disabled={generate.isPending} onClick={() => generate.mutate(undefined)}><RefreshCw className={clsx('h-4 w-4', generate.isPending && 'animate-spin')} /> Generate now</button>}
        </>} />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Field label="Date"><input className="input" type="date" max={todayIso()} value={date} onChange={(e) => setSp(e.target.value ? { date: e.target.value } : {}, { replace: true })} /></Field>
        <Field label="Department"><Select value={dept} onChange={setDept} placeholder="All departments" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} /></Field>
        <Field label="Employee" className="col-span-2 md:col-span-1"><UserPicker value={user} onChange={setUser} placeholder="All employees" departmentId={dept ? Number(dept) : null} /></Field>
        <div className="col-span-2 md:col-span-1"><span className="label">Format</span><Chips value={view} onChange={setView} options={[{ value: 'consolidated', label: 'Consolidated' }, { value: 'employee', label: 'Employee-wise' }]} /></div>
      </div>

      {isLoading ? <Loading label="Building report…" /> : error ? <ErrorState error={error} onRetry={refetch} /> : r && (
        <>
          <div className="card flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
            <div className="min-w-0 text-sm">
              <p className="font-medium">{r.org_name} · {fmtDate(r.date)} <span className="muted font-normal">({r.timezone})</span></p>
              <p className="muted text-xs">
                {data.live ? <span className="text-amber-700 dark:text-amber-400">{data.versions?.length ? 'Live view of current data (not a stored report).' : 'Live preview from current data — not generated yet for this date.'}</span>
                  : <>Generated {fmtDateTime(data.generated_at)} · {data.trigger === 'auto' ? 'automatically' : `manually${data.generated_by_name ? ` by ${data.generated_by_name}` : ''}`}</>}
                {isFetching && ' · refreshing…'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {data.versions?.length > 0 && <Select value={live ? 'live' : reportId || data.report_id} onChange={(v) => setSp({ date, report: v }, { replace: true })} options={[{ value: 'live', label: 'Live — current data' }, ...data.versions.map((v: any) => ({ value: v.id, label: `${fmtDateTime(v.generated_at)} (${v.trigger})` }))]} className="w-60" aria-label="Report version" />}
              <button className="btn-secondary btn-sm" onClick={async () => { await copyText(data.text); toast.success('Report copied to clipboard'); }}><ClipboardCopy className="h-4 w-4" /> Copy</button>
              {(can('reports.export') || can('eod.generate')) && <>
                <button className="btn-secondary btn-sm" onClick={() => exp('pdf')}><FileText className="h-4 w-4" /> PDF</button>
                <button className="btn-secondary btn-sm" onClick={() => exp('xlsx')}><FileSpreadsheet className="h-4 w-4" /> Excel</button>
              </>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Checklists complete" value={`${r.summary.submitted}/${r.summary.expected}`} hint={r.summary.compliance !== null ? `${r.summary.compliance}% compliance` : 'no checklists'} tone="brand" />
            <Stat label="Partial" value={r.summary.partial} tone={r.summary.partial ? 'warn' : 'default'} />
            <Stat label="Not submitted" value={r.summary.not_submitted} tone={r.summary.not_submitted ? 'danger' : 'default'} />
            <Stat label="Tasks completed" value={r.summary.tasks_completed} tone="good" />
            <Stat label="Pending tasks" value={r.summary.tasks_pending} hint={`${r.summary.tasks_overdue} overdue`} />
            <Stat label="Blocked tasks" value={r.summary.tasks_blocked} tone={r.summary.tasks_blocked ? 'warn' : 'default'} />
          </div>

          <Card title={<span className="flex items-center gap-1.5"><AlertTriangle className="h-4 w-4 text-amber-500" /> Not submitted / incomplete ({r.not_submitted.length})</span>} pad={false}>
            <div className="px-4 sm:px-0">
              <DataTable rows={r.not_submitted} empty={<p className="muted px-4 py-4 text-sm">Everyone with a checklist submitted it.</p>} columns={[
                { key: 'name', header: 'Employee' },
                { key: 'department_name', header: 'Department' },
                { key: 'status', header: 'Status', render: (n: any) => <StatusBadge status={n.status === 'partial' ? 'in_progress' : 'missed'} label={n.status === 'partial' ? `Partial ${n.answered}/${n.total}` : 'Nothing submitted'} /> },
                { key: 'missing_required', header: 'Mandatory unanswered' },
                { key: 'due_at', header: 'Deadline', render: (n: any) => <span className={n.overdue ? 'text-rose-600' : ''}>{fmtDateTime(n.due_at)}{n.overdue ? ' · overdue' : ''}</span> },
              ]} />
            </div>
          </Card>

          {view === 'consolidated' ? <Consolidated r={r} /> : <EmployeeWise r={r} />}

          {r.projects.length > 0 && (
            <Card title="Project progress" pad={false}>
              <div className="px-4 sm:px-0">
                <DataTable rows={r.projects} columns={[
                  { key: 'name', header: 'Project', render: (p: any) => <span><span className="muted mr-1 text-xs">{p.code}</span>{p.name}</span> },
                  { key: 'department_name', header: 'Department', render: (p: any) => p.department_name ?? '—' },
                  { key: 'status', header: 'Status', render: (p: any) => <StatusBadge status={p.status} /> },
                  { key: 'progress', header: 'Progress', render: (p: any) => <div className="w-32"><Progress value={p.progress} /></div> },
                  { key: 'open_tasks', header: 'Open tasks', render: (p: any) => `${p.open_tasks}${p.overdue_tasks ? ` (${p.overdue_tasks} overdue)` : ''}` },
                  { key: 'completed_today', header: 'Completed today' },
                ]} />
              </div>
            </Card>
          )}
        </>
      )}

      <Card title={<span className="flex items-center gap-1.5"><CalendarClock className="h-4 w-4" /> Report history</span>} pad={false}>
        <div className="px-4 sm:px-0">
          <DataTable rows={hist?.reports ?? []} onRowClick={(x: any) => setSp({ date: x.report_date, report: String(x.id) }, { replace: true })} empty={<Empty title="No reports generated yet" hint="Reports are generated automatically at the scheduled time, or with “Generate now”." />} columns={[
            { key: 'report_date', header: 'Date', render: (x: any) => fmtDate(x.report_date) },
            { key: 'trigger', header: 'Type', render: (x: any) => humanize(x.trigger) },
            { key: 'generated_at', header: 'Generated', render: (x: any) => fmtDateTime(x.generated_at) },
            { key: 'generated_by_name', header: 'By', render: (x: any) => x.generated_by_name ?? 'System' },
            { key: 'summary', header: 'Compliance', render: (x: any) => (x.summary ? `${x.summary.submitted}/${x.summary.expected} (${pct(x.summary.compliance)})` : '—') },
          ]} />
        </div>
      </Card>
      {settings && <ScheduleModal onClose={() => setSettings(false)} />}
    </div>
  );
}

function Bullets({ title, rows, render }: { title: string; rows: any[]; render: (x: any) => ReactNode }) {
  if (!rows?.length) return null;
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h4>
      <ul className="space-y-1 text-sm">{rows.map((x, i) => <li key={i} className="whitespace-pre-wrap break-words border-l-2 border-slate-200 pl-2 dark:border-slate-700">{render(x)}</li>)}</ul>
    </div>
  );
}

function Consolidated({ r }: { r: any }) {
  if (!r.departments.length) return <Card><Empty title="No employees match these filters" /></Card>;
  return (
    <div className="space-y-4">
      {r.departments.map((d: any) => {
        const empty = !d.metrics.length && !d.work_done.length && !d.tasks_completed.length && !d.blockers.length && !d.delays.length && !d.campaigns.length && !d.urls.length && !d.progress.length && !d.pending_work.length && !d.plans.length && !d.other.length;
        return (
          <Card key={String(d.id)} title={<span>{d.name}{d.hod_name && <span className="muted text-xs font-normal"> · HOD {d.hod_name}</span>}</span>}
            actions={d.expected ? <span className="text-xs tabular-nums">{d.submitted}/{d.expected} complete · {pct(d.compliance)}</span> : <span className="muted text-xs">no checklists</span>}>
            {empty ? <p className="muted text-sm">No submitted updates or completed tasks for this department on this date.</p> : (
              <div className="grid gap-4 lg:grid-cols-2">
                {d.metrics.length > 0 && (
                  <div className="lg:col-span-2">
                    <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Key metrics</h4>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      {d.metrics.map((m: any) => (
                        <div key={m.question} className="rounded-lg border p-2.5 dark:border-slate-700">
                          <p className="muted line-clamp-2 text-xs">{m.question}</p>
                          {m.total === null ? <p className="muted text-sm font-medium">Not reported</p> : <p className="text-lg font-semibold tabular-nums">{m.total.toLocaleString()} <span className="muted text-xs font-normal">{m.unit}</span></p>}
                          <p className="muted text-[11px]">{m.reported} of {m.asked} reported</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <Bullets title="Completed work" rows={d.work_done} render={(w) => <><b>{w.employee}:</b> {w.text}</>} />
                <Bullets title="Tasks completed" rows={d.tasks_completed} render={(t) => <><b>{t.employee}:</b> {t.task_key} {t.title}{t.project_name ? <span className="muted"> · {t.project_name}</span> : null}</>} />
                <Bullets title="Progress & deadlines" rows={d.progress} render={(w) => <><b>{w.employee}</b> — {w.question}: {w.text}</>} />
                <Bullets title="Campaigns" rows={d.campaigns} render={(w) => <><b>{w.employee}</b> — {w.question}: {w.text}</>} />
                <Bullets title="Published / supporting URLs" rows={d.urls} render={(u) => <><b>{u.employee}:</b> <a className="break-all text-brand-600 hover:underline" href={u.url} target="_blank" rel="noreferrer noopener">{u.url}</a>{u.published_at && <span className="muted"> · published {String(u.published_at).replace('T', ' ').slice(0, 16)}</span>}</>} />
                <Bullets title="Blockers & dependencies" rows={d.blockers} render={(b) => <><b>{b.employee}</b> — {b.question}: {b.text}</>} />
                <Bullets title="Delays" rows={d.delays} render={(b) => <><b>{b.employee}</b> — {b.question}: {b.text}</>} />
                <Bullets title="Pending work" rows={d.pending_work} render={(w) => <><b>{w.employee}:</b> {w.text}</>} />
                <Bullets title="Next plans" rows={d.plans} render={(w) => <><b>{w.employee}:</b> {w.text}</>} />
                <Bullets title="Other updates" rows={d.other} render={(w) => <><b>{w.employee}</b> — {w.question}: {w.text}</>} />
              </div>
            )}
            {d.tasks_pending > 0 && <p className="muted mt-3 text-xs">Open tasks: {d.tasks_pending} ({d.tasks_overdue} overdue)</p>}
          </Card>
        );
      })}
    </div>
  );
}

function EmployeeWise({ r }: { r: any }) {
  if (!r.employees.length) return <Card><Empty title="No employees match these filters" /></Card>;
  return (
    <div className="space-y-4">
      {r.employees.map((e: any) => (
        <Card key={e.id} title={<span>{e.name}<span className="muted text-xs font-normal"> · {e.department_name ?? 'No department'}{e.designation ? `, ${e.designation}` : ''}</span></span>}
          actions={e.submission === 'submitted' ? <StatusBadge status={e.checklist?.is_late ? 'late' : 'completed'} label={e.checklist?.is_late ? 'Complete (late)' : 'Complete'} />
            : e.submission === 'partial' ? <StatusBadge status="in_progress" label={`Partial ${e.checklist.answered_items}/${e.checklist.total_items}`} />
              : e.submission === 'not_submitted' ? <StatusBadge status="missed" label="Not submitted" /> : <span className="muted text-xs">No checklist</span>}>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="lg:col-span-2">
              {(e.answers.length > 0 || e.unanswered.length > 0) ? (
                <dl className="divide-y text-sm dark:divide-slate-800">
                  {e.answers.map((a: any) => (
                    <div key={a.item_id} className="grid gap-1 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                      <dt className="muted">{a.question}</dt>
                      <dd className="whitespace-pre-wrap break-words">{a.text}{a.late && <span className="ml-1 text-xs text-rose-600">(late)</span>}{a.revision > 1 && <span className="muted ml-1 text-xs">(revised ×{a.revision - 1})</span>}{a.note && <span className="muted block text-xs">Note: {a.note}</span>}{a.files.length > 0 && <span className="muted block text-xs">Files: {a.files.join(', ')}</span>}</dd>
                    </div>
                  ))}
                  {e.unanswered.map((u: any, i: number) => (
                    <div key={`u${i}`} className="grid gap-1 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                      <dt className="muted">{u.question}</dt>
                      <dd className="text-rose-600">Not answered{u.required ? ' (mandatory)' : ''}{u.has_draft ? ' — draft not submitted' : ''}</dd>
                    </div>
                  ))}
                </dl>
              ) : <p className="muted text-sm">No questions assigned for this date.</p>}
            </div>
            <Bullets title={`Completed tasks (${e.tasks_completed.length})`} rows={e.tasks_completed} render={(t) => <>{t.task_key} {t.title}{t.project_name && <span className="muted"> · {t.project_name}</span>}</>} />
            <Bullets title={`Pending tasks (${e.tasks_pending.length})`} rows={e.tasks_pending.slice(0, 10)} render={(t) => <>{t.task_key} {t.title} <span className={t.overdue ? 'text-rose-600' : 'muted'}>· {humanize(t.status)}{t.overdue ? ' · overdue' : ''}</span></>} />
            {e.daily_report && <Bullets title="Daily report" rows={[e.daily_report]} render={(d) => <>{d.work_completed}{d.challenges && <span className="muted block">Challenges: {d.challenges}</span>}</>} />}
          </div>
        </Card>
      ))}
    </div>
  );
}

function ScheduleModal({ onClose }: { onClose: () => void }) {
  const { data } = useApi<any>(['eod-settings'], '/eod/settings');
  const { data: roles = [] } = useApi<any[]>(['roles'], '/org/roles');
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (data) setF(data); }, [data]);
  const save = useAction(() => api('/eod/settings', { method: 'PUT', body: { eod_auto_enabled: f.eod_auto_enabled, eod_generation_time: f.eod_generation_time, eod_notify_roles: f.eod_notify_roles } }), { invalidate: [['eod-settings']], success: 'Schedule saved', onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title="Automatic EOD report" size="md" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f} onClick={() => save.mutate(undefined)}>Save</button></>}>
      {!f ? <Loading /> : (
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.eod_auto_enabled} onChange={(e) => setF({ ...f, eod_auto_enabled: e.target.checked })} /> Generate automatically on working days</label>
          <Field label={`Generation time (${f.default_timezone})`} className="w-48"><input className="input" type="time" value={f.eod_generation_time} onChange={(e) => setF({ ...f, eod_generation_time: e.target.value })} /></Field>
          <div><span className="label">Notify when ready (HODs are always told)</span><Chips multi value={f.eod_notify_roles} onChange={(v) => setF({ ...f, eod_notify_roles: v })} options={roles.map((r: any) => ({ value: r.key, label: r.name }))} /></div>
          <p className="muted text-xs">Working days follow Settings → General. Reports generated by hand are kept as extra versions.</p>
        </div>
      )}
    </Modal>
  );
}
