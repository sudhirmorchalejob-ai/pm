import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { BellPlus, BellRing, CheckCheck, Pause, Play, RefreshCw, Send, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fromNow, humanize } from '../../lib/format';
import { useAction, useApi } from '../../lib/hooks';
import { enableBrowserPush, pushSupported } from '../../lib/push';
import { Card, Chips, confirm, DataTable, Empty, ErrorState, Field, KV, Loading, Modal, PageHeader, Pagination, Select, StatusBadge, Tabs } from '../../components/ui';
import { toast } from '../../components/Toast';
import { CHANNEL_OPTS, ReminderForm } from './ReminderForm';

export default function NotificationsPage() {
  const [sp, setSp] = useSearchParams();
  const { can } = useAuth();
  const tab = sp.get('tab') ?? (can('notifications.schedule') ? 'reminders' : 'inbox');
  const setTab = (t: string) => setSp({ tab: t }, { replace: true });
  const [creating, setCreating] = useState(false);
  return (
    <div>
      <PageHeader title="Notifications & reminders" subtitle="Server-side scheduler · delivered even when you are offline"
        actions={can('notifications.schedule') && <button className="btn-primary" onClick={() => setCreating(true)}><BellPlus className="h-4 w-4" /> New reminder</button>} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'inbox', label: 'Inbox' },
        ...(can('notifications.schedule') ? [{ value: 'reminders', label: 'Reminders' }] : []),
        { value: 'logs', label: 'Delivery log' },
        { value: 'escalations', label: 'Escalations' },
        { value: 'preferences', label: 'Preferences' },
      ]} />
      {tab === 'inbox' && <Inbox />}
      {tab === 'reminders' && <Reminders openId={sp.get('schedule')} />}
      {tab === 'logs' && <Logs />}
      {tab === 'escalations' && <Escalations />}
      {tab === 'preferences' && <Preferences />}
      <ReminderForm open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function Inbox() {
  const nav = useNavigate();
  const [unread, setUnread] = useState(false);
  const [page, setPage] = useState(1);
  const { data, isLoading } = useApi<any>(['inbox'], '/notifications/inbox', { page, unread: unread ? 'true' : undefined });
  const inv = [['inbox'], ['unread'], ['inbox-mini']];
  const readAll = useAction(() => api('/notifications/inbox/read-all', { method: 'POST' }), { invalidate: inv, success: 'All marked as read' });
  const read = useAction((n: any) => api(`/notifications/inbox/${n.id}/read`, { method: 'POST' }), { invalidate: inv, onSuccess: () => undefined });
  return (
    <Card actions={<><button className={clsx('chip', unread ? 'chip-on' : 'chip-off')} onClick={() => setUnread(!unread)}>Unread only</button><button className="btn-ghost btn-sm" onClick={() => readAll.mutate(undefined)}><CheckCheck className="h-4 w-4" /> Mark all read</button></>} title="Notification center">
      {isLoading ? <Loading /> : (
        <>
          <ul className="-mx-2 divide-y">
            {data.items.map((n: any) => (
              <li key={n.id}>
                <button className={clsx('flex w-full gap-3 rounded-lg px-2 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60', !n.read_at && 'bg-brand-50/50 dark:bg-brand-900/10')}
                  onClick={() => { if (!n.read_at) read.mutate(n); if (n.link) nav(n.link); }}>
                  <span className={clsx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', n.read_at ? 'bg-slate-300 dark:bg-slate-700' : n.category === 'escalation' ? 'bg-rose-500' : 'bg-brand-500')} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{n.title}</span><span className="badge bg-slate-100 dark:bg-slate-800">{humanize(n.category)}</span></span>
                    <span className="muted mt-0.5 block whitespace-pre-line text-sm">{n.body}</span>
                    <span className="muted text-xs">{fmtDateTime(n.created_at)} · {fromNow(n.created_at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!data.items.length && <Empty title="No notifications" />}
          <Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

function Reminders({ openId }: { openId: string | null }) {
  const { can } = useAuth();
  const [status, setStatus] = useState('active,paused');
  const [all, setAll] = useState(false);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<any>(null);
  const [detail, setDetail] = useState<number | null>(openId ? Number(openId) : null);
  const { data, isLoading, error } = useApi<any>(['schedules'], '/notifications/schedules', { status, page, all: all ? 'true' : undefined });
  const inv = [['schedules'], ['schedule']];
  const pause = useAction((id: number) => api(`/notifications/schedules/${id}/pause`, { method: 'POST' }), { invalidate: inv, success: 'Paused' });
  const resume = useAction((id: number) => api(`/notifications/schedules/${id}/resume`, { method: 'POST' }), { invalidate: inv, success: 'Resumed' });
  const cancel = useAction((id: number) => api(`/notifications/schedules/${id}/cancel`, { body: { reason: 'Cancelled by user' } }), { invalidate: inv, success: 'Cancelled' });
  const test = useAction((id: number) => api(`/notifications/schedules/${id}/test`, { method: 'POST' }), { invalidate: inv, success: 'Test notification sent' });
  if (error) return <ErrorState error={error} />;
  const actions = (s: any) => (
    <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
      {s.status === 'active' && <button className="btn-ghost btn-sm" title="Pause" onClick={() => pause.mutate(s.id)}><Pause className="h-4 w-4" /></button>}
      {s.status === 'paused' && <button className="btn-ghost btn-sm" title="Resume" onClick={() => resume.mutate(s.id)}><Play className="h-4 w-4" /></button>}
      {['active', 'paused'].includes(s.status) && <button className="btn-ghost btn-sm" title="Send a test now" onClick={() => test.mutate(s.id)}><Send className="h-4 w-4" /></button>}
      {['active', 'paused'].includes(s.status) && <button className="btn-ghost btn-sm text-rose-600" title="Cancel" onClick={async () => { if (await confirm({ title: 'Cancel this reminder?', danger: true, confirmLabel: 'Cancel reminder' })) cancel.mutate(s.id); }}><Trash2 className="h-4 w-4" /></button>}
    </div>
  );
  const when = (s: any) => s.schedule_type === 'recurring' ? s.recurrence_text : s.schedule_type === 'deadline_offset' ? `${s.offset_minutes} min before ${s.task_key ?? 'task'} deadline` : `Once (${s.timezone})`;
  return (
    <>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Chips value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={[{ value: 'active,paused', label: 'Active' }, { value: 'completed', label: 'Completed' }, { value: 'cancelled', label: 'Cancelled' }, { value: '', label: 'All' }]} />
        {can('notifications.logs.view_all') && <button className={clsx('chip sm:ml-auto', all ? 'chip-on' : 'chip-off')} onClick={() => setAll(!all)}>Everyone’s reminders</button>}
      </div>
      <Card pad={false}>
        {isLoading ? <Loading /> : (
          <div className="px-4 sm:px-0">
            <DataTable rows={data.items} onRowClick={(s: any) => setDetail(s.id)} empty={<Empty icon={BellRing} title="No reminders" hint="Create a reminder at any date, time and timezone — one-off, recurring or relative to a task deadline." />}
              columns={[
                { key: 'title', header: 'Reminder', render: (s: any) => <div><p className="font-medium">{s.title}</p><p className="muted text-xs">{when(s)}</p></div> },
                { key: 'next', header: 'Next run', render: (s: any) => s.next_run_at ? <span className="text-sm">{fmtDateTime(s.next_run_at)}<span className="muted block text-xs">{fromNow(s.next_run_at)}</span></span> : '—' },
                { key: 'recipients', header: 'Recipients', render: (s: any) => <span className="text-xs">{s.recipients.map((r: any) => r.name).join(', ')}</span> },
                { key: 'channels', header: 'Channels', render: (s: any) => <span className="text-xs">{s.channels.map(humanize).join(', ')}</span> },
                { key: 'status', header: 'Status', render: (s: any) => <StatusBadge status={s.status} /> },
                { key: 'runs', header: 'Sent', render: (s: any) => s.run_count },
                { key: 'actions', header: '', render: actions },
              ]}
              card={(s: any) => (
                <div className="space-y-1">
                  <div className="flex items-start justify-between gap-2"><p className="font-medium">{s.title}</p><StatusBadge status={s.status} /></div>
                  <p className="muted text-xs">{when(s)}</p>
                  {s.next_run_at && <p className="text-xs">Next: <b>{fmtDateTime(s.next_run_at)}</b> ({fromNow(s.next_run_at)})</p>}
                  <div className="flex items-center justify-between"><span className="muted text-xs">{s.channels.map(humanize).join(', ')}</span>{actions(s)}</div>
                </div>
              )} />
            <div className="pb-4"><Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></div>
          </div>
        )}
      </Card>
      <ScheduleDetail id={detail} onClose={() => setDetail(null)} onEdit={(s) => { setDetail(null); setEditing(s); }} />
      <ReminderForm open={!!editing} schedule={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function ScheduleDetail({ id, onClose, onEdit }: { id: number | null; onClose: () => void; onEdit: (s: any) => void }) {
  const { data: s, isLoading } = useApi<any>(['schedule', id], id ? `/notifications/schedules/${id}` : null);
  return (
    <Modal open={!!id} onClose={onClose} title={s?.title ?? 'Reminder'} size="lg"
      footer={s && ['active', 'paused'].includes(s.status) && <button className="btn-primary" onClick={() => onEdit(s)}>Edit / reschedule</button>}>
      {isLoading || !s ? <Loading /> : (
        <div className="space-y-5">
          <KV items={[
            ['Status', <StatusBadge status={s.status} />], ['Type', humanize(s.schedule_type)], ['Schedule', s.recurrence_text ?? (s.schedule_type === 'deadline_offset' ? `${s.offset_minutes} min before deadline` : fmtDateTime(s.run_at))],
            ['Timezone', s.timezone], ['Next run', fmtDateTime(s.next_run_at)], ['Last run', fmtDateTime(s.last_run_at)], ['Times sent', s.run_count],
            ['Channels', s.channels.map(humanize).join(', ')], ['Recipients', s.recipients.map((r: any) => r.name).join(', ')], ['Created by', s.created_by_name],
            ['Task', s.task_id ? <Link className="text-brand-600" to={`/tasks/${s.task_id}`}>{s.task_key} {s.task_title}</Link> : '—'], ['Project', s.project_name],
          ]} />
          {s.message && <p className="rounded-lg bg-slate-100 p-3 text-sm dark:bg-slate-800">{s.message}</p>}
          {s.upcoming?.length > 0 && <div><p className="section-title mb-1">Upcoming occurrences (your local time)</p><ul className="grid gap-1 text-sm sm:grid-cols-2">{s.upcoming.map((u: string) => <li key={u}>• {fmtDateTime(u)}</li>)}</ul></div>}
          <div>
            <p className="section-title mb-1">Delivery log</p>
            {s.logs.length ? (
              <div className="overflow-x-auto"><table className="table"><thead><tr><th>Occurrence</th><th>Recipient</th><th>Channel</th><th>Status</th><th>Attempts</th><th>Detail</th></tr></thead>
                <tbody>{s.logs.map((l: any) => <tr key={l.id}><td className="whitespace-nowrap">{fmtDateTime(l.occurrence_at)}</td><td>{l.user_name}</td><td>{humanize(l.channel)}</td><td><StatusBadge status={l.status} /></td><td>{l.attempts}</td><td className="muted text-xs">{l.last_error ?? (l.read_at ? `read ${fromNow(l.read_at)}` : '')}</td></tr>)}</tbody></table></div>
            ) : <p className="muted text-sm">Nothing sent yet.</p>}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Logs() {
  const { can } = useAuth();
  const [f, setF] = useState({ status: '', channel: '', category: '' });
  const [page, setPage] = useState(1);
  const { data, isLoading } = useApi<any>(['logs'], '/notifications/logs', { ...f, page, pageSize: 30 });
  const retry = useAction((id: number) => api(`/notifications/logs/${id}/retry`, { method: 'POST' }), { invalidate: [['logs']], success: 'Retry queued' });
  const statuses = ['scheduled', 'sent', 'delivered', 'read', 'failed', 'retried', 'skipped', 'cancelled'];
  return (
    <Card pad={false}>
      <div className="flex flex-col gap-3 border-b p-4">
        <div className="flex flex-wrap gap-2">
          {statuses.map((s) => (
            <button key={s} className={clsx('chip', f.status === s ? 'chip-on' : 'chip-off')} onClick={() => { setF({ ...f, status: f.status === s ? '' : s }); setPage(1); }}>
              {humanize(s)} <span className="opacity-70">{data?.stats?.[s] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:w-1/2">
          <Select value={f.channel} onChange={(v) => setF({ ...f, channel: v })} placeholder="All channels" options={CHANNEL_OPTS} />
          <Select value={f.category} onChange={(v) => setF({ ...f, category: v })} placeholder="All categories" options={['reminder', 'event', 'escalation', 'system'].map((c) => ({ value: c, label: humanize(c) }))} />
        </div>
      </div>
      {isLoading ? <Loading /> : (
        <div className="px-4 sm:px-0">
          <DataTable rows={data.items}
            columns={[
              { key: 'title', header: 'Notification', render: (l: any) => <div className="max-w-xs"><p className="truncate font-medium">{l.title}</p><p className="muted text-xs">{humanize(l.category)}{l.schedule_title ? ` · ${l.schedule_title}` : ''}</p></div> },
              { key: 'user_name', header: 'Recipient' },
              { key: 'channel', header: 'Channel', render: (l: any) => humanize(l.channel) },
              { key: 'status', header: 'Status', render: (l: any) => <StatusBadge status={l.status} /> },
              { key: 'occurrence_at', header: 'Scheduled for', render: (l: any) => <span className="whitespace-nowrap text-xs">{fmtDateTime(l.occurrence_at)}</span> },
              { key: 'sent', header: 'Sent / delivered / read', render: (l: any) => <span className="text-xs">{[l.sent_at && `S ${fmtDateTime(l.sent_at)}`, l.delivered_at && `D ${fmtDateTime(l.delivered_at)}`, l.read_at && `R ${fmtDateTime(l.read_at)}`].filter(Boolean).join(' · ') || '—'}</span> },
              { key: 'attempts', header: 'Tries' },
              { key: 'err', header: 'Detail', render: (l: any) => <span className="muted block max-w-[220px] truncate text-xs" title={l.last_error ?? ''}>{l.last_error}</span> },
              { key: 'a', header: '', render: (l: any) => l.status === 'failed' && can('notifications.logs.view_all') ? <button className="btn-ghost btn-sm" onClick={() => retry.mutate(l.id)}><RefreshCw className="h-4 w-4" /> Retry</button> : null },
            ]} />
          <div className="pb-4"><Pagination page={page} pageSize={30} total={data.total} onPage={setPage} /></div>
        </div>
      )}
    </Card>
  );
}

function Escalations() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useApi<any>(['escalations'], '/notifications/escalations', { page });
  if (isLoading) return <Loading />;
  return (
    <Card pad={false}>
      <div className="px-4 sm:px-0">
        <DataTable rows={data.items} empty={<Empty title="No escalations" />}
          columns={[
            { key: 'level', header: 'Level', render: (h: any) => <span className={clsx('badge', h.level >= 3 ? 'bg-rose-600 text-white' : h.level === 2 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 dark:bg-slate-800')}>L{h.level}</span> },
            { key: 'task', header: 'Task', render: (h: any) => <Link className="text-brand-600" to={`/tasks/${h.task_id}`}>{h.task_key} {h.title}</Link> },
            { key: 'rule_name', header: 'Rule' },
            { key: 'status', header: 'Task status', render: (h: any) => <StatusBadge status={h.status} /> },
            { key: 'n', header: 'Notified', render: (h: any) => h.notified_user_ids.length },
            { key: 'escalated_at', header: 'When', render: (h: any) => fmtDateTime(h.escalated_at) },
          ]} />
        <div className="pb-4"><Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></div>
      </div>
    </Card>
  );
}

export function Preferences() {
  const { data, isLoading, refetch } = useApi<any>(['prefs'], '/notifications/preferences');
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (data) setF(data); }, [data]);
  const save = useAction(() => api('/notifications/preferences', { method: 'PUT', body: {
    in_app: f.in_app, email: f.email, browser_push: f.browser_push, mobile_push: f.mobile_push, whatsapp: f.whatsapp, whatsapp_number: f.whatsapp_number || null,
    quiet_hours_start: f.quiet_hours_start || null, quiet_hours_end: f.quiet_hours_end || null,
  } }), { invalidate: [['prefs']], success: 'Preferences saved' });
  if (isLoading || !f) return <Loading />;
  const rows: [string, string, string][] = [['in_app', 'In-app', 'Notification center & live toasts'], ['email', 'Email', 'Sent via SMTP'], ['browser_push', 'Browser push', 'Works when the browser is closed (after enabling below)'], ['mobile_push', 'Mobile push', 'Firebase Cloud Messaging (registered mobile devices)'], ['whatsapp', 'WhatsApp', 'Requires your number and server configuration']];
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Delivery channels">
        <ul className="divide-y">
          {rows.map(([k, l, hint]) => (
            <li key={k} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1"><p className="text-sm font-medium">{l} {!data.channels[k]?.configured && <span className="badge ml-1 bg-amber-100 text-amber-800">not configured on server</span>}</p><p className="muted text-xs">{hint}</p></div>
              <input type="checkbox" className="h-5 w-5" checked={!!f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} aria-label={l} />
            </li>
          ))}
        </ul>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="WhatsApp number (with country code)"><input className="input" value={f.whatsapp_number ?? ''} placeholder="+91 98xxxxxxxx" onChange={(e) => setF({ ...f, whatsapp_number: e.target.value })} /></Field>
        </div>
        <button className="btn-primary mt-4" onClick={() => save.mutate(undefined)} disabled={save.isPending}>Save preferences</button>
        <p className="muted mt-2 text-xs">Escalations and system alerts are always recorded in your in-app inbox.</p>
      </Card>
      <Card title="This device">
        <p className="text-sm">Browser push subscriptions: <b>{data.push_subscriptions}</b></p>
        <button className="btn-secondary mt-3" disabled={!pushSupported()} onClick={async () => { try { toast.success(await enableBrowserPush()); refetch(); } catch (e: any) { toast.error(e.message); } }}><BellRing className="h-4 w-4" /> Enable push on this device</button>
        {!pushSupported() && <p className="muted mt-2 text-xs">This browser does not support Web Push (on iPhone, add the app to the Home Screen first).</p>}
        <div className="mt-6"><p className="section-title mb-2">Server channel status</p>
          <ul className="space-y-1 text-sm">{Object.entries(data.channels).map(([k, v]: any) => <li key={k} className="flex gap-2"><span className={v.configured ? 'text-emerald-600' : 'text-amber-600'}>{v.configured ? '●' : '○'}</span><span className="w-28">{humanize(k)}</span><span className="muted text-xs">{v.note}</span></li>)}</ul>
        </div>
      </Card>
    </div>
  );
}
