import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { AlertTriangle, ChevronLeft, ChevronRight, Inbox, Loader2, Search, X } from 'lucide-react';
import { humanize, initials } from '../lib/format';
import { useApi } from '../lib/hooks';

export { clsx };

// ---------------------------------------------------------------- layout primitives
export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: string }) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {back && <Link to={back} className="muted mb-1 inline-flex items-center text-xs hover:text-brand-600"><ChevronLeft className="h-3.5 w-3.5" /> Back</Link>}
        <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {subtitle && <div className="muted mt-0.5 text-sm">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={clsx('card min-w-0', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b px-4 py-3 sm:px-5">
          <h2 className="section-title truncate">{title}</h2>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={pad ? 'card-pad' : ''}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone = 'default', icon: Icon, to }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'danger' | 'warn' | 'good' | 'brand'; icon?: any; to?: string }) {
  const tones = { default: 'text-slate-900 dark:text-slate-100', danger: 'text-rose-600 dark:text-rose-400', warn: 'text-amber-600 dark:text-amber-400', good: 'text-emerald-600 dark:text-emerald-400', brand: 'text-brand-600 dark:text-brand-400' };
  const body = (
    <div className="card flex h-full items-start justify-between gap-2 p-3.5 transition hover:shadow-md sm:p-4">
      <div className="min-w-0">
        <div className="muted line-clamp-2 text-xs font-medium leading-snug">{label}</div>
        <div className={clsx('mt-1 text-xl font-semibold tabular-nums sm:text-2xl', tones[tone])}>{value}</div>
        {hint && <div className="muted mt-0.5 truncate text-xs">{hint}</div>}
      </div>
      {Icon && <Icon className="h-5 w-5 shrink-0 text-slate-400" />}
    </div>
  );
  return to ? <Link to={to} className="block">{body}</Link> : body;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('h-5 w-5 animate-spin text-brand-500', className)} aria-label="Loading" />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500"><Spinner /> {label}</div>;
}

