import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { BellRing, CalendarClock, ChevronLeft, ChevronRight, ClipboardList, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, todayIso } from '../../lib/format';
import { useApi, useDebounced } from '../../lib/hooks';
import { toast } from '../../components/Toast';
import { Card, confirm, DataTable, Empty, ErrorState, Loading, Modal, PageHeader, Pagination, SearchInput, Select, Tabs, UserPicker, clsx } from '../../components/ui';
import { ActivityItem, RevisionsModal, useCategories } from './common';
import { EodEditor, EodHistory } from './eod';
import { QuickActivityModal, QuickAddActivity } from './QuickActivity';
import { CompleteTaskModal, invalidateMyWork, TaskFormModal, TaskRow } from './tasks';

const shift = (d: string, n: number) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

function DateNav({ date, onChange }: { date: string; onChange: (d: string) => void }) {
  const today = todayIso();
  return (
    <div className="flex items-center gap-1">
      <button className="btn-secondary btn-sm" aria-label="Previous day" onClick={() => onChange(shift(date, -1))}><ChevronLeft className="h-4 w-4" /></button>
      <input type="date" className="input w-auto py-1" value={date} max={today} onChange={(e) => e.target.value && onChange(e.target.value)} aria-label="Date" />
      <button className="btn-secondary btn-sm" aria-label="Next day" disabled={date >= today} onClick={() => onChange(shift(date, 1))}><ChevronRight className="h-4 w-4" /></button>
      {date !== today && <button className="btn-ghost btn-sm" onClick={() => onChange(today)}>Today</button>}
    </div>
  );
}

/** Timeline + actions for one day. */
function useActivityActions() {
  const qc = useQueryClient();
  const [edit, setEdit] = useState<any>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);
  const remove = async (a: any) => {
    const reason = await confirm({ title: 'Delete this activity?', message: 'It disappears from your timeline and reports. The deleted version stays in the edit history.', danger: true, confirmLabel: 'Delete', input: { label: 'Reason (optional)' } });
    if (reason === false) return;
    try {
      await api(`/activities/${a.id}`, { method: 'DELETE', body: typeof reason === 'string' ? { reason } : {} });
      ['my-work-today', 'activities', 'my-eod', 'coordination'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.success('Activity deleted');
    } catch (e: any) { toast.error(e.message); }
  };
  const modals = <>
    <QuickActivityModal open={!!edit} edit={edit} onClose={() => setEdit(null)} />
    <RevisionsModal activityId={historyId} onClose={() => setHistoryId(null)} />
  </>;
  return { setEdit, setHistoryId, remove, modals };
}

