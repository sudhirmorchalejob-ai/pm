import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fromNow, humanize, money } from '../lib/format';
import { useAction, useApi, useLiveRefresh } from '../lib/hooks';
import { Due } from '../components/TaskBits';
import { Card, confirm, DataTable, Empty, Loading, PageHeader, Pagination, PriorityBadge, StatusBadge, Tabs } from '../components/ui';

export default function Approvals() {
  const { can } = useAuth();
  const [tab, setTab] = useState('pending');
  const { data, isLoading } = useApi<any>(['approvals'], '/approvals/pending');
  useLiveRefresh([['approvals']]);
  const inv = [['approvals'], ['approvals-count'], ['dashboard']];
  const decideExt = useAction(({ a, decision, comments }: any) => api(`/tasks/${a.task_id}/extension/${a.id}/decide`, { body: { decision, comments } }), { invalidate: inv, success: 'Decision recorded' });
  const decideReq = useAction(({ a, decision, comments }: any) => api(`/approvals/requests/${a.id}/decide`, { body: { decision, comments } }), { invalidate: inv, success: 'Decision recorded' });
  const withdraw = useAction((a: any) => api(`/approvals/requests/${a.id}/withdraw`, { method: 'POST' }), { invalidate: inv, success: 'Withdrawn' });
  const reject = async (fn: any, a: any) => { const c = await confirm({ title: 'Reject request', danger: true, confirmLabel: 'Reject', input: { label: 'Reason', required: true } }); if (c) fn.mutate({ a, decision: 'rejected', comments: c }); };
  return (
    <div>
      <PageHeader title="Approvals" subtitle="Task completions, deadline extensions and project-level changes" />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'pending', label: 'Pending', count: data ? data.completions.length + data.extensions.length + data.requests.length : undefined }, { value: 'history', label: 'History' }]} />
      {tab === 'history' ? <History /> : isLoading ? <Loading /> : (
        <div className="space-y-5">
          {can('tasks.review') && (
            <Card title={`Task completions awaiting review (${data.completions.length})`} pad={false}>
              <div className="px-4 sm:px-0">
                <DataTable rows={data.completions} empty={<Empty title="No submissions waiting" />} columns={[
                  { key: 'task', header: 'Task', render: (a: any) => <Link to={`/tasks/${a.task_id}`} className="font-medium text-brand-600">{a.task_key} {a.title}</Link> },
                  { key: 'requested_by_name', header: 'Submitted by' }, { key: 'project_name', header: 'Project' },
                  { key: 'priority', header: 'Priority', render: (a: any) => <PriorityBadge priority={a.priority} /> },
                  { key: 'requested_at', header: 'Waiting', render: (a: any) => fromNow(a.requested_at) },
                  { key: 'go', header: '', render: (a: any) => <Link className="btn-primary btn-sm" to={`/tasks/${a.task_id}`}>Review</Link> },
                ]} />
              </div>
            </Card>
          )}
          {can('tasks.review') && (
            <Card title={`Deadline extension requests (${data.extensions.length})`} pad={false}>
              <div className="px-4 sm:px-0">
                <DataTable rows={data.extensions} empty={<Empty title="No extension requests" />} columns={[
                  { key: 'task', header: 'Task', render: (a: any) => <Link to={`/tasks/${a.task_id}`} className="font-medium text-brand-600">{a.task_key} {a.title}</Link> },
                  { key: 'requested_by_name', header: 'Requested by' },
                  { key: 'dates', header: 'Deadline', render: (a: any) => <span className="text-xs">{fmtDateTime(a.previous_deadline)} → <b>{fmtDateTime(a.requested_deadline)}</b></span> },
                  { key: 'request_note', header: 'Reason', render: (a: any) => <span className="text-sm">{a.request_note}</span> },
                  { key: 'act', header: '', render: (a: any) => <div className="flex gap-1"><button className="btn-success btn-sm" onClick={() => decideExt.mutate({ a, decision: 'approved' })}><Check className="h-4 w-4" /></button><button className="btn-danger btn-sm" onClick={() => reject(decideExt, a)}><X className="h-4 w-4" /></button></div> },
                ]} />
              </div>
            </Card>
          )}
          <Card title={can('approvals.decide') ? `Project approvals (${data.requests.length})` : 'My pending project requests'} pad={false}>
            <div className="px-4 sm:px-0">
              <DataTable rows={data.requests} empty={<Empty title="No project-level requests" />} columns={[
                { key: 'type', header: 'Type', render: (a: any) => <span className="badge bg-slate-100 dark:bg-slate-800">{humanize(a.approval_type)}</span> },
                { key: 'title', header: 'Request', render: (a: any) => <div className="max-w-md"><p className="font-medium">{a.title}</p>{a.details && <p className="muted text-xs">{a.details}</p>}{a.payload?.estimated_budget != null && <p className="text-xs">New budget: <b>{money(a.payload.estimated_budget)}</b></p>}</div> },
                { key: 'project', header: 'Project', render: (a: any) => a.project_id ? <Link className="text-brand-600" to={`/projects/${a.project_id}`}>{a.project_code}</Link> : '—' },
                { key: 'requested_by_name', header: 'Requested by', render: (a: any) => a.requested_by_name ?? 'You' },
                { key: 'requested_at', header: 'When', render: (a: any) => fromNow(a.requested_at) },
                { key: 'act', header: '', render: (a: any) => can('approvals.decide')
                  ? <div className="flex gap-1"><button className="btn-success btn-sm" onClick={() => decideReq.mutate({ a, decision: 'approved' })}><Check className="h-4 w-4" /> Approve</button><button className="btn-danger btn-sm" onClick={() => reject(decideReq, a)}><X className="h-4 w-4" /></button></div>
                  : <button className="btn-secondary btn-sm" onClick={() => withdraw.mutate(a)}>Withdraw</button> },
              ]} />
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function History() {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useApi<any>(['approvals', 'history', page], '/approvals/history', { page });
  if (isLoading) return <Loading />;
  return (
    <Card pad={false}><div className="px-4 sm:px-0">
      <DataTable rows={data.items.map((r: any, i: number) => ({ ...r, id: `${r.kind}${r.id}${i}` }))} empty={<Empty />} columns={[
        { key: 'kind', header: 'Type', render: (r: any) => humanize(r.kind) },
        { key: 'title', header: 'Item', render: (r: any) => <Link className="text-brand-600" to={r.link}>{r.title}</Link> },
        { key: 'decision', header: 'Decision', render: (r: any) => <StatusBadge status={r.decision} /> },
        { key: 'reviewer_name', header: 'Reviewer' }, { key: 'requested_by_name', header: 'Requested by' },
        { key: 'comments', header: 'Comments', render: (r: any) => <span className="text-xs">{r.comments ?? '—'}</span> },
        { key: 'decided_at', header: 'Decided', render: (r: any) => fmtDateTime(r.decided_at) },
      ]} />
      <div className="pb-4"><Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></div>
    </div></Card>
  );
}
export { Due };
