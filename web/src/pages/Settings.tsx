import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { humanize } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { Card, Chips, confirm, DataTable, Field, Loading, Modal, PageHeader, Select, Tabs } from '../components/ui';
import { CHANNEL_OPTS } from './notifications/ReminderForm';
import { ActivityCategoriesAdmin } from './mywork/admin';

export default function SettingsPage() {
  const { can } = useAuth();
  const tabs = [
    ...(can('settings.manage') ? [{ value: 'general', label: 'General' }] : []),
    ...(can('settings.manage') ? [{ value: 'activities', label: 'Activity categories' }] : []),
    ...(can('roles.manage') ? [{ value: 'roles', label: 'Roles & permissions' }] : []),
    ...(can('notifications.rules.manage') ? [{ value: 'rules', label: 'Notification rules' }] : []),
    ...(can('escalations.manage') ? [{ value: 'escalations', label: 'Escalation rules' }] : []),
  ];
  const [tab, setTab] = useState(tabs[0]?.value);
  return (
    <div>
      <PageHeader title="Settings" />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'general' && <General />}
      {tab === 'activities' && <ActivityCategoriesAdmin />}
      {tab === 'roles' && <Roles />}
      {tab === 'rules' && <Rules />}
      {tab === 'escalations' && <Escalations />}
    </div>
  );
}

function General() {
  const { data, isLoading } = useApi<any>(['settings'], '/settings');
  const { data: tzs = [] } = useApi<string[]>(['timezones'], '/timezones', undefined, { staleTime: Infinity });
  const { data: roles = [] } = useApi<any[]>(['roles'], '/org/roles');
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (data) setF(data); }, [data]);
  const save = useAction(() => api('/settings', { method: 'PUT', body: {
    organization_name: f.organization_name, default_timezone: f.default_timezone, reminders_on_task_close: f.reminders_on_task_close, overload_threshold_percent: Number(f.overload_threshold_percent),
    daily_report_roles: f.daily_report_roles, daily_report_reminder_time: f.daily_report_reminder_time, working_days: f.working_days.map(Number),
    checklist_channels: f.checklist_channels, checklist_notify_new_questions: f.checklist_notify_new_questions,
  } }), { invalidate: [['settings']], success: 'Settings saved' });
  if (isLoading || !f) return <Loading />;
  return (
    <Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Organization name"><input className="input" value={f.organization_name} onChange={(e) => setF({ ...f, organization_name: e.target.value })} /></Field>
        <Field label="Default timezone"><Select value={f.default_timezone} onChange={(v) => setF({ ...f, default_timezone: v })} options={tzs.map((z) => ({ value: z, label: z }))} /></Field>
        <Field label="Pending reminders when a task is completed or cancelled"><Select value={f.reminders_on_task_close} onChange={(v) => setF({ ...f, reminders_on_task_close: v })} options={[{ value: 'cancel', label: 'Cancel them automatically' }, { value: 'keep', label: 'Keep them' }]} /></Field>
        <Field label="Overload threshold (% of weekly capacity)"><input className="input" type="number" min={50} max={300} value={f.overload_threshold_percent} onChange={(e) => setF({ ...f, overload_threshold_percent: e.target.value })} /></Field>
        <Field label="Daily report reminder time (default timezone, blank = off)"><input className="input" type="time" value={f.daily_report_reminder_time} onChange={(e) => setF({ ...f, daily_report_reminder_time: e.target.value })} /></Field>
        <div><span className="label">Working days</span><Chips multi value={f.working_days.map(String)} onChange={(v) => setF({ ...f, working_days: v })} options={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => ({ value: String(i + 1), label: d }))} /></div>
        <div className="md:col-span-2"><span className="label">Checklist notifications (assignments, reminders, escalations, EOD ready)</span><Chips multi value={f.checklist_channels ?? ['in_app']} onChange={(v) => setF({ ...f, checklist_channels: v.length ? v : ['in_app'] })} options={CHANNEL_OPTS} /></div>
        <label className="flex items-center gap-2 text-sm md:col-span-2"><input type="checkbox" checked={!!f.checklist_notify_new_questions} onChange={(e) => setF({ ...f, checklist_notify_new_questions: e.target.checked })} /> Notify employees when new questions are added to their checklist</label>
        <div className="md:col-span-2"><span className="label">Roles required to submit daily reports</span><Chips multi value={f.daily_report_roles} onChange={(v) => setF({ ...f, daily_report_roles: v })} options={roles.map((r: any) => ({ value: r.key, label: r.name }))} /></div>
      </div>
      <button className="btn-primary mt-5" onClick={() => save.mutate(undefined)}>Save settings</button>
    </Card>
  );
}

