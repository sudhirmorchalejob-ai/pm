import { useRef, useState } from 'react';
import { History, Paperclip, Pencil, Trash2, Upload, Users } from 'lucide-react';
import { api, download } from '../../lib/api';
import { fmtDateTime, humanize } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { toast } from '../../components/Toast';
import { clsx, Modal, Spinner } from '../../components/ui';

export interface Category { id: number; key: string | null; name: string; group_name: string; report_section: string; suggests_employee: boolean; sort_order: number; is_active: boolean; my_uses: number; total_uses?: number }

/** Active quick categories, most-used (by me, last 60 days) first. */
export function useCategories(enabled = true) {
  const q = useApi<Category[]>(['activity-categories'], enabled ? '/activities/categories' : null, undefined, { staleTime: 60_000 });
  const sorted = [...(q.data ?? [])].sort((a, b) => (b.my_uses - a.my_uses) || (a.sort_order - b.sort_order));
  return { ...q, sorted };
}

export const SECTION_TONE: Record<string, string> = {
  coordination: 'bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-200',
  updates: 'bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-200',
  assignment: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-200',
  follow_up: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-200',
  meeting: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-200',
  review: 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-200',
  guidance: 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-200',
  issue_resolution: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200',
  testing: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  missing_functionality: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  improvements: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  client_meeting: 'bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-200',
  client_requirements: 'bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-200',
  client_coordination: 'bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-200',
  development: 'bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-200',
  documentation: 'bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-200',
  other: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
};

export async function uploadActivityFiles(files: FileList | File[]): Promise<{ id: number; original_name: string }[]> {
  const fd = new FormData();
  Array.from(files).forEach((f) => fd.append('files', f));
  return api('/activities/files', { method: 'POST', form: fd });
}

export function AttachButton({ onUploaded }: { onUploaded: (f: { id: number; original_name: string }[]) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <input ref={ref} type="file" multiple hidden onChange={async (e) => {
        if (!e.target.files?.length) return;
        setBusy(true);
        try { onUploaded(await uploadActivityFiles(e.target.files)); } catch (err: any) { toast.error(err.message); } finally { setBusy(false); e.target.value = ''; }
      }} />
      <button type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? <Spinner className="h-3.5 w-3.5" /> : <Upload className="h-3.5 w-3.5" />} Attach
      </button>
    </>
  );
}

export function FileList({ files, onRemove }: { files: { id: number; original_name: string }[]; onRemove?: (id: number) => void }) {
  if (!files?.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {files.map((f) => (
        <span key={f.id} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs dark:border-slate-700">
          <Paperclip className="h-3 w-3" />
          <button type="button" className="max-w-[180px] truncate hover:underline" onClick={() => download(`/files/${f.id}/download`).catch((e) => toast.error(e.message))}>{f.original_name}</button>
          {onRemove && <button type="button" aria-label={`Remove ${f.original_name}`} onClick={() => onRemove(f.id)}><Trash2 className="h-3 w-3 text-slate-400 hover:text-rose-600" /></button>}
        </span>
      ))}
    </div>
  );
}

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const minutesLabel = (m?: number | null) => (!m ? '' : m >= 60 ? `${+(m / 60).toFixed(1)} h` : `${m} min`);

