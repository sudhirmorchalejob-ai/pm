import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BellRing, Check, Repeat, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDate, todayIso } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { toast } from '../../components/Toast';
import { clsx, confirm, Field, Modal, PriorityBadge, Select, Spinner } from '../../components/ui';

const W = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
type Repeat = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';
const REMINDERS = [{ v: '', l: 'No reminder' }, { v: '0', l: 'At due time' }, { v: '15', l: '15 min before' }, { v: '30', l: '30 min before' }, { v: '60', l: '1 hour before' }, { v: '120', l: '2 hours before' }];

export const invalidateMyWork = (qc: ReturnType<typeof useQueryClient>) =>
  ['my-work-today', 'my-tasks', 'my-series', 'my-eod'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

/** New personal task — one-off or repeating (each day's occurrence gets its own status). */
export function TaskFormModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ title: '', description: '', priority: 'medium', project_id: '', due_date: todayIso(), due_time: '', reminder: '', repeat: 'none' as Repeat, weekdays: [] as number[], month_day: '1', end_date: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { data: projects } = useApi<any>(['projects-mini-active'], open ? '/projects' : null, { pageSize: 200, status: 'approved,planned,ready_to_start,in_progress,on_hold', future: 'false' }, { staleTime: 300_000 });
  useEffect(() => { if (open) { setErr(null); setF((s) => ({ ...s, title: '', description: '', due_date: todayIso(), due_time: '', reminder: '', repeat: 'none', weekdays: [], end_date: '' })); } }, [open]);
  const set = (k: string, v: any) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    setErr(null);
    if (f.title.trim().length < 2) { setErr('Enter a title'); return; }
    const base: any = { title: f.title.trim(), description: f.description.trim() || null, priority: f.priority, project_id: f.project_id ? Number(f.project_id) : null };
    if (f.repeat !== 'none') {
      const freq = f.repeat === 'weekly' ? { frequency: 'weekly', frequency_config: { weekdays: f.weekdays.length ? f.weekdays : [new Date().getDay() || 7] } }
        : f.repeat === 'monthly' ? { frequency: 'monthly', frequency_config: { month_days: [Number(f.month_day)] } }
          : { frequency: 'daily', frequency_config: f.repeat === 'weekdays' ? { working_days_only: true } : {} };
      base.recurrence = { ...freq, start_date: f.due_date || todayIso(), end_date: f.end_date || null };
      base.due_time = f.due_time || null;
      base.reminder_offset_minutes = f.due_time && f.reminder !== '' ? Number(f.reminder) : null;
    } else {
      base.due_date = f.due_date || null;
      base.due_time = f.due_date && f.due_time ? f.due_time : null;
      base.reminder_offset_minutes = f.due_date && f.due_time && f.reminder !== '' ? Number(f.reminder) : null;
    }
    setSaving(true);
    try {
      await api('/my-work/tasks', { method: 'POST', body: base });
      invalidateMyWork(qc);
      toast.success(f.repeat === 'none' ? 'Task added' : 'Repeating task added');
      onClose();
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="New personal task"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={saving} onClick={save}>{saving && <Spinner className="h-4 w-4" />} Add task</button></>}>
      <div className="space-y-3" onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); }}>
        <Field label="Task"><input className="input" autoFocus value={f.title} maxLength={300} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Review pending implementations" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Priority"><Select value={f.priority} onChange={(v) => set('priority', v)} options={['low', 'medium', 'high', 'critical'].map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))} /></Field>
          <Field label="Project (optional)"><Select value={f.project_id} onChange={(v) => set('project_id', v)} placeholder="No project" options={(projects?.items ?? []).map((p: any) => ({ value: p.id, label: p.name }))} /></Field>
        </div>
        <div>
          <span className="label">Repeat</span>
          <div className="flex flex-wrap gap-1.5">
            {([['none', 'Does not repeat'], ['daily', 'Every day'], ['weekdays', 'Working days'], ['weekly', 'Weekly'], ['monthly', 'Monthly']] as [Repeat, string][]).map(([v, l]) => (
              <button key={v} type="button" className={clsx('chip', f.repeat === v ? 'chip-on' : 'chip-off')} onClick={() => set('repeat', v)}>{l}</button>
            ))}
          </div>
          {f.repeat === 'weekly' && (
            <div className="mt-2 flex flex-wrap gap-1">
              {W.map((d, i) => <button key={d} type="button" className={clsx('chip', f.weekdays.includes(i + 1) ? 'chip-on' : 'chip-off')} onClick={() => set('weekdays', f.weekdays.includes(i + 1) ? f.weekdays.filter((x) => x !== i + 1) : [...f.weekdays, i + 1])}>{d}</button>)}
            </div>
          )}
          {f.repeat === 'monthly' && <Field label="Day of month" className="mt-2 max-w-[160px]"><Select value={f.month_day} onChange={(v) => set('month_day', v)} options={[...Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })), { value: '-1', label: 'Last day' }]} /></Field>}
          {f.repeat !== 'none' && <p className="muted mt-1 text-xs">Each occurrence gets its own completion status — nothing is marked done automatically.</p>}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={f.repeat === 'none' ? 'Due date' : 'Starts on'}><input type="date" className="input" value={f.due_date} onChange={(e) => set('due_date', e.target.value)} /></Field>
          <Field label="Due time (optional)"><input type="time" className="input" value={f.due_time} onChange={(e) => set('due_time', e.target.value)} /></Field>
          <Field label="Reminder"><Select value={f.reminder} disabled={!f.due_time} onChange={(v) => set('reminder', v)} options={REMINDERS.map((r) => ({ value: r.v, label: r.l }))} /></Field>
        </div>
        {f.repeat !== 'none' && <Field label="Ends on (optional)" className="max-w-[200px]"><input type="date" className="input" value={f.end_date} min={f.due_date} onChange={(e) => set('end_date', e.target.value)} /></Field>}
        <Field label="Description (optional)"><textarea className="input min-h-[64px]" value={f.description} maxLength={5000} onChange={(e) => set('description', e.target.value)} /></Field>
        {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/30 dark:text-rose-200" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}

/** Complete a task, optionally with a completion note. */
export function CompleteTaskModal({ task, onClose }: { task: any | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setNote(''), [task]);
  async function done() {
    setBusy(true);
    try {
      await api(`/my-work/tasks/${task.id}`, { method: 'PATCH', body: { status: 'completed', completion_note: note.trim() || null } });
      invalidateMyWork(qc); toast.success('Marked completed'); onClose();
    } catch (e: any) { toast.error(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal open={!!task} onClose={onClose} title="Mark task completed" size="sm"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy} onClick={done}><Check className="h-4 w-4" /> Completed</button></>}>
      <p className="mb-3 text-sm font-medium">{task?.title}</p>
      <Field label="Completion note (optional)"><textarea className="input min-h-[72px]" autoFocus value={note} maxLength={5000} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done(); }} /></Field>
    </Modal>
  );
}

