import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BellRing, CalendarClock, FileText, ListChecks, NotebookPen } from 'lucide-react';
import { fmtDateTime, fromNow, todayIso } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { Card, clsx, Progress } from '../../components/ui';
import { ActivityItem } from './common';
import { QuickAddActivity } from './QuickActivity';
import { CompleteTaskModal, TaskFormModal, TaskRow } from './tasks';

const ViewAll = ({ to, label = 'View all' }: { to: string; label?: string }) => <Link to={to} className="text-xs font-medium text-brand-600">{label}</Link>;

/** Personal block on the home screen: quick add, my tasks, reminders, timeline, my EOD report. */
export function MyDayPanel() {
  const today = todayIso();
  const { data, isLoading } = useApi<any>(['my-work-today', today], '/my-work/today', { date: today }, { refetchInterval: 120_000 });
  const [completing, setCompleting] = useState<any>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const t = data?.tasks;
  const pending = t ? [...t.overdue, ...t.due_today, ...t.undated] : [];
  const eod = data?.eod;
  return (
    <section aria-label="My day" className="space-y-3">
      <div className="flex flex-col gap-3 rounded-xl border border-brand-200 bg-brand-50/60 p-4 dark:border-brand-900/60 dark:bg-brand-900/20 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">My Daily Work & Activities</h2>
          <p className="muted text-sm">{data ? `${data.timeline.length} activit${data.timeline.length === 1 ? 'y' : 'ies'} recorded today · ${pending.length} open task${pending.length === 1 ? '' : 's'}` : 'Record each activity right after you finish it.'}</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <QuickAddActivity className="w-full justify-center py-2.5 text-base sm:w-auto sm:text-sm" label="Add Daily Activity" fab />
          <Link to="/my-work" className="btn-secondary justify-center">Open my work</Link>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-4">
        <Card title="My daily tasks" actions={<button className="text-xs font-medium text-brand-600" onClick={() => setTaskOpen(true)}>+ Task</button>}>
          {isLoading ? <p className="muted text-sm">Loading…</p> : pending.length === 0 ? (
            <p className="muted text-sm">{t?.completed_today.length ? `All done — ${t.completed_today.length} completed today.` : 'No open personal tasks.'}</p>
          ) : (
            <ul className="-my-2 divide-y dark:divide-slate-800">{pending.slice(0, 6).map((x: any) => <TaskRow key={x.id} t={x} today={today} onComplete={setCompleting} />)}</ul>
          )}
          {pending.length > 6 && <div className="mt-2"><ViewAll to="/my-work?tab=tasks" label={`${pending.length - 6} more`} /></div>}
        </Card>
        <Card title="My reminders">
          {isLoading ? <p className="muted text-sm">Loading…</p> : !data?.reminders.length ? <p className="muted text-sm">Nothing in the next 24 hours.</p> : (
            <ul className="space-y-2 text-sm">
              {data.reminders.slice(0, 6).map((r: any) => (
                <li key={`${r.kind}${r.id}`} className="flex items-start gap-2">
                  {r.kind === 'checklist' ? <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /> : <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />}
                  <span className="min-w-0"><span className="block truncate">{r.title}</span><span className="muted text-xs">{fmtDateTime(r.at)}</span></span>
                </li>
              ))}
            </ul>
          )}
          {data?.checklist && data.checklist.total_items > 0 && (
            <Link to="/checklist" className="mt-3 flex items-center gap-2 rounded-lg border p-2 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800/60">
              <ListChecks className="h-4 w-4 text-brand-600" />
              <span className="flex-1">My checklist: {data.checklist.status === 'submitted' ? 'submitted' : `${data.checklist.answered_items}/${data.checklist.total_items} answered`}</span>
            </Link>
          )}
        </Card>
        <Card title="My activity timeline" actions={<ViewAll to="/my-work" />}>
          {isLoading ? <p className="muted text-sm">Loading…</p> : !data?.timeline.length ? <p className="muted text-sm">Nothing recorded yet today.</p> : (
            <ol className="max-h-80 overflow-y-auto pr-1">{[...data.timeline].reverse().slice(0, 8).map((a: any) => <ActivityItem key={a.id} a={a} compact />)}</ol>
          )}
        </Card>
        <Card title="My EOD report">
          <div className="space-y-3 text-sm">
            <p className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-brand-600" />
              {!eod ? 'Not generated yet' : eod.status === 'final' ? <span className="font-medium text-emerald-700 dark:text-emerald-300">Finalized {fromNow(eod.finalized_at)}</span> : <span className="font-medium text-amber-700 dark:text-amber-300">Draft · updated {fromNow(eod.updated_at)}</span>}
            </p>
            <p className="muted text-xs">Built only from the activities and tasks you recorded. Review, edit, then copy into Bitrix24.</p>
            <Link to="/my-work?tab=eod" className="btn-secondary btn-sm w-full justify-center">{!eod ? 'Generate today’s report' : eod.status === 'final' ? 'View / copy report' : 'Review & finalize'}</Link>
          </div>
        </Card>
      </div>
      <CompleteTaskModal task={completing} onClose={() => setCompleting(null)} />
      <TaskFormModal open={taskOpen} onClose={() => setTaskOpen(false)} />
    </section>
  );
}

