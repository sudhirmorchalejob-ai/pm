import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Clock } from 'lucide-react';
import { dueLabel } from '../lib/format';
import { PriorityBadge, StatusBadge } from './ui';

export const TASK_STATUSES = ['not_started', 'in_progress', 'on_hold', 'blocked', 'submitted', 'under_review', 'revision_required', 'completed', 'cancelled'];
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];

export function Due({ deadline, done }: { deadline?: string | null; done?: boolean }) {
  const d = dueLabel(deadline, done);
  return (
    <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap text-xs', d.tone === 'danger' && 'font-medium text-rose-600 dark:text-rose-400', d.tone === 'warn' && 'text-amber-700 dark:text-amber-400', (d.tone === 'muted' || d.tone === 'normal') && 'text-slate-500')}>
      <Clock className="h-3 w-3" />{d.text}
    </span>
  );
}

/** Compact, touch-friendly task list used on dashboards and monitoring screens. */
export function TaskList({ tasks, empty = 'No tasks', showAssignees = false }: { tasks: any[]; empty?: string; showAssignees?: boolean }) {
  if (!tasks?.length) return <p className="muted py-6 text-center text-sm">{empty}</p>;
  return (
    <ul className="-mx-2 divide-y">
      {tasks.map((t) => (
        <li key={t.id}>
          <Link to={`/tasks/${t.id}`} className="flex flex-col gap-1 rounded-lg px-2 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/60 sm:flex-row sm:items-center sm:gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium"><span className="muted mr-1.5 text-xs font-normal">{t.task_key}</span>{t.title}</p>
              <p className="muted truncate text-xs">{[t.project_name, showAssignees && t.assignee_names, t.blocker_note].filter(Boolean).join(' · ')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <PriorityBadge priority={t.priority} />
              <StatusBadge status={t.status} />
              <Due deadline={t.deadline} done={['completed', 'cancelled'].includes(t.status)} />
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