function TodayTab({ date, setDate }: { date: string; setDate: (d: string) => void }) {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useApi<any>(['my-work-today', date], '/my-work/today', { date });
  const acts = useActivityActions();
  const [taskOpen, setTaskOpen] = useState(false);
  const [completing, setCompleting] = useState<any>(null);
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const t = data.tasks;
  const pending = [...t.overdue, ...t.due_today, ...t.undated];
  const followUp = async (a: any) => { await api(`/activities/${a.id}/follow-up`, { method: 'POST', body: { done: true } }).catch((e) => toast.error(e.message)); qc.invalidateQueries({ queryKey: ['my-work-today'] }); toast.success('Follow-up done'); };
  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <Card className="xl:col-span-2" title={`Activity timeline · ${data.timeline.length}`} actions={<DateNav date={date} onChange={setDate} />}>
        {data.timeline.length === 0 ? (
          <Empty icon={ClipboardList} title={date === todayIso() ? 'Nothing recorded yet today' : 'Nothing recorded on this day'} hint="Add each activity right after you finish it — it takes a few seconds." action={<QuickAddActivity defaultDate={date} />} />
        ) : (
          <ol className="pt-1">{data.timeline.map((a: any) => <ActivityItem key={a.id} a={a} onEdit={() => acts.setEdit(a)} onDelete={() => acts.remove(a)} onHistory={() => acts.setHistoryId(a.id)} />)}</ol>
        )}
      </Card>
      <div className="space-y-5">
        <Card title="My tasks" actions={<button className="btn-secondary btn-sm" onClick={() => setTaskOpen(true)}><Plus className="h-3.5 w-3.5" /> Task</button>}>
          {pending.length === 0 && t.completed_today.length === 0 ? <p className="muted text-sm">No open personal tasks.</p> : (
            <ul className="divide-y dark:divide-slate-800">
              {pending.map((x: any) => <TaskRow key={x.id} t={x} today={todayIso()} onComplete={setCompleting} />)}
              {t.completed_today.map((x: any) => <TaskRow key={x.id} t={x} today={todayIso()} onComplete={setCompleting} />)}
            </ul>
          )}
        </Card>
        <Card title="Reminders (next 24 h)">
          {data.reminders.length === 0 ? <p className="muted text-sm">No upcoming reminders.</p> : (
            <ul className="space-y-2 text-sm">
              {data.reminders.map((r: any) => (
                <li key={`${r.kind}${r.id}`} className="flex items-start gap-2">
                  {r.kind === 'checklist' ? <CalendarClock className="mt-0.5 h-4 w-4 text-amber-600" /> : <BellRing className="mt-0.5 h-4 w-4 text-brand-600" />}
                  <span className="min-w-0 flex-1"><span className="block truncate">{r.title}</span><span className="muted text-xs">{fmtDateTime(r.at)}</span></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={`Open follow-ups · ${data.follow_ups.length}`}>
          {data.follow_ups.length === 0 ? <p className="muted text-sm">No open follow-ups.</p> : (
            <ul className="space-y-2.5 text-sm">
              {data.follow_ups.map((a: any) => (
                <li key={a.id} className="flex items-start gap-2">
                  <button className="mt-0.5 h-5 w-5 shrink-0 rounded border-2 border-slate-300 hover:border-brand-600 dark:border-slate-600" aria-label="Mark follow-up done" onClick={() => followUp(a)} />
                  <span className="min-w-0">
                    <span className="block">{a.follow_up_note || a.description}</span>
                    <span className="muted text-xs">{(a.participants ?? []).map((p: any) => p.name).join(', ') || a.category_name}{a.follow_up_due ? ` · by ${fmtDate(a.follow_up_due)}` : ''} · {fmtDate(a.activity_date)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {acts.modals}
      <TaskFormModal open={taskOpen} onClose={() => setTaskOpen(false)} />
      <CompleteTaskModal task={completing} onClose={() => setCompleting(null)} />
    </div>
  );
}

function TasksTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const [open, setOpen] = useState(false);
  const [completing, setCompleting] = useState<any>(null);
  const { data, isLoading } = useApi<any>(['my-tasks', status, dq, page], '/my-work/tasks', { status: status === 'all' ? undefined : status, q: dq || undefined, page, pageSize: 30 });
  const { data: series = [] } = useApi<any[]>(['my-series'], '/my-work/series');
  const toggle = async (s: any) => { await api(`/my-work/series/${s.id}`, { method: 'PATCH', body: { is_active: !s.is_active } }).catch((e) => toast.error(e.message)); invalidateMyWork(qc); };
  const del = async (s: any) => {
    if (!(await confirm({ title: `Stop "${s.title}"?`, message: 'No new occurrences are created. Past occurrences and their completion history are kept.', danger: true, confirmLabel: 'Stop repeating' }))) return;
    await api(`/my-work/series/${s.id}`, { method: 'DELETE' }).catch((e) => toast.error(e.message)); invalidateMyWork(qc);
  };
  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <Card className="xl:col-span-2" title="Personal tasks" actions={<button className="btn-primary btn-sm" onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5" /> New task</button>}>
        <div className="mb-3 flex flex-col gap-2 sm:flex-row">
          <Select value={status} onChange={(v) => { setStatus(v); setPage(1); }} className="sm:w-44" options={[{ value: 'pending', label: 'Pending' }, { value: 'overdue', label: 'Overdue' }, { value: 'completed', label: 'Completed' }, { value: 'all', label: 'All' }]} />
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search tasks and notes…" className="flex-1" />
        </div>
        {isLoading ? <Loading /> : !data?.items.length ? <Empty title="No tasks" hint="Create tasks for yourself whenever your day changes." /> : (
          <>
            <ul className="divide-y dark:divide-slate-800">{data.items.map((t: any) => <TaskRow key={t.id} t={t} today={todayIso()} onComplete={setCompleting} showDelete />)}</ul>
            <Pagination page={page} pageSize={30} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <Card title="Repeating tasks">
        {series.length === 0 ? <p className="muted text-sm">None yet. Choose “Repeat” when creating a task — e.g. “Collect team updates” every working day.</p> : (
          <ul className="space-y-3">
            {series.map((s: any) => (
              <li key={s.id} className={clsx('rounded-lg border p-3 dark:border-slate-700', !s.is_active && 'opacity-60')}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><p className="text-sm font-medium">{s.title}</p><p className="muted text-xs">{s.schedule}{s.due_time ? ` · ${String(s.due_time).slice(0, 5)}` : ''}</p><p className="muted text-xs">{s.completed} of {s.occurrences} occurrences completed</p></div>
                  <div className="flex shrink-0 gap-1">
                    <button className="btn-ghost btn-sm" onClick={() => toggle(s)} aria-label={s.is_active ? 'Pause' : 'Resume'} title={s.is_active ? 'Pause' : 'Resume'}>{s.is_active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</button>
                    <button className="btn-ghost btn-sm" onClick={() => del(s)} aria-label="Stop repeating"><Trash2 className="h-3.5 w-3.5 text-slate-400" /></button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <TaskFormModal open={open} onClose={() => setOpen(false)} />
      <CompleteTaskModal task={completing} onClose={() => setCompleting(null)} />
    </div>
  );
}

function HistoryTab() {
  const { sorted: cats } = useCategories();
  const [f, setF] = useState({ from: shift(todayIso(), -30), to: todayIso(), category_id: '', participant_id: null as number | null, q: '' });
  const [page, setPage] = useState(1);
  const dq = useDebounced(f.q);
  const acts = useActivityActions();
  const { data, isLoading } = useApi<any>(['activities', 'history', f.from, f.to, f.category_id, f.participant_id, dq, page], '/activities',
    { from: f.from, to: f.to, category_id: f.category_id || undefined, participant_id: f.participant_id || undefined, q: dq || undefined, page, pageSize: 50 });
  const set = (k: string, v: any) => { setF((s) => ({ ...s, [k]: v })); setPage(1); };
  const byDay = new Map<string, any[]>();
  for (const a of data?.items ?? []) { const d = String(a.activity_date); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d)!.push(a); }
  return (
    <Card title="Daily work history">
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <input type="date" className="input" value={f.from} max={f.to} onChange={(e) => set('from', e.target.value)} aria-label="From" />
        <input type="date" className="input" value={f.to} max={todayIso()} onChange={(e) => set('to', e.target.value)} aria-label="To" />
        <Select value={f.category_id} onChange={(v) => set('category_id', v)} placeholder="All categories" options={cats.map((c) => ({ value: c.id, label: c.name }))} />
        <UserPicker value={f.participant_id} onChange={(v: any) => set('participant_id', v)} placeholder="Any employee" />
        <SearchInput value={f.q} onChange={(v) => set('q', v)} placeholder="Search descriptions…" />
      </div>
      {isLoading ? <Loading /> : !data?.items.length ? <Empty title="No activities in this range" /> : (
        <>
          {[...byDay.entries()].map(([d, list]) => (
            <section key={d} className="mb-5">
              <h3 className="section-title mb-2">{fmtDate(d)} <span className="muted font-normal">· {list.length}</span></h3>
              <ol>{[...list].reverse().map((a: any) => <ActivityItem key={a.id} a={a} onEdit={() => acts.setEdit(a)} onDelete={() => acts.remove(a)} onHistory={() => acts.setHistoryId(a.id)} />)}</ol>
            </section>
          ))}
          <Pagination page={page} pageSize={50} total={data.total} onPage={setPage} />
        </>
      )}
      {acts.modals}
    </Card>
  );
}

/** Coordination & guidance history per employee (a management log, not a performance score). */
export function CoordinationHistoryModal({ employeeId, onClose, performerId }: { employeeId: number | null; onClose: () => void; performerId?: number }) {
  const [page, setPage] = useState(1);
  const qc = useQueryClient();
  const { data, isLoading } = useApi<any>(['coordination', 'employee', employeeId, performerId, page], employeeId ? `/activities/coordination/employee/${employeeId}` : null, { performer_id: performerId, page, pageSize: 30 });
  const followUp = async (a: any, body: any) => { await api(`/activities/${a.id}/follow-up`, { method: 'POST', body }).catch((e) => toast.error(e.message)); qc.invalidateQueries({ queryKey: ['coordination'] }); };
  return (
    <Modal open={!!employeeId} onClose={onClose} size="xl" title={data ? `Coordination history — ${data.employee.name}` : 'Coordination history'}>
      {isLoading || !data ? <Loading /> : (
        <div className="space-y-4">
          <p className="muted text-sm">{data.employee.department_name ?? 'No department'}{data.employee.company_name ? ` · ${data.employee.company_name}` : ''} — a record of coordination and guidance, not a performance rating.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border p-3 dark:border-slate-700"><div className="muted text-xs">Entries</div><div className="text-lg font-semibold">{data.stats.total}</div></div>
            <div className="rounded-lg border p-3 dark:border-slate-700"><div className="muted text-xs">Open follow-ups</div><div className="text-lg font-semibold">{data.stats.open_follow_ups}</div></div>
            <div className="rounded-lg border p-3 dark:border-slate-700"><div className="muted text-xs">Issues resolved</div><div className="text-lg font-semibold">{data.stats.resolved}</div></div>
            <div className="rounded-lg border p-3 dark:border-slate-700"><div className="muted text-xs">Last</div><div className="text-sm font-semibold">{data.stats.last_at ? fmtDateTime(data.stats.last_at) : '—'}</div></div>
          </div>
          {data.items.length === 0 ? <Empty title="No coordination recorded yet" /> : (
            <div>{data.items.map((a: any) => (
              <div key={a.id}>
                <div className="muted mb-1 ml-[4.25rem] text-xs">{fmtDate(a.activity_date)} · {a.user_name}</div>
                <ol><ActivityItem a={a} /></ol>
                {a.follow_up_required && !a.follow_up_done_at && (
                  <div className="mb-3 ml-[4.25rem] flex gap-1.5">
                    <button className="btn-secondary btn-sm" onClick={() => followUp(a, { done: true })}>Follow-up done</button>
                    {a.issue_resolved !== true && <button className="btn-secondary btn-sm" onClick={() => followUp(a, { done: true, issue_resolved: true })}>Done & resolved</button>}
                  </div>
                )}
              </div>
            ))}</div>
          )}
          <Pagination page={page} pageSize={30} total={data.total} onPage={setPage} />
        </div>
      )}
    </Modal>
  );
}

function CoordinationTab() {
  const [from, setFrom] = useState(shift(todayIso(), -90));
  const [employee, setEmployee] = useState<number | null>(null);
  const { data = [], isLoading } = useApi<any[]>(['coordination', 'summary', from], '/activities/coordination/summary', { from });
  const { user } = useAuth();
  return (
    <Card title="Coordination with employees" pad={false}
      actions={<Select value={from} onChange={setFrom} className="w-40" options={[{ value: shift(todayIso(), -7), label: 'Last 7 days' }, { value: shift(todayIso(), -30), label: 'Last 30 days' }, { value: shift(todayIso(), -90), label: 'Last 90 days' }, { value: shift(todayIso(), -365), label: 'Last year' }]} />}>
      {isLoading ? <Loading /> : data.length === 0 ? <div className="p-5"><Empty title="No coordination recorded" hint="Select employees when you add an activity — the history builds up here." /></div> : (
        <DataTable rows={data} onRowClick={(r: any) => setEmployee(r.id)}
          columns={[
            { key: 'name', header: 'Employee', render: (r: any) => <span className="font-medium">{r.name}{!r.is_active && <span className="muted"> (deactivated)</span>}<span className="muted block text-xs font-normal">{r.department_name ?? ''}</span></span> },
            { key: 'total', header: 'Entries', render: (r: any) => <span>{r.total}{r.total !== r.direct && <span className="muted text-xs"> ({r.direct} direct)</span>}</span> },
            { key: 'coordination', header: 'Coordinated' },
            { key: 'guidance', header: 'Guidance' },
            { key: 'open_follow_ups', header: 'Open follow-ups', render: (r: any) => <span className={r.open_follow_ups ? 'font-medium text-amber-700 dark:text-amber-300' : ''}>{r.open_follow_ups}</span> },
            { key: 'resolved', header: 'Resolved / open issues', render: (r: any) => `${r.resolved} / ${r.unresolved}` },
            { key: 'last_at', header: 'Last', render: (r: any) => fmtDate(r.last_at) },
          ]} />
      )}
      <CoordinationHistoryModal employeeId={employee} performerId={user?.id} onClose={() => setEmployee(null)} />
    </Card>
  );
}

export default function MyWork() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'today';
  const date = sp.get('date') ?? todayIso();
  const setParam = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  return (
    <div className="space-y-5 pb-20 sm:pb-0">
      <PageHeader title="My Daily Work & Activities" subtitle="Your own development, coordination, testing and client work — recorded as it happens."
        actions={<QuickAddActivity defaultDate={tab === 'today' ? date : undefined} />} />
      <Tabs value={tab} onChange={(v) => setParam('tab', v)} tabs={[
        { value: 'today', label: 'Today' }, { value: 'tasks', label: 'My tasks' }, { value: 'eod', label: 'EOD report' },
        { value: 'coordination', label: 'Coordination' }, { value: 'history', label: 'History' }, { value: 'reports', label: 'Past reports' },
      ]} />
      {tab === 'today' && <TodayTab date={date} setDate={(d) => setParam('date', d === todayIso() ? null : d)} />}
      {tab === 'tasks' && <TasksTab />}
      {tab === 'eod' && (
        <div className="space-y-3">
          <DateNav date={date} onChange={(d) => setParam('date', d === todayIso() ? null : d)} />
          <EodEditor date={date} />
        </div>
      )}
      {tab === 'coordination' && <CoordinationTab />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'reports' && <Card title="Past personal reports"><EodHistory onOpen={(d) => { const n = new URLSearchParams(sp); n.set('tab', 'eod'); n.set('date', d); setSp(n); }} /></Card>}
      <QuickAddActivity fab className="hidden" />
    </div>
  );
}
