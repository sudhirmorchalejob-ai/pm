import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRightLeft, KeyRound, Pencil, Plus, Power, UserPlus, Users as UsersIcon } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, fromNow, humanize } from '../lib/format';
import { useAction, useApi, useDebounced } from '../lib/hooks';
import { Avatar, Card, confirm, DataTable, Empty, Field, Loading, Modal, PageHeader, Pagination, SearchInput, Select, StatusBadge, Tabs, UserPicker } from '../components/ui';

export default function Organization() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'departments';
  return (
    <div>
      <PageHeader title="Organization" subtitle="Departments, teams, employees and reporting lines" />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} tabs={[
        { value: 'departments', label: 'Departments' }, { value: 'teams', label: 'Teams' }, { value: 'users', label: 'Employees' },
        { value: 'designations', label: 'Designations' }, { value: 'chart', label: 'Reporting hierarchy' },
      ]} />
      {tab === 'departments' && <Departments />}
      {tab === 'teams' && <Teams />}
      {tab === 'users' && <Users />}
      {tab === 'designations' && <Designations />}
      {tab === 'chart' && <OrgChart />}
    </div>
  );
}

function Departments() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [inactive, setInactive] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [detail, setDetail] = useState<number | null>(null);
  const { data = [], isLoading } = useApi<any[]>(['departments', inactive], '/org/departments', { includeInactive: inactive ? 'true' : undefined });
  const save = useAction((d: any) => d.id ? api(`/org/departments/${d.id}`, { method: 'PATCH', body: d.body }) : api('/org/departments', { body: d.body }), { invalidate: [['departments']], success: 'Saved', onSuccess: () => setEdit(null) });
  return (
    <Card title={<label className="flex items-center gap-2 text-sm font-normal"><input type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} /> Show inactive</label>}
      actions={can('org.manage') && <button className="btn-primary btn-sm" onClick={() => setEdit({})}><Plus className="h-4 w-4" /> Department</button>} pad={false}>
      {isLoading ? <Loading /> : <div className="px-4 sm:px-0"><DataTable rows={data} onRowClick={(d: any) => setDetail(d.id)} columns={[
        { key: 'name', header: 'Department', render: (d: any) => <span className="font-medium">{d.name}<span className="muted block text-xs font-normal">{d.code}</span></span> },
        { key: 'hod_name', header: 'HOD' }, { key: 'employee_count', header: 'Employees' }, { key: 'team_count', header: 'Teams' }, { key: 'open_tasks', header: 'Open tasks' },
        { key: 'is_active', header: 'Status', render: (d: any) => <StatusBadge status={d.is_active ? 'active' : 'cancelled'} label={d.is_active ? 'Active' : 'Inactive'} /> },
        ...(can('org.manage') ? [{ key: 'edit', header: '', render: (d: any) => <button className="btn-ghost btn-sm" aria-label={`Edit ${d.name}`} onClick={(e) => { e.stopPropagation(); setEdit(d); }}><Pencil className="h-4 w-4" /></button> }] : []),
      ]} /></div>}
      <DeptForm item={edit} onClose={() => setEdit(null)} onSave={(body) => save.mutate({ id: edit?.id, body })} />
      {detail && <DepartmentDetail id={detail} onClose={() => setDetail(null)} onEdit={(d) => { setDetail(null); setEdit(d); }} onMonitor={() => nav(`/monitoring/departments/${detail}`)} />}
    </Card>
  );
}

