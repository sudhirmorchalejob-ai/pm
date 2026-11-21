import { useEffect, useState } from 'react';

import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { browserTz, fmtDateTime, todayIso, zonedDate, zonedTime } from '../../lib/format';
import { useAction, useApi } from '../../lib/hooks';
import { Chips, Field, Modal, Select, UserPicker } from '../../components/ui';

export const CHANNEL_OPTS = [
  { value: 'in_app', label: 'In-app' }, { value: 'email', label: 'Email' }, { value: 'browser_push', label: 'Browser push' },
  { value: 'mobile_push', label: 'Mobile push' }, { value: 'whatsapp', label: 'WhatsApp' },
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const OFFSETS = [{ value: '15', label: '15 min' }, { value: '30', label: '30 min' }, { value: '60', label: '1 hour' }, { value: '120', label: '2 hours' }, { value: '1440', label: '1 day' }, { value: '2880', label: '2 days' }];

export function ReminderForm({ open, onClose, schedule, defaults }: { open: boolean; onClose: () => void; schedule?: any; defaults?: any }) {
  const { user, can } = useAuth();
  const edit = !!schedule;
  const [f, setF] = useState<any>({});
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [created, setCreated] = useState<any>(null);
  const { data: tzs = [] } = useApi<string[]>(['timezones'], open ? '/timezones' : null, undefined, { staleTime: Infinity });
  const { data: channels } = useApi<any>(['channels'], open ? '/notifications/channels' : null);
  const { data: tasks } = useApi<any>(['tasks', 'mini'], open ? '/tasks' : null, { pageSize: 200, status: 'not_started,in_progress,on_hold,blocked,revision_required,submitted,under_review' });
  const { data: projects } = useApi<any>(['projects-mini'], open ? '/projects' : null, { pageSize: 200 });
  const { data: depts = [] } = useApi<any[]>(['departments'], open ? '/org/departments' : null);

  useEffect(() => {
    if (!open) return;
    setErrors({}); setCreated(null);
    const tz = user!.timezone || browserTz();
    if (schedule) {
      const r = schedule.recurrence;
      const local = schedule.run_at ? new Date(schedule.run_at) : null;
      setF({
        title: schedule.title, message: schedule.message ?? '', description: schedule.description ?? '', schedule_type: schedule.schedule_type, timezone: schedule.timezone,
        date: r?.starts_on ?? (local ? zonedDate(local, schedule.timezone) : todayIso()), time: (r?.time_of_day ?? (local ? zonedTime(local, schedule.timezone) : '10:00')).slice(0, 5),
        offset_minutes: String(schedule.offset_minutes ?? 30), channels: schedule.channels, recipient_ids: schedule.recipients.map((x: any) => x.id),
        freq: r?.freq ?? 'weekly', interval: r?.interval ?? 1, by_weekday: (r?.by_weekday ?? [1]).map(String), by_month_day: r?.by_month_day ?? '', ends_on: r?.ends_on ?? '', max_count: r?.max_count ?? '',
        task_id: schedule.task_id ?? '', project_id: schedule.project_id ?? '', department_id: schedule.department_id ?? '',
      });
    } else {
      const soon = new Date(Date.now() + 60 * 60_000);
      setF({
        title: '', message: '', description: '', schedule_type: 'one_time', timezone: tz, date: zonedDate(soon, tz), time: zonedTime(soon, tz),
        offset_minutes: '30', channels: ['in_app'], recipient_ids: [user!.id], freq: 'weekly', interval: 1, by_weekday: ['1'], by_month_day: '', ends_on: '', max_count: '',
        task_id: '', project_id: '', department_id: '', ...defaults,
      });
    }
  }, [open, schedule]);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const num = (v: any) => (v === '' || v == null ? null : Number(v));

  const save = useAction(async () => {
    const body: any = {
      title: f.title, message: f.message || null, description: f.description || null, timezone: f.timezone, channels: f.channels, recipient_ids: f.recipient_ids,
      task_id: num(f.task_id), project_id: num(f.project_id), department_id: num(f.department_id),
    };
    if (!edit) body.schedule_type = f.schedule_type;
    if (f.schedule_type !== 'deadline_offset') { body.date = f.date; body.time = f.time; }
    if (f.schedule_type === 'deadline_offset') body.offset_minutes = Number(f.offset_minutes);
    if (f.schedule_type === 'recurring') body.recurrence = {
      freq: f.freq, interval: Number(f.interval) || 1, by_weekday: f.freq === 'weekly' ? f.by_weekday.map(Number) : undefined,
      by_month_day: f.freq === 'monthly' && f.by_month_day ? Number(f.by_month_day) : undefined, ends_on: f.ends_on || null, max_count: f.max_count ? Number(f.max_count) : undefined,
    };
    try {
      return edit ? await api(`/notifications/schedules/${schedule.id}`, { method: 'PATCH', body }) : await api('/notifications/schedules', { body });
    } catch (e) { if (e instanceof ApiError) setErrors(e.fieldErrors); throw e; }
  }, { invalidate: [['schedules'], ['schedule'], ['task']], success: edit ? 'Reminder rescheduled' : 'Reminder scheduled', onSuccess: (r: any) => setCreated(r) });

  const unconfigured = (f.channels ?? []).filter((c: string) => channels && !channels[c]?.configured);
  return (
    <Modal open={open} onClose={onClose} title={edit ? 'Edit reminder' : 'Schedule a reminder'} size="lg"
      footer={created ? <button className="btn-primary" onClick={onClose}>Done</button> : <><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.title || !f.channels?.length || save.isPending} onClick={() => save.mutate(undefined)}>{edit ? 'Save' : 'Schedule'}</button></>}>
      {created ? (
        <div className="space-y-2 text-center">
          <p className="text-lg font-semibold">✅ Scheduled on the server</p>
          <p className="text-sm">Next notification: <b>{fmtDateTime(created.next_run_at)}</b> (your local time)</p>
          <p className="muted text-sm">It will be delivered even if you log out or close the browser.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title *" error={errors.title} className="sm:col-span-2"><input className="input" value={f.title ?? ''} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Follow up with HOD on ERP migration" autoFocus /></Field>
          <Field label="Notification message" className="sm:col-span-2"><textarea className="input" rows={2} value={f.message ?? ''} onChange={(e) => set('message', e.target.value)} placeholder="Custom text recipients will see" /></Field>
          {!edit && (
            <div className="sm:col-span-2"><span className="label">Type</span>
              <Chips value={f.schedule_type} onChange={(v) => set('schedule_type', v)} options={[{ value: 'one_time', label: 'One time' }, { value: 'recurring', label: 'Recurring' }, { value: 'deadline_offset', label: 'Before a task deadline' }]} />
            </div>
          )}
          {f.schedule_type !== 'deadline_offset' && <>
            <Field label={f.schedule_type === 'recurring' ? 'Starts on' : 'Date'} error={errors.date}><input className="input" type="date" value={f.date ?? ''} onChange={(e) => set('date', e.target.value)} /></Field>
            <Field label="Time" error={errors.time}><input className="input" type="time" value={f.time ?? ''} onChange={(e) => set('time', e.target.value)} /></Field>
          </>}
          {f.schedule_type === 'deadline_offset' && <>
            <Field label="Task *" className="sm:col-span-2"><Select value={f.task_id} onChange={(v) => set('task_id', v)} placeholder="Select a task with a deadline" options={(tasks?.items ?? []).filter((t: any) => t.deadline).map((t: any) => ({ value: t.id, label: `${t.task_key} ${t.title}` }))} /></Field>
            <div className="sm:col-span-2"><span className="label">Remind before deadline</span><Chips value={String(f.offset_minutes)} onChange={(v) => set('offset_minutes', v)} options={OFFSETS} /></div>
          </>}
          <Field label="Timezone" className={f.schedule_type === 'deadline_offset' ? 'sm:col-span-2' : 'sm:col-span-2'} hint="The reminder fires at this wall-clock time in this timezone (DST-aware)">
            <Select value={f.timezone} onChange={(v) => set('timezone', v)} options={(tzs.length ? tzs : [f.timezone]).map((z) => ({ value: z, label: z }))} />
          </Field>
          {f.schedule_type === 'recurring' && (
            <div className="grid gap-3 rounded-lg border p-3 sm:col-span-2 sm:grid-cols-3">
              <Field label="Repeat"><Select value={f.freq} onChange={(v) => set('freq', v)} options={['minutely', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'].map((x) => ({ value: x, label: { minutely: 'Every N minutes', hourly: 'Every N hours', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' }[x]! }))} /></Field>
              <Field label="Interval"><input className="input" type="number" min={1} value={f.interval} onChange={(e) => set('interval', e.target.value)} /></Field>
              {f.freq === 'monthly' ? <Field label="Day of month"><input className="input" type="number" min={1} max={31} value={f.by_month_day} placeholder="Start day" onChange={(e) => set('by_month_day', e.target.value)} /></Field> : <div />}
              {f.freq === 'weekly' && <div className="sm:col-span-3"><span className="label">On days</span><Chips multi value={f.by_weekday} onChange={(v) => set('by_weekday', v)} options={WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d }))} /></div>}
              <Field label="End date (optional)"><input className="input" type="date" value={f.ends_on} onChange={(e) => set('ends_on', e.target.value)} /></Field>
              <Field label="Max occurrences (optional)"><input className="input" type="number" min={1} value={f.max_count} onChange={(e) => set('max_count', e.target.value)} /></Field>
            </div>
          )}
          <Field label="Recipients" className="sm:col-span-2" hint={can('notifications.schedule_others') ? 'Defaults to you. Only people inside your scope can be selected.' : 'You can schedule reminders for yourself'}>
            {can('notifications.schedule_others') ? <UserPicker multi value={f.recipient_ids ?? []} onChange={(v) => set('recipient_ids', v)} /> : <input className="input" disabled value={user!.name} />}
          </Field>
          <div className="sm:col-span-2"><span className="label">Channels</span><Chips multi value={f.channels ?? []} onChange={(v) => set('channels', v)} options={CHANNEL_OPTS} />
            {unconfigured.length > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Not configured on this server: {unconfigured.join(', ')} — those deliveries will be logged as “skipped”.</p>}
          </div>
          {f.schedule_type !== 'deadline_offset' && <Field label="Related task"><Select value={f.task_id} onChange={(v) => set('task_id', v)} placeholder="— None —" options={(tasks?.items ?? []).map((t: any) => ({ value: t.id, label: `${t.task_key} ${t.title}` }))} /></Field>}
          <Field label="Related project"><Select value={f.project_id} onChange={(v) => set('project_id', v)} placeholder="— None —" options={(projects?.items ?? []).map((p: any) => ({ value: p.id, label: p.name }))} /></Field>
          <Field label="Related department"><Select value={f.department_id} onChange={(v) => set('department_id', v)} placeholder="— None —" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} /></Field>
        </div>
      )}
    </Modal>
  );
}
