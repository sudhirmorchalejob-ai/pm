import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Edit3, FileUp, Plus, Rocket, Send, Trash2 } from 'lucide-react';
import { api, download } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fromNow, humanize, money } from '../../lib/format';
import { useAction, useApi } from '../../lib/hooks';
import { BarsChart } from '../../components/charts';
import { Gantt } from '../../components/Gantt';
import { TaskList } from '../../components/TaskBits';
import { Avatar, Card, confirm, DataTable, Empty, ErrorState, Field, KV, Loading, Modal, PageHeader, PriorityBadge, Progress, Select, Stat, StatusBadge, Tabs, UserPicker } from '../../components/ui';
import { TaskForm } from '../tasks/TaskForm';
import { ProjectForm } from './ProjectForm';
import { ReadinessPanel } from './FutureProjects';

const STATUSES = ['proposed', 'under_evaluation', 'approved', 'planned', 'ready_to_start', 'in_progress', 'on_hold', 'completed', 'cancelled'];

export default function ProjectDetail() {
  const id = Number(useParams().id);
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'overview';
  const { can } = useAuth();
  const { data: p, isLoading, error, refetch } = useApi<any>(['project', id], `/projects/${id}`);
  const [modal, setModal] = useState<string | null>(null);
  const inv = [['project', id], ['projects']];
  const setStatus = useAction((status: string) => api(`/projects/${id}/status`, { body: { status } }), { invalidate: inv, success: 'Status updated' });
  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  const M = p.can_manage;
  const tabs = [
    { value: 'overview', label: 'Overview' }, { value: 'tasks', label: 'Tasks', count: Object.values(p.task_stats as Record<string, number>).reduce((a, b) => a + b, 0) },
    { value: 'team', label: 'Team', count: p.members.length }, { value: 'timeline', label: 'Timeline' }, { value: 'milestones', label: 'Milestones', count: p.milestones.length },
    { value: 'documents', label: 'Documents' }, { value: 'discussions', label: 'Discussions' }, { value: 'dependencies', label: 'Dependencies', count: p.dependencies.length },
    { value: 'risks', label: 'Risks', count: p.risks.filter((r: any) => r.status !== 'closed').length }, { value: 'resources', label: 'Resources', count: p.resources.length },
    { value: 'activity', label: 'Activity' }, { value: 'report', label: 'Report' },
  ];
  return (
    <div>
      <PageHeader back={p.is_future ? '/future-projects' : '/projects'}
        title={<span className="flex flex-wrap items-center gap-2">{p.name}<span className="muted text-base font-normal">{p.code}</span></span>}
        subtitle={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={p.status} /><PriorityBadge priority={p.priority} />{p.is_future && <span className="badge bg-indigo-100 text-indigo-700"><Rocket className="h-3 w-3" /> Future project</span>}</span>}
        actions={<>
          {M && !p.is_future && <Select className="w-auto" value={p.status} onChange={(v) => setStatus.mutate(v)} options={STATUSES.map((s) => ({ value: s, label: humanize(s) }))} aria-label="Project status" />}
          {M && <button className="btn-secondary" onClick={() => setModal('approval')}><Send className="h-4 w-4" /> Request approval</button>}
          {M && <button className="btn-secondary" onClick={() => setModal('edit')}><Edit3 className="h-4 w-4" /> Edit</button>}
          {can('tasks.create') && !p.is_future && <button className="btn-primary" onClick={() => setModal('task')}><Plus className="h-4 w-4" /> Task</button>}
        </>} />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} tabs={tabs} />

      {tab === 'overview' && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-5">
            {p.is_future && <ReadinessPanel project={p} onChanged={refetch} />}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Progress" value={`${p.progress}%`} hint="approved effort" />
              <Stat label="Open tasks" value={['not_started', 'in_progress', 'on_hold', 'blocked', 'revision_required', 'submitted', 'under_review'].reduce((s, k) => s + (p.task_stats[k] ?? 0), 0)} />
              <Stat label="Completed" value={p.task_stats.completed ?? 0} tone="good" />
              <Stat label="Open risks" value={p.risks.filter((r: any) => ['open', 'mitigating'].includes(r.status)).length} tone={p.risks.some((r: any) => r.status === 'open' && ['high', 'critical'].includes(r.impact)) ? 'danger' : 'default'} />
            </div>
            <Card title="About">
              <p className="whitespace-pre-line text-sm">{p.description || <span className="muted">No description</span>}</p>
              {p.business_objective && <p className="mt-3 text-sm"><b>Business objective:</b> {p.business_objective}</p>}
              <div className="mt-4"><Progress value={p.progress} /></div>
            </Card>
            <Card title="Upcoming milestones"><MilestoneList p={p} compact /></Card>
          </div>
          <Card title="Details">
            <KV items={[
              ['Project manager', p.manager_name], ['HOD', p.hod_name], ['Department', p.department_name], ['Client', p.client_name],
              ['Client contact', [p.client_contact, p.client_email].filter(Boolean).join(' · ') || '—'], ['Start', fmtDate(p.start_date)], ['End', fmtDate(p.end_date)],
              ['Estimated budget', money(p.estimated_budget)], ['Created by', p.created_by_name], ['Created', fmtDate(p.created_at)],
            ]} />
          </Card>
        </div>
      )}
      {tab === 'tasks' && <ProjectTasks p={p} />}
      {tab === 'team' && <Team p={p} />}
      {tab === 'timeline' && <Timeline p={p} />}
      {tab === 'milestones' && <Card title="Milestones & deliverables"><MilestoneList p={p} /><Deliverables p={p} /></Card>}
      {tab === 'documents' && <Documents p={p} />}
      {tab === 'discussions' && <Discussions p={p} />}
      {tab === 'dependencies' && <Dependencies p={p} />}
      {tab === 'risks' && <Risks p={p} />}
      {tab === 'resources' && <Resources p={p} />}
      {tab === 'activity' && <Activity id={id} />}
      {tab === 'report' && <ProjectReport id={id} />}

      <ProjectForm open={modal === 'edit'} onClose={() => setModal(null)} project={p} future={p.is_future} />
      <TaskForm open={modal === 'task'} onClose={() => setModal(null)} defaults={{ project_id: p.id }} />
      <ApprovalRequest open={modal === 'approval'} onClose={() => setModal(null)} p={p} />
    </div>
  );
}

