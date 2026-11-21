import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { addDays, addMonths, addWeeks, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, isToday, parseISO, startOfMonth, startOfWeek } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../lib/auth';
import { useApi, useMediaQuery } from '../lib/hooks';
import { Card, Chips, Loading, PageHeader, Select, UserPicker } from '../components/ui';

const TYPES = [
  { value: 'tasks', label: 'Task deadlines' }, { value: 'milestones', label: 'Milestones' }, { value: 'projects', label: 'Projects' }, { value: 'future', label: 'Future projects' },
  { value: 'meetings', label: 'Meetings' }, { value: 'agenda', label: 'Agenda' }, { value: 'reminders', label: 'Reminders' },
];
const DOT: Record<string, string> = { task: 'bg-blue-500', milestone: 'bg-violet-500', project: 'bg-teal-500', future_project: 'bg-indigo-300', meeting: 'bg-amber-500', agenda: 'bg-pink-500', reminder: 'bg-slate-400' };

export default function CalendarPage() {
  const nav = useNavigate();
  const { can } = useAuth();
  const mobile = useMediaQuery('(max-width: 767px)');
  const [view, setView] = useState<'month' | 'week' | 'day'>(mobile ? 'day' : 'month');
  const [cursor, setCursor] = useState(new Date());
  const [types, setTypes] = useState(TYPES.map((t) => t.value));
  const [employee, setEmployee] = useState<number | null>(null);
  const [projectId, setProjectId] = useState('');
  const [deptId, setDeptId] = useState('');
  const range = useMemo(() => {
    if (view === 'month') return { from: startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }), to: endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }) };
    if (view === 'week') return { from: startOfWeek(cursor, { weekStartsOn: 1 }), to: endOfWeek(cursor, { weekStartsOn: 1 }) };
    return { from: cursor, to: cursor };
  }, [cursor, view]);
  const { data: projects } = useApi<any>(['projects-mini'], '/projects', { pageSize: 200 });
  const { data: depts = [] } = useApi<any[]>(['departments'], can('org.view') ? '/org/departments' : null);
  const { data, isLoading } = useApi<any>(['calendar'], '/calendar', {
    from: format(range.from, 'yyyy-MM-dd'), to: format(range.to, 'yyyy-MM-dd'), types, employee_id: employee ?? undefined, project_id: projectId || undefined, department_id: deptId || undefined,
  });
  const events: any[] = data?.events ?? [];
  const on = (d: Date) => events.filter((e) => isSameDay(e.allDay ? parseISO(e.start) : new Date(e.start), d));
  const move = (n: number) => setCursor((c) => (view === 'month' ? addMonths(c, n) : view === 'week' ? addWeeks(c, n) : addDays(c, n)));
  const title = view === 'month' ? format(cursor, 'MMMM yyyy') : view === 'week' ? `${format(range.from, 'd MMM')} – ${format(range.to, 'd MMM yyyy')}` : format(cursor, 'EEEE, d MMMM yyyy');
  const Ev = ({ e, compact }: { e: any; compact?: boolean }) => (
    <button onClick={() => nav(e.link)} className={clsx('flex w-full items-center gap-1.5 truncate rounded px-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800', compact ? 'py-0.5 text-[11px]' : 'py-2 text-sm')} title={e.title}>
      <span className={clsx('h-2 w-2 shrink-0 rounded-full', DOT[e.type], e.overdue && 'ring-2 ring-rose-400')} />
      {!e.allDay && <span className="muted shrink-0">{format(new Date(e.start), 'HH:mm')}</span>}
      <span className={clsx('truncate', e.status === 'completed' && 'line-through opacity-60')}>{e.title}</span>
      {!compact && e.meta && <span className="muted ml-auto truncate text-xs">{e.meta}</span>}
    </button>
  );
  return (
    <div>
      <PageHeader title="Calendar" actions={<Chips value={view} onChange={setView} options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }, { value: 'day', label: 'Day' }]} />} />
      <Card className="mb-4">
        <Chips multi value={types} onChange={setTypes} options={TYPES} />
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {can('monitoring.employees') && <UserPicker value={employee} onChange={setEmployee} placeholder="Filter by employee…" />}
          <Select value={projectId} onChange={setProjectId} placeholder="All projects" options={(projects?.items ?? []).map((p: any) => ({ value: p.id, label: p.name }))} />
          {depts.length > 0 && <Select value={deptId} onChange={setDeptId} placeholder="All departments" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} />}
        </div>
      </Card>
      <Card pad={false}>
        <div className="flex items-center justify-between border-b px-3 py-2">
          <button className="btn-ghost btn-sm" onClick={() => move(-1)} aria-label="Previous"><ChevronLeft className="h-4 w-4" /></button>
          <div className="flex items-center gap-2"><h2 className="text-sm font-semibold sm:text-base">{title}</h2><button className="btn-secondary btn-sm" onClick={() => setCursor(new Date())}>Today</button></div>
          <button className="btn-ghost btn-sm" onClick={() => move(1)} aria-label="Next"><ChevronRight className="h-4 w-4" /></button>
        </div>
        {isLoading ? <Loading /> : view === 'month' ? (
          <div>
            <div className="grid grid-cols-7 border-b text-center text-[11px] font-semibold uppercase text-slate-500">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="py-2">{mobile ? d[0] : d}</div>)}</div>
            <div className="grid grid-cols-7">
              {Array.from({ length: Math.round((range.to.getTime() - range.from.getTime()) / 86400000) + 1 }, (_, i) => addDays(range.from, i)).map((d) => {
                const evs = on(d);
                return (
                  <div key={d.toISOString()} className={clsx('min-h-[64px] border-b border-r p-1 sm:min-h-[110px]', !isSameMonth(d, cursor) && 'bg-slate-50/60 dark:bg-slate-900/40')}>
                    <button onClick={() => { setCursor(d); setView('day'); }} className={clsx('mb-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs', isToday(d) ? 'bg-brand-600 font-bold text-white' : !isSameMonth(d, cursor) ? 'text-slate-400' : '')}>{format(d, 'd')}</button>
                    {mobile ? (
                      <div className="flex flex-wrap gap-0.5">{evs.slice(0, 6).map((e) => <span key={e.id} className={clsx('h-1.5 w-1.5 rounded-full', DOT[e.type])} />)}</div>
                    ) : (
                      <div className="space-y-0.5">{evs.slice(0, 4).map((e) => <Ev key={e.id} e={e} compact />)}{evs.length > 4 && <button className="muted px-1.5 text-[11px]" onClick={() => { setCursor(d); setView('day'); }}>+{evs.length - 4} more</button>}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : view === 'week' ? (
          <div className="divide-y md:grid md:grid-cols-7 md:divide-x md:divide-y-0">
            {Array.from({ length: 7 }, (_, i) => addDays(range.from, i)).map((d) => (
              <div key={d.toISOString()} className="min-h-[80px] p-2 md:min-h-[360px]">
                <p className={clsx('mb-1 text-xs font-semibold', isToday(d) && 'text-brand-600')}>{format(d, 'EEE d')}</p>
                <div className="space-y-0.5">{on(d).map((e) => <Ev key={e.id} e={e} compact />)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-3">
            {on(cursor).length ? on(cursor).map((e) => <Ev key={e.id} e={e} />) : <p className="muted py-10 text-center text-sm">Nothing scheduled</p>}
          </div>
        )}
        <div className="flex flex-wrap gap-3 border-t px-3 py-2 text-[11px] text-slate-500">
          {Object.entries(DOT).map(([k, c]) => <span key={k} className="inline-flex items-center gap-1"><span className={clsx('h-2 w-2 rounded-full', c)} />{k.replace('_', ' ')}</span>)}
        </div>
      </Card>
    </div>
  );
}