function DepartmentDetail({ id, onClose, onEdit, onMonitor }: { id: number; onClose: () => void; onEdit: (d: any) => void; onMonitor: () => void }) {
  const { can } = useAuth();
  const [tab, setTab] = useState('members');
  const [ids, setIds] = useState<number[]>([]);
  const [reason, setReason] = useState('');
  const { data: d, isLoading } = useApi<any>(['department', id], `/org/departments/${id}`);
  const add = useAction(() => api(`/org/departments/${id}/members`, { body: { user_ids: ids, reason: reason || undefined } }),
    { invalidate: [['department', id], ['departments'], ['users'], ['directory']], success: (r: any) => `${r.moved} employee(s) assigned`, onSuccess: () => { setIds([]); setReason(''); } });
  return (
    <Modal open onClose={onClose} title={d ? `${d.name} (${d.code})` : 'Department'} size="xl"
      footer={d && <>
        {can('monitoring.departments') && <button className="btn-secondary" onClick={onMonitor}>Open monitoring</button>}
        {can('org.manage') && <button className="btn-primary" onClick={() => onEdit(d)}><Pencil className="h-4 w-4" /> Edit department</button>}
      </>}>
      {isLoading || !d ? <Loading /> : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div><span className="muted block text-xs">Head of department</span>{d.hod_name ?? '—'}</div>
            <div><span className="muted block text-xs">Active members</span>{d.members.filter((m: any) => m.is_active).length}</div>
            <div><span className="muted block text-xs">Teams</span>{d.teams.length}</div>
            <div><span className="muted block text-xs">Status</span>{d.is_active ? 'Active' : 'Inactive'}</div>
          </div>
          {d.description && <p className="muted mb-3 text-sm">{d.description}</p>}
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'members', label: 'Members', count: d.members.length }, { value: 'teams', label: 'Teams & leaders', count: d.teams.length }, { value: 'history', label: 'History', count: d.history.length }]} />
          {tab === 'members' && (
            <>
              {(can('org.manage') || can('users.manage')) && d.is_active && (
                <div className="mb-3 grid gap-2 rounded-lg border p-3 dark:border-slate-700 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
                  <UserPicker multi value={ids} onChange={setIds} placeholder="Assign employees to this department…" exclude={d.members.map((m: any) => m.id)} />
                  <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" aria-label="Reason" />
                  <button className="btn-primary" disabled={!ids.length || add.isPending} onClick={() => add.mutate(undefined)}><UsersIcon className="h-4 w-4" /> Assign</button>
                </div>
              )}
              <DataTable rows={d.members} empty={<Empty title="No employees in this department" />} columns={[
                { key: 'name', header: 'Employee', render: (m: any) => <span className="flex items-center gap-2"><Avatar name={m.name} size="sm" /><span>{m.name}<span className="muted block text-xs">{m.employee_code}</span></span></span> },
                { key: 'role_name', header: 'Role' }, { key: 'team_name', header: 'Team', render: (m: any) => m.team_name ?? '—' }, { key: 'designation', header: 'Designation', render: (m: any) => m.designation ?? '—' },
                { key: 'member_since', header: 'Member since', render: (m: any) => (m.member_since ? fmtDate(m.member_since) : '—') },
                { key: 'is_active', header: 'Status', render: (m: any) => <StatusBadge status={m.is_active ? 'active' : 'cancelled'} label={m.is_active ? humanize(m.employment_status) : 'Deactivated'} /> },
              ]} />
            </>
          )}
          {tab === 'teams' && <DataTable rows={d.teams} empty={<Empty title="No teams" hint="Create teams on the Teams tab." />} columns={[
            { key: 'name', header: 'Team' }, { key: 'leader_name', header: 'Team leader', render: (t: any) => t.leader_name ?? '—' }, { key: 'member_count', header: 'Members' },
          ]} />}
          {tab === 'history' && <DataTable rows={d.history} empty={<Empty title="No history yet" />} columns={[
            { key: 'user_name', header: 'Employee' },
            { key: 'team_name', header: 'Team', render: (h: any) => h.team_name ?? '—' },
            { key: 'effective_from', header: 'From', render: (h: any) => fmtDateTime(h.effective_from) },
            { key: 'effective_to', header: 'Until', render: (h: any) => (h.effective_to ? fmtDateTime(h.effective_to) : <span className="text-emerald-600">current</span>) },
            { key: 'reason', header: 'Reason', render: (h: any) => h.reason ?? '—' },
            { key: 'changed_by_name', header: 'Changed by', render: (h: any) => h.changed_by_name ?? 'System' },
          ]} />}
        </>
      )}
    </Modal>
  );
}

