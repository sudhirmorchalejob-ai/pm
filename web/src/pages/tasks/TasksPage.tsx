import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Columns3, List, Plus, Repeat } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { humanize } from '../../lib/format';
import { useAction, useApi, useDebounced, useLiveRefresh, usePref } from '../../lib/hooks';
import { Due, PRIORITIES, TASK_STATUSES } from '../../components/TaskBits';
import { AvatarStack, Card, Chips, DataTable, ErrorState, Loading, PageHeader, Pagination, PriorityBadge, Progress, SearchInput, Select, StatusBadge } from '../../components/ui';
import { toast } from '../../components/Toast';
import { TaskForm } from './TaskForm';

const BOARD_COLS = ['not_started', 'in_progress', 'on_hold', 'blocked', 'submitted', 'under_review', 'revision_required', 'completed'];
const DRAGGABLE_TARGETS = ['not_started', 'in_progress', 'on_hold', 'blocked'];

export default function TasksPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [view, setView] = usePref<'list' | 'board'>('tasks-view', 'list');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('deadline:asc');
  const [creating, setCreating] = useState(false);
  const filters = {
    status: sp.get('status')?.split(',') ?? [],
    priority: sp.get('priority') ?? '',
    project_id: sp.get('project_id') ?? '',
    due: sp.get('due') ?? '',
    mine: sp.get('mine') ?? '',
    templates: sp.get('templates') ?? '',
    archived: sp.get('archived') ?? '',
  };
  const setFilter = (k: string, v: string | string[]) => {
    const n = new URLSearchParams(sp);
    const val = Array.isArray(v) ? v.join(',') : v;
    if (val) n.set(k, val); else n.delete(k);
    setSp(n, { replace: true }); setPage(1);
  };
  const query = { ...filters, q: dq, page: view === 'board' ? 1 : page, pageSize: view === 'board' ? 300 : 25, sort };
  const { data, isLoading, error, refetch } = useApi<any>(['tasks', 'list'], '/tasks', query);
  const { data: projects } = useApi<any>(['projects-mini'], '/projects', { pageSize: 200 });
  useLiveRefresh([['tasks']]);

  const move = useAction(async ({ task, to }: { task: any; to: string }) => {
    if (to === 'submitted') return api(`/tasks/${task.id}/submit`, { body: {} });
    if (!DRAGGABLE_TARGETS.includes(to)) throw new Error('Use the task page for review decisions');
    if (to === 'blocked') {
      const note = window.prompt('Describe the blocker');
      if (!note) throw new Error('Blocker description is required');
      return api(`/tasks/${task.id}/progress`, { body: { status: to, blocker_note: note } });
    }
    return api(`/tasks/${task.id}/progress`, { body: { status: to } });
  }, { invalidate: [['tasks'], ['dashboard']], success: 'Status updated' });

  const grouped = useMemo(() => Object.fromEntries(BOARD_COLS.map((s) => [s, (data?.items ?? []).filter((t: any) => t.status === s)])), [data]);

  return (
    <div>
      <PageHeader title="Tasks" subtitle={data ? `${data.total} task${data.total === 1 ? '' : 's'}` : undefined}
        actions={<>
          <div className="flex rounded-lg border p-0.5" role="group" aria-label="View">
            <button className={clsx('btn-sm btn', view === 'list' ? 'bg-slate-100 dark:bg-slate-800' : '')} onClick={() => setView('list')} aria-pressed={view === 'list'}><List className="h-4 w-4" /> List</button>
            <button className={clsx('btn-sm btn', view === 'board' ? 'bg-slate-100 dark:bg-slate-800' : '')} onClick={() => setView('board')} aria-pressed={view === 'board'}><Columns3 className="h-4 w-4" /> Board</button>
          </div>
          {(can('tasks.create') || can('tasks.update_own')) && <button className="btn-primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New task</button>}
        </>} />

      <Card className="mb-4">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Search title or ID…" />
          <Select value={filters.project_id} onChange={(v) => setFilter('project_id', v)} placeholder="All projects" options={(projects?.items ?? []).map((p: any) => ({ value: p.id, label: p.name }))} />
          <Select value={filters.priority} onChange={(v) => setFilter('priority', v)} placeholder="Any priority" options={PRIORITIES.map((p) => ({ value: p, label: humanize(p) }))} />
          <Select value={filters.due} onChange={(v) => setFilter('due', v)} placeholder="Any deadline" options={[{ value: 'today', label: 'Due today' }, { value: 'overdue', label: 'Overdue' }, { value: 'week', label: 'Next 7 days' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'no_deadline', label: 'No deadline' }]} />
        </div>
        <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1"><Chips multi value={filters.status} onChange={(v: string[]) => setFilter('status', v)} options={TASK_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} /></div>
          <div className="flex flex-wrap gap-1.5">
            <button className={clsx('chip', filters.mine ? 'chip-on' : 'chip-off')} onClick={() => setFilter('mine', filters.mine ? '' : 'true')}>Assigned to me</button>
            <button className={clsx('chip', filters.templates ? 'chip-on' : 'chip-off')} onClick={() => setFilter('templates', filters.templates ? '' : 'true')}><Repeat className="h-3 w-3" /> Recurring</button>
            <button className={clsx('chip', filters.archived ? 'chip-on' : 'chip-off')} onClick={() => setFilter('archived', filters.archived ? '' : 'true')}>Archived</button>
          </div>
        </div>
      </Card>

      {isLoading ? <Loading /> : error ? <ErrorState error={error} onRetry={refetch} /> : view === 'list' ? (
        <Card pad={false}>
          <div className="px-4 sm:px-0">
            <DataTable rows={data.items} sort={sort} onSort={setSort} onRowClick={(t: any) => nav(`/tasks/${t.id}`)}
              columns={[
                { key: 'key', header: 'ID', sortable: true, render: (t: any) => <span className="muted text-xs">{t.task_key}</span> },
                { key: 'title', header: 'Task', sortable: true, render: (t: any) => <div className="min-w-[200px]"><p className="font-medium">{t.title}</p><p className="muted text-xs">{t.project_name ?? t.department_name ?? ''}</p></div> },
                { key: 'assignees', header: 'Assignees', render: (t: any) => <AvatarStack people={t.assignees} /> },
                { key: 'priority', header: 'Priority', sortable: true, render: (t: any) => <PriorityBadge priority={t.priority} /> },
                { key: 'status', header: 'Status', sortable: true, render: (t: any) => <StatusBadge status={t.status} /> },
                { key: 'progress', header: 'Progress', sortable: true, render: (t: any) => <div className="w-24"><Progress value={t.progress} /></div> },
                { key: 'deadline', header: 'Deadline', sortable: true, render: (t: any) => <Due deadline={t.deadline} done={['completed', 'cancelled'].includes(t.status)} /> },
              ]}
              card={(t: any) => (
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2"><p className="font-medium leading-snug">{t.title}</p><PriorityBadge priority={t.priority} /></div>
                  <p className="muted text-xs">{t.task_key}{t.project_name ? ` · ${t.project_name}` : ''}</p>
                  <div className="flex flex-wrap items-center gap-2"><StatusBadge status={t.status} /><Due deadline={t.deadline} done={['completed', 'cancelled'].includes(t.status)} /><span className="ml-auto"><AvatarStack people={t.assignees} /></span></div>
                  <Progress value={t.progress} />
                </div>
              )} />
          </div>
          <div className="px-4 pb-4"><Pagination page={page} pageSize={25} total={data.total} onPage={setPage} /></div>
        </Card>
      ) : (
        <div className="scrollbar-thin -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0">
          {BOARD_COLS.map((s) => (
            <div key={s} className="flex w-[84vw] max-w-[300px] shrink-0 snap-start flex-col rounded-xl bg-slate-100 p-2 dark:bg-slate-900/60 sm:w-72"
              onDragOver={(e) => DRAGGABLE_TARGETS.concat('submitted').includes(s) && e.preventDefault()}
              onDrop={(e) => { const t = (data.items as any[]).find((x) => String(x.id) === e.dataTransfer.getData('text/plain')); if (t && t.status !== s) move.mutate({ task: t, to: s }); }}>
              <div className="flex items-center justify-between px-1.5 pb-2 pt-1"><StatusBadge status={s} /><span className="muted text-xs">{grouped[s].length}</span></div>
              <div className="flex flex-col gap-2">
                {grouped[s].map((t: any) => (
                  <Link key={t.id} to={`/tasks/${t.id}`} draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', String(t.id))}
                    className="card block p-3 transition hover:shadow-md">
                    <div className="flex items-start justify-between gap-2"><p className="text-sm font-medium leading-snug">{t.title}</p><PriorityBadge priority={t.priority} /></div>
                    <p className="muted mt-1 text-xs">{t.task_key}{t.project_name ? ` · ${t.project_name}` : ''}</p>
                    <div className="mt-2 flex items-center justify-between"><Due deadline={t.deadline} done={t.status === 'completed'} /><AvatarStack people={t.assignees} /></div>
                    {t.subtask_count > 0 && <p className="muted mt-1 text-[11px]">Subtasks {t.subtask_done}/{t.subtask_count}</p>}
                  </Link>
                ))}
                {!grouped[s].length && <p className="muted px-2 py-4 text-center text-xs">Empty</p>}
              </div>
            </div>
          ))}
        </div>
      )}
      {view === 'board' && <p className="muted text-xs">Drag your own cards between “Not started / In progress / On hold / Blocked”, or onto “Submitted” to submit for review. Review decisions are made on the task page.</p>}
      <TaskForm open={creating} onClose={() => setCreating(false)} defaults={{ project_id: filters.project_id ? Number(filters.project_id) : undefined }} />
    </div>
  );
}
export { toast };