function useSub(p: any, path: string) {
  const inv = [['project', p.id]];
  return {
    add: useAction((body: any) => api(`/projects/${p.id}/${path}`, { body }), { invalidate: inv, success: 'Added' }),
    update: useAction(({ id, ...body }: any) => api(`/projects/${p.id}/${path}/${id}`, { method: 'PATCH', body }), { invalidate: inv, success: 'Saved' }),
    remove: useAction((id: number) => api(`/projects/${p.id}/${path}/${id}`, { method: 'DELETE' }), { invalidate: inv, success: 'Removed' }),
  };
}

function MilestoneList({ p, compact }: { p: any; compact?: boolean }) {
  const s = useSub(p, 'milestones');
  const [f, setF] = useState({ title: '', due_date: '' });
  const items = compact ? p.milestones.filter((m: any) => m.status !== 'completed').slice(0, 5) : p.milestones;
  return (
    <div>
      <ul className="divide-y">
        {items.map((m: any) => (
          <li key={m.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
            <span className="text-violet-500">◆</span><span className="min-w-0 flex-1 font-medium">{m.title}<span className="muted block text-xs font-normal">{m.done_count}/{m.task_count} tasks done</span></span>
            <span className="muted text-xs">{fmtDate(m.due_date)}</span>
            {!compact && p.can_manage ? (
              <Select className="w-auto min-h-[32px] py-1 text-xs" value={m.status} onChange={(v) => s.update.mutate({ id: m.id, status: v })} options={['pending', 'in_progress', 'awaiting_approval', 'completed', 'missed'].map((x) => ({ value: x, label: humanize(x) }))} />
            ) : <StatusBadge status={m.status} />}
            {!compact && p.can_manage && <button onClick={async () => (await confirm({ title: 'Remove milestone?', danger: true })) && s.remove.mutate(m.id)} aria-label="Remove"><Trash2 className="h-4 w-4 text-slate-400" /></button>}
          </li>
        ))}
        {!items.length && <Empty title="No milestones" />}
      </ul>
      {!compact && p.can_manage && (
        <form className="mt-3 grid gap-2 sm:grid-cols-[1fr_170px_auto]" onSubmit={(e) => { e.preventDefault(); s.add.mutate(f, { onSuccess: () => setF({ title: '', due_date: '' }) }); }}>
          <input className="input" placeholder="Milestone title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
          <input className="input" type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} required />
          <button className="btn-secondary">Add milestone</button>
        </form>
      )}
      {!compact && p.can_manage && <p className="muted mt-2 text-xs">Marking a milestone “completed” creates an approval request unless you are an approver.</p>}
    </div>
  );
}