function DeptForm({ item, onClose, onSave }: { item: any; onClose: () => void; onSave: (b: any) => void }) {
  const [f, setF] = useState<any>({});
  useEffect(() => { if (item) setF({ name: item.name ?? '', code: item.code ?? '', description: item.description ?? '', hod_id: item.hod_id ?? null, is_active: item.is_active ?? true }); }, [item]);
  return (
    <Modal open={!!item} onClose={onClose} title={item?.id ? `Edit ${item.name}` : 'New department'}
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.name || !f.code} onClick={() => onSave({ ...f, description: f.description || null })}>Save</button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name *"><input className="input" value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Code *"><input className="input uppercase" value={f.code ?? ''} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Head of department" className="sm:col-span-2"><UserPicker value={f.hod_id} onChange={(v) => setF({ ...f, hod_id: v })} /></Field>
        <Field label="Description" className="sm:col-span-2"><textarea className="input" rows={2} value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        {item?.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> Active (uncheck to deactivate)</label>}
      </div>
    </Modal>
  );
}

function Teams() {
  const { can } = useAuth();
  const [edit, setEdit] = useState<any>(null);
  const [members, setMembers] = useState<any>(null);
  const { data = [], isLoading } = useApi<any[]>(['teams'], '/org/teams');
  const { data: depts = [] } = useApi<any[]>(['departments'], '/org/departments');
  const [f, setF] = useState<any>({});
  useEffect(() => { if (edit) setF({ name: edit.name ?? '', department_id: edit.department_id ?? '', leader_id: edit.leader_id ?? null, description: edit.description ?? '' }); }, [edit]);
  const save = useAction(() => { const body = { ...f, department_id: Number(f.department_id), description: f.description || null }; return edit.id ? api(`/org/teams/${edit.id}`, { method: 'PATCH', body }) : api('/org/teams', { body }); },
    { invalidate: [['teams']], success: 'Team saved', onSuccess: () => setEdit(null) });
  const [ids, setIds] = useState<number[]>([]);
  const addMembers = useAction(() => api(`/org/teams/${members.id}/members`, { body: { user_ids: ids } }), { invalidate: [['teams'], ['team-users']], success: 'Members added', onSuccess: () => setIds([]) });
  const { data: teamUsers } = useApi<any>(['team-users', members?.id], members ? '/org/users' : null, { team_id: members?.id, pageSize: 200 });
  const remove = useAction((uid: number) => api(`/org/teams/${members.id}/members/${uid}`, { method: 'DELETE' }), { invalidate: [['teams'], ['team-users']] });
  return (
    <Card actions={(can('org.manage') || can('tasks.assign')) && <button className="btn-primary btn-sm" onClick={() => setEdit({})}><Plus className="h-4 w-4" /> Team</button>} title="Teams" pad={false}>
      {isLoading ? <Loading /> : <div className="px-4 sm:px-0"><DataTable rows={data} onRowClick={setMembers} empty={<Empty title="No teams" />} columns={[
        { key: 'name', header: 'Team', render: (t: any) => <span className="font-medium">{t.name}</span> }, { key: 'department_name', header: 'Department' },
        { key: 'leader_name', header: 'Team leader' }, { key: 'member_count', header: 'Members' },
        { key: 'e', header: '', render: (t: any) => <button className="btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setEdit(t); }}>Edit</button> },
      ]} /></div>}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit team' : 'New team'} footer={<><button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button><button className="btn-primary" disabled={!f.name || !f.department_id} onClick={() => save.mutate(undefined)}>Save</button></>}>
        <div className="grid gap-4">
          <Field label="Name"><input className="input" value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Department"><Select value={f.department_id} onChange={(v) => setF({ ...f, department_id: v })} placeholder="Select" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} /></Field>
          <Field label="Team leader"><UserPicker value={f.leader_id} onChange={(v) => setF({ ...f, leader_id: v })} departmentId={f.department_id ? Number(f.department_id) : undefined} /></Field>
          <Field label="Description"><input className="input" value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        </div>
      </Modal>
      <Modal open={!!members} onClose={() => setMembers(null)} title={`${members?.name ?? ''} — members`}>
        <div className="mb-3 flex gap-2"><div className="flex-1"><UserPicker multi value={ids} onChange={setIds} placeholder="Add employees…" /></div><button className="btn-secondary" disabled={!ids.length} onClick={() => addMembers.mutate(undefined)}>Add</button></div>
        <ul className="divide-y">{teamUsers?.items?.map((u: any) => <li key={u.id} className="flex items-center gap-2 py-2 text-sm"><Avatar name={u.name} size="sm" />{u.name}<span className="muted text-xs">{u.designation}</span><button className="btn-ghost btn-sm ml-auto" onClick={() => remove.mutate(u.id)}>Remove</button></li>)}</ul>
      </Modal>
    </Card>
  );
}

function Users() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [dept, setDept] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [active, setActive] = useState('true');
  const [page, setPage] = useState(1);
  const [edit, setEdit] = useState<any>(null);
  const [transfer, setTransfer] = useState<any>(null);
  const { data: depts = [] } = useApi<any[]>(['departments'], '/org/departments');
  const { data: roles = [] } = useApi<any[]>(['roles'], '/org/roles');
  const { data, isLoading } = useApi<any>(['users'], '/org/users', { q: dq, department_id: dept || undefined, role: role || undefined, status: status || undefined, active: active || undefined, page });
  const toggleActive = useAction(async (u: any) => {
    const reason = await confirm({ title: u.is_active ? `Deactivate ${u.name}?` : `Reactivate ${u.name}?`, danger: u.is_active, confirmLabel: u.is_active ? 'Deactivate' : 'Reactivate',
      message: u.is_active ? 'They lose access and stop receiving tasks, questions and notifications. All their tasks, answers, reports and history are kept.' : 'They can sign in again and will receive assignments and checklists.',
      input: { label: 'Reason (kept in the employee’s history)', required: true } });
    if (!reason || reason === true) return null;
    return api(`/org/users/${u.id}/${u.is_active ? 'deactivate' : 'activate'}`, { body: { reason } });
  }, { invalidate: [['users'], ['directory'], ['user']], success: 'Employee status updated' });
  const reset = useAction((id: number) => api(`/org/users/${id}/reset-password`, { method: 'POST' }), { onSuccess: (r: any) => confirm({ title: 'Temporary password', message: <>Share securely with the employee — they must change it at first sign-in:<pre className="mt-2 rounded bg-slate-100 p-2 dark:bg-slate-800">{r.temporaryPassword}</pre></>, confirmLabel: 'Done' }) });
  return (
    <>
      <Card className="mb-4"><div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_180px_150px_150px_auto]">
        <SearchInput value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Name, email or code" />
        <Select value={dept} onChange={setDept} placeholder="All departments" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} />
        <Select value={role} onChange={setRole} placeholder="All roles" options={roles.map((r: any) => ({ value: r.key, label: r.name }))} />
        <Select value={status} onChange={setStatus} placeholder="Any employment status" options={['active', 'on_leave', 'notice', 'exited'].map((s) => ({ value: s, label: humanize(s) }))} />
        <Select value={active} onChange={(v) => { setActive(v); setPage(1); }} placeholder="Active & deactivated" options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Deactivated' }]} aria-label="Account status" />
        {can('users.manage') && <button className="btn-primary" onClick={() => setEdit({})}><UserPlus className="h-4 w-4" /> Employee</button>}
      </div></Card>
      <Card pad={false}>{isLoading ? <Loading /> : <div className="px-4 sm:px-0">
        <DataTable rows={data.items} onRowClick={(u: any) => can('users.manage') ? setEdit(u) : nav(`/monitoring/employees/${u.id}`)} columns={[
          { key: 'name', header: 'Employee', render: (u: any) => <span className="flex items-center gap-2"><Avatar name={u.name} size="sm" /><span><span className="block font-medium">{u.name}</span><span className="muted text-xs">{u.employee_code} · {u.email}</span></span></span> },
          { key: 'role_name', header: 'Role' }, { key: 'department_name', header: 'Department' }, { key: 'team_name', header: 'Team' }, { key: 'designation', header: 'Designation' },
          { key: 'manager_name', header: 'Reports to' }, { key: 'open_tasks', header: 'Open tasks' },
          { key: 'employment_status', header: 'Status', render: (u: any) => !u.is_active ? <StatusBadge status="cancelled" label="Deactivated" /> : <StatusBadge status={u.employment_status === 'exited' ? 'cancelled' : u.employment_status === 'active' ? 'active' : 'paused'} label={humanize(u.employment_status)} /> },
          { key: 'last_login_at', header: 'Last login', render: (u: any) => u.last_login_at ? fromNow(u.last_login_at) : 'never' },
          ...(can('users.manage') ? [{ key: 'pw', header: '', render: (u: any) => (
            <span className="flex gap-0.5" onClick={(e) => e.stopPropagation()}>
              {u.is_active && <button className="btn-ghost btn-sm" title="Transfer department" aria-label={`Transfer ${u.name}`} onClick={() => setTransfer(u)}><ArrowRightLeft className="h-4 w-4" /></button>}
              <button className="btn-ghost btn-sm" title={u.is_active ? 'Deactivate' : 'Reactivate'} aria-label={u.is_active ? `Deactivate ${u.name}` : `Reactivate ${u.name}`} onClick={() => toggleActive.mutate(u)}><Power className={`h-4 w-4 ${u.is_active ? 'text-emerald-600' : 'text-slate-400'}`} /></button>
              {u.is_active && <button className="btn-ghost btn-sm" title="Reset password" aria-label={`Reset password for ${u.name}`} onClick={async () => { if (await confirm({ title: `Reset password for ${u.name}?`, message: 'All their sessions will be signed out.' })) reset.mutate(u.id); }}><KeyRound className="h-4 w-4" /></button>}
            </span>) }] : []),
        ]} />
        <div className="pb-4"><Pagination page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></div>
      </div>}</Card>
      <UserForm item={edit} onClose={() => setEdit(null)} />
      {transfer && <TransferForm user={transfer} onClose={() => setTransfer(null)} />}
    </>
  );
}

