import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useApi } from '../../lib/hooks';
import { toast } from '../../components/Toast';
import { clsx, Field, Modal, Select, Spinner, UserPicker } from '../../components/ui';
import { AttachButton, Category, FileList, useCategories } from './common';

const STATUSES = [
  { value: 'completed', label: 'Completed' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'pending', label: 'Pending' },
] as const;
const DURATIONS = [15, 30, 45, 60, 90, 120];
const pad = (n: number) => String(n).padStart(2, '0');
const localNow = () => { const d = new Date(); return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; };
const toLocalParts = (iso: string) => { const d = new Date(iso); return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }; };

interface FormState {
  category_id: number | null; description: string; participant_ids: number[]; department_ids: number[]; project_id: number | null;
  status: string; date: string; time: string; timeEdited: boolean; duration_minutes: number | null;
  follow_up_required: boolean; follow_up_note: string; follow_up_due: string; issue_resolved: boolean | null; bugs_found: string;
  files: { id: number; original_name: string }[]; reason: string;
}
const blank = (category_id: number | null = null): FormState => ({
  category_id, description: '', participant_ids: [], department_ids: [], project_id: null, status: 'completed', ...localNow(), timeEdited: false,
  duration_minutes: null, follow_up_required: false, follow_up_note: '', follow_up_due: '', issue_resolved: null, bugs_found: '', files: [], reason: '',
});

/**
 * Super-fast activity entry: pick a category, type what happened, save. Everything else
 * (employees, project, time, duration, follow-up, attachments) is optional.
 */