function Deliverables({ p }: { p: any }) {
  const s = useSub(p, 'deliverables');
  const [f, setF] = useState({ title: '', due_date: '' });
  return (
    <div className="mt-6">
      <h3 className="section-title mb-2">Deliverables</h3>
      <ul className="divide-y">
        {p.deliverables.map((d: any) => (
          <li key={d.id} className="flex flex-wrap items-center gap-2 py-2 text-sm"><span className="flex-1">📦 {d.title}</span><span className="muted text-xs">{fmtDate(d.due_date)}</span>
            {p.can_manage ? <Select className="w-auto min-h-[32px] py-1 text-xs" value={d.status} onChange={(v) => s.update.mutate({ id: d.id, status: v })} options={['pending', 'in_progress', 'delivered', 'accepted'].map((x) => ({ value: x, label: humanize(x) }))} /> : <StatusBadge status={d.status} />}
          </li>
        ))}
        {!p.deliverables.length && <li className="muted py-2 text-sm">No deliverables</li>}
      </ul>
      {p.can_manage && <form className="mt-3 grid gap-2 sm:grid-cols-[1fr_170px_auto]" onSubmit={(e) => { e.preventDefault(); s.add.mutate({ title: f.title, due_date: f.due_date || null }, { onSuccess: () => setF({ title: '', due_date: '' }) }); }}>
        <input className="input" placeholder="Deliverable" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
        <input className="input" type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} />
        <button className="btn-secondary">Add</button>
      </form>}
    </div>
  );
}

function ProjectTasks({ p }: { p: any }) {
  const [status, setStatus] = useState('');
  const { data, isLoading } = useApi<any>(['tasks', 'project', p.id], '/tasks', { project_id: p.id, pageSize: 200, status: status || undefined });
  return (
    <Card actions={<Link className="text-xs font-medium text-brand-600" to={`/tasks?project_id=${p.id}`}>Open in task board</Link>}
      title={<Select className="w-auto min-h-[32px] py-1" value={status} onChange={setStatus} placeholder="All statuses" options={['not_started', 'in_progress', 'blocked', 'submitted', 'revision_required', 'completed'].map((s) => ({ value: s, label: humanize(s) }))} />}>
      {isLoading ? <Loading /> : <TaskList tasks={data.items.map((t: any) => ({ ...t, assignee_names: t.assignees.map((a: any) => a.name).join(', ') }))} showAssignees />}
    </Card>
  );
}

