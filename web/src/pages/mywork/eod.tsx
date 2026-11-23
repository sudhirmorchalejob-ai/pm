import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCopy, Lock, RefreshCw, RotateCcw, Save } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { useApi } from '../../lib/hooks';
import { toast } from '../../components/Toast';
import { Card, confirm, Empty, ErrorState, Field, Loading, Pagination, Spinner, Stat } from '../../components/ui';
import { copyText, toBitrix } from './common';

/**
 * Personal EOD report: generated from the entries of the day, reviewed and edited,
 * then finalized. Copy as plain text or with Bitrix24 formatting.
 */
export function EodEditor({ date }: { date: string }) {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useApi<any>(['my-eod', date], '/my-work/eod', { date });
  const [content, setContent] = useState('');
  const [prio, setPrio] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const report = data?.report;
  const final = report?.status === 'final';
  const dirty = !!report && (content !== report.content || (prio || '') !== (report.next_day_priorities || ''));

  useEffect(() => {
    if (!data) return;
    setContent(data.report?.content ?? '');
    setPrio(data.report?.next_day_priorities ?? '');
  }, [data?.report?.revision, data?.report?.id, date]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (what: string, fn: () => Promise<any>, ok: string) => {
    setBusy(what);
    try { await fn(); await qc.invalidateQueries({ queryKey: ['my-eod'] }); qc.invalidateQueries({ queryKey: ['my-work-today'] }); toast.success(ok); } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  };
  const generate = async () => {
    if (report && dirty && !(await confirm({ title: 'Replace your edits?', message: 'Regenerating rebuilds the report from your recorded activities and tasks. Unsaved edits to the text are replaced.', confirmLabel: 'Regenerate' }))) return;
    if (report && !dirty && report.content !== report.generated_content && !(await confirm({ title: 'Replace your edited text?', message: 'The saved report contains your own edits. Regenerating replaces them with a fresh report from your entries.', confirmLabel: 'Regenerate' }))) return;
    await run('generate', () => api('/my-work/eod/generate', { method: 'POST', body: { date, next_day_priorities: prio || null } }), 'Report generated from your entries');
  };
  const save = () => run('save', () => api('/my-work/eod', { method: 'PUT', body: { date, content, next_day_priorities: prio || null, expected_revision: report?.revision } }), 'Draft saved');
  const finalize = async () => {
    if (!(await confirm({ title: 'Finalize this report?', message: 'It will be included in the company EOD report. You can reopen it later if something changes.', confirmLabel: 'Finalize' }))) return;
    await run('final', async () => {
      if (dirty) await api('/my-work/eod', { method: 'PUT', body: { date, content, next_day_priorities: prio || null, expected_revision: report?.revision } });
      await api('/my-work/eod/finalize', { method: 'POST', body: { date } });
    }, 'Report finalized');
  };
  const reopen = () => run('reopen', () => api('/my-work/eod/reopen', { method: 'POST', body: { date } }), 'Report reopened for editing');

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const s = data.data.summary;
  const text = report ? content : data.generated;

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card title={<span className="inline-flex items-center gap-2">Daily work report — {fmtDate(date)} {final && <span className="badge bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"><Lock className="h-3 w-3" /> Finalized</span>}{report && !final && <span className="badge bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">Draft</span>}</span>}
          actions={<div className="flex flex-wrap gap-1.5">
            <button className="btn-secondary btn-sm" onClick={() => copyText(text, 'Report copied')}><ClipboardCopy className="h-3.5 w-3.5" /> Copy</button>
            <button className="btn-secondary btn-sm" onClick={() => copyText(toBitrix(text), 'Copied with Bitrix24 formatting')}><ClipboardCopy className="h-3.5 w-3.5" /> Copy for Bitrix24</button>
          </div>}>
          {!report && (
            <p className="mb-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
              Preview built from what you recorded today. Generate it to review and edit; nothing is added that you didn’t enter.
            </p>
          )}
          {data.stale && !final && (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
              You recorded new activities or tasks since this draft was generated. Regenerate to include them (your edits will be replaced).
            </p>
          )}
          {report ? (
            <textarea className="input min-h-[420px] font-mono text-[13px] leading-relaxed" value={content} readOnly={final} aria-label="Report text" onChange={(e) => setContent(e.target.value)} />
          ) : (
            <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-lg border bg-slate-50 p-3 font-mono text-[13px] leading-relaxed dark:border-slate-700 dark:bg-slate-900">{data.generated}</pre>
          )}
          <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            {!final && <button className="btn-secondary" disabled={!!busy} onClick={generate}>{busy === 'generate' ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />} {report ? 'Regenerate from entries' : 'Generate report'}</button>}
            {report && !final && <button className="btn-secondary" disabled={!!busy || !dirty} onClick={save}>{busy === 'save' ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />} Save draft</button>}
            {report && !final && <button className="btn-primary" disabled={!!busy} onClick={finalize}>{busy === 'final' ? <Spinner className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />} Finalize</button>}
            {final && <button className="btn-secondary" disabled={!!busy} onClick={reopen}><RotateCcw className="h-4 w-4" /> Reopen to edit</button>}
          </div>
          {final && report.finalized_at && <p className="muted mt-2 text-xs">Finalized {fmtDateTime(report.finalized_at)} · included in the company EOD report.</p>}
        </Card>
      </div>
      <div className="space-y-4">
        <Card title="Next day's priorities">
          <Field label="One per line" hint="Included at the end of the report. Tasks already scheduled for tomorrow are added automatically.">
            <textarea className="input min-h-[120px]" value={prio} readOnly={final} maxLength={5000} onChange={(e) => setPrio(e.target.value)} placeholder={'Release HRMS build\nReview API integration with Neha'} />
          </Field>
          {!final && report && <p className="muted mt-2 text-xs">Save the draft or regenerate to apply.</p>}
          {!final && !report && <p className="muted mt-2 text-xs">Applied when you generate the report.</p>}
        </Card>
        <Card title="From your entries">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Activities" value={s.activities} />
            <Stat label="Employees assisted" value={s.employees_assisted} />
            <Stat label="Client meetings" value={s.client_meetings} />
            <Stat label="Tasks completed" value={s.tasks_completed} />
            <Stat label="Bugs found" value={s.bugs_found} />
            <Stat label="Pending" value={s.pending} tone={s.pending ? 'warn' : 'default'} />
          </div>
        </Card>
      </div>
    </div>
  );
}

export function EodHistory({ onOpen }: { onOpen: (date: string) => void }) {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useApi<any>(['my-eod-history', page], '/my-work/eod/history', { page, pageSize: 20 });
  if (isLoading) return <Loading />;
  if (!data?.items.length) return <Empty title="No reports yet" hint="Generate today’s report from the EOD tab." />;
  return (
    <>
      <ul className="divide-y dark:divide-slate-800">
        {data.items.map((r: any) => (
          <li key={r.id}>
            <button className="flex w-full items-center justify-between gap-3 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50" onClick={() => onOpen(String(r.report_date))}>
              <span><span className="font-medium">{fmtDate(r.report_date)}</span><span className="muted block text-xs">{r.summary ? `${r.summary.activities} activities · ${r.summary.tasks_completed} tasks completed` : ''}</span></span>
              <span className={r.status === 'final' ? 'badge bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200' : 'badge bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'}>{r.status === 'final' ? 'Finalized' : 'Draft'}</span>
            </button>
          </li>
        ))}
      </ul>
      <Pagination page={page} pageSize={20} total={data.total} onPage={setPage} />
    </>
  );
}
