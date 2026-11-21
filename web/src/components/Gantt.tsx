import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { addDays, differenceInCalendarDays, format, max as maxDate, min as minDate, parseISO, startOfMonth, startOfWeek } from 'date-fns';
import clsx from 'clsx';
import { Chips } from './ui';

export interface GanttItem { id: number; label: string; start: string; end: string; progress: number; status: string; kind?: string; link?: string; meta?: string; overdue?: boolean }
export interface GanttDep { from: number; to: number; type?: string }

const ROW = 36;
const BAR_TONE: Record<string, string> = {
  completed: '#1baf7a', in_progress: '#2a78d6', blocked: '#d03b3b', on_hold: '#eda100', submitted: '#6250d6', under_review: '#6250d6',
  revision_required: '#eb6834', not_started: '#94a3b8', cancelled: '#cbd5e1', future: '#a5b4fc', proposed: '#94a3b8', planned: '#6366f1',
  approved: '#14b8a6', ready_to_start: '#06b6d4', under_evaluation: '#38bdf8',
};
const SCALES = { day: 34, week: 14, month: 4.5 } as const;

/**
 * Lightweight, dependency-aware Gantt chart. Horizontal scroll on small screens with a
 * sticky label column; finish-to-start dependencies are drawn as elbow connectors.
 */