/** Supervisor block: today's team updates, pending checklists and department progress. */
export function TeamTodayPanel() {
  const { data, isLoading } = useApi<any>(['dashboard-team'], '/my-work/team', undefined, { refetchInterval: 120_000 });
  if (isLoading || !data) return null;
  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <Card title="Today's team updates" actions={<ViewAll to="/compliance" label="Compliance" />}>
        {!data.updates.length ? <p className="muted text-sm">No updates submitted yet today.</p> : (
          <ul className="max-h-96 space-y-3 overflow-y-auto pr-1 text-sm">
            {data.updates.map((u: any) => (
              <li key={`${u.kind}${u.id}`} className="flex gap-2">
                {u.kind === 'checklist' ? <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : u.kind === 'daily_report' ? <NotebookPen className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" /> : <FileText className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" />}
                <span className="min-w-0"><span className="font-medium">{u.name}</span> <span className="muted text-xs">{fromNow(u.at)}</span><span className="block break-words text-slate-600 dark:text-slate-300">{u.text}</span></span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title={`Pending employee checklists · ${data.pending_checklists.length}`} actions={<ViewAll to="/compliance" />}>
        {!data.pending_checklists.length ? <p className="muted text-sm">Every checklist due today is submitted.</p> : (
          <ul className="max-h-96 divide-y overflow-y-auto pr-1 text-sm dark:divide-slate-800">
            {data.pending_checklists.map((c: any) => (
              <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0"><span className="block truncate font-medium">{c.name}</span><span className="muted block truncate text-xs">{c.department_name ?? 'No department'} · {c.answered_items}/{c.total_items} answered{c.required_items - c.required_answered > 0 ? ` · ${c.required_items - c.required_answered} mandatory left` : ''}</span></span>
                <span className={clsx('badge shrink-0', c.overdue ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200' : c.status === 'in_progress' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300')}>{c.overdue ? 'Overdue' : c.status === 'in_progress' ? 'In progress' : 'Not started'}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Department progress (today)">
        {!data.departments.length ? <p className="muted text-sm">No departments with employees.</p> : (
          <ul className="space-y-3 text-sm">
            {data.departments.map((d: any) => {
              const pct = d.expected ? Math.round((d.submitted / d.expected) * 100) : null;
              return (
                <li key={d.id}>
                  <div className="flex items-baseline justify-between gap-2"><span className="truncate font-medium">{d.name}</span><span className="muted shrink-0 text-xs">{d.expected ? `${d.submitted}/${d.expected} checklists` : 'no checklists'}</span></div>
                  <div className="mt-1"><Progress value={pct ?? 0} /></div>
                  <div className="muted mt-0.5 text-xs">{d.open_tasks} open tasks{d.overdue_tasks ? ` · ${d.overdue_tasks} overdue` : ''}{d.completed_today ? ` · ${d.completed_today} completed today` : ''}</div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
