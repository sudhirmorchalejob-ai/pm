import { useRef, useState } from 'react';
import { Paperclip, Plus, Trash2, Upload } from 'lucide-react';
import { api, download } from '../../lib/api';
import { toast } from '../../components/Toast';
import { clsx, Spinner } from '../../components/ui';

export const ANSWER_TYPE_LABELS: Record<string, string> = {
  text: 'Short text', long_text: 'Long text', number: 'Number', date: 'Date', time: 'Time', yes_no: 'Yes / No', url: 'URL',
  url_list: 'List of URLs (with publish time)', single_choice: 'Single choice', multiple_choice: 'Multiple choice', file: 'File upload', rating: 'Rating 1–5', email: 'Email',
};
export const REPORT_TAG_LABELS: Record<string, string> = {
  work_done: 'Completed work', plan: 'Next plans', pending: 'Pending work', blocker: 'Blockers & dependencies', delay: 'Delays & reasons',
  progress: 'Progress / status', deadline: 'Deadlines', campaign: 'Campaigns', url: 'Published URLs', metric: 'Key metric (numbers are summed)', other: 'Other update',
};

export function isAnswered(type: string, v: any) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (type === 'yes_no') return typeof v === 'boolean';
  if (typeof v === 'number') return Number.isFinite(v);
  return true;
}

const norm = (x: any) => (typeof x === 'string' ? x.trim().toLowerCase() : typeof x === 'boolean' ? String(x) : JSON.stringify(x));
/** Same rule as the server (questionnaire/answers.ts) so conditional questions appear as you type. */
export function conditionMet(op: string | null, expected: any, actual: any, actualType: string) {
  if (!op) return true;
  const answered = isAnswered(actualType, actual);
  switch (op) {
    case 'answered': return answered;
    case 'not_answered': return !answered;
    case 'equals': return answered && norm(actual) === norm(expected);
    case 'not_equals': return !answered || norm(actual) !== norm(expected);
    case 'contains':
      if (!answered) return false;
      if (Array.isArray(actual)) return actual.some((a) => norm(typeof a === 'object' ? a.url : a) === norm(expected));
      return String(actual).toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'gt': return answered && Number(actual) > Number(expected);
    case 'lt': return answered && Number(actual) < Number(expected);
    default: return true;
  }
}

export async function uploadFiles(files: FileList | File[]): Promise<{ id: number; original_name: string }[]> {
  const fd = new FormData();
  Array.from(files).forEach((f) => fd.append('files', f));
  return api('/checklists/files', { method: 'POST', form: fd });
}

export function FileChips({ ids, names, onRemove }: { ids: number[]; names: Record<number, string>; onRemove?: (id: number) => void }) {
  if (!ids?.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <span key={id} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs dark:border-slate-700">
          <Paperclip className="h-3 w-3" />
          <button type="button" className="max-w-[180px] truncate hover:underline" onClick={() => download(`/files/${id}/download`).catch((e) => toast.error(e.message))}>{names[id] ?? `file #${id}`}</button>
          {onRemove && <button type="button" aria-label="Remove file" onClick={() => onRemove(id)}><Trash2 className="h-3 w-3 text-slate-400 hover:text-rose-600" /></button>}
        </span>
      ))}
    </div>
  );
}

export function UploadButton({ onUploaded, label = 'Attach files', disabled }: { onUploaded: (files: { id: number; original_name: string }[]) => void; label?: string; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <input ref={ref} type="file" multiple hidden onChange={async (e) => {
        if (!e.target.files?.length) return;
        setBusy(true);
        try { onUploaded(await uploadFiles(e.target.files)); } catch (err: any) { toast.error(err.message); } finally { setBusy(false); e.target.value = ''; }
      }} />
      <button type="button" className="btn-secondary btn-sm" disabled={disabled || busy} onClick={() => ref.current?.click()}>
        {busy ? <Spinner className="h-3.5 w-3.5" /> : <Upload className="h-3.5 w-3.5" />} {label}
      </button>
    </>
  );
}