/** One timeline entry. */
export function ActivityItem({ a, onEdit, onDelete, onHistory, showUser, compact }: { a: any; onEdit?: () => void; onDelete?: () => void; onHistory?: () => void; showUser?: boolean; compact?: boolean }) {
  const direct = (a.participants ?? []).filter((p: any) => !p.via_department_id);
  const viaDept = (a.departments ?? []) as { id: number; name: string }[];
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      <div className="flex w-14 shrink-0 flex-col items-end pt-0.5">
        <span className="text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-200">{timeOf(a.occurred_at)}</span>
        {a.duration_minutes ? <span className="muted text-[11px]">{minutesLabel(a.duration_minutes)}</span> : null}
      </div>
      <div className="relative flex flex-col items-center">
        <span className={clsx('mt-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white dark:ring-slate-900', a.status === 'completed' ? 'bg-brand-600' : 'bg-amber-500')} />
        <span className="w-px flex-1 bg-slate-200 dark:bg-slate-700" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={clsx('badge', SECTION_TONE[a.report_section] ?? SECTION_TONE.other)}>{a.category_name}</span>
          {showUser && <span className="text-xs font-medium">{a.user_name}</span>}
          {a.status !== 'completed' && <span className="badge bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{humanize(a.status)}</span>}
          {a.issue_resolved === true && <span className="badge bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">Resolved</span>}
          {a.issue_resolved === false && <span className="badge bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200">Unresolved</span>}
          {a.bugs_found ? <span className="badge bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">{a.bugs_found} bug{a.bugs_found > 1 ? 's' : ''}</span> : null}
          {a.revision > 1 && <span className="muted text-[11px]">edited</span>}
        </div>
        <p className={clsx('mt-1 whitespace-pre-wrap break-words text-sm', compact && 'line-clamp-2')}>{a.description}</p>
        {(direct.length > 0 || viaDept.length > 0 || a.project_name) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            {(direct.length > 0 || viaDept.length > 0) && (
              <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{[...direct.map((p: any) => p.name), ...viaDept.map((d) => `${d.name} team`)].join(', ')}</span>
            )}
            {a.project_name && <span>📁 {a.project_name}</span>}
          </div>
        )}
        {a.follow_up_required && (
          <p className={clsx('mt-1 text-xs', a.follow_up_done_at ? 'text-emerald-700 line-through dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300')}>
            Follow-up{a.follow_up_due ? ` by ${a.follow_up_due}` : ''}: {a.follow_up_note || 'required'}
          </p>
        )}
        {!compact && a.files?.length > 0 && <div className="mt-1.5"><FileList files={a.files} /></div>}
        {(onEdit || onDelete || onHistory) && (
          <div className="mt-1 flex gap-1">
            {onEdit && <button className="btn-ghost btn-sm" onClick={onEdit} aria-label="Edit activity"><Pencil className="h-3.5 w-3.5" /> Edit</button>}
            {onHistory && a.revision_count > 1 && <button className="btn-ghost btn-sm" onClick={onHistory}><History className="h-3.5 w-3.5" /> History</button>}
            {onDelete && <button className="btn-ghost btn-sm text-rose-600" onClick={onDelete} aria-label="Delete activity"><Trash2 className="h-3.5 w-3.5" /></button>}
          </div>
        )}
      </div>
    </li>
  );
}

/** Every saved version of an activity (append-only). */
export function RevisionsModal({ activityId, onClose }: { activityId: number | null; onClose: () => void }) {
  const { data = [], isLoading } = useApi<any[]>(['activity-revisions', activityId], activityId ? `/activities/${activityId}/revisions` : null);
  return (
    <Modal open={!!activityId} onClose={onClose} title="Edit history" size="lg">
      {isLoading ? <Spinner /> : (
        <ol className="space-y-3">
          {data.map((r: any) => (
            <li key={r.id} className="rounded-lg border p-3 text-sm dark:border-slate-700">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">Version {r.revision} · {humanize(r.action)}</span>
                <span className="muted text-xs">{r.changed_by_name} · {fmtDateTime(r.changed_at)}</span>
              </div>
              {r.reason && <p className="muted mt-1 text-xs">Reason: {r.reason}</p>}
              <p className="mt-2 whitespace-pre-wrap">{r.snapshot?.description}</p>
              <p className="muted mt-1 text-xs">
                {r.snapshot?.category_name} · {humanize(r.snapshot?.status)} · {fmtDateTime(r.snapshot?.occurred_at)}
                {r.snapshot?.participants?.length ? ` · with ${r.snapshot.participants.map((p: any) => p.name).join(', ')}` : ''}
                {r.snapshot?.project_name ? ` · ${r.snapshot.project_name}` : ''}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

/** Plain report text → Bitrix24 BBCode: headings in bold, bullet runs as lists. */
export function toBitrix(text: string) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  let inList = false;
  lines.forEach((line, i) => {
    const bullet = /^\s*[•\-*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) { out.push('[LIST]'); inList = true; }
      out.push(`[*]${bullet[1]}`);
      return;
    }
    if (inList) { out.push('[/LIST]'); inList = false; }
    const next = lines[i + 1] ?? '';
    const isHeading = line.trim() && (i === 0 || (/^[A-Z0-9 '&/()·,-]+$/.test(line.trim()) && /^\s*[•\-*]\s+/.test(next)));
    out.push(isHeading ? `[B]${line.trim()}[/B]` : line);
  });
  if (inList) out.push('[/LIST]');
  return out.join('\n');
}

export async function copyText(text: string, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
  } catch {
    // Fallback for browsers without clipboard permission
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast.success(what); } catch { toast.error('Copy failed — select the text and copy it manually'); }
    ta.remove();
  }
}
