import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Clock, History, Link2, ListChecks, Pencil, Save, Send } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtTime, todayIso } from '../../lib/format';
import { useApi, useAction } from '../../lib/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '../../components/Toast';
import { Card, clsx, DataTable, Empty, ErrorState, Field, Loading, Modal, PageHeader, Pagination, PriorityBadge, Progress, StatusBadge, Tabs } from '../../components/ui';
import { AnswerInput, cleanValue, conditionMet, FileChips, isAnswered, UploadButton } from './answers';

type Local = { value: any; note: string | null; supporting_urls: string[]; file_ids: number[] };

export default function MyChecklist() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'day';
  return (
    <div>
      <PageHeader title="My checklist" subtitle="Your daily questions. Save a draft any time; submit when you’re ready." />
      <Tabs value={tab} onChange={(t) => setSp(t === 'day' ? {} : { tab: t }, { replace: true })} tabs={[{ value: 'day', label: 'Checklist' }, { value: 'history', label: 'History' }]} />
      {tab === 'history' ? <MyHistory onOpen={(d) => setSp({ date: d }, { replace: true })} /> : <Day />}
    </div>
  );
}

function statusLabel(cl: any) {
  if (cl.status === 'submitted') return { status: cl.is_late ? 'late' : 'completed', label: cl.is_late ? 'Complete (late)' : 'Complete' };
  if (cl.overdue) return { status: 'missed', label: 'Overdue' };
  return { status: cl.status === 'in_progress' ? 'in_progress' : 'pending', label: cl.status === 'in_progress' ? 'In progress' : 'Not started' };
}

