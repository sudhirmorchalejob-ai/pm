import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtDateTime } from '../lib/format';
import { useApi, useDebounced } from '../lib/hooks';
import { Card, DataTable, Field, Loading, Modal, PageHeader, Pagination, SearchInput, Select, UserPicker } from '../components/ui';

const LINK: Record<string, (id: number) => string> = { task: (id) => `/tasks/${id}`, project: (id) => `/projects/${id}`, user: (id) => `/monitoring/employees/${id}` };

export default function Audit() {
  const [action, setAction] = useState('');
  const da = useDebounced(action);
  const [entity, setEntity] = useState('');
  const [actor, setActor] = useState<number | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<any>(null);
  const { data, isLoading } = useApi<any>(['audit'], '/audit', { action: da, entity_type: entity || undefined, actor_id: actor ?? undefined, from: from || undefined, to: to || undefined, page });
  return (
    <div>
      <PageHeader title="Audit log" subtitle="Append-only record of every significant change (enforced by a database trigger)" />
      <Card className="mb-4"><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <SearchInput value={action} onChange={(v) => { setAction(v); setPage(1); }} placeholder="Action, e.g. deadline" />
        <Select value={entity} onChange={(v) => { setEntity(v); setPage(1); }} placeholder="All entities" options={['task', 'project', 'user', 'department', 'team', 'notification_schedule', 'approval_request', 'daily_report', 'role', 'settings', 'meeting', 'agenda', 'report'].map((e) => ({ value: e, label: e }))} />
        <UserPicker value={actor} onChange={(v) => { setActor(v); setPage(1); }} placeholder="Any actor" />
        <Field label=""><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" /></Field>
        <Field label=""><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" /></Field>
      </div></Card>
      <Card pad={false}>{isLoading ? <Loading /> : <div className="px-4 sm:px-0">
        <DataTable rows={data.items} onRowClick={setOpen} columns={[
          { key: 'created_at', header: 'When', render: (a: any) => <span className="whitespace-nowrap text-xs">{fmtDateTime(a.created_at)}</span> },
          { key: 'actor_name', header: 'Actor', render: (a: any) => a.actor_name ?? <span className="muted">System</span> },
          { key: 'action', header: 'Action', render: (a: any) => <code className="text-xs">{a.action}</code> },
          { key: 'entity', header: 'Entity', render: (a: any) => a.entity_id && LINK[a.entity_type] ? <Link onClick={(e) => e.stopPropagation()} className="text-brand-600" to={LINK[a.entity_type](a.entity_id)}>{a.entity_type} #{a.entity_id}</Link> : `${a.entity_type}${a.entity_id ? ` #${a.entity_id}` : ''}` },
          { key: 'summary', header: 'Summary', render: (a: any) => <span className="line-clamp-1 max-w-sm text-xs">{a.summary}</span> },
          { key: 'ip', header: 'IP', render: (a: any) => <span className="muted text-xs">{a.ip}</span> },
        ]} />
        <div className="pb-4"><Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></div>
      </div>}</Card>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open?.action ?? ''} size="lg">
        {open && <div className="space-y-3 text-sm">
          <p><b>{open.actor_name ?? 'System'}</b> · {fmtDateTime(open.created_at)} · {open.ip ?? ''}</p>
          {open.summary && <p>{open.summary}</p>}
          {open.before && <div><p className="label">Before</p><pre className="overflow-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">{JSON.stringify(open.before, null, 2)}</pre></div>}
          {open.after && <div><p className="label">After</p><pre className="overflow-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">{JSON.stringify(open.after, null, 2)}</pre></div>}
          <p className="muted text-xs">{open.user_agent}</p>
        </div>}
      </Modal>
    </div>
  );
}
