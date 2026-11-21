import { useState } from 'react';
import { Bell, Check, Plus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { browserTz, fmtDateTime, fromNow, todayIso, zonedDate, zonedTime } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { Card, Chips, confirm, Empty, Field, Loading, Modal, PageHeader, PriorityBadge, Select, StatusBadge } from '../components/ui';
import { CHANNEL_OPTS } from './notifications/ReminderForm';

export default function Agenda() {
  const [status, setStatus] = useState('open');
  const [editing, setEditing] = useState<any>(null);
  const { data = [], isLoading } = useApi<any[]>(['agenda'], '/agenda', { status: status || undefined });
  const done = useAction((id: number) => api(`/agenda/${id}`, { method: 'PATCH', body: { status: 'done' } }), { invalidate: [['agenda']], success: 'Marked done' });
  const del = useAction((id: number) => api(`/agenda/${id}`, { method: 'DELETE' }), { invalidate: [['agenda']], success: 'Removed' });
  const groups = new Map<string, any[]>();
  for (const a of data) { const k = new Date(a.due_at) < new Date() && a.status === 'open' ? 'Overdue' : new Date(a.due_at).toDateString(); groups.set(k, [...(groups.get(k) ?? []), a]); }
  return (
    <div>
      <PageHeader title="My management agenda" subtitle="Private follow-ups with server-side reminders" actions={<button className="btn-primary" onClick={() => setEditing({})}><Plus className="h-4 w-4" /> Add follow-up</button>} />
      <div className="mb-4"><Chips value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }, { value: '', label: 'All' }]} /></div>
      {isLoading ? <Loading /> : !data.length ? <Card><Empty title="Your agenda is empty" hint="E.g. “Check IT department progress at 10:00”, “Follow up with HOD”, “Review project budget”." /></Card> : (
        <div className="space-y-4">
          {[...groups.entries()].map(([k, items]) => (
            <Card key={k} title={k === 'Overdue' ? <span className="text-rose-600">Overdue</span> : k}>
              <ul className="divide-y">
                {items.map((a) => (
                  <li key={a.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
                    <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(a)}>
                      <p className={clsx('font-medium', a.status === 'done' && 'muted line-through')}>{a.title}</p>
                      <p className="muted text-xs">{fmtDateTime(a.due_at)} ({a.timezone}){a.recurrence ? ' · recurring' : ''}{a.project_name ? ` · ${a.project_name}` : ''}{a.department_name ? ` · ${a.department_name}` : ''}</p>
                      {a.notes && <p className="muted mt-1 text-sm">{a.notes}</p>}
                    </button>
                    <div className="flex flex-wrap items-center gap-2">
                      <PriorityBadge priority={a.priority} />
                      {a.reminder?.next_run_at && <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-200"><Bell className="h-3 w-3" /> {fromNow(a.reminder.next_run_at)}</span>}
                      {a.status !== 'open' && <StatusBadge status={a.status} />}
                      {a.status === 'open' && <button className="btn-secondary btn-sm" onClick={() => done.mutate(a.id)}><Check className="h-4 w-4" /> Done</button>}
                      <button className="btn-ghost btn-sm" aria-label="Delete" onClick={async () => (await confirm({ title: 'Remove follow-up?', danger: true })) && del.mutate(a.id)}><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
      <AgendaForm item={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function AgendaForm({ item, onClose }: { item: any; onClose: () => void }) {
  const { user } = useAuth();
  const edit = !!item?.id;
  const tz = item?.timezone ?? user?.timezone ?? browserTz();
  const [f, setF] = useState<any>(null);
  const { data: projects } = useApi<any>(['projects-mini'], item ? '/projects' : null, { pageSize: 200 });
  const { data: depts = [] } = useApi<any[]>(['departments'], item ? '/org/departments' : null);
  if (item && (!f || f._for !== (item.id ?? 'new'))) {
    const due = item.due_at ? new Date(item.due_at) : new Date(Date.now() + 2 * 3600_000);
    setF({ _for: item.id ?? 'new', title: item.title ?? '', description: item.description ?? '', notes: item.notes ?? '', priority: item.priority ?? 'medium', timezone: tz,
      date: item.due_at ? zonedDate(due, tz) : todayIso(), time: zonedTime(due, tz), reminder_minutes_before: item.reminder_minutes_before ?? 15, channels: ['in_app', 'browser_push'],
      related_project_id: item.related_project_id ?? '', related_department_id: item.related_department_id ?? '', recurring: false, freq: 'weekly', by_weekday: ['1'] });
  }
  const save = useAction(() => {
    const body: any = { title: f.title, description: f.description || null, notes: f.notes || null, priority: f.priority, date: f.date, time: f.time, timezone: f.timezone,
      reminder_minutes_before: f.reminder_minutes_before === '' ? null : Number(f.reminder_minutes_before), channels: f.channels,
      related_project_id: f.related_project_id ? Number(f.related_project_id) : null, related_department_id: f.related_department_id ? Number(f.related_department_id) : null };
    if (!edit && f.recurring) body.recurrence = { freq: f.freq, interval: 1, by_weekday: f.freq === 'weekly' ? f.by_weekday.map(Number) : undefined };
    return edit ? api(`/agenda/${item.id}`, { method: 'PATCH', body }) : api('/agenda', { body });
  }, { invalidate: [['agenda'], ['schedules']], success: edit ? 'Updated' : 'Added to agenda', onSuccess: () => { setF(null); onClose(); } });
  return (
    <Modal open={!!item && !!f} onClose={() => { setF(null); onClose(); }} title={edit ? 'Edit follow-up' : 'New follow-up'}
      footer={<><button className="btn-secondary" onClick={() => { setF(null); onClose(); }}>Cancel</button><button className="btn-primary" disabled={!f?.title || save.isPending} onClick={() => save.mutate(undefined)}>Save</button></>}>
      {f && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title *" className="sm:col-span-2"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Follow up with HOD Finance" /></Field>
          <Field label="Date"><input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          <Field label={`Time (${f.timezone})`}><input className="input" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
          <Field label="Priority"><Select value={f.priority} onChange={(v) => setF({ ...f, priority: v })} options={['low', 'medium', 'high', 'critical'].map((p) => ({ value: p, label: p }))} /></Field>
          <Field label="Remind me (minutes before)"><input className="input" type="number" min={0} value={f.reminder_minutes_before} onChange={(e) => setF({ ...f, reminder_minutes_before: e.target.value })} /></Field>
          <div className="sm:col-span-2"><span className="label">Reminder channels</span><Chips multi value={f.channels} onChange={(v) => setF({ ...f, channels: v })} options={CHANNEL_OPTS} /></div>
          {!edit && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={f.recurring} onChange={(e) => setF({ ...f, recurring: e.target.checked })} /> Repeat</label>}
          {!edit && f.recurring && <div className="sm:col-span-2"><Chips value={f.freq} onChange={(v) => setF({ ...f, freq: v })} options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }]} />
            {f.freq === 'weekly' && <div className="mt-2"><Chips multi value={f.by_weekday} onChange={(v) => setF({ ...f, by_weekday: v })} options={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => ({ value: String(i + 1), label: d }))} /></div>}
            <p className="muted mt-1 text-xs">Recurring follow-ups remind you at each occurrence.</p></div>}
          <Field label="Related project"><Select value={f.related_project_id} onChange={(v) => setF({ ...f, related_project_id: v })} placeholder="—" options={(projects?.items ?? []).map((p: any) => ({ value: p.id, label: p.name }))} /></Field>
          <Field label="Related department"><Select value={f.related_department_id} onChange={(v) => setF({ ...f, related_department_id: v })} placeholder="—" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} /></Field>
          <Field label="Notes" className="sm:col-span-2"><textarea className="input" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </div>
      )}
    </Modal>
  );
}
