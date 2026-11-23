import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardCopy, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useApi } from '../lib/hooks';
import { toast } from '../components/Toast';
import { clsx, Field, Loading, Modal, Select, Spinner } from '../components/ui';
import { copyText } from './mywork/common';

const ACTION_TONE: Record<string, string> = {
  create: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  update: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  exists: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  skip: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200',
};
const ACTION_LABEL: Record<string, string> = { create: 'Will create', update: 'Will update', exists: 'Already exists', skip: 'Skipped' };
const DONE_LABEL: Record<string, string> = { create: 'Created', update: 'Updated', exists: 'Kept', skip: 'Skipped' };

/**
 * Administrative setup of the initial company structure. Starts from the bundled starter file,
 * everything is editable here first, a preview shows exactly what will happen, and applying
 * again never creates duplicates.
 */
export function TeamSetupModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: starter, isLoading } = useApi<any>(['team-setup-starter'], open ? '/org/setup/team-structure/starter' : null);
  const { data: roles = [] } = useApi<any[]>(['roles'], open ? '/org/roles' : null);
  const [s, setS] = useState<any>(null);
  const [opt, setOpt] = useState({ email_domain: '', temporary_password: '', apply_templates: true });
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (open && starter && !s) setS(JSON.parse(JSON.stringify(starter))); }, [open, starter, s]);
  useEffect(() => { if (!open) { setResult(null); } }, [open]);
  const setEmp = (i: number, k: string, v: any) => { setS((x: any) => ({ ...x, employees: x.employees.map((e: any, j: number) => (j === i ? { ...e, [k]: v } : e)) })); setResult(null); };
  const setDept = (i: number, k: string, v: any) => { setS((x: any) => ({ ...x, departments: x.departments.map((e: any, j: number) => (j === i ? { ...e, [k]: v } : e)) })); setResult(null); };
  const setCo = (i: number, k: string, v: any) => { setS((x: any) => ({ ...x, companies: x.companies.map((e: any, j: number) => (j === i ? { ...e, [k]: v } : e)) })); setResult(null); };

  async function run(dry: boolean) {
    setBusy(dry ? 'preview' : 'apply');
    try {
      const structure = {
        ...s,
        employees: s.employees.map((e: any) => ({ ...e, email: e.email?.trim() || undefined, company: e.company || undefined, department: e.department || undefined, manager: e.manager || undefined, role: e.role || undefined, designations: (e.designations ?? []).filter(Boolean) })),
        departments: s.departments.map((d: any) => ({ ...d, hod: d.hod || undefined, template: d.template || null })),
      };
      const r = await api('/org/setup/team-structure', { body: { structure, options: { ...opt, dry_run: dry } } });
      setResult(r);
      if (!dry) {
        ['users', 'directory', 'departments', 'designations', 'companies', 'user', 'org-chart'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
        toast.success(`Applied: ${r.summary.employees_created} employees created, ${r.summary.employees_updated} updated`);
      }
    } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  }

  const deptNames = (s?.departments ?? []).map((d: any) => d.name);
  const companyNames = (s?.companies ?? []).map((c: any) => c.name);
  const applied = result && !result.dry_run;
  return (
    <Modal open={open} onClose={onClose} size="xl" title="Team setup — initial company structure"
      footer={applied ? <button className="btn-primary" onClick={onClose}>Done</button> : <>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-secondary" disabled={!s || !!busy} onClick={() => run(true)}>{busy === 'preview' && <Spinner className="h-4 w-4" />} Preview</button>
        <button className="btn-primary" disabled={!s || !!busy || !result} onClick={() => run(false)}>{busy === 'apply' && <Spinner className="h-4 w-4" />} Apply</button>
      </>}>
      {isLoading || !s ? <Loading /> : applied ? (
        <div className="space-y-4">
          <p className="text-sm">Done. {result.summary.companies_created} companies, {result.summary.departments_created} departments, {result.summary.designations_created} designations and {result.summary.employees_created} employees created; {result.summary.employees_updated} existing employees updated{result.summary.skipped ? `; ${result.summary.skipped} skipped` : ''}. Everything can be edited on the Organization screens.</p>
          {result.generated_passwords.length > 0 && (
            <div>
              <div className="mb-1 flex items-center justify-between"><span className="section-title">Temporary passwords — shown once</span>
                <button className="btn-secondary btn-sm" onClick={() => copyText(result.generated_passwords.map((p: any) => `${p.name}\t${p.email}\t${p.password}`).join('\n'), 'Copied')}><ClipboardCopy className="h-3.5 w-3.5" /> Copy all</button></div>
              <p className="muted mb-2 text-xs">Share them privately. Everyone must set their own password at first sign-in.</p>
              <table className="w-full text-sm"><tbody>{result.generated_passwords.map((p: any) => <tr key={p.email} className="border-t dark:border-slate-800"><td className="py-1.5">{p.name}</td><td>{p.email}</td><td className="font-mono">{p.password}</td></tr>)}</tbody></table>
            </div>
          )}
          {opt.temporary_password && result.summary.employees_created > 0 && <p className="muted text-sm">New accounts use the temporary password you entered and must change it at first sign-in.</p>}
          <PlanTable plan={result.plan} applied />
        </div>
      ) : (
        <div className="space-y-5">
          <p className="muted text-sm">Starter records from the requirements. Edit anything below, preview, then apply. Existing companies, departments and employees (matched by email or exact name) are kept, never duplicated; only their empty fields are filled.</p>
          <section>
            <h3 className="section-title mb-2">Companies</h3>
            <div className="space-y-2">{s.companies.map((c: any, i: number) => (
              <div key={i} className="grid grid-cols-[1fr_120px_auto] gap-2">
                <input className="input" value={c.name} onChange={(e) => setCo(i, 'name', e.target.value)} aria-label="Company name" />
                <input className="input" value={c.code ?? ''} onChange={(e) => setCo(i, 'code', e.target.value)} aria-label="Company code" placeholder="Code" />
                <button className="btn-ghost btn-sm" aria-label="Remove company" onClick={() => setS({ ...s, companies: s.companies.filter((_: any, j: number) => j !== i) })}><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}</div>
            <button className="btn-ghost btn-sm mt-1" onClick={() => setS({ ...s, companies: [...s.companies, { name: '', code: '' }] })}><Plus className="h-3.5 w-3.5" /> Company</button>
          </section>
          <section>
            <h3 className="section-title mb-2">Departments</h3>
            <div className="space-y-2">{s.departments.map((d: any, i: number) => (
              <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_110px_1fr_1fr_auto]">
                <input className="input" value={d.name} onChange={(e) => setDept(i, 'name', e.target.value)} aria-label="Department name" />
                <input className="input" value={d.code ?? ''} onChange={(e) => setDept(i, 'code', e.target.value)} aria-label="Department code" placeholder="Code" />
                <Select value={d.hod ?? ''} onChange={(v) => setDept(i, 'hod', v)} placeholder="No HOD" options={s.employees.map((e: any) => ({ value: e.name, label: `HOD: ${e.name}` }))} aria-label="Head of department" />
                <Select value={d.template ?? ''} onChange={(v) => setDept(i, 'template', v)} placeholder="No checklist template" options={[['development', 'Development'], ['data_scrapper', 'Data Scrapper'], ['digital_marketing', 'Digital Marketing'], ['implementation', 'Implementation']].map(([v, l]) => ({ value: v, label: `Template: ${l}` }))} aria-label="Checklist template" />
                <button className="btn-ghost btn-sm" aria-label="Remove department" onClick={() => setS({ ...s, departments: s.departments.filter((_: any, j: number) => j !== i) })}><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}</div>
            <button className="btn-ghost btn-sm mt-1" onClick={() => setS({ ...s, departments: [...s.departments, { name: '', code: '' }] })}><Plus className="h-3.5 w-3.5" /> Department</button>
          </section>
          <section>
            <h3 className="section-title mb-2">Employees</h3>
            <div className="space-y-3">{s.employees.map((e: any, i: number) => (
              <div key={i} className="grid gap-2 rounded-lg border p-2 dark:border-slate-700 sm:grid-cols-2 lg:grid-cols-[1fr_1.4fr_1fr_1fr_1fr_auto]">
                <input className="input" value={e.name} onChange={(x) => setEmp(i, 'name', x.target.value)} aria-label="Name" placeholder="Name" />
                <input className="input" type="email" value={e.email ?? ''} onChange={(x) => setEmp(i, 'email', x.target.value)} aria-label="Email" placeholder={opt.email_domain ? `${(e.name || '').split(' ')[0].toLowerCase()}@${opt.email_domain}` : 'Email'} />
                <Select value={e.department ?? ''} onChange={(v) => setEmp(i, 'department', v)} placeholder="No department" options={deptNames.map((n: string) => ({ value: n, label: n }))} aria-label="Department" />
                <Select value={e.company ?? ''} onChange={(v) => setEmp(i, 'company', v)} placeholder="No company" options={companyNames.map((n: string) => ({ value: n, label: n }))} aria-label="Company" />
                <Select value={e.role ?? 'employee'} onChange={(v) => setEmp(i, 'role', v)} options={roles.map((r: any) => ({ value: r.key, label: r.name }))} aria-label="Role" />
                <button className="btn-ghost btn-sm" aria-label={`Remove ${e.name}`} onClick={() => setS({ ...s, employees: s.employees.filter((_: any, j: number) => j !== i) })}><Trash2 className="h-4 w-4" /></button>
                <input className="input sm:col-span-2 lg:col-span-6" value={(e.designations ?? []).join(', ')} onChange={(x) => setEmp(i, 'designations', x.target.value.split(',').map((t: string) => t.trim()))} aria-label="Designations" placeholder="Designations, comma-separated (first is primary)" />
              </div>
            ))}</div>
            <button className="btn-ghost btn-sm mt-1" onClick={() => setS({ ...s, employees: [...s.employees, { name: '', role: 'employee', manager: s.employees[0]?.name }] })}><Plus className="h-3.5 w-3.5" /> Employee</button>
          </section>
          <section className="grid gap-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50 sm:grid-cols-3">
            <Field label="Email domain for blank emails" hint="e.g. rajlaxmisolutions.com → neha@rajlaxmisolutions.com"><input className="input" value={opt.email_domain} onChange={(e) => { setOpt({ ...opt, email_domain: e.target.value.trim() }); setResult(null); }} /></Field>
            <Field label="Temporary password (optional)" hint="Leave blank to generate one per person. Everyone changes it at first sign-in."><input className="input" type="text" autoComplete="off" value={opt.temporary_password} onChange={(e) => setOpt({ ...opt, temporary_password: e.target.value })} /></Field>
            <label className="flex items-start gap-2 pt-6 text-sm"><input type="checkbox" checked={opt.apply_templates} onChange={(e) => setOpt({ ...opt, apply_templates: e.target.checked })} /> Add the department’s starter checklist questions to new departments</label>
          </section>
          {result && <PlanTable plan={result.plan} />}
          {!result && <p className="muted text-sm">Preview first — Apply is enabled after a preview.</p>}
        </div>
      )}
    </Modal>
  );
}

function PlanTable({ plan, applied }: { plan: any[]; applied?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead><tr className="text-left text-xs text-slate-500"><th className="py-1.5">Record</th><th>Name</th><th>Result</th><th>Details</th></tr></thead>
        <tbody>{plan.map((p, i) => (
          <tr key={i} className="border-t align-top dark:border-slate-800">
            <td className="py-1.5 capitalize">{p.kind}</td>
            <td className="font-medium">{p.name}{p.email && <span className="muted block text-xs font-normal">{p.email}</span>}</td>
            <td><span className={clsx('badge', ACTION_TONE[p.action])}>{(applied ? DONE_LABEL : ACTION_LABEL)[p.action]}</span></td>
            <td className={clsx('text-xs', p.error ? 'text-rose-600' : 'text-slate-500 dark:text-slate-400')}>{p.error ?? p.details.join(' · ')}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
