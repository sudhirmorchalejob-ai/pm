import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRightCircle, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, isoToLocalInput, localInputToIso } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { Card, Chips, DataTable, Empty, Field, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, UserPicker } from '../components/ui';

export default function Meetings() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [upcoming, setUpcoming] = useState('true');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useApi<any>(['meetings'], '/meetings', { upcoming, page });
  const openId = sp.get('id');
  return (
    <div>
      <PageHeader title="Meetings" subtitle="Schedule, record minutes and turn action items into tasks" actions={can('meetings.manage') && <button className="btn-primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Schedule meeting</button>} />
      <div className="mb-3"><Chips value={upcoming} onChange={(v) => { setUpcoming(v); setPage(1); }} options={[{ value: 'true', label: 'Upcoming' }, { value: 'false', label: 'All' }]} /></div>
      <Card pad={false}>{isLoading ? <Loading /> : <div className="px-4 sm:px-0">
        <DataTable rows={data.items} onRowClick={(m: any) => setSp({ id: String(m.id) })} empty={<Empty title="No meetings" />} columns={[
          { key: 'title', header: 'Meeting', render: (m: any) => <span className="font-medium">{m.title}<span className="muted block text-xs font-normal">{m.project_name ?? ''}</span></span> },
          { key: 'starts_at', header: 'When', render: (m: any) => fmtDateTime(m.starts_at) }, { key: 'location', header: 'Where' },
          { key: 'organizer_name', header: 'Organizer' }, { key: 'attendees', header: 'Attendees', render: (m: any) => m.attendees.length },
          { key: 'open_actions', header: 'Open actions' }, { key: 'status', header: 'Status', render: (m: any) => <StatusBadge status={m.status} /> },
        ]} />
        <div className="pb-4"><Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></div>
      </div>}</Card>
      <MeetingForm open={creating} onClose={() => setCreating(false)} />
      {openId && <MeetingDetail id={Number(openId)} onClose={() => setSp({})} />}
    </div>
  );
}