function Team({ p }: { p: any }) {
  const [ids, setIds] = useState<number[]>([]);
  const [alloc, setAlloc] = useState(100);
  const inv = [['project', p.id]];
  const add = useAction(() => api(`/projects/${p.id}/members`, { body: { members: ids.map((user_id) => ({ user_id, allocation_percent: alloc })) } }), { invalidate: inv, success: 'Members added', onSuccess: () => setIds([]) });
  const remove = useAction((uid: number) => api(`/projects/${p.id}/members/${uid}`, { method: 'DELETE' }), { invalidate: inv, success: 'Removed' });
  return (
    <Card title="Team">
      {p.can_manage && (
        <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_120px_auto]">
          <UserPicker multi value={ids} onChange={setIds} exclude={p.members.map((m: any) => m.user_id)} placeholder="Add people…" />
          <input className="input" type="number" min={0} max={100} value={alloc} onChange={(e) => setAlloc(Number(e.target.value))} aria-label="Allocation %" />
          <button className="btn-secondary" disabled={!ids.length} onClick={() => add.mutate(undefined)}>Add</button>
        </div>
      )}
      <DataTable rows={p.members.map((m: any) => ({ ...m, id: m.user_id }))}
        columns={[
          { key: 'name', header: 'Member', render: (m: any) => <span className="flex items-center gap-2"><Avatar name={m.name} size="sm" /><span><span className="block font-medium">{m.name}</span><span className="muted text-xs">{m.designation}</span></span></span> },
          { key: 'department_name', header: 'Department' }, { key: 'role_in_project', header: 'Role', render: (m: any) => humanize(m.role_in_project) },
          { key: 'allocation_percent', header: 'Allocation', render: (m: any) => `${m.allocation_percent}%` }, { key: 'open_tasks', header: 'Open tasks' },
          { key: 'x', header: '', render: (m: any) => p.can_manage && m.user_id !== p.manager_id ? <button onClick={() => remove.mutate(m.user_id)} aria-label="Remove member"><Trash2 className="h-4 w-4 text-slate-400" /></button> : null },
        ]} />
    </Card>
  );
}

function Timeline({ p }: { p: any }) {
  const { data, isLoading } = useApi<any>(['gantt', p.id], '/gantt', { project_id: p.id });
  return <Card title="Gantt timeline">{isLoading ? <Loading /> : <Gantt items={data.items} dependencies={data.dependencies} milestones={data.milestones} />}</Card>;
}