/** A personal task row with one-tap completion. */
export function TaskRow({ t, onComplete, today, showDelete }: { t: any; onComplete: (t: any) => void; today: string; showDelete?: boolean }) {
  const qc = useQueryClient();
  const overdue = t.status === 'pending' && t.due_date && t.due_date < today;
  const reopen = async () => { await api(`/my-work/tasks/${t.id}`, { method: 'PATCH', body: { status: 'pending' } }).catch((e) => toast.error(e.message)); invalidateMyWork(qc); };
  const remove = async () => {
    if (!(await confirm({ title: 'Delete this task?', message: t.series_id ? 'Only this occurrence is deleted; the repeating task continues.' : undefined, danger: true, confirmLabel: 'Delete' }))) return;
    await api(`/my-work/tasks/${t.id}`, { method: 'DELETE' }).catch((e) => toast.error(e.message)); invalidateMyWork(qc);
  };
  const time = t.due_at && t.due_date ? new Date(t.due_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <li className="flex items-start gap-3 py-2">
      {t.status === 'pending' ? (
        <button className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 border-slate-300 hover:border-brand-600 dark:border-slate-600" aria-label={`Complete ${t.title}`} onClick={() => onComplete(t)} />
      ) : (
        <button className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-600 text-white" aria-label={`Reopen ${t.title}`} title="Reopen" onClick={reopen}><Check className="h-4 w-4" /></button>
      )}
      <div className="min-w-0 flex-1">
        <p className={clsx('text-sm', t.status === 'completed' && 'text-slate-500 line-through')}>{t.title}</p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
          {t.priority !== 'medium' && <PriorityBadge priority={t.priority} />}
          {t.series_id && <span className="inline-flex items-center gap-0.5"><Repeat className="h-3 w-3" /> repeating</span>}
          {t.due_date && <span className={clsx(overdue && 'font-medium text-rose-600')}>{overdue ? `Overdue · ${fmtDate(t.due_date)}` : t.due_date === today ? `Today${time ? ` ${time}` : ''}` : fmtDate(t.due_date)}</span>}
          {t.remind_at && t.status === 'pending' && <span className="inline-flex items-center gap-0.5"><BellRing className="h-3 w-3" /> {new Date(t.remind_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
          {t.project_name && <span>📁 {t.project_name}</span>}
        </div>
        {t.completion_note && <p className="muted mt-0.5 text-xs">✓ {t.completion_note}</p>}
      </div>
      {t.status === 'completed' && <button className="btn-ghost btn-sm" onClick={reopen} aria-label="Reopen"><RotateCcw className="h-3.5 w-3.5" /></button>}
      {showDelete && <button className="btn-ghost btn-sm" onClick={remove} aria-label="Delete task"><Trash2 className="h-3.5 w-3.5 text-slate-400" /></button>}
    </li>
  );
}
