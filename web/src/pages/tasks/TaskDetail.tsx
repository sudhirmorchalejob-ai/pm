import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Archive, BellPlus, CalendarPlus, Check, CheckCircle2, Clock, Edit3, Link2, Paperclip, Pause, Play, RotateCcw, Send, Trash2, UserPlus, X, XCircle } from 'lucide-react';
import { api, download } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fromNow, humanize, isoToLocalInput, localInputToIso, todayIso } from '../../lib/format';
import { useAction, useApi, useLiveRefresh } from '../../lib/hooks';
import { Due } from '../../components/TaskBits';
import { Avatar, Card, confirm, Empty, ErrorState, Field, KV, Loading, Modal, PageHeader, PriorityBadge, Progress, Select, StatusBadge, Tabs, UserPicker } from '../../components/ui';
import { ReminderForm } from '../notifications/ReminderForm';
import { TaskForm } from './TaskForm';

export default function TaskDetail() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const { user } = useAuth();
  const { data: t, isLoading, error, refetch } = useApi<any>(['task', id], `/tasks/${id}`);
  const [tab, setTab] = useState('overview');
  const [modal, setModal] = useState<string | null>(null);
  useLiveRefresh([['task', id]]);
  const inv = [['task', id], ['tasks'], ['dashboard'], ['approvals-count'], ['history', id], ['comments', id]];
  const act = (fn: (v: any) => Promise<any>, success: string) => useAction(fn, { invalidate: inv, success });

  const start = act(() => api(`/tasks/${id}/progress`, { body: { status: 'in_progress' } }), 'Work started');
  const hold = act(() => api(`/tasks/${id}/progress`, { body: { status: 'on_hold' } }), 'Put on hold');
  const submit = act((note: string) => api(`/tasks/${id}/submit`, { body: { note } }), 'Submitted for review');
  const reviewStart = act(() => api(`/tasks/${id}/review/start`, { method: 'POST' }), 'Review started');
  const cancel = act((reason: string) => api(`/tasks/${id}/cancel`, { body: { reason } }), 'Task cancelled');
  const reopen = act(() => api(`/tasks/${id}/reopen`, { method: 'POST' }), 'Task reopened');
  const archive = act((archived: boolean) => api(`/tasks/${id}/archive`, { body: { archived } }), 'Updated');
  const del = useAction(() => api(`/tasks/${id}`, { method: 'DELETE' }), { invalidate: [['tasks']], success: 'Task deleted', onSuccess: () => nav('/tasks') });
  const decideExt = act(({ aid, decision, comments }: any) => api(`/tasks/${id}/extension/${aid}/decide`, { body: { decision, comments } }), 'Extension decision saved');

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const P = t.permissions;
  const open = ['not_started', 'in_progress', 'on_hold', 'blocked', 'revision_required'].includes(t.status);
  const pendingExt = t.approvals.find((a: any) => a.approval_type === 'extension' && a.decision === 'pending');

  return (
    <div>
      <PageHeader back="/tasks"
        title={<span className="flex flex-wrap items-center gap-2"><span className="muted text-base font-normal">{t.task_key}</span>{t.title}</span>}
        subtitle={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={t.status} /><PriorityBadge priority={t.priority} />{t.is_overdue && <span className="badge bg-rose-600 text-white">Overdue</span>}{t.is_recurring_template && <span className="badge bg-brand-100 text-brand-700">Recurring template</span>}<Due deadline={t.deadline} done={!open} /></span>}
        actions={<>
          {P.is_assignee && open && t.status !== 'in_progress' && <button className="btn-secondary" onClick={() => start.mutate(undefined)}><Play className="h-4 w-4" /> Start</button>}
          {P.is_assignee && t.status === 'in_progress' && <button className="btn-secondary" onClick={() => hold.mutate(undefined)}><Pause className="h-4 w-4" /> Hold</button>}
          {(P.is_assignee || P.can_manage) && open && <button className="btn-secondary" onClick={() => setModal('progress')}><Clock className="h-4 w-4" /> Update progress</button>}
          {P.is_assignee && open && <button className="btn-primary" onClick={async () => { const note = await confirm({ title: 'Submit for review?', message: 'Your reviewer will be notified. The task is only completed once approved.', confirmLabel: 'Submit', input: { label: 'Note for reviewer (optional)' } }); if (note) submit.mutate(note === true ? '' : note); }}><Send className="h-4 w-4" /> Submit for review</button>}
          {P.can_review && t.status === 'submitted' && <button className="btn-secondary" onClick={() => reviewStart.mutate(undefined)}>Start review</button>}
          {P.can_review && ['submitted', 'under_review'].includes(t.status) && <button className="btn-success" onClick={() => setModal('review')}><CheckCircle2 className="h-4 w-4" /> Review</button>}
          {P.can_manage && open && <button className="btn-secondary" onClick={() => setModal('edit')}><Edit3 className="h-4 w-4" /> Edit</button>}
          {P.can_manage && open && <button className="btn-secondary" onClick={() => setModal('assign')}><UserPlus className="h-4 w-4" /> Reassign</button>}
        </>} />

      {pendingExt && (
        <div className="card mb-4 flex flex-col gap-3 border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20 sm:flex-row sm:items-center">
          <CalendarPlus className="h-5 w-5 shrink-0 text-amber-600" />
          <div className="flex-1 text-sm"><b>{pendingExt.requested_by_name}</b> requested an extension to <b>{fmtDateTime(pendingExt.requested_deadline)}</b>: “{pendingExt.request_note}”</div>
          {P.can_review && <div className="flex gap-2">
            <button className="btn-success btn-sm" onClick={() => decideExt.mutate({ aid: pendingExt.id, decision: 'approved' })}><Check className="h-4 w-4" /> Approve</button>
            <button className="btn-danger btn-sm" onClick={async () => { const c = await confirm({ title: 'Reject extension', input: { label: 'Reason', required: true }, danger: true, confirmLabel: 'Reject' }); if (c) decideExt.mutate({ aid: pendingExt.id, decision: 'rejected', comments: c }); }}><X className="h-4 w-4" /> Reject</button>
          </div>}
        </div>
      )}
      {t.status === 'blocked' && t.blocker_note && <div className="card mb-4 border-rose-300 bg-rose-50 p-4 text-sm dark:border-rose-900 dark:bg-rose-900/20"><b>Blocker:</b> {t.blocker_note}</div>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <Tabs value={tab} onChange={setTab} tabs={[
            { value: 'overview', label: 'Overview' }, { value: 'comments', label: 'Comments' }, { value: 'files', label: 'Files', count: t.attachments.length },
            { value: 'time', label: 'Time', count: t.time_entries.length }, { value: 'reminders', label: 'Reminders', count: t.reminders.length }, { value: 'history', label: 'History' },
          ]} />
          {tab === 'overview' && <Overview t={t} canEdit={P.can_manage || P.is_assignee} canManage={P.can_manage} />}
          {tab === 'comments' && <Comments taskId={id} />}
          {tab === 'files' && <Files t={t} canEdit={P.can_manage || P.is_assignee} />}
          {tab === 'time' && <TimeTab t={t} />}
          {tab === 'reminders' && <Reminders t={t} onAdd={() => setModal('reminder')} />}
          {tab === 'history' && <History taskId={id} />}
        </div>
        <div className="space-y-4">
          <Card title="Details">
            <KV items={[
              ['Project', t.project_id ? <Link className="text-brand-600" to={`/projects/${t.project_id}`}>{t.project_name}</Link> : '—'],
              ['Milestone', t.milestone_title], ['Department', t.department_name], ['Assigned by', t.assigned_by_name],
              ['Start', fmtDate(t.start_date)], ['Deadline', fmtDateTime(t.deadline)],
              ['Estimated', t.estimated_hours != null ? `${t.estimated_hours} h` : '—'], ['Actual', `${t.actual_hours} h`],
              ['Complexity', `${t.complexity} / 5`], ['Type', humanize(t.task_type)],
              ['Revisions', t.revision_count], ['Quality', t.quality_rating ? `${t.quality_rating} / 5` : '—'],
              ['Completed', t.completed_at ? `${fmtDateTime(t.completed_at)} by ${t.approved_by_name}` : '—'],
            ]} />
            <div className="mt-4"><span className="label">Progress</span><Progress value={t.progress} /></div>
          </Card>
          <Card title="Assignees">
            <ul className="space-y-2">{t.assignees.map((a: any) => <li key={a.id} className="flex items-center gap-2 text-sm"><Avatar name={a.name} size="sm" />{a.name}{a.is_primary && <span className="badge bg-slate-100 dark:bg-slate-800">Primary</span>}</li>)}</ul>
          </Card>
          <Card title="Actions">
            <div className="flex flex-col gap-2">
              {P.is_assignee && open && t.deadline && !pendingExt && <button className="btn-secondary justify-start" onClick={() => setModal('extension')}><CalendarPlus className="h-4 w-4" /> Request deadline extension</button>}
              <button className="btn-secondary justify-start" onClick={() => setModal('reminder')}><BellPlus className="h-4 w-4" /> Add reminder</button>
              {P.can_manage && !open && <button className="btn-secondary justify-start" onClick={() => reopen.mutate(undefined)}><RotateCcw className="h-4 w-4" /> Reopen</button>}
              {P.can_manage && open && <button className="btn-secondary justify-start" onClick={async () => { const r = await confirm({ title: 'Cancel task?', danger: true, confirmLabel: 'Cancel task', input: { label: 'Reason', required: true } }); if (r) cancel.mutate(r); }}><XCircle className="h-4 w-4" /> Cancel task</button>}
              {P.can_delete && <button className="btn-secondary justify-start" onClick={() => archive.mutate(!t.is_archived)}><Archive className="h-4 w-4" /> {t.is_archived ? 'Unarchive' : 'Archive'}</button>}
              {P.can_delete && <button className="btn-secondary justify-start text-rose-600" onClick={async () => { if (await confirm({ title: 'Delete task?', message: 'The task is soft-deleted and kept in the audit history.', danger: true, confirmLabel: 'Delete' })) del.mutate(undefined); }}><Trash2 className="h-4 w-4" /> Delete</button>}
            </div>
          </Card>
        </div>
      </div>

      <TaskForm open={modal === 'edit'} onClose={() => setModal(null)} task={t} />
      <ProgressModal open={modal === 'progress'} onClose={() => setModal(null)} t={t} inv={inv} />
      <ReviewModal open={modal === 'review'} onClose={() => setModal(null)} t={t} inv={inv} />
      <AssignModal open={modal === 'assign'} onClose={() => setModal(null)} t={t} inv={inv} />
      <ExtensionModal open={modal === 'extension'} onClose={() => setModal(null)} t={t} inv={inv} />
      <ReminderForm open={modal === 'reminder'} onClose={() => { setModal(null); refetch(); }} defaults={{ task_id: t.id, title: `Follow up: ${t.title}`, schedule_type: t.deadline ? 'deadline_offset' : 'one_time', recipient_ids: [user!.id] }} />
    </div>
  );
}