function MeetingForm({ open, onClose, meeting }: { open: boolean; onClose: () => void; meeting?: any }) {
  const [f, setF] = useState<any>({});
  const { data: projects } = useApi<any>(['projects-mini'], open ? '/projects' : null, { pageSize: 200 });
  useEffect(() => {
    if (!open) return;
    const start = new Date(Date.now() + 86400_000); start.setMinutes(0, 0, 0);
    setF(meeting ? { title: meeting.title, starts_at: isoToLocalInput(meeting.starts_at), ends_at: isoToLocalInput(meeting.ends_at), location: meeting.location ?? '', agenda: meeting.agenda ?? '', project_id: meeting.project_id ?? '', attendee_ids: meeting.attendees.map((a: any) => a.id) }
      : { title: '', starts_at: isoToLocalInput(start.toISOString()), ends_at: isoToLocalInput(new Date(start.getTime() + 3600_000).toISOString()), location: '', agenda: '', project_id: '', attendee_ids: [] });
  }, [open]);
  const save = useAction(() => {
    const body = { title: f.title, starts_at: localInputToIso(f.starts_at), ends_at: localInputToIso(f.ends_at), location: f.location || null, agenda: f.agenda || null, project_id: f.project_id ? Number(f.project_id) : null, attendee_ids: f.attendee_ids };
    return meeting ? api(`/meetings/${meeting.id}`, { method: 'PATCH', body }) : api('/meetings', { body });
  }, { invalidate: [['meetings'], ['meeting']], success: meeting ? 'Meeting updated' : 'Meeting scheduled — attendees notified', onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title={meeting ? 'Edit meeting' : 'Schedule meeting'} size="lg"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.title || save.isPending} onClick={() => save.mutate(undefined)}>Save</button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title *" className="sm:col-span-2"><input className="input" value={f.title ?? ''} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Starts"><input className="input" type="datetime-local" value={f.starts_at ?? ''} onChange={(e) => setF({ ...f, starts_at: e.target.value })} /></Field>
        <Field label="Ends"><input className="input" type="datetime-local" value={f.ends_at ?? ''} onChange={(e) => setF({ ...f, ends_at: e.target.value })} /></Field>
        <Field label="Location / link"><input className="input" value={f.location ?? ''} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
        <Field label="Project"><Select value={f.project_id} onChange={(v) => setF({ ...f, project_id: v })} placeholder="—" options={(projects?.items ?? []).map((p: any) => ({ value: p.id, label: p.name }))} /></Field>
        <Field label="Attendees" className="sm:col-span-2"><UserPicker multi value={f.attendee_ids ?? []} onChange={(v) => setF({ ...f, attendee_ids: v })} /></Field>
        <Field label="Agenda" className="sm:col-span-2"><textarea className="input" rows={3} value={f.agenda ?? ''} onChange={(e) => setF({ ...f, agenda: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function MeetingDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const { user } = useAuth();
  const { data: m, isLoading } = useApi<any>(['meeting', id], `/meetings/${id}`);
  const [minutes, setMinutes] = useState<string | null>(null);
  const [act, setAct] = useState<any>({ title: '', assignee_id: null, due_date: '' });
  const [editing, setEditing] = useState(false);
  const inv = [['meeting', id], ['meetings']];
  const saveMinutes = useAction(() => api(`/meetings/${id}`, { method: 'PATCH', body: { minutes, status: 'completed' } }), { invalidate: inv, success: 'Minutes saved' });
  const cancel = useAction(() => api(`/meetings/${id}`, { method: 'PATCH', body: { status: 'cancelled' } }), { invalidate: inv, success: 'Meeting cancelled' });
  const addAct = useAction(() => api(`/meetings/${id}/actions`, { body: { title: act.title, assignee_id: act.assignee_id, due_date: act.due_date || null } }), { invalidate: inv, onSuccess: () => setAct({ title: '', assignee_id: null, due_date: '' }) });
  const toggle = useAction((a: any) => api(`/meetings/${id}/actions/${a.id}`, { method: 'PATCH', body: { status: a.status === 'open' ? 'done' : 'open' } }), { invalidate: inv });
  const toTask = useAction((a: any) => api(`/meetings/${id}/actions/${a.id}/to-task`, { method: 'POST' }), { invalidate: inv, success: 'Task created' });
  const organizer = m?.organizer_id === user!.id;
  return (
    <Modal open onClose={onClose} title={m?.title ?? 'Meeting'} size="xl"
      footer={organizer && m?.status === 'scheduled' && <><button className="btn-secondary" onClick={() => cancel.mutate(undefined)}>Cancel meeting</button><button className="btn-secondary" onClick={() => setEditing(true)}>Edit</button></>}>
      {isLoading ? <Loading /> : (
        <div className="space-y-5">
          <p className="text-sm">{fmtDateTime(m.starts_at)} – {fmtDateTime(m.ends_at)} · {m.location ?? 'No location'} · <StatusBadge status={m.status} /></p>
          <p className="text-sm"><b>Attendees:</b> {m.attendees.map((a: any) => a.name).join(', ')}</p>
          {m.agenda && <div><p className="section-title">Agenda</p><p className="whitespace-pre-line text-sm">{m.agenda}</p></div>}
          <div>
            <p className="section-title mb-1">Minutes</p>
            {organizer ? <>
              <textarea className="input" rows={5} value={minutes ?? m.minutes ?? ''} onChange={(e) => setMinutes(e.target.value)} placeholder="Discussion, decisions…" />
              <button className="btn-primary mt-2" disabled={minutes == null} onClick={() => saveMinutes.mutate(undefined)}>Save minutes</button>
            </> : <p className="whitespace-pre-line text-sm">{m.minutes || <span className="muted">Not recorded yet</span>}</p>}
          </div>
          <div>
            <p className="section-title mb-1">Action items</p>
            <ul className="divide-y">
              {m.action_items.map((a: any) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <input type="checkbox" checked={a.status === 'done'} onChange={() => toggle.mutate(a)} aria-label={a.title} />
                  <span className={a.status === 'done' ? 'muted line-through' : ''}>{a.title}</span>
                  <span className="muted text-xs">{a.assignee_name ?? 'unassigned'}{a.due_date ? ` · ${fmtDate(a.due_date)}` : ''}</span>
                  {a.task_id ? <Link className="ml-auto text-xs text-brand-600" to={`/tasks/${a.task_id}`}>{a.task_key}</Link>
                    : organizer && a.assignee_id && <button className="btn-ghost btn-sm ml-auto" onClick={() => toTask.mutate(a)}><ArrowRightCircle className="h-4 w-4" /> Make task</button>}
                </li>
              ))}
              {!m.action_items.length && <li className="muted py-2 text-sm">No action items</li>}
            </ul>
            {organizer && <form className="mt-2 grid gap-2 sm:grid-cols-[1fr_200px_150px_auto]" onSubmit={(e) => { e.preventDefault(); addAct.mutate(undefined); }}>
              <input className="input" placeholder="Action item" value={act.title} onChange={(e) => setAct({ ...act, title: e.target.value })} required />
              <UserPicker value={act.assignee_id} onChange={(v) => setAct({ ...act, assignee_id: v })} placeholder="Owner" />
              <input className="input" type="date" value={act.due_date} onChange={(e) => setAct({ ...act, due_date: e.target.value })} />
              <button className="btn-secondary">Add</button>
            </form>}
          </div>
        </div>
      )}
      {m && <MeetingForm open={editing} meeting={m} onClose={() => setEditing(false)} />}
    </Modal>
  );
}