export function ErrorState({ error, onRetry }: { error: any; onRetry?: () => void }) {
  return (
    <div className="card flex flex-col items-center gap-2 p-8 text-center">
      <AlertTriangle className="h-8 w-8 text-amber-500" />
      <p className="font-medium">{error?.status === 403 ? 'You don’t have access to this' : error?.status === 404 ? 'Not found' : 'Something went wrong'}</p>
      <p className="muted text-sm">{error?.message}</p>
      {onRetry && <button className="btn-secondary mt-2" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Empty({ title = 'Nothing here yet', hint, action, icon: Icon = Inbox }: { title?: string; hint?: ReactNode; action?: ReactNode; icon?: any }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <Icon className="h-8 w-8 text-slate-300 dark:text-slate-600" />
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="muted max-w-sm text-sm">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- badges
const STATUS_TONE: Record<string, string> = {
  not_started: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  in_progress: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  on_hold: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  blocked: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  submitted: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  under_review: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  revision_required: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  cancelled: 'bg-slate-200 text-slate-500 line-through dark:bg-slate-800 dark:text-slate-500',
  // projects
  proposed: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  under_evaluation: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  approved: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  planned: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
  ready_to_start: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  // generic
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  rejected: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  draft: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  scheduled: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  sent: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  delivered: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  read: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  failed: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  retried: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  skipped: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  open: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  done: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  reviewed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  needs_info: 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  awaiting_approval: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
  missed: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  on_track: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  at_risk: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  late: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
};
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const s = status === 'submitted' ? 'Submitted for review' : undefined;
  return <span className={clsx('badge', STATUS_TONE[status] ?? 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300')}>{label ?? s ?? humanize(status)}</span>;
}
const PRIO: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300', medium: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
  high: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300', critical: 'bg-rose-600 text-white',
};
export const PriorityBadge = ({ priority }: { priority: string }) => <span className={clsx('badge', PRIO[priority])}>{humanize(priority)}</span>;

export function Progress({ value, tone }: { value: number; tone?: string }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
        <div className={clsx('h-full rounded-full', tone ?? (v >= 100 ? 'bg-emerald-500' : 'bg-brand-500'))} style={{ width: `${v}%` }} />
      </div>
      <span className="w-9 text-right text-xs tabular-nums text-slate-500">{v}%</span>
    </div>
  );
}

export function Avatar({ name, size = 'md' }: { name?: string; size?: 'sm' | 'md' }) {
  const hue = [...(name ?? '')].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <span className={clsx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-8 w-8 text-xs')}
      style={{ background: `hsl(${hue} 55% 48%)` }} title={name}>{initials(name)}</span>
  );
}

export function AvatarStack({ people, max = 3 }: { people: { id: number; name: string }[]; max?: number }) {
  return (
    <div className="flex -space-x-1.5">
      {people.slice(0, max).map((p) => <span key={p.id} className="rounded-full ring-2 ring-white dark:ring-slate-900"><Avatar name={p.name} size="sm" /></span>)}
      {people.length > max && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-[10px] ring-2 ring-white dark:bg-slate-700 dark:ring-slate-900">+{people.length - max}</span>}
    </div>
  );
}

// ---------------------------------------------------------------- forms
export function Field({ label, error, hint, children, className }: { label: string; error?: string | string[]; hint?: ReactNode; children: ReactNode; className?: string }) {
  const err = Array.isArray(error) ? error[0] : error;
  return (
    <label className={clsx('block min-w-0', className)}>
      <span className="label">{label}</span>
      {children}
      {err ? <span className="mt-1 block text-xs text-rose-600">{err}</span> : hint ? <span className="muted mt-1 block text-xs">{hint}</span> : null}
    </label>
  );
}

export function Select({ value, onChange, options, placeholder, className, ...rest }: { value: any; onChange: (v: string) => void; options: { value: any; label: string }[]; placeholder?: string; className?: string; [k: string]: any }) {
  return (
    <select className={clsx('input', className)} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={String(o.value)} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={clsx('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input className="input pl-9" type="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} aria-label={placeholder} />
    </div>
  );
}

export function Chips<T extends string>({ value, onChange, options, multi = false }: { value: T[] | T; onChange: (v: any) => void; options: { value: T; label: string }[]; multi?: boolean }) {
  const arr = Array.isArray(value) ? value : [value];
  return (
    <div className="scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
      {options.map((o) => {
        const on = arr.includes(o.value);
        return (
          <button key={o.value} type="button" className={clsx('chip shrink-0', on ? 'chip-on' : 'chip-off')} aria-pressed={on}
            onClick={() => (multi ? onChange(on ? arr.filter((x) => x !== o.value) : [...arr, o.value]) : onChange(o.value))}>{o.label}</button>
        );
      })}
    </div>
  );
}

/** Searchable people picker (single or multi) backed by the directory endpoint. */
export function UserPicker({ value, onChange, multi = false, placeholder = 'Select people…', departmentId, exclude = [] }: { value: number[] | number | null; onChange: (v: any) => void; multi?: boolean; placeholder?: string; departmentId?: number | null; exclude?: number[] }) {
  const { data = [] } = useApi<any[]>(['directory', departmentId], '/org/directory', departmentId ? { department_id: departmentId } : undefined, { staleTime: 60_000 });
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = Array.isArray(value) ? value : value ? [value] : [];
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const filtered = useMemo(() => data.filter((u) => !exclude.includes(u.id) && (!q || `${u.name} ${u.employee_code} ${u.department_name ?? ''}`.toLowerCase().includes(q.toLowerCase()))).slice(0, 50), [data, q, exclude]);
  const byId = new Map(data.map((u) => [u.id, u]));
  const toggle = (id: number) => {
    if (multi) onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
    else { onChange(id); setOpen(false); setQ(''); }
  };
  return (
    <div className="relative" ref={ref}>
      <div className="input flex min-h-[40px] flex-wrap items-center gap-1 py-1.5" onClick={() => setOpen(true)}>
        {selected.map((id) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-1.5 py-0.5 text-xs text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
            {(byId.get(id) as any)?.name ?? `#${id}`}
            <button type="button" aria-label="Remove" onClick={(e) => { e.stopPropagation(); onChange(multi ? selected.filter((x) => x !== id) : null); }}><X className="h-3 w-3" /></button>
          </span>
        ))}
        <input className="min-w-[80px] flex-1 bg-transparent text-sm outline-none" value={q} placeholder={selected.length ? '' : placeholder} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} />
      </div>
      {open && (
        <ul className="card absolute z-50 mt-1 max-h-60 w-full overflow-auto p-1 shadow-lg" role="listbox">
          {filtered.length === 0 && <li className="muted px-3 py-2 text-sm">No matches</li>}
          {filtered.map((u) => (
            <li key={u.id}>
              <button type="button" className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800', selected.includes(u.id) && 'bg-brand-50 dark:bg-brand-900/30')} onClick={() => toggle(u.id)}>
                <Avatar name={u.name} size="sm" />
                <span className="min-w-0 flex-1"><span className="block truncate">{u.name}</span><span className="muted block truncate text-xs">{u.designation ?? ''}{u.department_name ? ` · ${u.department_name}` : ''}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- overlays
/** Centered dialog on desktop, bottom sheet on mobile. */
export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', h); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;
  const w = { sm: 'sm:max-w-md', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' }[size];
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-[1px]" onClick={onClose} />
      <div className={clsx('relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl bg-white shadow-xl dark:bg-slate-900 sm:rounded-2xl', w)}>
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-300 dark:bg-slate-700 sm:hidden" />
        <header className="flex items-center justify-between gap-2 border-b px-4 py-3 sm:px-5">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          <button className="btn-ghost btn-sm" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {footer && <footer className="pb-safe flex flex-col-reverse gap-2 border-t px-4 py-3 sm:flex-row sm:justify-end sm:px-5">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

let confirmImpl: (o: ConfirmOpts) => Promise<boolean> = async () => false;
interface ConfirmOpts { title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean; input?: { label: string; required?: boolean; placeholder?: string } }
/** Promise-based confirm dialog: `if (await confirm({...}))`. With `input`, resolves to the text (or false). */
export const confirm = (o: ConfirmOpts) => confirmImpl(o) as Promise<any>;
export function ConfirmHost() {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: any) => void }) | null>(null);
  const [text, setText] = useState('');
  useEffect(() => { confirmImpl = (o) => new Promise((resolve) => { setText(''); setState({ ...o, resolve }); }); }, []);
  if (!state) return null;
  const close = (v: any) => { state.resolve(v); setState(null); };
  return (
    <Modal open onClose={() => close(false)} title={state.title} size="sm"
      footer={<>
        <button className="btn-secondary" onClick={() => close(false)}>Cancel</button>
        <button className={state.danger ? 'btn-danger' : 'btn-primary'} disabled={state.input?.required && !text.trim()} onClick={() => close(state.input ? text.trim() || true : true)}>{state.confirmLabel ?? 'Confirm'}</button>
      </>}>
      {state.message && <div className="text-sm text-slate-600 dark:text-slate-300">{state.message}</div>}
      {state.input && <Field label={state.input.label} className="mt-3"><textarea className="input" rows={3} autoFocus value={text} placeholder={state.input.placeholder} onChange={(e) => setText(e.target.value)} /></Field>}
    </Modal>
  );
}

// ---------------------------------------------------------------- tabs & tables
export function Tabs({ tabs, value, onChange }: { tabs: { value: string; label: ReactNode; count?: number }[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="scrollbar-thin -mx-4 mb-4 overflow-x-auto border-b px-4 sm:mx-0 sm:px-0" role="tablist">
      <div className="flex gap-1">
        {tabs.map((t) => (
          <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
            className={clsx('-mb-px flex min-h-[40px] shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition', value === t.value ? 'border-brand-600 text-brand-700 dark:text-brand-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200')}>
            {t.label}{t.count != null && <span className="rounded-full bg-slate-100 px-1.5 text-[11px] dark:bg-slate-800">{t.count}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface Column<T> { key: string; header: ReactNode; render?: (row: T) => ReactNode; className?: string; sortable?: boolean }

/**
 * Responsive data table: a real table from md breakpoint, stacked cards on phones
 * (via `card` renderer, or an automatic label/value layout).
 */
export function DataTable<T extends { id?: any }>({ columns, rows, onRowClick, card, sort, onSort, empty }: {
  columns: Column<T>[]; rows: T[]; onRowClick?: (r: T) => void; card?: (r: T) => ReactNode; sort?: string; onSort?: (s: string) => void; empty?: ReactNode;
}) {
  if (!rows.length) return <>{empty ?? <Empty />}</>;
  const [sf, sd] = (sort ?? '').split(':');
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.className}>
                  {c.sortable && onSort ? (
                    <button className="inline-flex items-center gap-1 uppercase" onClick={() => onSort(`${c.key}:${sf === c.key && sd === 'asc' ? 'desc' : 'asc'}`)}>
                      {c.header}{sf === c.key && <span aria-hidden>{sd === 'asc' ? '▲' : '▼'}</span>}
                    </button>
                  ) : c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id ?? i} className={onRowClick ? 'cursor-pointer' : ''} onClick={() => onRowClick?.(r)}>
                {columns.map((c) => <td key={c.key} className={c.className}>{c.render ? c.render(r) : (r as any)[c.key] ?? '—'}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y md:hidden">
        {rows.map((r, i) => (
          <li key={r.id ?? i} className={clsx('py-3', onRowClick && 'cursor-pointer active:bg-slate-50 dark:active:bg-slate-800')} onClick={() => onRowClick?.(r)}>
            {card ? card(r) : (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                {columns.map((c) => (
                  <div key={c.key} className="min-w-0"><dt className="muted text-[11px] uppercase">{c.header}</dt><dd className="truncate">{c.render ? c.render(r) : (r as any)[c.key] ?? '—'}</dd></div>
                ))}
              </dl>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return total ? <p className="muted mt-3 text-xs">{total} item{total === 1 ? '' : 's'}</p> : null;
  return (
    <div className="mt-3 flex items-center justify-between gap-2 text-sm">
      <span className="muted text-xs">{(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} of {total}</span>
      <div className="flex items-center gap-1">
        <button className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></button>
        <span className="px-2 text-xs tabular-nums">{page} / {pages}</span>
        <button className="btn-secondary btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm xs:grid-cols-2">
      {items.map(([k, v], i) => <div key={i} className="min-w-0"><dt className="muted text-xs">{k}</dt><dd className="mt-0.5 break-words">{v ?? '—'}</dd></div>)}
    </dl>
  );
}