function TransferForm({ user, onClose }: { user: any; onClose: () => void }) {
  const { data: depts = [] } = useApi<any[]>(['departments'], '/org/departments');
  const { data: teams = [] } = useApi<any[]>(['teams'], '/org/teams');
  const [f, setF] = useState<any>({ department_id: '', team_id: '', manager_id: undefined, reason: '' });
  const save = useAction(() => api(`/org/users/${user.id}/transfer`, { body: { department_id: Number(f.department_id), team_id: f.team_id ? Number(f.team_id) : null, ...(f.manager_id !== undefined ? { manager_id: f.manager_id } : {}), reason: f.reason } }),
    { invalidate: [['users'], ['directory'], ['user'], ['departments']], success: `${user.name} transferred`, onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={`Transfer ${user.name}`} footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.department_id || f.reason.trim().length < 3 || save.isPending} onClick={() => save.mutate(undefined)}>Transfer</button></>}>
      <p className="muted mb-3 text-sm">Currently: {user.department_name ?? 'no department'}{user.team_name ? ` · ${user.team_name}` : ''}. The previous department stays in their history.</p>
      <div className="grid gap-3">
        <Field label="New department"><Select value={f.department_id} onChange={(v) => setF({ ...f, department_id: v, team_id: '' })} placeholder="Select" options={depts.filter((d: any) => d.id !== user.department_id || true).map((d: any) => ({ value: d.id, label: d.name }))} /></Field>
        <Field label="Team (optional)"><Select value={f.team_id} onChange={(v) => setF({ ...f, team_id: v })} placeholder="No team" options={teams.filter((t: any) => t.department_id === Number(f.department_id)).map((t: any) => ({ value: t.id, label: t.name }))} /></Field>
        <Field label="New reporting manager (optional)"><UserPicker value={f.manager_id ?? null} onChange={(v) => setF({ ...f, manager_id: v })} exclude={[user.id]} /></Field>
        <Field label="Reason (required)"><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Moved to the implementation team" /></Field>
      </div>
    </Modal>
  );
}

