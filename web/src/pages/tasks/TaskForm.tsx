import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { browserTz, isoToLocalInput, localInputToIso, todayIso } from '../../lib/format';
import { useAction, useApi } from '../../lib/hooks';
import { Chips, Field, Modal, Select, UserPicker } from '../../components/ui';
import { PRIORITIES } from '../../components/TaskBits';

const REMINDER_PRESETS = [{ value: '30', label: '30 min before' }, { value: '60', label: '1 h before' }, { value: '240', label: '4 h before' }, { value: '1440', label: '1 day before' }];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function TaskForm({ open, onClose, task, defaults }: { open: boolean; onClose: () => void; task?: any; defaults?: { project_id?: number; milestone_id?: number } }) {
  const { user, can } = useAuth();
  const edit = !!task;
  const [f, setF] = useState<any>({});
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const { data: projects } = useApi<any>(['projects-mini'], open ? '/projects' : null, { pageSize: 200, status: 'approved,planned,ready_to_start,in_progress,on_hold,proposed,under_evaluation', future: 'false' });
  const { data: departments = [] } = useApi<any[]>(['departments'], open ? '/org/departments' : null);
  const { data: project } = useApi<any>(['project', f.project_id], open && f.project_id ? `/projects/${f.project_id}` : null);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setF(task ? {
      title: task.title, description: task.description ?? '', project_id: task.project_id ?? '', milestone_id: task.milestone_id ?? '', department_id: task.department_id ?? '',
      priority: task.priority, complexity: task.complexity, task_type: task.task_type, start_date: task.start_date ?? '', deadline: isoToLocalInput(task.deadline),
      estimated_hours: task.estimated_hours ?? '', remarks: task.remarks ?? '',
    } : {
      title: '', description: '', project_id: defaults?.project_id ?? '', milestone_id: defaults?.milestone_id ?? '', department_id: '', priority: 'medium', complexity: 3, task_type: 'general',
      start_date: todayIso(), deadline: '', estimated_hours: '', assignee_ids: can('tasks.assign') ? [] : [user!.id], subtasks: '', checklist: '', reminders: ['60'], recurring: false,
      rec: { freq: 'weekly', interval: 1, by_weekday: [1], time_of_day: '18:00', starts_on: todayIso(), ends_on: '' },
    });
  }, [open, task]);

  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const save = useAction(async () => {
    const num = (v: any) => (v === '' || v == null ? null : Number(v));
    const common = {
      title: f.title, description: f.description || null, project_id: num(f.project_id), milestone_id: num(f.milestone_id), department_id: num(f.department_id),
      priority: f.priority, complexity: Number(f.complexity), task_type: f.task_type || 'general', start_date: f.start_date || null,
      estimated_hours: num(f.estimated_hours), remarks: f.remarks || null,
    };
    try {
      if (edit) {
        const body: any = { ...common, deadline: localInputToIso(f.deadline) };
        if (task.deadline && body.deadline !== task.deadline && f.deadline_reason) body.deadline_change_reason = f.deadline_reason;
        return await api(`/tasks/${task.id}`, { method: 'PATCH', body });
      }
      return await api('/tasks', { body: {
        ...common, deadline: f.recurring ? null : localInputToIso(f.deadline), assignee_ids: f.assignee_ids,
        subtasks: String(f.subtasks).split('\n').map((s: string) => s.trim()).filter(Boolean),
        checklist: String(f.checklist).split('\n').map((s: string) => s.trim()).filter(Boolean),
        reminders: f.recurring || !f.deadline ? [] : f.reminders.map((m: string) => ({ offset_minutes: Number(m), channels: ['in_app', 'email', 'browser_push'] })),
        recurrence: f.recurring ? { ...f.rec, interval: Number(f.rec.interval), timezone: user!.timezone || browserTz(), ends_on: f.rec.ends_on || null, by_weekday: f.rec.freq === 'weekly' ? f.rec.by_weekday : undefined } : null,
      } });
    } catch (e) { if (e instanceof ApiError) setErrors(e.fieldErrors); throw e; }
  }, { invalidate: [['tasks'], ['task'], ['dashboard'], ['project']], success: edit ? 'Task updated' : 'Task created', onSuccess: onClose });

  const deadlineChanged = edit && task.deadline && localInputToIso(f.deadline) !== task.deadline;
  return (
    <Modal open={open} onClose={onClose} title={edit ? `Edit ${task.task_key}` : 'New task'} size="lg"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.title || save.isPending || (!edit && !f.assignee_ids?.length)} onClick={() => save.mutate(undefined)}>{edit ? 'Save changes' : 'Create task'}</button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title *" error={errors.title} className="sm:col-span-2"><input className="input" value={f.title ?? ''} onChange={(e) => set('title', e.target.value)} autoFocus /></Field>
        <Field label="Description" className="sm:col-span-2"><textarea className="input" rows={3} value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
        {!edit && (
          <Field label="Assignees *" className="sm:col-span-2" hint={can('tasks.assign') ? 'First person is the primary assignee' : 'You can only create tasks for yourself'} error={errors.assignee_ids}>
            {can('tasks.assign') ? <UserPicker multi value={f.assignee_ids ?? []} onChange={(v) => set('assignee_ids', v)} /> : <input className="input" disabled value={user!.name} />}
          </Field>
        )}
        <Field label="Project"><Select value={f.project_id} onChange={(v) => { set('project_id', v); set('milestone_id', ''); }} placeholder="— None —" options={(projects?.items ?? []).map((p: any) => ({ value: p.id, label: `${p.code} · ${p.name}` }))} /></Field>
        <Field label="Milestone"><Select value={f.milestone_id} onChange={(v) => set('milestone_id', v)} placeholder="— None —" disabled={!f.project_id} options={(project?.milestones ?? []).map((m: any) => ({ value: m.id, label: m.title }))} /></Field>
        <Field label="Department" hint="Defaults to the primary assignee's department"><Select value={f.department_id} onChange={(v) => set('department_id', v)} placeholder="Auto" options={departments.map((d: any) => ({ value: d.id, label: d.name }))} /></Field>
        <Field label="Task type"><input className="input" value={f.task_type ?? ''} onChange={(e) => set('task_type', e.target.value)} placeholder="general, bug, report…" /></Field>
        <Field label="Priority"><Select value={f.priority} onChange={(v) => set('priority', v)} options={PRIORITIES.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))} /></Field>
        <Field label="Complexity (1–5)" hint="Used for fair, complexity-weighted performance scoring"><input className="input" type="range" min={1} max={5} value={f.complexity ?? 3} onChange={(e) => set('complexity', e.target.value)} /><span className="text-xs">{f.complexity}</span></Field>
        {!edit && (
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="h-4 w-4" checked={!!f.recurring} onChange={(e) => set('recurring', e.target.checked)} /> Recurring task</label>
        )}
        {!f.recurring ? (
          <>
            <Field label="Start date"><input className="input" type="date" value={f.start_date ?? ''} onChange={(e) => set('start_date', e.target.value)} /></Field>
            <Field label="Deadline (your local time)" error={errors.deadline}><input className="input" type="datetime-local" value={f.deadline ?? ''} onChange={(e) => set('deadline', e.target.value)} /></Field>
            {deadlineChanged && <Field label="Reason for deadline change" className="sm:col-span-2"><input className="input" value={f.deadline_reason ?? ''} onChange={(e) => set('deadline_reason', e.target.value)} /></Field>}
          </>
        ) : (
          <div className="grid gap-3 rounded-lg border p-3 sm:col-span-2 sm:grid-cols-3">
            <Field label="Repeats"><Select value={f.rec.freq} onChange={(v) => set('rec', { ...f.rec, freq: v })} options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }]} /></Field>
            <Field label="Every"><input className="input" type="number" min={1} value={f.rec.interval} onChange={(e) => set('rec', { ...f.rec, interval: e.target.value })} /></Field>
            <Field label="Due time"><input className="input" type="time" value={f.rec.time_of_day} onChange={(e) => set('rec', { ...f.rec, time_of_day: e.target.value })} /></Field>
            {f.rec.freq === 'weekly' && <div className="sm:col-span-3"><span className="label">On</span><Chips multi value={f.rec.by_weekday.map(String)} onChange={(v: string[]) => set('rec', { ...f.rec, by_weekday: v.map(Number) })} options={WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d }))} /></div>}
            <Field label="Starts"><input className="input" type="date" value={f.rec.starts_on} onChange={(e) => set('rec', { ...f.rec, starts_on: e.target.value })} /></Field>
            <Field label="Ends (optional)"><input className="input" type="date" value={f.rec.ends_on} onChange={(e) => set('rec', { ...f.rec, ends_on: e.target.value })} /></Field>
            <p className="muted text-xs sm:col-span-3">An instance is generated automatically 24 h before each occurrence and assigned to the same people.</p>
          </div>
        )}
        <Field label="Estimated hours"><input className="input" type="number" min={0} step="0.5" value={f.estimated_hours ?? ''} onChange={(e) => set('estimated_hours', e.target.value)} /></Field>
        {!edit && !f.recurring && f.deadline && (
          <div className="sm:col-span-2"><span className="label">Deadline reminders (sent server-side to assignees)</span><Chips multi value={f.reminders ?? []} onChange={(v) => set('reminders', v)} options={REMINDER_PRESETS} /></div>
        )}
        {!edit && <>
          <Field label="Subtasks (one per line)"><textarea className="input" rows={3} value={f.subtasks ?? ''} onChange={(e) => set('subtasks', e.target.value)} /></Field>
          <Field label="Checklist (one per line)"><textarea className="input" rows={3} value={f.checklist ?? ''} onChange={(e) => set('checklist', e.target.value)} /></Field>
        </>}
        <Field label="Remarks" className="sm:col-span-2"><input className="input" value={f.remarks ?? ''} onChange={(e) => set('remarks', e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