/** Input control for one question, driven entirely by its configured answer type and options. */
export function AnswerInput({ type, options, value, onChange, disabled, files, onFileNames, id }: {
  type: string; options: any; value: any; onChange: (v: any) => void; disabled?: boolean; files?: Record<number, string>; onFileNames?: (m: Record<number, string>) => void; id?: string;
}) {
  const o = options ?? {};
  switch (type) {
    case 'long_text':
      return <textarea id={id} className="input" rows={3} maxLength={20000} disabled={disabled} placeholder={o.placeholder} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
      return (
        <div className="flex items-center gap-2">
          <input id={id} className="input max-w-[200px]" type="number" inputMode="decimal" disabled={disabled} min={o.min} max={o.max} step="any" value={value ?? ''}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
          {o.unit && <span className="muted text-sm">{o.unit}</span>}
        </div>
      );
    case 'date': return <input id={id} className="input max-w-[200px]" type="date" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} />;
    case 'time': return <input id={id} className="input max-w-[160px]" type="time" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} />;
    case 'email': return <input id={id} className="input" type="email" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'url': return <input id={id} className="input" type="url" inputMode="url" placeholder="https://" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'yes_no':
      return (
        <div className="flex gap-2" role="radiogroup">
          {[true, false].map((b) => (
            <button key={String(b)} type="button" role="radio" aria-checked={value === b} disabled={disabled}
              className={clsx('chip', value === b ? 'chip-on' : 'chip-off')} onClick={() => onChange(value === b ? null : b)}>{b ? 'Yes' : 'No'}</button>
          ))}
        </div>
      );
    case 'rating':
      return (
        <div className="flex gap-1.5" role="radiogroup">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={value === n} disabled={disabled} className={clsx('chip w-10 justify-center', value === n ? 'chip-on' : 'chip-off')} onClick={() => onChange(value === n ? null : n)}>{n}</button>
          ))}
        </div>
      );
    case 'single_choice':
      return (
        <div className="flex flex-wrap gap-1.5" role="radiogroup">
          {(o.choices ?? []).map((c: string) => (
            <button key={c} type="button" role="radio" aria-checked={value === c} disabled={disabled} className={clsx('chip', value === c ? 'chip-on' : 'chip-off')} onClick={() => onChange(value === c ? null : c)}>{c}</button>
          ))}
        </div>
      );
    case 'multiple_choice': {
      const arr: string[] = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {(o.choices ?? []).map((c: string) => {
            const on = arr.includes(c);
            return <button key={c} type="button" aria-pressed={on} disabled={disabled} className={clsx('chip', on ? 'chip-on' : 'chip-off')} onClick={() => onChange(on ? arr.filter((x) => x !== c) : [...arr, c])}>{c}</button>;
          })}
        </div>
      );
    }
    case 'url_list': {
      const rows: any[] = Array.isArray(value) ? value : [];
      const set = (i: number, patch: any) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
      return (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid gap-2 rounded-lg border p-2 dark:border-slate-700 sm:grid-cols-[1fr_190px_auto]">
              <input className="input" type="url" placeholder="https://…" disabled={disabled} value={r.url ?? ''} onChange={(e) => set(i, { url: e.target.value })} aria-label={`Link ${i + 1}`} />
              <input className="input" type="datetime-local" disabled={disabled} value={r.published_at ?? ''} onChange={(e) => set(i, { published_at: e.target.value || null })} aria-label={`Publication time for link ${i + 1}`} />
              {!disabled && <button type="button" className="btn-ghost btn-sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove link"><Trash2 className="h-4 w-4" /></button>}
            </div>
          ))}
          {!disabled && <button type="button" className="btn-secondary btn-sm" onClick={() => onChange([...rows, { url: '', published_at: null }])}><Plus className="h-3.5 w-3.5" /> Add link</button>}
        </div>
      );
    }
    case 'file': {
      const ids: number[] = Array.isArray(value) ? value : [];
      return (
        <div>
          <FileChips ids={ids} names={files ?? {}} onRemove={disabled ? undefined : (fid) => onChange(ids.filter((x) => x !== fid))} />
          {!disabled && <div className="mt-2"><UploadButton label="Upload file" onUploaded={(fs) => { onFileNames?.(Object.fromEntries(fs.map((f) => [f.id, f.original_name]))); onChange([...ids, ...fs.map((f) => f.id)]); }} /></div>}
        </div>
      );
    }
    default:
      return <input id={id} className="input" maxLength={2000} disabled={disabled} placeholder={o.placeholder} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** Remove blank rows before sending a URL list. */
export function cleanValue(type: string, v: any) {
  if (type === 'url_list' && Array.isArray(v)) return v.filter((r) => r?.url?.trim());
  if (typeof v === 'string' && !v.trim()) return null;
  return v;
}