function Roles() {
  const { data: roles = [], isLoading } = useApi<any[]>(['roles'], '/org/roles');
  const { data: perms = [] } = useApi<any[]>(['permissions'], '/org/permissions');
  const [matrix, setMatrix] = useState<Record<number, Set<string>>>({});
  useEffect(() => { setMatrix(Object.fromEntries(roles.map((r) => [r.id, new Set(r.permissions)]))); }, [roles]);
  const save = useAction((r: any) => api(`/org/roles/${r.id}/permissions`, { method: 'PUT', body: { permissions: [...matrix[r.id]] } }), { invalidate: [['roles']], success: 'Permissions updated' });
  if (isLoading) return <Loading />;
  const modules = [...new Set(perms.map((p) => p.module))];
  return (
    <Card pad={false}>
      <p className="muted p-4 text-sm">Data scope (what records a role can see) is fixed per role: {roles.map((r) => `${r.name} → ${r.scope_level}`).join(' · ')}. Permissions below control what they can do. All checks are enforced by the API.</p>
      <div className="scrollbar-thin overflow-x-auto">
        <table className="table min-w-[900px]">
          <thead><tr><th className="sticky left-0 bg-white dark:bg-slate-900">Permission</th>{roles.map((r) => <th key={r.id} className="text-center">{r.name}</th>)}</tr></thead>
          <tbody>
            {modules.map((m) => [
              <tr key={m}><td colSpan={roles.length + 1} className="bg-slate-50 text-xs font-semibold uppercase dark:bg-slate-800/50">{humanize(m)}</td></tr>,
              ...perms.filter((p) => p.module === m).map((p) => (
                <tr key={p.key}>
                  <td className="sticky left-0 bg-white dark:bg-slate-900"><p className="text-sm">{p.description}</p><code className="muted text-[11px]">{p.key}</code></td>
                  {roles.map((r) => (
                    <td key={r.id} className="text-center">
                      <input type="checkbox" className="h-4 w-4" disabled={r.key === 'super_admin'} checked={matrix[r.id]?.has(p.key) ?? false} aria-label={`${r.name}: ${p.key}`}
                        onChange={(e) => setMatrix((mx) => { const s = new Set(mx[r.id]); e.target.checked ? s.add(p.key) : s.delete(p.key); return { ...mx, [r.id]: s }; })} />
                    </td>
                  ))}
                </tr>
              )),
            ])}
            <tr><td className="sticky left-0 bg-white dark:bg-slate-900" />{roles.map((r) => <td key={r.id} className="text-center">{r.key !== 'super_admin' && <button className="btn-secondary btn-sm" onClick={() => save.mutate(r)}>Save</button>}</td>)}</tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Rules() {
  const { data = [], isLoading } = useApi<any[]>(['notif-rules'], '/notifications/rules');
  const { data: meta } = useApi<any>(['notif-meta'], '/notifications/meta');
  const [edit, setEdit] = useState<any>(null);
  const toggle = useAction((r: any) => api(`/notifications/rules/${r.id}`, { method: 'PATCH', body: { is_active: !r.is_active } }), { invalidate: [['notif-rules']] });
  const del = useAction((id: number) => api(`/notifications/rules/${id}`, { method: 'DELETE' }), { invalidate: [['notif-rules']], success: 'Deleted' });
  const save = useAction((f: any) => f.id ? api(`/notifications/rules/${f.id}`, { method: 'PATCH', body: f.body }) : api('/notifications/rules', { body: f.body }), { invalidate: [['notif-rules']], success: 'Rule saved', onSuccess: () => setEdit(null) });
  if (isLoading) return <Loading />;
  return (
    <Card title="Event-triggered notification rules" actions={<button className="btn-primary btn-sm" onClick={() => setEdit({ name: '', event_type: 'task.assigned', channels: ['in_app'], recipient_roles: ['assignee'], title_template: '', message_template: '', is_active: true })}><Plus className="h-4 w-4" /> Rule</button>} pad={false}>
      <div className="px-4 sm:px-0"><DataTable rows={data} onRowClick={setEdit} columns={[
        { key: 'name', header: 'Rule', render: (r: any) => <span className="font-medium">{r.name}<span className="muted block text-xs font-normal">{meta?.event_types?.[r.event_type] ?? r.event_type}</span></span> },
        { key: 'recipient_roles', header: 'Recipients', render: (r: any) => r.recipient_roles.map(humanize).join(', ') },
        { key: 'channels', header: 'Channels', render: (r: any) => r.channels.map(humanize).join(', ') },
        { key: 'active', header: 'Active', render: (r: any) => <input type="checkbox" checked={r.is_active} onClick={(e) => e.stopPropagation()} onChange={() => toggle.mutate(r)} aria-label="Active" /> },
        { key: 'x', header: '', render: (r: any) => <button onClick={async (e) => { e.stopPropagation(); if (await confirm({ title: 'Delete rule?', danger: true })) del.mutate(r.id); }} aria-label="Delete"><Trash2 className="h-4 w-4 text-slate-400" /></button> },
      ]} /></div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit rule' : 'New rule'} size="lg"
        footer={<><button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button><button className="btn-primary" onClick={() => save.mutate({ id: edit.id, body: { name: edit.name, event_type: edit.event_type, channels: edit.channels, recipient_roles: edit.recipient_roles, title_template: edit.title_template, message_template: edit.message_template, is_active: edit.is_active, priority_filter: edit.priority_filter?.length ? edit.priority_filter : null } })}>Save</button></>}>
        {edit && <div className="grid gap-4">
          <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Event"><Select value={edit.event_type} onChange={(v) => setEdit({ ...edit, event_type: v })} options={Object.entries(meta?.event_types ?? {}).map(([k, v]: any) => ({ value: k, label: v }))} /></Field>
          <div><span className="label">Recipients</span><Chips multi value={edit.recipient_roles} onChange={(v) => setEdit({ ...edit, recipient_roles: v })} options={(meta?.recipient_roles ?? []).map((r: string) => ({ value: r, label: humanize(r) }))} /></div>
          <div><span className="label">Channels</span><Chips multi value={edit.channels} onChange={(v) => setEdit({ ...edit, channels: v })} options={CHANNEL_OPTS} /></div>
          <div><span className="label">Only for priorities (none = all)</span><Chips multi value={edit.priority_filter ?? []} onChange={(v) => setEdit({ ...edit, priority_filter: v })} options={['low', 'medium', 'high', 'critical'].map((p) => ({ value: p, label: p }))} /></div>
          <Field label="Title template" hint="Variables: {{task.title}}, {{task.task_key}}, {{task.priority}}, {{actor.name}}, {{comments}} …"><input className="input" value={edit.title_template} onChange={(e) => setEdit({ ...edit, title_template: e.target.value })} /></Field>
          <Field label="Message template"><textarea className="input" rows={3} value={edit.message_template} onChange={(e) => setEdit({ ...edit, message_template: e.target.value })} /></Field>
        </div>}
      </Modal>
    </Card>
  );
}

function Escalations() {
  const { data = [], isLoading } = useApi<any[]>(['esc-rules'], '/notifications/escalation-rules');
  const { data: depts = [] } = useApi<any[]>(['departments'], '/org/departments');
  const [edit, setEdit] = useState<any>(null);
  const save = useAction((f: any) => f.id ? api(`/notifications/escalation-rules/${f.id}`, { method: 'PATCH', body: f.body }) : api('/notifications/escalation-rules', { body: f.body }), { invalidate: [['esc-rules']], success: 'Rule saved', onSuccess: () => setEdit(null) });
  const when = (m: number) => m < 0 ? `${fmtMin(-m)} before deadline` : m === 0 ? 'At deadline' : `${fmtMin(m)} overdue`;
  if (isLoading) return <Loading />;
  return (
    <Card title="Deadline & escalation rules" actions={<button className="btn-primary btn-sm" onClick={() => setEdit({ name: '', level: 2, offset_minutes: 1440, notify_roles: ['hod'], channels: ['in_app', 'email'], is_active: true, priority_filter: [], department_id: '', task_type: '' })}><Plus className="h-4 w-4" /> Rule</button>} pad={false}>
      <p className="muted px-4 pt-4 text-sm">Evaluated every minute by the background worker. Each rule fires once per task per deadline — if the deadline is changed and missed again, it fires again.</p>
      <div className="px-4 sm:px-0"><DataTable rows={data} onRowClick={(r: any) => setEdit({ ...r, priority_filter: r.priority_filter ?? [], department_id: r.department_id ?? '', task_type: r.task_type ?? '' })} columns={[
        { key: 'level', header: 'Level', render: (r: any) => `L${r.level}` }, { key: 'name', header: 'Rule', render: (r: any) => <span className={r.is_active ? 'font-medium' : 'muted line-through'}>{r.name}</span> },
        { key: 'offset', header: 'Trigger', render: (r: any) => when(r.offset_minutes) }, { key: 'notify_roles', header: 'Notify', render: (r: any) => r.notify_roles.map(humanize).join(', ') },
        { key: 'filters', header: 'Applies to', render: (r: any) => [r.priority_filter?.join('/'), r.department_name, r.task_type].filter(Boolean).join(' · ') || 'All tasks' },
        { key: 'channels', header: 'Channels', render: (r: any) => r.channels.map(humanize).join(', ') },
      ]} /></div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit escalation rule' : 'New escalation rule'} size="lg"
        footer={<><button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button><button className="btn-primary" onClick={() => save.mutate({ id: edit.id, body: {
          name: edit.name, level: Number(edit.level), offset_minutes: Number(edit.offset_minutes), notify_roles: edit.notify_roles, channels: edit.channels, is_active: edit.is_active,
          priority_filter: edit.priority_filter.length ? edit.priority_filter : null, department_id: edit.department_id ? Number(edit.department_id) : null, task_type: edit.task_type || null, message_template: edit.message_template || null } })}>Save</button></>}>
        {edit && <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Level"><input className="input" type="number" min={1} max={10} value={edit.level} onChange={(e) => setEdit({ ...edit, level: e.target.value })} /></Field>
          <Field label="Minutes relative to deadline" hint={`${when(Number(edit.offset_minutes) || 0)} (negative = before)`}><input className="input" type="number" value={edit.offset_minutes} onChange={(e) => setEdit({ ...edit, offset_minutes: e.target.value })} /></Field>
          <div className="sm:col-span-2"><span className="label">Notify</span><Chips multi value={edit.notify_roles} onChange={(v) => setEdit({ ...edit, notify_roles: v })} options={['assignee', 'assigner', 'team_leader', 'hod', 'project_manager', 'director', 'admin'].map((r) => ({ value: r, label: humanize(r) }))} /></div>
          <div className="sm:col-span-2"><span className="label">Channels</span><Chips multi value={edit.channels} onChange={(v) => setEdit({ ...edit, channels: v })} options={CHANNEL_OPTS} /></div>
          <div className="sm:col-span-2"><span className="label">Priorities (none = all)</span><Chips multi value={edit.priority_filter} onChange={(v) => setEdit({ ...edit, priority_filter: v })} options={['low', 'medium', 'high', 'critical'].map((p) => ({ value: p, label: p }))} /></div>
          <Field label="Department (optional)"><Select value={edit.department_id} onChange={(v) => setEdit({ ...edit, department_id: v })} placeholder="All" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} /></Field>
          <Field label="Task type (optional)"><input className="input" value={edit.task_type} onChange={(e) => setEdit({ ...edit, task_type: e.target.value })} /></Field>
          <Field label="Message template (optional)" className="sm:col-span-2" hint="{{task.task_key}}, {{task.title}}, {{when}}, {{level}}"><input className="input" value={edit.message_template ?? ''} onChange={(e) => setEdit({ ...edit, message_template: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Active</label>
        </div>}
      </Modal>
    </Card>
  );
}
const fmtMin = (m: number) => (m % 1440 === 0 ? `${m / 1440} day(s)` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);