export function QuickActivityModal({ open, onClose, edit, defaultDate }: { open: boolean; onClose: () => void; edit?: any | null; defaultDate?: string }) {
  const qc = useQueryClient();
  const { sorted, isLoading } = useCategories(open);
  const [f, setF] = useState<FormState>(blank());
  const [showAll, setShowAll] = useState(false);
  const [more, setMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const { data: departments = [] } = useApi<any[]>(['departments'], open ? '/org/departments' : null, undefined, { staleTime: 300_000 });
  const { data: projects } = useApi<any>(['projects-mini-active'], open ? '/projects' : null, { pageSize: 200, status: 'approved,planned,ready_to_start,in_progress,on_hold', future: 'false' }, { staleTime: 300_000 });

  useEffect(() => {
    if (!open) return;
    setErr(null); setShowAll(false);
    if (edit) {
      const p = toLocalParts(edit.occurred_at);
      setF({
        category_id: edit.category_id, description: edit.description, participant_ids: (edit.participants ?? []).filter((x: any) => !x.via_department_id).map((x: any) => x.id),
        department_ids: edit.department_ids ?? [], project_id: edit.project_id, status: edit.status, ...p, timeEdited: true, duration_minutes: edit.duration_minutes,
        follow_up_required: edit.follow_up_required, follow_up_note: edit.follow_up_note ?? '', follow_up_due: edit.follow_up_due ?? '', issue_resolved: edit.issue_resolved,
        bugs_found: edit.bugs_found != null ? String(edit.bugs_found) : '', files: edit.files ?? [], reason: '',
      });
      setMore(true);
    } else {
      const b = blank(null);
      if (defaultDate && defaultDate !== b.date) { b.date = defaultDate; b.time = '12:00'; b.timeEdited = true; }
      setF(b); setMore(false);
    }
  }, [open, edit, defaultDate]);

  const cat: Category | undefined = sorted.find((c) => c.id === f.category_id);
  const visible = useMemo(() => {
    if (showAll) return sorted;
    const top = sorted.slice(0, 8);
    if (f.category_id && !top.some((c) => c.id === f.category_id)) { const sel = sorted.find((c) => c.id === f.category_id); if (sel) top.push(sel); }
    return top;
  }, [sorted, showAll, f.category_id]);
  const groups = useMemo(() => {
    const m = new Map<string, Category[]>();
    for (const c of [...sorted].sort((a, b) => a.sort_order - b.sort_order)) { if (!m.has(c.group_name)) m.set(c.group_name, []); m.get(c.group_name)!.push(c); }
    return [...m.entries()];
  }, [sorted]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const pick = (id: number) => { set('category_id', id); setShowAll(false); setTimeout(() => descRef.current?.focus(), 0); };

  const isTesting = cat && ['testing', 'missing_functionality'].includes(cat.report_section);
  const isIssue = cat && ['guidance', 'issue_resolution', 'review'].includes(cat.report_section);

  async function save(another: boolean) {
    setErr(null);
    if (!f.category_id) { setErr('Choose a category'); return; }
    if (f.description.trim().length < 2) { setErr('Describe the activity'); descRef.current?.focus(); return; }
    const occurred = f.timeEdited || edit ? new Date(`${f.date}T${f.time}`).toISOString() : undefined;
    const body: any = {
      category_id: f.category_id, description: f.description.trim(), participant_ids: f.participant_ids, department_ids: f.department_ids,
      project_id: f.project_id || null, status: f.status, duration_minutes: f.duration_minutes || null, file_ids: f.files.map((x) => x.id),
      follow_up_required: f.follow_up_required, follow_up_note: f.follow_up_required ? f.follow_up_note.trim() || null : null,
      follow_up_due: f.follow_up_required && f.follow_up_due ? f.follow_up_due : null,
      issue_resolved: f.issue_resolved, bugs_found: f.bugs_found === '' ? null : Number(f.bugs_found),
    };
    if (occurred) body.occurred_at = occurred;
    setSaving(true);
    try {
      if (edit) await api(`/activities/${edit.id}`, { method: 'PATCH', body: { ...body, reason: f.reason.trim() || null, expected_revision: edit.revision } });
      else await api('/activities', { method: 'POST', body });
      ['my-work-today', 'activities', 'my-eod', 'coordination', 'dashboard-team'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      qc.invalidateQueries({ queryKey: ['activity-categories'] });
      toast.success(edit ? 'Activity updated' : 'Activity saved');
      if (another && !edit) { setF(blank(f.category_id)); setTimeout(() => descRef.current?.focus(), 0); } else onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={edit ? 'Edit activity' : 'Add daily activity'} size="lg"
      footer={<div className={clsx('grid gap-2 sm:flex sm:justify-end', edit ? 'grid-cols-1' : 'grid-cols-2')}>
        <button className="btn-secondary hidden sm:inline-flex" onClick={onClose}>Cancel</button>
        {!edit && <button className="btn-secondary" disabled={saving} onClick={() => save(true)}>Save & add another</button>}
        <button className="btn-primary" disabled={saving} onClick={() => save(false)}>{saving && <Spinner className="h-4 w-4" />} {edit ? 'Save changes' : 'Save'}</button>
      </div>}>
      <div className="space-y-4" onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(false); } }}>
        {/* 1. category */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="label mb-0">Activity</span>
            {sorted.length > 8 && <button type="button" className="text-xs font-medium text-brand-600" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `All ${sorted.length} categories`}</button>}
          </div>
          {isLoading ? <Spinner /> : showAll ? (
            <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
              {groups.map(([g, list]) => (
                <div key={g}>
                  <div className="muted mb-1 text-[11px] font-semibold uppercase tracking-wide">{g}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {list.map((c) => <button key={c.id} type="button" className={clsx('chip', f.category_id === c.id ? 'chip-on' : 'chip-off')} aria-pressed={f.category_id === c.id} onClick={() => pick(c.id)}>{c.name}</button>)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {visible.map((c) => <button key={c.id} type="button" className={clsx('chip', f.category_id === c.id ? 'chip-on' : 'chip-off')} aria-pressed={f.category_id === c.id} onClick={() => pick(c.id)}>{c.name}</button>)}
            </div>
          )}
        </div>

        {/* 2. what happened */}
        <Field label="What did you do?">
          <textarea ref={descRef} className="input min-h-[88px]" value={f.description} maxLength={5000} onChange={(e) => set('description', e.target.value)}
            placeholder={cat?.suggests_employee ? 'e.g. Explained the API integration approach and next steps' : 'e.g. Tested the HRMS website and mobile app; found missing functionality'} />
        </Field>

        {/* 3. people (optional) */}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={cat?.suggests_employee ? 'Employee(s)' : 'Employee(s) — optional'}>
            <UserPicker multi value={f.participant_ids} onChange={(v: number[]) => set('participant_ids', v)} placeholder="Search employees…" />
          </Field>
          <Field label="Whole department — optional">
            <Select value="" onChange={(v) => v && !f.department_ids.includes(Number(v)) && set('department_ids', [...f.department_ids, Number(v)])}
              placeholder={f.department_ids.length ? 'Add another department…' : 'No department'} options={departments.filter((d: any) => d.is_active && !f.department_ids.includes(d.id)).map((d: any) => ({ value: d.id, label: d.name }))} />
            {f.department_ids.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {f.department_ids.map((id) => (
                  <button key={id} type="button" className="chip chip-on" onClick={() => set('department_ids', f.department_ids.filter((x) => x !== id))} aria-label="Remove department">
                    {departments.find((d: any) => d.id === id)?.name ?? `#${id}`} ✕
                  </button>
                ))}
              </div>
            )}
          </Field>
        </div>

        {/* 4. status */}
        <div>
          <span className="label">Status</span>
          <div className="flex flex-wrap gap-1.5">
            {STATUSES.map((s) => <button key={s.value} type="button" className={clsx('chip', f.status === s.value ? 'chip-on' : 'chip-off')} aria-pressed={f.status === s.value} onClick={() => set('status', s.value)}>{s.label}</button>)}
          </div>
        </div>

        <button type="button" className="flex items-center gap-1 text-sm font-medium text-brand-600" onClick={() => setMore((v) => !v)} aria-expanded={more}>
          {more ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />} {more ? 'Fewer details' : 'Project, time, follow-up, attachments'}
        </button>

        {more && (
          <div className="space-y-4 rounded-xl border border-dashed p-3 dark:border-slate-700">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Project" className="sm:col-span-1">
                <Select value={f.project_id ?? ''} onChange={(v) => set('project_id', v ? Number(v) : null)} placeholder="No project" options={(projects?.items ?? []).map((p: any) => ({ value: p.id, label: p.name }))} />
              </Field>
              <Field label="Date">
                <input type="date" className="input" value={f.date} max={localNow().date} onChange={(e) => setF((s) => ({ ...s, date: e.target.value, timeEdited: true }))} />
              </Field>
              <Field label="Time">
                <input type="time" className="input" value={f.time} onChange={(e) => setF((s) => ({ ...s, time: e.target.value, timeEdited: true }))} />
              </Field>
            </div>
            <div>
              <span className="label">Duration</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {DURATIONS.map((m) => <button key={m} type="button" className={clsx('chip', f.duration_minutes === m ? 'chip-on' : 'chip-off')} onClick={() => set('duration_minutes', f.duration_minutes === m ? null : m)}>{m >= 60 ? `${m / 60} h` : `${m} min`}</button>)}
                <input type="number" min={1} max={1440} className="input w-24" placeholder="min" aria-label="Duration in minutes" value={f.duration_minutes && !DURATIONS.includes(f.duration_minutes) ? f.duration_minutes : ''} onChange={(e) => set('duration_minutes', e.target.value ? Number(e.target.value) : null)} />
              </div>
            </div>
            {(isIssue || f.issue_resolved !== null) && (
              <div>
                <span className="label">Issue resolved?</span>
                <div className="flex gap-1.5">
                  {[{ v: true, l: 'Yes' }, { v: false, l: 'Not yet' }, { v: null, l: 'N/A' }].map((o) => (
                    <button key={String(o.v)} type="button" className={clsx('chip', f.issue_resolved === o.v ? 'chip-on' : 'chip-off')} onClick={() => set('issue_resolved', o.v)}>{o.l}</button>
                  ))}
                </div>
              </div>
            )}
            {(isTesting || f.bugs_found !== '') && (
              <Field label="Bugs found" className="max-w-[160px]">
                <input type="number" min={0} max={10000} className="input" value={f.bugs_found} onChange={(e) => set('bugs_found', e.target.value)} />
              </Field>
            )}
            <div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.follow_up_required} onChange={(e) => set('follow_up_required', e.target.checked)} /> Follow-up required</label>
              {f.follow_up_required && (
                <div className="mt-2 grid gap-3 sm:grid-cols-3">
                  <Field label="Follow-up note" className="sm:col-span-2"><input className="input" value={f.follow_up_note} maxLength={2000} onChange={(e) => set('follow_up_note', e.target.value)} placeholder="What needs to be checked" /></Field>
                  <Field label="By date"><input type="date" className="input" value={f.follow_up_due} onChange={(e) => set('follow_up_due', e.target.value)} /></Field>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <AttachButton onUploaded={(files) => set('files', [...f.files, ...files])} />
              <FileList files={f.files} onRemove={(id) => set('files', f.files.filter((x) => x.id !== id))} />
            </div>
            {edit && <Field label="Reason for change (optional)"><input className="input" value={f.reason} maxLength={500} onChange={(e) => set('reason', e.target.value)} /></Field>}
          </div>
        )}
        {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/30 dark:text-rose-200" role="alert">{err}</p>}
        <p className="muted hidden text-xs sm:block">Tip: Ctrl + Enter saves.</p>
      </div>
    </Modal>
  );
}

/** Prominent "+ Add Daily Activity" button (and an optional floating button on phones). */
export function QuickAddActivity({ fab = false, className, label = 'Add Daily Activity', defaultDate }: { fab?: boolean; className?: string; label?: string; defaultDate?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={clsx('btn-primary', className)} onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> {label}</button>
      {fab && (
        <button onClick={() => setOpen(true)} aria-label="Add daily activity"
          className="fixed bottom-20 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg shadow-brand-600/30 hover:bg-brand-700 active:scale-95 sm:hidden"
          style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
          <Plus className="h-6 w-6" />
        </button>
      )}
      <QuickActivityModal open={open} onClose={() => setOpen(false)} defaultDate={defaultDate} />
    </>
  );
}