export function Gantt({ items, dependencies = [], milestones = [] }: { items: GanttItem[]; dependencies?: GanttDep[]; milestones?: { id: number; title: string; due_date: string; status: string }[] }) {
  const nav = useNavigate();
  const [zoom, setZoom] = useState<keyof typeof SCALES>(items.length && spanDays(items) > 120 ? 'month' : 'week');
  const valid = items.filter((i) => i.start);
  const { start, days } = useMemo(() => {
    if (!valid.length) return { start: new Date(), days: 30 };
    const dates = valid.flatMap((i) => [parseISO(i.start), parseISO(i.end || i.start)]).concat(milestones.map((m) => parseISO(m.due_date))).concat([new Date()]);
    const s = startOfWeek(addDays(minDate(dates), -3), { weekStartsOn: 1 });
    const e = addDays(maxDate(dates), 10);
    return { start: s, days: Math.max(30, differenceInCalendarDays(e, s)) };
  }, [items, milestones]);
  const px = SCALES[zoom];
  const width = days * px;
  const x = (d: string | Date) => differenceInCalendarDays(typeof d === 'string' ? parseISO(d) : d, start) * px;
  const index = new Map(valid.map((i, k) => [i.id, k]));
  const ticks = useMemo(() => {
    const out: { x: number; label: string; major: boolean }[] = [];
    for (let i = 0; i <= days; i++) {
      const d = addDays(start, i);
      if (zoom === 'day') out.push({ x: i * px, label: format(d, 'd'), major: d.getDate() === 1 || i === 0 });
      else if (zoom === 'week' && d.getDay() === 1) out.push({ x: i * px, label: format(d, 'd MMM'), major: d.getDate() <= 7 });
      else if (zoom === 'month' && d.getDate() === 1) out.push({ x: i * px, label: format(d, 'MMM yy'), major: d.getMonth() === 0 });
    }
    return out;
  }, [start, days, zoom, px]);
  if (!valid.length) return <p className="muted py-10 text-center text-sm">No dated items to display</p>;
  const todayX = x(new Date());
  const height = valid.length * ROW;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Chips value={zoom} onChange={setZoom} options={[{ value: 'day', label: 'Days' }, { value: 'week', label: 'Weeks' }, { value: 'month', label: 'Months' }]} />
        <div className="flex flex-wrap gap-3 text-[11px] text-slate-500">
          {['not_started', 'in_progress', 'blocked', 'submitted', 'completed'].map((s) => <span key={s} className="inline-flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: BAR_TONE[s] }} />{s.replace('_', ' ')}</span>)}
          <span className="inline-flex items-center gap-1"><span className="h-3 w-0.5 bg-rose-500" />today</span>
        </div>
      </div>
      <div className="flex overflow-hidden rounded-lg border">
        <div className="w-32 shrink-0 border-r bg-white dark:bg-slate-900 sm:w-64">
          <div className="flex h-9 items-center border-b px-2 text-xs font-semibold text-slate-500">Item</div>
          {valid.map((i) => (
            <button key={i.id} onClick={() => i.link && nav(i.link)} className="flex w-full flex-col justify-center truncate border-b px-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800" style={{ height: ROW }} title={i.label}>
              <span className="truncate text-xs font-medium">{i.label}</span>
              {i.meta && <span className="muted hidden truncate text-[10px] sm:block">{i.meta}</span>}
            </button>
          ))}
        </div>
        <div className="scrollbar-thin flex-1 overflow-x-auto">
          <div style={{ width }} className="relative">
            <div className="relative h-9 border-b bg-slate-50 dark:bg-slate-900/60">
              {ticks.map((t, k) => <span key={k} className={clsx('absolute top-0 flex h-full items-center border-l pl-1 text-[10px]', t.major ? 'font-semibold text-slate-600 dark:text-slate-300' : 'text-slate-400')} style={{ left: t.x }}>{t.label}</span>)}
            </div>
            <div className="relative" style={{ height }}>
              {ticks.map((t, k) => <span key={k} className="absolute top-0 h-full border-l border-slate-100 dark:border-slate-800" style={{ left: t.x }} />)}
              {valid.map((_, k) => <span key={k} className="absolute inset-x-0 border-b border-slate-100 dark:border-slate-800" style={{ top: (k + 1) * ROW - 1 }} />)}
              <span className="absolute top-0 z-10 h-full w-0.5 bg-rose-500/80" style={{ left: todayX }} title="Today" />
              {milestones.map((m) => (
                <span key={m.id} className="absolute top-0 z-10 h-full border-l-2 border-dashed border-violet-400" style={{ left: x(m.due_date) }} title={`◆ ${m.title} — ${m.due_date}`}>
                  <span className="absolute -left-1.5 -top-1 text-violet-500">◆</span>
                </span>
              ))}
              <svg className="pointer-events-none absolute inset-0 z-20" width={width} height={height} aria-hidden>
                <defs><marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="#64748b" /></marker></defs>
                {dependencies.map((d, k) => {
                  const a = index.get(d.from); const b = index.get(d.to);
                  if (a == null || b == null) return null;
                  const fa = valid[a]; const fb = valid[b];
                  const x1 = x(addDays(parseISO(fa.end || fa.start), 1)); const y1 = a * ROW + ROW / 2;
                  const x2 = x(fb.start); const y2 = b * ROW + ROW / 2;
                  const mid = Math.max(x1 + 8, Math.min(x2 - 8, x1 + 8));
                  return <path key={k} d={`M${x1},${y1} H${mid} V${y2} H${x2 - 2}`} fill="none" stroke="#64748b" strokeWidth={1.5} markerEnd="url(#arr)" />;
                })}
              </svg>
              {valid.map((i, k) => {
                const left = x(i.start);
                const w = Math.max(px, x(addDays(parseISO(i.end || i.start), 1)) - left);
                const tone = BAR_TONE[i.kind === 'future' ? 'future' : i.status] ?? '#64748b';
                return (
                  <button key={i.id} onClick={() => i.link && nav(i.link)} title={`${i.label}\n${i.start} → ${i.end} · ${i.progress}%`}
                    className={clsx('absolute z-10 overflow-hidden rounded-md text-left text-[10px] font-medium text-white shadow-sm ring-2 ring-white transition hover:brightness-110 dark:ring-slate-950', i.overdue && 'outline outline-2 outline-rose-500')}
                    style={{ left, width: w, top: k * ROW + 8, height: ROW - 16, background: `${tone}55` }}>
                    <span className="absolute inset-y-0 left-0" style={{ width: `${i.progress}%`, background: tone }} />
                    {w > 50 && <span className="relative truncate px-1.5 leading-5 text-slate-900 dark:text-white">{i.progress}%</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function spanDays(items: GanttItem[]) {
  const ds = items.filter((i) => i.start).flatMap((i) => [parseISO(i.start), parseISO(i.end || i.start)]);
  return ds.length ? differenceInCalendarDays(maxDate(ds), minDate(ds)) : 0;
}
export { startOfMonth };