function Documents({ p }: { p: any }) {
  const { data = [], isLoading } = useApi<any[]>(['docs', p.id], `/projects/${p.id}/documents`);
  const [category, setCategory] = useState('general');
  const up = useAction((files: FileList) => { const fd = new FormData(); [...files].forEach((f) => fd.append('files', f)); fd.append('category', category); return api(`/projects/${p.id}/documents`, { form: fd }); }, { invalidate: [['docs', p.id]], success: 'Uploaded' });
  return (
    <Card title="Project documentation">
      <div className="mb-4 flex flex-col gap-2 rounded-lg border border-dashed p-3 sm:flex-row sm:items-center">
        <Select className="sm:w-48" value={category} onChange={setCategory} options={['general', 'requirements', 'design', 'contract', 'meeting_minutes', 'report'].map((c) => ({ value: c, label: humanize(c) }))} />
        <label className="btn-secondary cursor-pointer"><FileUp className="h-4 w-4" /> Upload<input type="file" multiple className="hidden" onChange={(e) => e.target.files?.length && up.mutate(e.target.files)} /></label>
      </div>
      {isLoading ? <Loading /> : (
        <ul className="divide-y">{data.map((d) => <li key={d.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm"><button className="min-w-0 flex-1 truncate text-left text-brand-600" onClick={() => download(`/files/${d.file_id}/download`)}>{d.title}</button><span className="badge bg-slate-100 dark:bg-slate-800">{humanize(d.category)}</span><span className="muted text-xs">{d.uploaded_by_name} · {fromNow(d.created_at)}</span></li>)}
          {!data.length && <Empty title="No documents yet" />}</ul>
      )}
    </Card>
  );
}

function Discussions({ p }: { p: any }) {
  const { data = [], isLoading } = useApi<any[]>(['discussions', p.id], `/projects/${p.id}/discussions`);
  const { data: people = [] } = useApi<any[]>(['directory', undefined], '/org/directory', undefined, { staleTime: 60_000 });
  const [body, setBody] = useState('');
  const post = useAction(() => api(`/projects/${p.id}/discussions`, { body: { body, mentions: people.filter((u) => body.includes(`@${u.name}`)).map((u) => u.id) } }), { invalidate: [['discussions', p.id]], onSuccess: () => setBody('') });
  return (
    <Card title="Discussion">
      {isLoading ? <Loading /> : <ul className="space-y-4">{data.map((d) => <li key={d.id} className="flex gap-3"><Avatar name={d.author_name} /><div className="min-w-0"><p className="text-sm"><b>{d.author_name}</b> <span className="muted text-xs">{fromNow(d.created_at)}</span></p><p className="whitespace-pre-line break-words text-sm">{d.body}</p></div></li>)}{!data.length && <Empty title="Start the conversation" hint="Mention people with @Full Name." />}</ul>}
      <form className="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (body.trim()) post.mutate(undefined); }}>
        <textarea className="input" rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Share an update…" /><button className="btn-primary sm:self-end" disabled={!body.trim()}><Send className="h-4 w-4" /> Post</button>
      </form>
    </Card>
  );
}

function Dependencies({ p }: { p: any }) {
  const s = useSub(p, 'dependencies');
  const { data: projects } = useApi<any>(['projects-mini'], '/projects', { pageSize: 200 });
  const [f, setF] = useState({ depends_on_project_id: '', description: '' });
  return (
    <Card title="Dependencies">
      <ul className="divide-y">{p.dependencies.map((d: any) => (
        <li key={d.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
          <span className="min-w-0 flex-1">{d.description}{d.depends_on_project_id && <Link className="block text-xs text-brand-600" to={`/projects/${d.depends_on_project_id}`}>↳ {d.depends_on_code} {d.depends_on_name} ({humanize(d.depends_on_status)})</Link>}</span>
          {p.can_manage ? <Select className="w-auto min-h-[32px] py-1 text-xs" value={d.status} onChange={(v) => s.update.mutate({ id: d.id, status: v })} options={[{ value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }]} /> : <StatusBadge status={d.status} />}
        </li>))}{!p.dependencies.length && <Empty title="No dependencies" />}</ul>
      {p.can_manage && <form className="mt-3 grid gap-2 sm:grid-cols-[220px_1fr_auto]" onSubmit={(e) => { e.preventDefault(); s.add.mutate({ depends_on_project_id: f.depends_on_project_id ? Number(f.depends_on_project_id) : null, description: f.description }, { onSuccess: () => setF({ depends_on_project_id: '', description: '' }) }); }}>
        <Select value={f.depends_on_project_id} onChange={(v) => setF({ ...f, depends_on_project_id: v })} placeholder="External / no project" options={(projects?.items ?? []).filter((x: any) => x.id !== p.id).map((x: any) => ({ value: x.id, label: x.name }))} />
        <input className="input" placeholder="What is needed?" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required />
        <button className="btn-secondary">Add</button>
      </form>}
    </Card>
  );
}

function Risks({ p }: { p: any }) {
  const s = useSub(p, 'risks');
  const [f, setF] = useState<any>({ title: '', probability: 'medium', impact: 'medium', mitigation: '', owner_id: null });
  const tone: Record<string, string> = { low: 'text-slate-500', medium: 'text-amber-600', high: 'text-orange-600', critical: 'text-rose-600' };
  return (
    <Card title="Risk register">
      <DataTable rows={p.risks}
        columns={[
          { key: 'title', header: 'Risk', render: (r: any) => <div className="max-w-sm"><p className="font-medium">{r.title}</p>{r.mitigation && <p className="muted text-xs">Mitigation: {r.mitigation}</p>}</div> },
          { key: 'probability', header: 'Probability', render: (r: any) => <span className={tone[r.probability]}>{humanize(r.probability)}</span> },
          { key: 'impact', header: 'Impact', render: (r: any) => <span className={tone[r.impact]}>{humanize(r.impact)}</span> },
          { key: 'owner_name', header: 'Owner' },
          { key: 'status', header: 'Status', render: (r: any) => p.can_manage ? <Select className="w-auto min-h-[32px] py-1 text-xs" value={r.status} onChange={(v) => s.update.mutate({ id: r.id, status: v })} options={['open', 'mitigating', 'closed', 'occurred'].map((x) => ({ value: x, label: humanize(x) }))} /> : <StatusBadge status={r.status} /> },
        ]} empty={<Empty title="No risks logged" />} />
      {p.can_manage && (
        <form className="mt-4 grid gap-2 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={(e) => { e.preventDefault(); s.add.mutate({ ...f, mitigation: f.mitigation || null }, { onSuccess: () => setF({ title: '', probability: 'medium', impact: 'medium', mitigation: '', owner_id: null }) }); }}>
          <input className="input lg:col-span-2" placeholder="Risk" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
          <Select value={f.probability} onChange={(v) => setF({ ...f, probability: v })} options={['low', 'medium', 'high'].map((x) => ({ value: x, label: `Prob: ${x}` }))} />
          <Select value={f.impact} onChange={(v) => setF({ ...f, impact: v })} options={['low', 'medium', 'high', 'critical'].map((x) => ({ value: x, label: `Impact: ${x}` }))} />
          <UserPicker value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} placeholder="Owner" />
          <input className="input sm:col-span-2 lg:col-span-4" placeholder="Mitigation plan" value={f.mitigation} onChange={(e) => setF({ ...f, mitigation: e.target.value })} />
          <button className="btn-secondary">Add risk</button>
        </form>
      )}
    </Card>
  );
}

function Resources({ p }: { p: any }) {
  const s = useSub(p, 'resources');
  const { data: skills = [] } = useApi<any[]>(['skills'], '/org/skills');
  const [f, setF] = useState<any>({ skill_id: '', user_id: null, required_count: 1, hours_per_week: 40, start_date: '', end_date: '' });
  return (
    <Card title="Resource requirements & allocations">
      <DataTable rows={p.resources}
        columns={[
          { key: 'what', header: 'Resource', render: (r: any) => r.user_name ?? r.skill_name ?? r.department_name ?? '—' },
          { key: 'required_count', header: 'Count' }, { key: 'hours_per_week', header: 'h/week' },
          { key: 'when', header: 'Period', render: (r: any) => `${fmtDate(r.start_date)} → ${fmtDate(r.end_date)}` },
          { key: 'status', header: 'Status', render: (r: any) => p.can_manage ? <Select className="w-auto min-h-[32px] py-1 text-xs" value={r.status} onChange={(v) => s.update.mutate({ id: r.id, status: v })} options={['required', 'requested', 'allocated', 'released'].map((x) => ({ value: x, label: humanize(x) }))} /> : <StatusBadge status={r.status} /> },
        ]} empty={<Empty title="No resource requirements" />} />
      {p.can_manage && (
        <form className="mt-4 grid gap-2 rounded-lg border p-3 sm:grid-cols-3 lg:grid-cols-7" onSubmit={(e) => { e.preventDefault(); s.add.mutate({ skill_id: f.skill_id ? Number(f.skill_id) : null, user_id: f.user_id, required_count: Number(f.required_count), hours_per_week: Number(f.hours_per_week), start_date: f.start_date || null, end_date: f.end_date || null }); }}>
          <Select value={f.skill_id} onChange={(v) => setF({ ...f, skill_id: v })} placeholder="Skill" options={skills.map((x: any) => ({ value: x.id, label: x.name }))} />
          <div className="lg:col-span-2"><UserPicker value={f.user_id} onChange={(v) => setF({ ...f, user_id: v })} placeholder="Specific person (optional)" /></div>
          <input className="input" type="number" min={1} value={f.required_count} onChange={(e) => setF({ ...f, required_count: e.target.value })} aria-label="Count" />
          <input className="input" type="number" min={0} value={f.hours_per_week} onChange={(e) => setF({ ...f, hours_per_week: e.target.value })} aria-label="Hours per week" />
          <input className="input" type="date" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} aria-label="Start" />
          <button className="btn-secondary">Add</button>
        </form>
      )}
    </Card>
  );
}

function Activity({ id }: { id: number }) {
  const { data = [], isLoading } = useApi<any[]>(['activity', id], `/projects/${id}/activity`);
  if (isLoading) return <Loading />;
  return (
    <Card title="Activity history">
      <ol className="relative space-y-3 border-l pl-5">{data.map((a) => (
        <li key={a.id} className="text-sm"><span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-brand-500 dark:border-slate-900" />
          <p><b>{a.actor_name ?? 'System'}</b> <span className="muted">{a.action}</span>{a.entity_type === 'task' && <Link className="ml-1 text-brand-600" to={`/tasks/${a.entity_id}`}>task #{a.entity_id}</Link>}{a.summary && ` — ${a.summary}`}</p>
          <p className="muted text-xs">{fmtDateTime(a.created_at)}</p></li>))}
        {!data.length && <Empty title="No activity yet" />}</ol>
    </Card>
  );
}

function ProjectReport({ id }: { id: number }) {
  const { data, isLoading } = useApi<any>(['project-report', id], `/projects/${id}/report`);
  if (isLoading) return <Loading />;
  const s = data.summary;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Tasks" value={s.total} /><Stat label="Completed" value={s.completed} tone="good" /><Stat label="On time" value={s.completed ? `${Math.round((s.on_time / s.completed) * 100)}%` : '—'} />
        <Stat label="Overdue" value={s.overdue} tone={s.overdue ? 'danger' : 'default'} /><Stat label="Est. hours" value={Math.round(s.estimated_hours)} /><Stat label="Actual hours" value={Math.round(s.actual_hours)} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Department contribution"><BarsChart data={data.by_department} x="department" series={[{ key: 'total', label: 'Tasks' }, { key: 'completed', label: 'Completed' }]} /></Card>
        <Card title="By assignee" pad={false}><DataTable rows={data.by_assignee} columns={[{ key: 'name', header: 'Assignee' }, { key: 'total', header: 'Tasks' }, { key: 'completed', header: 'Completed' }, { key: 'overdue', header: 'Overdue' }]} /></Card>
      </div>
      <Card title="Milestone performance" pad={false}><DataTable rows={data.milestones} columns={[{ key: 'title', header: 'Milestone' }, { key: 'due_date', header: 'Due', render: (m: any) => fmtDate(m.due_date) }, { key: 'status', header: 'Status', render: (m: any) => <StatusBadge status={m.status} /> }, { key: 'completed_at', header: 'Completed', render: (m: any) => fmtDate(m.completed_at) }]} /></Card>
    </div>
  );
}

function ApprovalRequest({ open, onClose, p }: { open: boolean; onClose: () => void; p: any }) {
  const [f, setF] = useState<any>({ approval_type: 'budget_change', title: '', details: '', estimated_budget: p.estimated_budget ?? '', end_date: p.end_date ?? '', description: '' });
  const send = useAction(() => {
    const payload: any = {};
    if (f.approval_type === 'budget_change') payload.estimated_budget = Number(f.estimated_budget);
    if (f.approval_type === 'scope_change') { if (f.description) payload.description = f.description; if (f.end_date) payload.end_date = f.end_date; }
    return api('/approvals/requests', { body: { approval_type: f.approval_type, project_id: p.id, title: f.title, details: f.details || null, payload } });
  }, { invalidate: [['approvals-count']], success: 'Approval requested', onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title="Request approval"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.title || send.isPending} onClick={() => send.mutate(undefined)}>Submit request</button></>}>
      <div className="space-y-4">
        <Field label="Type"><Select value={f.approval_type} onChange={(v) => setF({ ...f, approval_type: v })} options={[{ value: 'budget_change', label: 'Budget change' }, { value: 'scope_change', label: 'Scope change' }, { value: 'project_approval', label: 'Project approval' }, { value: 'resource_allocation', label: 'Resource allocation' }]} /></Field>
        <Field label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        {f.approval_type === 'budget_change' && <Field label={`New budget (current ${money(p.estimated_budget)})`}><input className="input" type="number" min={0} value={f.estimated_budget} onChange={(e) => setF({ ...f, estimated_budget: e.target.value })} /></Field>}
        {f.approval_type === 'scope_change' && <><Field label="New description (optional)"><textarea className="input" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field><Field label="New end date (optional)"><input className="input" type="date" value={f.end_date} onChange={(e) => setF({ ...f, end_date: e.target.value })} /></Field></>}
        <Field label="Justification"><textarea className="input" rows={3} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} /></Field>
        <p className="muted text-xs">On approval the change is applied automatically and recorded in the audit log.</p>
      </div>
    </Modal>
  );
}