function UserForm({ item, onClose }: { item: any; onClose: () => void }) {
  const [f, setF] = useState<any>({});
  const [errors, setErrors] = useState<any>({});
  const { data: depts = [] } = useApi<any[]>(['departments'], item ? '/org/departments' : null);
  const { data: roles = [] } = useApi<any[]>(['roles'], item ? '/org/roles' : null);
  const { data: desig = [] } = useApi<any[]>(['designations'], item ? '/org/designations' : null);
  const { data: teams = [] } = useApi<any[]>(['teams'], item ? '/org/teams' : null);
  const { data: tzs = [] } = useApi<string[]>(['timezones'], item ? '/timezones' : null, undefined, { staleTime: Infinity });
  const { data: detail } = useApi<any>(['user', item?.id], item?.id ? `/org/users/${item.id}` : null);
  const { data: skills = [] } = useApi<any[]>(['skills'], item ? '/org/skills' : null);
  const [skillSel, setSkillSel] = useState<{ skill_id: number; level: number }[]>([]);
  useEffect(() => {
    if (!item) return;
    setErrors({});
    setF(item.id ? { ...item, role_id: undefined } : { employee_code: '', name: '', email: '', phone: '', role_id: '', department_id: '', designation_id: '', team_id: '', manager_id: null, timezone: 'Asia/Kolkata', employment_status: 'active', joining_date: '', capacity_hours_per_week: 40 });
  }, [item]);
  useEffect(() => { if (detail) { setF((x: any) => ({ ...x, role_id: detail.role_id })); setSkillSel(detail.skills.map((s: any) => ({ skill_id: s.id, level: s.level }))); } }, [detail]);
  const num = (v: any) => (v === '' || v == null ? null : Number(v));
  const save = useAction(async () => {
    const body: any = { employee_code: f.employee_code, name: f.name, email: f.email, phone: f.phone || null, role_id: Number(f.role_id), department_id: num(f.department_id), designation_id: num(f.designation_id),
      team_id: num(f.team_id), manager_id: num(f.manager_id), timezone: f.timezone, employment_status: f.employment_status, joining_date: f.joining_date || null, exit_date: f.exit_date || null, capacity_hours_per_week: Number(f.capacity_hours_per_week) };
    try {
      if (item.id) { await api(`/org/users/${item.id}`, { method: 'PATCH', body }); await api(`/org/users/${item.id}/skills`, { method: 'PUT', body: { skills: skillSel } }); return {}; }
      return await api('/org/users', { body });
    } catch (e) { if (e instanceof ApiError) setErrors(e.fieldErrors); throw e; }
  }, { invalidate: [['users'], ['directory'], ['user']], success: 'Employee saved', onSuccess: (r: any) => { onClose(); if (r?.temporaryPassword) confirm({ title: 'Employee created', message: <>Temporary password (must be changed at first sign-in):<pre className="mt-2 rounded bg-slate-100 p-2 dark:bg-slate-800">{r.temporaryPassword}</pre></>, confirmLabel: 'Done' }); } });
  return (
    <Modal open={!!item} onClose={onClose} title={item?.id ? `Edit ${item.name}` : 'New employee'} size="xl"
      footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!f.name || !f.email || !f.role_id || !f.employee_code || save.isPending} onClick={() => save.mutate(undefined)}>Save</button></>}>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Employee code *" error={errors.employee_code}><input className="input" value={f.employee_code ?? ''} onChange={(e) => setF({ ...f, employee_code: e.target.value })} /></Field>
        <Field label="Full name *" error={errors.name}><input className="input" value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email *" error={errors.email}><input className="input" type="email" value={f.email ?? ''} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Phone"><input className="input" value={f.phone ?? ''} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Role *"><Select value={f.role_id} onChange={(v) => setF({ ...f, role_id: v })} placeholder="Select" options={roles.map((r: any) => ({ value: r.id, label: r.name }))} /></Field>
        <Field label="Department"><Select value={f.department_id} onChange={(v) => setF({ ...f, department_id: v })} placeholder="—" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} /></Field>
        <Field label="Team"><Select value={f.team_id} onChange={(v) => setF({ ...f, team_id: v })} placeholder="—" options={teams.filter((t: any) => !f.department_id || t.department_id === Number(f.department_id)).map((t: any) => ({ value: t.id, label: t.name }))} /></Field>
        <Field label="Designation"><Select value={f.designation_id} onChange={(v) => setF({ ...f, designation_id: v })} placeholder="—" options={desig.map((d: any) => ({ value: d.id, label: d.title }))} /></Field>
        <Field label="Reports to"><UserPicker value={f.manager_id} onChange={(v) => setF({ ...f, manager_id: v })} exclude={item?.id ? [item.id] : []} /></Field>
        <Field label="Employment status"><Select value={f.employment_status} onChange={(v) => setF({ ...f, employment_status: v })} options={['active', 'on_leave', 'notice', 'exited'].map((s) => ({ value: s, label: humanize(s) }))} /></Field>
        <Field label="Joining date"><input className="input" type="date" value={f.joining_date ?? ''} onChange={(e) => setF({ ...f, joining_date: e.target.value })} /></Field>
        {f.employment_status === 'exited' || f.employment_status === 'notice' ? <Field label="Exit date"><input className="input" type="date" value={f.exit_date ?? ''} onChange={(e) => setF({ ...f, exit_date: e.target.value })} /></Field> : null}
        <Field label="Timezone"><Select value={f.timezone} onChange={(v) => setF({ ...f, timezone: v })} options={(tzs.length ? tzs : [f.timezone ?? 'UTC']).map((z) => ({ value: z, label: z }))} /></Field>
        <Field label="Capacity (h/week)"><input className="input" type="number" min={0} max={80} value={f.capacity_hours_per_week ?? 40} onChange={(e) => setF({ ...f, capacity_hours_per_week: e.target.value })} /></Field>
        {item?.id && (
          <div className="sm:col-span-2 lg:col-span-3">
            <span className="label">Skill profile (level 1–5)</span>
            <div className="flex flex-wrap gap-2">
              {skills.map((s: any) => {
                const sel = skillSel.find((x) => x.skill_id === s.id);
                return (
                  <span key={s.id} className={`chip ${sel ? 'chip-on' : 'chip-off'}`}>
                    <button type="button" onClick={() => setSkillSel(sel ? skillSel.filter((x) => x.skill_id !== s.id) : [...skillSel, { skill_id: s.id, level: 3 }])}>{s.name}</button>
                    {sel && <select className="bg-transparent text-xs" value={sel.level} onChange={(e) => setSkillSel(skillSel.map((x) => x.skill_id === s.id ? { ...x, level: Number(e.target.value) } : x))} aria-label={`${s.name} level`}>{[1, 2, 3, 4, 5].map((l) => <option key={l} value={l} className="text-black">{l}</option>)}</select>}
                  </span>
                );
              })}
            </div>
          </div>
        )}
        {detail?.department_history?.length > 0 && (
          <div className="sm:col-span-2 lg:col-span-3"><span className="label">Department history</span>
            <ul className="text-xs">{detail.department_history.map((h: any) => <li key={h.id}>{fmtDate(h.effective_from)} → {h.effective_to ? fmtDate(h.effective_to) : 'now'}: <b>{h.department_name ?? 'No department'}</b>{h.team_name ? ` · ${h.team_name}` : ''}{h.reason ? ` — ${h.reason}` : ''} ({h.changed_by_name ?? 'system'})</li>)}</ul>
          </div>
        )}
        {detail?.status_history?.length > 0 && (
          <div className="sm:col-span-2 lg:col-span-3"><span className="label">Activation history</span>
            <ul className="text-xs">{detail.status_history.map((h: any) => <li key={h.id}>{fmtDateTime(h.changed_at)}: <b>{h.is_active ? 'Active' : 'Deactivated'}</b> · {humanize(h.employment_status)}{h.reason ? ` — ${h.reason}` : ''} ({h.changed_by_name ?? 'system'})</li>)}</ul>
          </div>
        )}
        {detail?.reporting_history?.length > 0 && (
          <div className="sm:col-span-2 lg:col-span-3"><span className="label">Reporting history</span>
            <ul className="text-xs">{detail.reporting_history.map((h: any) => <li key={h.id}>{fmtDate(h.effective_from)} → {h.effective_to ? fmtDate(h.effective_to) : 'now'}: reports to <b>{h.manager_name ?? '—'}</b> (changed by {h.changed_by_name ?? 'system'})</li>)}</ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

function Designations() {
  const { can } = useAuth();
  const { data = [], isLoading } = useApi<any[]>(['designations'], '/org/designations');
  const [f, setF] = useState({ title: '', level: 3 });
  const add = useAction(() => api('/org/designations', { body: { title: f.title, level: Number(f.level) } }), { invalidate: [['designations']], success: 'Added', onSuccess: () => setF({ title: '', level: 3 }) });
  return (
    <Card title="Designations">
      {can('org.manage') && <form className="mb-4 grid gap-2 sm:grid-cols-[1fr_120px_auto]" onSubmit={(e) => { e.preventDefault(); add.mutate(undefined); }}><input className="input" placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required /><input className="input" type="number" min={1} max={20} value={f.level} onChange={(e) => setF({ ...f, level: Number(e.target.value) })} aria-label="Level" /><button className="btn-secondary">Add</button></form>}
      {isLoading ? <Loading /> : <DataTable rows={data} columns={[{ key: 'title', header: 'Title' }, { key: 'level', header: 'Level' }, { key: 'department_name', header: 'Department', render: (d: any) => d.department_name ?? 'All' }]} />}
    </Card>
  );
}

function OrgChart() {
  const { data = [], isLoading } = useApi<any[]>(['org-chart'], '/org/org-chart');
  if (isLoading) return <Loading />;
  const ids = new Set(data.map((u) => u.id));
  const children = (id: number | null) => data.filter((u) => (id === null ? !u.manager_id || !ids.has(u.manager_id) : u.manager_id === id));
  const Node = ({ u, depth }: { u: any; depth: number }) => (
    <li>
      <div className="flex items-center gap-2 py-1.5" style={{ paddingLeft: depth * 16 }}>
        <Avatar name={u.name} size="sm" /><span className="text-sm font-medium">{u.name}</span><span className="muted truncate text-xs">{u.designation ?? u.role_name}{u.department_name ? ` · ${u.department_name}` : ''}</span>
      </div>
      {children(u.id).length > 0 && <ul className="border-l border-slate-200 dark:border-slate-800" style={{ marginLeft: depth * 16 + 12 }}>{children(u.id).map((c) => <Node key={c.id} u={c} depth={1} />)}</ul>}
    </li>
  );
  return <Card title="Reporting hierarchy"><ul className="overflow-x-auto">{children(null).map((u) => <Node key={u.id} u={u} depth={0} />)}</ul>{!data.length && <Empty />}</Card>;
}