function Day() {
  const [sp, setSp] = useSearchParams();
  const date = sp.get('date') ?? undefined;
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useApi<any>(['checklist-mine', date], '/checklists/mine', date ? { date } : undefined);
  const cl = data?.checklist;
  const [local, setLocal] = useState<Record<number, Local>>({});
  const [dirty, setDirty] = useState<Set<number>>(new Set());
  const [names, setNames] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [missing, setMissing] = useState<{ id: number; question_text: string }[] | null>(null);
  const [revise, setRevise] = useState<any>(null);
  const [history, setHistory] = useState<any>(null);

  useEffect(() => {
    if (!cl) return;
    const m: Record<number, Local> = {};
    for (const i of cl.items) if (i.status !== 'submitted') m[i.id] = { value: i.draft?.value ?? null, note: i.draft?.note ?? null, supporting_urls: i.draft?.supporting_urls ?? [], file_ids: i.draft?.file_ids ?? [] };
    setLocal(m); setDirty(new Set()); setErrors({}); setNames(cl.files ?? {});
  }, [cl?.id, cl?.updated_at]);

  useEffect(() => {
    if (!dirty.size) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty.size]);

  const byQuestion = useMemo(() => new Map<number, any>((cl?.items ?? []).filter((i: any) => i.question_id).map((i: any) => [i.question_id, i])), [cl]);
  const currentValue = (i: any) => (i.status === 'submitted' ? i.answer : local[i.id]?.value);
  const visible = (i: any, depth = 0): boolean => {
    if (!i.condition_operator || !i.condition_question_id || depth > 10) return true;
    const ctl = byQuestion.get(i.condition_question_id);
    if (!ctl) return true;
    return visible(ctl, depth + 1) && conditionMet(i.condition_operator, i.condition_value, currentValue(ctl), ctl.answer_type);
  };

  const set = (id: number, patch: Partial<Local>) => {
    setLocal((m) => ({ ...m, [id]: { ...m[id], ...patch } }));
    setDirty((d) => new Set(d).add(id));
    setErrors((e) => { const n = { ...e }; delete n[id]; return n; });
  };
  const payload = (onlyDirty: boolean) => (cl?.items ?? []).filter((i: any) => i.status !== 'submitted' && (!onlyDirty || dirty.has(i.id)))
    .map((i: any) => ({ item_id: i.id, value: cleanValue(i.answer_type, local[i.id]?.value), note: local[i.id]?.note || null, supporting_urls: (local[i.id]?.supporting_urls ?? []).filter(Boolean), file_ids: local[i.id]?.file_ids ?? [] }));

  const onFail = (e: any) => {
    if (e instanceof ApiError && e.details?.items) { setErrors(Object.fromEntries(Object.entries(e.details.items).map(([k, v]) => [Number(k), String(v)]))); toast.error('Please fix the highlighted answers'); }
    else toast.error(e?.message ?? 'Something went wrong');
  };
  const refresh = () => { qc.invalidateQueries({ queryKey: ['checklist-mine'] }); qc.invalidateQueries({ queryKey: ['checklist-history'] }); };
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null);
  const saveDraft = async () => {
    setBusy('save');
    try { await api(`/checklists/${cl.id}/draft`, { method: 'PUT', body: { items: payload(true) } }); toast.success('Draft saved'); refresh(); } catch (e) { onFail(e); } finally { setBusy(null); }
  };
  const submit = async () => {
    setBusy('submit');
    try {
      const r = await api<any>(`/checklists/${cl.id}/submit`, { method: 'POST', body: { items: payload(true) } });
      toast.success(`${r.submitted} answer${r.submitted === 1 ? '' : 's'} submitted`);
      setMissing(r.unanswered_required);
      refresh();
    } catch (e) { onFail(e); } finally { setBusy(null); }
  };

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const dateBar = (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      <Field label="Date" className="w-44"><input className="input" type="date" max={data?.today ?? todayIso()} value={data?.date ?? ''} onChange={(e) => setSp(e.target.value && e.target.value !== data?.today ? { date: e.target.value } : {}, { replace: true })} /></Field>
      {date && date !== data?.today && <button className="btn-secondary" onClick={() => setSp({}, { replace: true })}>Back to today</button>}
    </div>
  );
  if (!cl) return <>{dateBar}<Card><Empty icon={ListChecks} title={data?.date === data?.today ? 'No questions for you today' : 'No checklist on this date'} hint="Questions appear here when an administrator assigns them to you, your department or everyone." /></Card></>;

  const items = cl.items.filter((i: any) => visible(i));
  const sections: [string, any[]][] = [];
  for (const i of items) {
    const name = i.section_name ?? 'General';
    const s = sections.find(([n]) => n === name);
    if (s) s[1].push(i); else sections.push([name, [i]]);
  }
  const editable = data.editable;
  const answeredLocally = items.filter((i: any) => i.status !== 'submitted' && isAnswered(i.answer_type, cleanValue(i.answer_type, local[i.id]?.value))).length;
  const requiredOpen = items.filter((i: any) => i.is_required && i.status !== 'submitted');
  const st = statusLabel(cl);

  return (
    <div>
      {dateBar}
      <Card className="mb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">{fmtDate(cl.checklist_date)}</h2>
              <StatusBadge status={st.status} label={st.label} />
            </div>
            <p className="muted mt-1 text-sm">
              {cl.answered_items} of {cl.total_items} answered · {cl.required_items - cl.required_answered} mandatory left
              {cl.due_at && <> · <Clock className="inline h-3.5 w-3.5" /> due {fmtDateTime(cl.due_at)}</>}
              {cl.submitted_at && <> · completed {fmtDateTime(cl.submitted_at)}</>}
            </p>
          </div>
          <div className="w-full sm:w-56"><Progress value={cl.completion_percent} /></div>
        </div>
        {!editable && <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800">This checklist is read-only (older than the 7-day answer window).</p>}
      </Card>

      {missing && missing.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40" role="alert">
          <p className="flex items-center gap-1.5 font-medium text-amber-900 dark:text-amber-200"><AlertTriangle className="h-4 w-4" /> Mandatory questions still unanswered</p>
          <ul className="mt-1 list-disc pl-5 text-amber-900 dark:text-amber-200">{missing.map((m) => <li key={m.id}>{m.question_text}</li>)}</ul>
        </div>
      )}

      <div className="space-y-4">
        {sections.map(([name, list]) => (
          <Card key={name} title={name} pad={false}>
            <ul className="divide-y dark:divide-slate-800">
              {list.map((i: any) => (
                <ItemRow key={i.id} item={i} local={local[i.id]} names={names} error={errors[i.id]} editable={editable}
                  onChange={(p) => set(i.id, p)} onNames={(m) => setNames((n) => ({ ...n, ...m }))}
                  onRevise={() => setRevise(i)} onHistory={() => setHistory(i)} />
              ))}
            </ul>
          </Card>
        ))}
      </div>

      {editable && cl.items.some((i: any) => i.status !== 'submitted') && (
        <div className="sticky bottom-[4.25rem] z-20 -mx-4 mt-4 border-y bg-white/95 px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.04)] backdrop-blur dark:border-slate-800 dark:bg-slate-900/95 sm:-mx-6 sm:px-6 md:bottom-0">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2">
            <span className="muted text-xs">{dirty.size ? `${dirty.size} unsaved change${dirty.size === 1 ? '' : 's'} · ` : ''}{answeredLocally} ready to submit{requiredOpen.length ? ` · ${requiredOpen.length} mandatory open` : ''}</span>
            <div className="flex gap-2">
              <button className="btn-secondary" disabled={!dirty.size || !!busy} onClick={saveDraft}><Save className="h-4 w-4" /> {busy === 'save' ? 'Saving…' : 'Save draft'}</button>
              <button className="btn-primary" disabled={!answeredLocally || !!busy} onClick={submit}><Send className="h-4 w-4" /> {busy === 'submit' ? 'Submitting…' : 'Submit answers'}</button>
            </div>
          </div>
        </div>
      )}

      {revise && <ReviseModal item={revise} names={names} onClose={() => setRevise(null)} onDone={() => { setRevise(null); refresh(); }} />}
      {history && <RevisionsModal item={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function ItemRow({ item: i, local, names, error, editable, onChange, onNames, onRevise, onHistory }: {
  item: any; local?: Local; names: Record<number, string>; error?: string; editable: boolean;
  onChange: (p: Partial<Local>) => void; onNames: (m: Record<number, string>) => void; onRevise: () => void; onHistory: () => void;
}) {
  const submitted = i.status === 'submitted';
  const [extras, setExtras] = useState(!!(local?.note || local?.supporting_urls?.length || local?.file_ids?.length));
  const fieldId = `q-${i.id}`;
  return (
    <li className={clsx('px-4 py-4 sm:px-5', error && 'bg-rose-50/60 dark:bg-rose-950/20')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <label htmlFor={fieldId} className="min-w-0 flex-1 text-sm font-medium">
          {i.question_text}{i.is_required && <span className="ml-0.5 text-rose-600" aria-label="mandatory">*</span>}
          {i.help_text && <span className="muted mt-0.5 block text-xs font-normal">{i.help_text}</span>}
        </label>
        <div className="flex shrink-0 items-center gap-1.5">
          {['high', 'critical'].includes(i.priority) && <PriorityBadge priority={i.priority} />}
          {submitted ? <StatusBadge status={i.is_late ? 'late' : 'completed'} label={`${i.is_late ? 'Late' : 'Submitted'} ${fmtTime(i.submitted_at)}`} />
            : i.status === 'draft' ? <StatusBadge status="draft" label="Draft saved" /> : <span className="muted text-xs">Due {fmtTime(i.due_at)}</span>}
        </div>
      </div>
      <div className="mt-2">
        {submitted ? (
          <div>
            <p className="whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">{i.answer_text || '—'}</p>
            {i.note && <p className="muted mt-1 text-xs">Note: {i.note}</p>}
            {i.supporting_urls?.length > 0 && <ul className="mt-1 text-xs">{i.supporting_urls.map((u: string) => <li key={u}><a className="text-brand-600 hover:underline" href={u} target="_blank" rel="noreferrer noopener">{u}</a></li>)}</ul>}
            <FileChips ids={i.file_ids} names={names} />
            <div className="mt-2 flex gap-2">
              {editable && <button className="btn-ghost btn-sm" onClick={onRevise}><Pencil className="h-3.5 w-3.5" /> Revise answer</button>}
              {i.revision_count > 1 && <button className="btn-ghost btn-sm" onClick={onHistory}><History className="h-3.5 w-3.5" /> {i.revision_count} versions</button>}
            </div>
          </div>
        ) : (
          <>
            <AnswerInput id={fieldId} type={i.answer_type} options={i.options} value={local?.value} disabled={!editable} files={names} onFileNames={onNames} onChange={(v) => onChange({ value: v })} />
            {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
            {editable && (
              <button type="button" className="muted mt-2 inline-flex items-center gap-1 text-xs hover:text-brand-600" onClick={() => setExtras((x) => !x)} aria-expanded={extras}>
                {extras ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} Note, supporting links & documents
              </button>
            )}
            {extras && (
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <Field label="Note (optional)"><textarea className="input" rows={2} maxLength={5000} disabled={!editable} value={local?.note ?? ''} onChange={(e) => onChange({ note: e.target.value })} /></Field>
                <Field label="Supporting URLs (one per line)"><textarea className="input" rows={2} disabled={!editable} placeholder="https://…" value={(local?.supporting_urls ?? []).join('\n')} onChange={(e) => onChange({ supporting_urls: e.target.value.split('\n') })} /></Field>
                <div className="sm:col-span-2">
                  <UploadButton disabled={!editable} onUploaded={(fs) => { onNames(Object.fromEntries(fs.map((f) => [f.id, f.original_name]))); onChange({ file_ids: [...(local?.file_ids ?? []), ...fs.map((f) => f.id)] }); }} />
                  <FileChips ids={local?.file_ids ?? []} names={names} onRemove={editable ? (id) => onChange({ file_ids: (local?.file_ids ?? []).filter((x) => x !== id) }) : undefined} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function ReviseModal({ item, names: names0, onClose, onDone }: { item: any; names: Record<number, string>; onClose: () => void; onDone: () => void }) {
  const [value, setValue] = useState<any>(item.answer);
  const [note, setNote] = useState(item.note ?? '');
  const [reason, setReason] = useState('');
  const [names, setNames] = useState(names0);
  const save = useAction(() => api(`/checklists/items/${item.id}/revise`, { method: 'POST', body: { value: cleanValue(item.answer_type, value), note: note || null, reason, expected_revision: item.revision } }), { success: 'Answer revised — the previous version is kept', onSuccess: onDone });
  return (
    <Modal open onClose={onClose} title="Revise answer" size="lg" footer={<>
      <button className="btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn-primary" disabled={reason.trim().length < 3 || !isAnswered(item.answer_type, cleanValue(item.answer_type, value)) || save.isPending} onClick={() => save.mutate(undefined)}>Save revision</button>
    </>}>
      <p className="mb-3 text-sm font-medium">{item.question_text}</p>
      <p className="muted mb-3 text-xs">Current answer (version {item.revision}): {item.answer_text}</p>
      <AnswerInput type={item.answer_type} options={item.options} value={value} onChange={setValue} files={names} onFileNames={(m) => setNames((n) => ({ ...n, ...m }))} />
      <Field label="Note (optional)" className="mt-3"><textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <Field label="Reason for the change (required)" className="mt-3"><input className="input" value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} placeholder="e.g. recounted the records" /></Field>
    </Modal>
  );
}

export function RevisionsModal({ item, onClose }: { item: any; onClose: () => void }) {
  const { data, isLoading } = useApi<any>(['revisions', item.id], `/checklists/items/${item.id}/revisions`);
  return (
    <Modal open onClose={onClose} title="Answer history" size="lg">
      <p className="mb-3 text-sm font-medium">{item.question_text}</p>
      {isLoading ? <Loading /> : (
        <ol className="space-y-3">
          {(data?.revisions ?? []).map((r: any) => (
            <li key={r.id} className="rounded-lg border p-3 text-sm dark:border-slate-700">
              <div className="muted mb-1 flex flex-wrap justify-between gap-2 text-xs">
                <span>Version {r.revision}{r.revision === 1 ? ' (first submission)' : ''} · {r.submitted_by_name}</span>
                <span>{fmtDateTime(r.submitted_at)}</span>
              </div>
              <p className="whitespace-pre-wrap break-words">{r.answer_text || '—'}</p>
              {r.note && <p className="muted mt-1 text-xs">Note: {r.note}</p>}
              {r.reason && <p className="mt-1 text-xs"><span className="font-medium">Reason:</span> {r.reason}</p>}
              <FileChips ids={r.file_ids} names={data?.files ?? {}} />
              {r.supporting_urls?.length > 0 && <p className="mt-1 flex items-center gap-1 text-xs"><Link2 className="h-3 w-3" />{r.supporting_urls.join(', ')}</p>}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

function MyHistory({ onOpen }: { onOpen: (date: string) => void }) {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useApi<any>(['checklist-history', page], '/checklists/mine/history', { page, pageSize: 20 });
  if (isLoading) return <Loading />;
  return (
    <Card pad={false}>
      <div className="px-4 py-2 sm:px-0">
        <DataTable rows={data?.items ?? []} onRowClick={(r: any) => onOpen(r.checklist_date)} empty={<Empty icon={CheckCircle2} title="No checklists yet" />} columns={[
          { key: 'checklist_date', header: 'Date', render: (r: any) => fmtDate(r.checklist_date) },
          { key: 'status', header: 'Status', render: (r: any) => { const s = statusLabel({ ...r, overdue: r.status !== 'submitted' && r.due_at && new Date(r.due_at) < new Date() }); return <StatusBadge status={s.status} label={s.label} />; } },
          { key: 'answered', header: 'Answered', render: (r: any) => `${r.answered_items}/${r.total_items}` },
          { key: 'completion_percent', header: 'Completion', render: (r: any) => <div className="w-32"><Progress value={r.completion_percent} /></div> },
          { key: 'submitted_at', header: 'Completed', render: (r: any) => (r.submitted_at ? fmtDateTime(r.submitted_at) : '—') },
        ]} />
      </div>
      <div className="px-4 pb-3"><Pagination page={page} pageSize={20} total={data?.total ?? 0} onPage={setPage} /></div>
    </Card>
  );
}