function Overview({ t, canEdit, canManage }: { t: any; canEdit: boolean; canManage: boolean }) {
  const inv = [['task', t.id]];
  const [newSub, setNewSub] = useState('');
  const [newItem, setNewItem] = useState('');
  const [dep, setDep] = useState('');
  const toggleSub = useAction((s: any) => api(`/tasks/${t.id}/subtasks/${s.id}`, { method: 'PATCH', body: { is_done: !s.is_done } }), { invalidate: inv });
  const addSub = useAction(() => api(`/tasks/${t.id}/subtasks`, { body: { title: newSub } }), { invalidate: inv, onSuccess: () => setNewSub('') });
  const delSub = useAction((sid: number) => api(`/tasks/${t.id}/subtasks/${sid}`, { method: 'DELETE' }), { invalidate: inv });
  const toggleItem = useAction((c: any) => api(`/tasks/${t.id}/checklist/${c.id}`, { method: 'PATCH', body: { is_done: !c.is_done } }), { invalidate: inv });
  const addItem = useAction(() => api(`/tasks/${t.id}/checklist`, { body: { label: newItem } }), { invalidate: inv, onSuccess: () => setNewItem('') });
  const { data: candidates } = useApi<any>(['tasks', 'deps', t.project_id], canManage ? '/tasks' : null, { project_id: t.project_id || undefined, pageSize: 100 });
  const addDep = useAction(() => api(`/tasks/${t.id}/dependencies`, { body: { depends_on_task_id: Number(dep) } }), { invalidate: inv, success: 'Dependency added', onSuccess: () => setDep('') });
  const delDep = useAction((d: number) => api(`/tasks/${t.id}/dependencies/${d}`, { method: 'DELETE' }), { invalidate: inv });
  return (
    <div className="space-y-4">
      <Card title="Description"><p className="whitespace-pre-line text-sm">{t.description || <span className="muted">No description</span>}</p>{t.remarks && <p className="muted mt-3 text-sm"><b>Remarks:</b> {t.remarks}</p>}</Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Subtasks (${t.subtasks.filter((s: any) => s.is_done).length}/${t.subtasks.length})`}>
          <ul className="space-y-1">
            {t.subtasks.map((s: any) => (
              <li key={s.id} className="group flex min-h-[36px] items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4" checked={s.is_done} disabled={!canEdit} onChange={() => toggleSub.mutate(s)} aria-label={s.title} />
                <span className={s.is_done ? 'muted line-through' : ''}>{s.title}</span>
                {canEdit && <button className="ml-auto opacity-60 hover:opacity-100" onClick={() => delSub.mutate(s.id)} aria-label="Delete subtask"><X className="h-3.5 w-3.5" /></button>}
              </li>
            ))}
          </ul>
          {canEdit && <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newSub.trim()) addSub.mutate(undefined); }}><input className="input" placeholder="Add subtask" value={newSub} onChange={(e) => setNewSub(e.target.value)} /><button className="btn-secondary">Add</button></form>}
        </Card>
        <Card title="Checklist">
          <ul className="space-y-1">
            {t.checklist.map((c: any) => <li key={c.id} className="flex min-h-[36px] items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={c.is_done} disabled={!canEdit} onChange={() => toggleItem.mutate(c)} aria-label={c.label} /><span className={c.is_done ? 'muted line-through' : ''}>{c.label}</span></li>)}
            {!t.checklist.length && <li className="muted text-sm">No checklist items</li>}
          </ul>
          {canEdit && <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newItem.trim()) addItem.mutate(undefined); }}><input className="input" placeholder="Add item" value={newItem} onChange={(e) => setNewItem(e.target.value)} /><button className="btn-secondary">Add</button></form>}
        </Card>
      </div>
      <Card title={<span className="inline-flex items-center gap-1.5"><Link2 className="h-4 w-4" /> Dependencies</span>}>
        <p className="label">Depends on (must finish first)</p>
        <ul className="mb-3 space-y-1 text-sm">
          {t.dependencies.map((d: any) => <li key={d.id} className="flex items-center gap-2"><Link className="text-brand-600" to={`/tasks/${d.id}`}>{d.task_key} {d.title}</Link><StatusBadge status={d.status} />{canManage && <button onClick={() => delDep.mutate(d.id)} aria-label="Remove dependency"><X className="h-3.5 w-3.5" /></button>}</li>)}
          {!t.dependencies.length && <li className="muted">None</li>}
        </ul>
        {t.dependents.length > 0 && <><p className="label">Blocking</p><ul className="mb-3 space-y-1 text-sm">{t.dependents.map((d: any) => <li key={d.id}><Link className="text-brand-600" to={`/tasks/${d.id}`}>{d.task_key} {d.title}</Link></li>)}</ul></>}
        {canManage && <div className="flex gap-2"><Select value={dep} onChange={setDep} placeholder="Add dependency…" options={(candidates?.items ?? []).filter((x: any) => x.id !== t.id).map((x: any) => ({ value: x.id, label: `${x.task_key} ${x.title}` }))} /><button className="btn-secondary" disabled={!dep} onClick={() => addDep.mutate(undefined)}>Add</button></div>}
      </Card>
      {t.approvals.length > 0 && (
        <Card title="Approval history">
          <ul className="space-y-3 text-sm">{t.approvals.map((a: any) => (
            <li key={a.id} className="flex flex-wrap items-start gap-2"><StatusBadge status={a.decision === 'revision_required' ? 'revision_required' : a.decision} label={`${humanize(a.approval_type)}: ${humanize(a.decision)}`} />
              <span className="muted text-xs">requested by {a.requested_by_name} {fromNow(a.requested_at)}{a.reviewer_name ? ` · reviewed by ${a.reviewer_name}` : ''}{a.decided_at ? ` ${fromNow(a.decided_at)}` : ''}</span>
              {(a.comments || a.request_note) && <p className="w-full text-sm">{a.comments || a.request_note}</p>}
            </li>
          ))}</ul>
        </Card>
      )}
    </div>
  );
}

function Comments({ taskId }: { taskId: number }) {
  const { data = [], isLoading } = useApi<any[]>(['comments', taskId], `/tasks/${taskId}/comments`);
  const { data: people = [] } = useApi<any[]>(['directory', undefined], '/org/directory', undefined, { staleTime: 60_000 });
  const [body, setBody] = useState('');
  const send = useAction(() => {
    const mentions = people.filter((p) => body.includes(`@${p.name}`)).map((p) => p.id);
    return api(`/tasks/${taskId}/comments`, { body: { body, mentions } });
  }, { invalidate: [['comments', taskId]], onSuccess: () => setBody('') });
  const mention = /@([\w ]{0,30})$/.exec(body)?.[1];
  const suggestions = mention != null ? people.filter((p) => p.name.toLowerCase().startsWith(mention.toLowerCase())).slice(0, 5) : [];
  if (isLoading) return <Loading />;
  return (
    <Card>
      <ul className="space-y-4">
        {data.map((c) => (
          <li key={c.id} className="flex gap-3">
            <Avatar name={c.author_name} />
            <div className="min-w-0 flex-1">
              <p className="text-sm"><b>{c.author_name}</b> <span className="muted text-xs">{fromNow(c.created_at)}</span>{c.is_feedback && <span className="badge ml-2 bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">Reviewer feedback</span>}</p>
              <p className="mt-0.5 whitespace-pre-line break-words text-sm">{c.body}</p>
            </div>
          </li>
        ))}
        {!data.length && <Empty title="No comments yet" hint="Use @Name to mention a colleague — they will be notified." />}
      </ul>
      <form className="relative mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (body.trim()) send.mutate(undefined); }}>
        <textarea className="input" rows={2} placeholder="Write a comment… type @ to mention" value={body} onChange={(e) => setBody(e.target.value)} />
        <button className="btn-primary sm:self-end" disabled={!body.trim() || send.isPending}><Send className="h-4 w-4" /> Send</button>
        {suggestions.length > 0 && (
          <ul className="card absolute bottom-full left-0 mb-1 w-64 p-1 shadow-lg">{suggestions.map((p) => <li key={p.id}><button type="button" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setBody(body.replace(/@[\w ]{0,30}$/, `@${p.name} `))}>{p.name}</button></li>)}</ul>
        )}
      </form>
    </Card>
  );
}

function Files({ t, canEdit }: { t: any; canEdit: boolean }) {
  const [deliverable, setDeliverable] = useState(false);
  const upload = useAction((files: FileList) => {
    const fd = new FormData();
    [...files].forEach((f) => fd.append('files', f));
    fd.append('is_deliverable', String(deliverable));
    return api(`/tasks/${t.id}/attachments`, { form: fd });
  }, { invalidate: [['task', t.id]], success: 'Uploaded' });
  const remove = useAction((aid: number) => api(`/tasks/${t.id}/attachments/${aid}`, { method: 'DELETE' }), { invalidate: [['task', t.id]] });
  return (
    <Card>
      {canEdit && (
        <div className="mb-4 flex flex-col gap-2 rounded-lg border border-dashed p-4 sm:flex-row sm:items-center">
          <label className="btn-secondary cursor-pointer"><Paperclip className="h-4 w-4" /> Upload files<input type="file" multiple className="hidden" onChange={(e) => e.target.files?.length && upload.mutate(e.target.files)} /></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={deliverable} onChange={(e) => setDeliverable(e.target.checked)} /> Mark as deliverable</label>
          <span className="muted text-xs sm:ml-auto">PDF, Office, images, CSV, ZIP · max 25 MB</span>
        </div>
      )}
      <ul className="divide-y">
        {t.attachments.map((a: any) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
            <button className="min-w-0 flex-1 truncate text-left text-brand-600" onClick={() => download(`/files/${a.file_id}/download`)}>{a.original_name}</button>
            {a.is_deliverable && <span className="badge bg-emerald-100 text-emerald-700">Deliverable</span>}
            <span className="muted text-xs">{(a.size_bytes / 1024).toFixed(0)} KB · {a.uploaded_by_name} · {fromNow(a.created_at)}</span>
            {canEdit && <button onClick={() => remove.mutate(a.id)} aria-label="Remove file"><X className="h-4 w-4" /></button>}
          </li>
        ))}
        {!t.attachments.length && <Empty title="No files attached" />}
      </ul>
    </Card>
  );
}

function TimeTab({ t }: { t: any }) {
  const { user } = useAuth();
  const [f, setF] = useState({ hours: '', entry_date: todayIso(), note: '' });
  const isAssignee = t.permissions.is_assignee;
  const log = useAction(() => api(`/tasks/${t.id}/time`, { body: { hours: Number(f.hours), entry_date: f.entry_date, note: f.note || null } }), { invalidate: [['task', t.id]], success: 'Time logged', onSuccess: () => setF({ ...f, hours: '', note: '' }) });
  const del = useAction((eid: number) => api(`/tasks/${t.id}/time/${eid}`, { method: 'DELETE' }), { invalidate: [['task', t.id]] });
  const est = Number(t.estimated_hours ?? 0);
  return (
    <Card>
      <div className="mb-4 grid grid-cols-3 gap-3 text-center">
        <div><p className="muted text-xs">Estimated</p><p className="text-lg font-semibold">{est || '—'} h</p></div>
        <div><p className="muted text-xs">Actual</p><p className="text-lg font-semibold">{t.actual_hours} h</p></div>
        <div><p className="muted text-xs">Variance</p><p className={`text-lg font-semibold ${est && t.actual_hours > est ? 'text-rose-600' : ''}`}>{est ? `${Math.round(((t.actual_hours - est) / est) * 100)}%` : '—'}</p></div>
      </div>
      {isAssignee && (
        <form className="mb-4 grid gap-2 sm:grid-cols-[100px_160px_1fr_auto]" onSubmit={(e) => { e.preventDefault(); log.mutate(undefined); }}>
          <input className="input" type="number" step="0.25" min="0.25" max="24" placeholder="Hours" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} required />
          <input className="input" type="date" value={f.entry_date} max={todayIso()} onChange={(e) => setF({ ...f, entry_date: e.target.value })} />
          <input className="input" placeholder="What did you work on?" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          <button className="btn-primary" disabled={!f.hours}>Log time</button>
        </form>
      )}
      <ul className="divide-y text-sm">
        {t.time_entries.map((e: any) => <li key={e.id} className="flex items-center gap-3 py-2"><span className="w-24 shrink-0">{fmtDate(e.entry_date)}</span><b className="w-14">{e.hours} h</b><span className="muted min-w-0 flex-1 truncate">{e.user_name}{e.note ? ` — ${e.note}` : ''}</span>{e.user_id === user!.id && <button onClick={() => del.mutate(e.id)} aria-label="Delete entry"><X className="h-4 w-4" /></button>}</li>)}
        {!t.time_entries.length && <Empty title="No time logged" />}
      </ul>
    </Card>
  );
}

function Reminders({ t, onAdd }: { t: any; onAdd: () => void }) {
  return (
    <Card actions={<button className="btn-secondary btn-sm" onClick={onAdd}><BellPlus className="h-4 w-4" /> Add</button>} title="Active reminders for this task">
      <ul className="divide-y text-sm">
        {t.reminders.map((r: any) => <li key={r.id} className="flex flex-wrap items-center gap-2 py-2"><Link to={`/notifications?schedule=${r.id}`} className="font-medium text-brand-600">{r.title}</Link><span className="muted text-xs">{r.schedule_type === 'deadline_offset' ? `${r.offset_minutes} min before deadline` : humanize(r.schedule_type)} · next {fmtDateTime(r.next_run_at)}</span><span className="muted text-xs">{r.channels.join(', ')}</span></li>)}
        {!t.reminders.length && <Empty title="No reminders" hint="Escalation rules still apply automatically to deadlines." />}
      </ul>
    </Card>
  );
}

function History({ taskId }: { taskId: number }) {
  const { data, isLoading } = useApi<any>(['history', taskId], `/tasks/${taskId}/history`);
  if (isLoading) return <Loading />;
  const items = [...data.updates.map((u: any) => ({ ...u, src: 'u' })), ...data.audit.map((a: any) => ({ ...a, src: 'a' }))].sort((a, b) => b.created_at.localeCompare(a.created_at));
  return (
    <Card>
      <ol className="relative space-y-4 border-l pl-5">
        {items.map((i: any) => (
          <li key={`${i.src}${i.id}`} className="text-sm">
            <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-brand-500 dark:border-slate-900" />
            {i.src === 'u'
              ? <p><b>{i.user_name}</b> {i.status_to && i.status_from !== i.status_to ? <>moved to <StatusBadge status={i.status_to} /></> : humanize(i.kind)}{i.progress != null && ` · ${i.progress}%`}</p>
              : <p><b>{i.actor_name ?? 'System'}</b> <span className="muted">{i.action}</span>{i.summary && ` — ${i.summary}`}</p>}
            {i.note && <p className="muted mt-0.5">{i.note}</p>}
            <p className="muted text-xs">{fmtDateTime(i.created_at)}</p>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function ProgressModal({ open, onClose, t, inv }: any) {
  const [f, setF] = useState<any>({});
  const save = useAction(() => api(`/tasks/${t.id}/progress`, { body: { progress: Number(f.progress), status: f.status || undefined, note: f.note || undefined, blocker_note: f.status === 'blocked' ? f.note : undefined, hours: f.hours ? Number(f.hours) : undefined } }),
    { invalidate: inv, success: 'Progress updated', onSuccess: onClose });
  if (open && f._id !== t.id) setF({ _id: t.id, progress: t.progress, status: '', note: '', hours: '' });
  return (
    <Modal open={open} onClose={() => { setF({}); onClose(); }} title="Update progress"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={save.isPending || (f.status === 'blocked' && !f.note)} onClick={() => save.mutate(undefined)}>Save update</button></>}>
      <div className="space-y-4">
        <Field label={`Progress: ${f.progress ?? 0}%`} hint="100% is set automatically when your submission is approved"><input type="range" className="w-full" min={0} max={99} step={5} value={f.progress ?? 0} onChange={(e) => setF({ ...f, progress: e.target.value })} /></Field>
        <Field label="Status"><Select value={f.status} onChange={(v) => setF({ ...f, status: v })} placeholder="Keep current" options={[{ value: 'in_progress', label: 'In progress' }, { value: 'on_hold', label: 'On hold' }, { value: 'blocked', label: 'Blocked (report blocker)' }]} /></Field>
        <Field label={f.status === 'blocked' ? 'Blocker description *' : 'Work update / note'}><textarea className="input" rows={3} value={f.note ?? ''} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <Field label="Hours spent (optional, logged for today)"><input className="input" type="number" step="0.25" min="0" max="24" value={f.hours ?? ''} onChange={(e) => setF({ ...f, hours: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function ReviewModal({ open, onClose, t, inv }: any) {
  const [decision, setDecision] = useState('approved');
  const [comments, setComments] = useState('');
  const [rating, setRating] = useState(4);
  const save = useAction(() => api(`/tasks/${t.id}/review`, { body: { decision, comments: comments || null, quality_rating: decision === 'approved' ? rating : undefined } }),
    { invalidate: inv, success: 'Review recorded', onSuccess: onClose });
  const pending = t.approvals.find((a: any) => a.approval_type === 'completion' && a.decision === 'pending');
  return (
    <Modal open={open} onClose={onClose} title={`Review ${t.task_key}`}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className={decision === 'approved' ? 'btn-success' : 'btn-danger'} disabled={save.isPending || (decision !== 'approved' && !comments.trim())} onClick={() => save.mutate(undefined)}>{decision === 'approved' ? 'Approve & complete' : decision === 'rejected' ? 'Reject' : 'Request revision'}</button></>}>
      <div className="space-y-4">
        {pending?.request_note && <p className="rounded-lg bg-slate-100 p-3 text-sm dark:bg-slate-800">“{pending.request_note}” — {pending.requested_by_name}</p>}
        <div className="grid grid-cols-3 gap-2">
          {[['approved', 'Approve'], ['revision_required', 'Revision'], ['rejected', 'Reject']].map(([v, l]) => (
            <button key={v} type="button" className={`chip justify-center ${decision === v ? 'chip-on' : 'chip-off'}`} onClick={() => setDecision(v)}>{l}</button>
          ))}
        </div>
        {decision === 'approved' && <Field label={`Quality rating: ${rating} / 5`} hint="Feeds the balanced performance score"><input type="range" min={1} max={5} className="w-full" value={rating} onChange={(e) => setRating(Number(e.target.value))} /></Field>}
        <Field label={decision === 'approved' ? 'Feedback (optional)' : 'What needs to change? *'}><textarea className="input" rows={4} value={comments} onChange={(e) => setComments(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function AssignModal({ open, onClose, t, inv }: any) {
  const [ids, setIds] = useState<number[]>([]);
  const [note, setNote] = useState('');
  if (open && !ids.length && t.assignees.length) setTimeout(() => setIds(t.assignees.map((a: any) => a.id)));
  const save = useAction(() => api(`/tasks/${t.id}/assign`, { body: { assignee_ids: ids, note: note || null } }), { invalidate: inv, success: 'Assignees updated', onSuccess: () => { setIds([]); onClose(); } });
  return (
    <Modal open={open} onClose={() => { setIds([]); onClose(); }} title="Assign / reassign"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!ids.length || save.isPending} onClick={() => save.mutate(undefined)}>Save</button></>}>
      <div className="space-y-4">
        <Field label="Assignees" hint="First selected is primary. Deadline reminders follow the new assignees."><UserPicker multi value={ids} onChange={setIds} /></Field>
        <Field label="Note (recorded in history)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function ExtensionModal({ open, onClose, t, inv }: any) {
  const [deadline, setDeadline] = useState('');
  const [reason, setReason] = useState('');
  const save = useAction(() => api(`/tasks/${t.id}/extension`, { body: { requested_deadline: localInputToIso(deadline), reason } }), { invalidate: inv, success: 'Extension requested', onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title="Request deadline extension"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!deadline || reason.trim().length < 5 || save.isPending} onClick={() => save.mutate(undefined)}>Send request</button></>}>
      <div className="space-y-4">
        <p className="muted text-sm">Current deadline: {fmtDateTime(t.deadline)}</p>
        <Field label="New deadline"><input className="input" type="datetime-local" min={isoToLocalInput(t.deadline)} value={deadline} onChange={(e) => setDeadline(e.target.value)} /></Field>
        <Field label="Reason (min 5 characters)"><textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
