import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useAction, useApi } from '../../lib/hooks';
import { Chips, Field, Modal, Select, UserPicker } from '../../components/ui';

const STATUSES = ['proposed', 'under_evaluation', 'approved', 'planned', 'ready_to_start', 'in_progress', 'on_hold'];
const HORIZONS = [
  { value: 'next_week', label: 'Next week', days: 7 }, { value: 'next_month', label: 'Next month', days: 30 }, { value: 'next_quarter', label: 'Next quarter', days: 90 },
  { value: 'six_months', label: '6 months', days: 182 }, { value: 'next_year', label: 'Next year', days: 365 }, { value: 'custom', label: 'Custom date', days: 0 },
];
const plus = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);

export function ProjectForm({ open, onClose, project, future = false }: { open: boolean; onClose: () => void; project?: any; future?: boolean }) {
  const { can } = useAuth();
  const edit = !!project;
  const [f, setF] = useState<any>({});
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const { data: depts = [] } = useApi<any[]>(['departments'], open ? '/org/departments' : null);
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setF(project ? {
      code: project.code, name: project.name, description: project.description ?? '', business_objective: project.business_objective ?? '', client_name: project.client_name ?? '',
      client_contact: project.client_contact ?? '', client_email: project.client_email ?? '', manager_id: project.manager_id, department_id: project.department_id ?? '', hod_id: project.hod_id,
      start_date: project.start_date ?? '', end_date: project.end_date ?? '', priority: project.priority, estimated_budget: project.estimated_budget ?? '',
    } : {
      code: '', name: '', description: '', business_objective: '', client_name: '', client_contact: '', client_email: '', manager_id: null, department_id: '', hod_id: null,
      start_date: future ? '' : new Date().toISOString().slice(0, 10), end_date: '', priority: 'medium', estimated_budget: '', status: future ? 'proposed' : 'planned', member_ids: [],
      horizon: 'next_quarter', expected_start_date: plus(90), expected_end_date: '', required_employees: 0, required_skills: '', expected_deliverables: '',
    });
  }, [open, project]);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const save = useAction(async () => {
    const num = (v: any) => (v === '' || v == null ? null : Number(v));
    const body: any = {
      code: f.code, name: f.name, description: f.description || null, business_objective: f.business_objective || null, client_name: f.client_name || null, client_contact: f.client_contact || null,
      client_email: f.client_email || null, manager_id: num(f.manager_id), department_id: num(f.department_id), hod_id: num(f.hod_id), start_date: f.start_date || null, end_date: f.end_date || null,
      priority: f.priority, estimated_budget: num(f.estimated_budget),
    };
    try {
      if (edit) return await api(`/projects/${project.id}`, { method: 'PATCH', body });
      return await api('/projects', { body: {
        ...body, status: f.status, member_ids: f.member_ids, is_future: future,
        future: future ? { expected_start_date: f.expected_start_date, expected_end_date: f.expected_end_date || null, planning_horizon: f.horizon, required_employees: Number(f.required_employees) || 0,
          required_skills: String(f.required_skills).split(',').map((s: string) => s.trim()).filter(Boolean), expected_deliverables: f.expected_deliverables || null } : undefined,
      } });
    } catch (e) { if (e instanceof ApiError) setErrors(e.fieldErrors); throw e; }
  }, { invalidate: [['projects'], ['project'], ['future'], ['dashboard']], success: edit ? 'Project updated' : future ? 'Future project created' : 'Project created', onSuccess: onClose });

  return (
    <Modal open={open} onClose={onClose} title={edit ? `Edit ${project.code}` : future ? 'Plan a future project' : 'New project'} size="xl"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.code || !f.name || save.isPending} onClick={() => save.mutate(undefined)}>{edit ? 'Save' : 'Create'}</button></>}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Project code *" error={errors.code}><input className="input uppercase" value={f.code ?? ''} onChange={(e) => set('code', e.target.value.toUpperCase())} placeholder="ERP-2027" /></Field>
        <Field label="Project name *" error={errors.name} className="lg:col-span-2"><input className="input" value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Description" className="sm:col-span-2 lg:col-span-3"><textarea className="input" rows={2} value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
        <Field label="Business objective" className="sm:col-span-2 lg:col-span-3"><input className="input" value={f.business_objective ?? ''} onChange={(e) => set('business_objective', e.target.value)} /></Field>
        {future && !edit && (
          <div className="rounded-lg border border-brand-200 bg-brand-50/50 p-3 dark:border-brand-900 dark:bg-brand-900/10 sm:col-span-2 lg:col-span-3">
            <span className="label">Planned for</span>
            <Chips value={f.horizon} onChange={(v) => { set('horizon', v); const h = HORIZONS.find((x) => x.value === v)!; if (h.days) set('expected_start_date', plus(h.days)); }} options={HORIZONS} />
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="Expected start *"><input className="input" type="date" min={plus(1)} value={f.expected_start_date ?? ''} onChange={(e) => { set('expected_start_date', e.target.value); set('horizon', 'custom'); }} /></Field>
              <Field label="Expected completion"><input className="input" type="date" value={f.expected_end_date ?? ''} onChange={(e) => set('expected_end_date', e.target.value)} /></Field>
              <Field label="Required employees"><input className="input" type="number" min={0} value={f.required_employees} onChange={(e) => set('required_employees', e.target.value)} /></Field>
              <Field label="Required skills (comma separated)" className="sm:col-span-3"><input className="input" value={f.required_skills} onChange={(e) => set('required_skills', e.target.value)} placeholder="React, Data Analytics, DevOps" /></Field>
              <Field label="Expected deliverables" className="sm:col-span-3"><textarea className="input" rows={2} value={f.expected_deliverables} onChange={(e) => set('expected_deliverables', e.target.value)} /></Field>
            </div>
          </div>
        )}
        <Field label={future ? 'Tentative project manager' : 'Project manager'}><UserPicker value={f.manager_id} onChange={(v) => set('manager_id', v)} placeholder="Select PM…" /></Field>
        <Field label="Department"><Select value={f.department_id} onChange={(v) => set('department_id', v)} placeholder="— Select —" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} /></Field>
        <Field label="HOD"><UserPicker value={f.hod_id} onChange={(v) => set('hod_id', v)} placeholder="Select HOD…" /></Field>
        {!future && <>
          <Field label="Start date"><input className="input" type="date" value={f.start_date ?? ''} onChange={(e) => set('start_date', e.target.value)} /></Field>
          <Field label="End date" error={errors.end_date}><input className="input" type="date" value={f.end_date ?? ''} onChange={(e) => set('end_date', e.target.value)} /></Field>
        </>}
        <Field label="Priority"><Select value={f.priority} onChange={(v) => set('priority', v)} options={['low', 'medium', 'high', 'critical'].map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))} /></Field>
        <Field label="Estimated budget (₹)" hint={edit && !project.is_future && !['proposed', 'under_evaluation'].includes(project.status) && !can('approvals.decide') ? 'Changing an approved budget requires a budget-change request' : undefined}>
          <input className="input" type="number" min={0} value={f.estimated_budget ?? ''} onChange={(e) => set('estimated_budget', e.target.value)} /></Field>
        {!edit && !future && <Field label="Initial status"><Select value={f.status} onChange={(v) => set('status', v)} options={STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))} /></Field>}
        <Field label="Client name"><input className="input" value={f.client_name ?? ''} onChange={(e) => set('client_name', e.target.value)} /></Field>
        <Field label="Client contact"><input className="input" value={f.client_contact ?? ''} onChange={(e) => set('client_contact', e.target.value)} /></Field>
        <Field label="Client email" error={errors.client_email}><input className="input" type="email" value={f.client_email ?? ''} onChange={(e) => set('client_email', e.target.value)} /></Field>
        {!edit && <Field label="Participating employees" className="sm:col-span-2 lg:col-span-3"><UserPicker multi value={f.member_ids ?? []} onChange={(v) => set('member_ids', v)} /></Field>}
      </div>
    </Modal>
  );
}
