import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, Copy, Eye, FileStack, ListPlus, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDateTime, humanize, todayIso } from '../../lib/format';
import { useAction, useApi } from '../../lib/hooks';
import { Card, Chips, clsx, confirm, DataTable, Empty, Field, Loading, Modal, PageHeader, PriorityBadge, SearchInput, Select, StatusBadge, Tabs, UserPicker } from '../../components/ui';
import { CHANNEL_OPTS } from '../notifications/ReminderForm';
import { ANSWER_TYPE_LABELS, REPORT_TAG_LABELS } from './answers';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const OPS: Record<string, string> = { equals: 'equals', not_equals: 'does not equal', contains: 'contains', gt: 'is greater than', lt: 'is less than', answered: 'is answered', not_answered: 'is not answered' };
const ESC_ROLES: Record<string, string> = { employee: 'Employee', team_leader: 'Team leader', hod: 'Head of department', manager: 'Reporting manager', admin: 'Super admins', director: 'Directors' };

export default function QuestionBuilder() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'questions';
  return (
    <div>
      <PageHeader title="Question builder" subtitle="Questions are generated into each employee’s daily checklist from this configuration." />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} tabs={[
        { value: 'questions', label: 'Questions' }, { value: 'sections', label: 'Sections' }, { value: 'templates', label: 'Templates' },
        { value: 'escalations', label: 'Escalation rules' }, { value: 'preview', label: 'Preview' },
      ]} />
      {tab === 'questions' && <Questions />}
      {tab === 'sections' && <Sections />}
      {tab === 'templates' && <Templates />}
      {tab === 'escalations' && <Escalations />}
      {tab === 'preview' && <Preview />}
    </div>
  );
}

// =========================================================================== questions
function Questions() {
  const [q, setQ] = useState('');
  const [section, setSection] = useState('');
  const [dept, setDept] = useState('');
  const [active, setActive] = useState<'all' | 'true' | 'false'>('all');
  const [edit, setEdit] = useState<any>(null);
  const { data: rows = [], isLoading } = useApi<any[]>(['questions', q, section, dept, active], '/questions', { q, section_id: section, department_id: dept, active: active === 'all' ? undefined : active });
  const { data: sections = [] } = useApi<any[]>(['question-sections'], '/questions/sections');
  const { data: depts = [] } = useApi<any[]>(['departments'], '/org/departments');
  const inv = [['questions'], ['question-sections']];
  const act = useAction((f: () => Promise<any>) => f(), { invalidate: inv });

  const grouped = useMemo(() => {
    const m = new Map<string, { id: number | null; name: string; items: any[] }>();
    for (const r of rows) {
      const k = String(r.section_id ?? 'none');
      if (!m.has(k)) m.set(k, { id: r.section_id, name: r.section_name ?? 'No section', items: [] });
      m.get(k)!.items.push(r);
    }
    return [...m.values()];
  }, [rows]);

  const move = (list: any[], idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= list.length) return;
    const order = [...list];
    [order[idx], order[j]] = [order[j], order[idx]];
    act.mutate(() => api('/questions/reorder', { method: 'POST', body: { items: order.map((r, i) => ({ id: r.id, section_id: r.section_id, sort_order: (i + 1) * 10 })) } }));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <SearchInput value={q} onChange={setQ} placeholder="Search questions…" className="md:w-72" />
        <Select value={section} onChange={setSection} placeholder="All sections" options={sections.map((s: any) => ({ value: s.id, label: s.name }))} className="md:w-48" />
        <Select value={dept} onChange={setDept} placeholder="All departments" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} className="md:w-48" />
        <Select value={active} onChange={(v) => setActive(v as any)} options={[{ value: 'all', label: 'Active & inactive' }, { value: 'true', label: 'Active only' }, { value: 'false', label: 'Inactive only' }]} className="md:w-44" />
        <button className="btn-primary md:ml-auto" onClick={() => setEdit({})}><Plus className="h-4 w-4" /> New question</button>
      </div>
      {isLoading ? <Loading /> : !rows.length ? (
        <Card><Empty icon={ListPlus} title="No questions yet" hint="Create a question, or apply one of the department templates." action={<button className="btn-primary" onClick={() => setEdit({})}><Plus className="h-4 w-4" /> New question</button>} /></Card>
      ) : grouped.map((g) => (
        <Card key={String(g.id)} title={<>{g.name} <span className="muted text-xs font-normal">· {g.items.length}</span></>} pad={false}>
          <ul className="divide-y dark:divide-slate-800">
            {g.items.map((r, idx) => (
              <li key={r.id} className={clsx('flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:px-5', !r.is_active && 'opacity-60')}>
                <div className="min-w-0 flex-1">
                  <button className="text-left text-sm font-medium hover:text-brand-600" onClick={() => setEdit(r)}>
                    {r.text}{r.is_required && <span className="text-rose-600">*</span>}
                  </button>
                  <div className="muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span>{ANSWER_TYPE_LABELS[r.answer_type]}</span>
                    <span>{r.frequency_label} · due {r.deadline_time}</span>
                    <span>{r.assignment_label}</span>
                    {r.condition_question_id && <span className="text-violet-600 dark:text-violet-400">conditional</span>}
                    <span>{REPORT_TAG_LABELS[r.report_tag]?.split(' (')[0]}</span>
                    <span>answered {r.times_answered}/{r.times_asked}</span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  {r.priority !== 'medium' && <PriorityBadge priority={r.priority} />}
                  {!r.is_active && <StatusBadge status="paused" label="Inactive" />}
                  <button className="btn-ghost btn-sm" title="Move up" aria-label="Move up" disabled={idx === 0} onClick={() => move(g.items, idx, -1)}><ArrowUp className="h-4 w-4" /></button>
                  <button className="btn-ghost btn-sm" title="Move down" aria-label="Move down" disabled={idx === g.items.length - 1} onClick={() => move(g.items, idx, 1)}><ArrowDown className="h-4 w-4" /></button>
                  <button className="btn-ghost btn-sm" title="Edit" aria-label="Edit" onClick={() => setEdit(r)}><Pencil className="h-4 w-4" /></button>
                  <button className="btn-ghost btn-sm" title="Duplicate (created inactive)" aria-label="Duplicate" onClick={() => act.mutate(() => api(`/questions/${r.id}/duplicate`, { method: 'POST' }))}><Copy className="h-4 w-4" /></button>
                  <button className="btn-ghost btn-sm" title={r.is_active ? 'Deactivate' : 'Activate'} aria-label={r.is_active ? 'Deactivate' : 'Activate'} onClick={() => act.mutate(() => api(`/questions/${r.id}`, { method: 'PATCH', body: { is_active: !r.is_active } }))}><Power className={clsx('h-4 w-4', r.is_active ? 'text-emerald-600' : 'text-slate-400')} /></button>
                  <button className="btn-ghost btn-sm" title="Delete" aria-label="Delete" onClick={async () => {
                    if (await confirm({ title: 'Delete question?', message: 'It stops appearing in new checklists. Submitted answers and history are kept.', danger: true, confirmLabel: 'Delete' })) act.mutate(() => api(`/questions/${r.id}`, { method: 'DELETE' }));
                  }}><Trash2 className="h-4 w-4" /></button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      {edit && <QuestionForm item={edit} sections={sections} depts={depts} questions={rows} onClose={() => setEdit(null)} />}
    </div>
  );
}

export function FrequencyEditor({ frequency, config, onChange }: { frequency: string; config: any; onChange: (f: string, c: any) => void }) {
  const c = config ?? {};
  const weekdays = (key = 'weekdays') => (
    <div><span className="label">Days of the week</span>
      <Chips multi value={(c[key] ?? []).map(String)} onChange={(v: string[]) => onChange(frequency, { ...c, [key]: v.map(Number).sort() })} options={WEEKDAYS.map((d, i) => ({ value: String(i + 1), label: d }))} />
    </div>
  );
  const monthDays = () => (
    <Field label="Days of the month" hint="Comma separated, e.g. 1, 15, last">
      <input className="input" value={(c.month_days ?? []).map((d: number) => (d === -1 ? 'last' : d)).join(', ')}
        onChange={(e) => onChange(frequency, { ...c, month_days: e.target.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).map((x) => (x === 'last' ? -1 : Number(x))).filter((n) => n === -1 || (n >= 1 && n <= 31)) })} />
    </Field>
  );
  return (
    <div className="space-y-3 rounded-lg border p-3 dark:border-slate-700">
      <Chips value={frequency} onChange={(f: string) => onChange(f, f === 'daily' ? { working_days_only: true } : f === 'weekly' ? { weekdays: [1] } : f === 'monthly' ? { month_days: [1] } : f === 'specific_dates' ? { dates: [] } : { every: 2, unit: 'week', weekdays: [1] })}
        options={[{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }, { value: 'specific_dates', label: 'Specific dates' }, { value: 'custom', label: 'Custom' }]} />
      {frequency === 'daily' && (
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!c.working_days_only} onChange={(e) => onChange(frequency, { ...c, working_days_only: e.target.checked })} /> Working days only</label>
          <label className="flex items-center gap-2 text-sm">Every <input className="input w-20" type="number" min={1} max={365} value={c.interval ?? 1} onChange={(e) => onChange(frequency, { ...c, interval: Math.max(1, Number(e.target.value) || 1) })} /> day(s)</label>
        </div>
      )}
      {frequency === 'weekly' && <>{weekdays()}<label className="flex items-center gap-2 text-sm">Every <input className="input w-20" type="number" min={1} max={52} value={c.interval ?? 1} onChange={(e) => onChange(frequency, { ...c, interval: Math.max(1, Number(e.target.value) || 1) })} /> week(s)</label></>}
      {frequency === 'monthly' && monthDays()}
      {frequency === 'specific_dates' && (
        <div>
          <div className="flex gap-2"><input id="add-date" className="input w-44" type="date" min={todayIso()} /><button type="button" className="btn-secondary" onClick={() => { const el = document.getElementById('add-date') as HTMLInputElement; if (el.value && !(c.dates ?? []).includes(el.value)) onChange(frequency, { dates: [...(c.dates ?? []), el.value].sort() }); }}>Add date</button></div>
          <div className="mt-2 flex flex-wrap gap-1.5">{(c.dates ?? []).map((d: string) => <button key={d} type="button" className="chip chip-off" onClick={() => onChange(frequency, { dates: c.dates.filter((x: string) => x !== d) })}>{d} ✕</button>)}</div>
        </div>
      )}
      {frequency === 'custom' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">Every <input className="input w-20" type="number" min={1} max={365} value={c.every ?? 1} onChange={(e) => onChange(frequency, { ...c, every: Math.max(1, Number(e.target.value) || 1) })} />
            <Select value={c.unit ?? 'week'} onChange={(u) => onChange(frequency, { every: c.every ?? 1, unit: u, ...(u === 'week' ? { weekdays: c.weekdays ?? [1] } : u === 'month' ? { month_days: c.month_days ?? [1] } : { working_days_only: c.working_days_only }) })} options={[{ value: 'day', label: 'day(s)' }, { value: 'week', label: 'week(s)' }, { value: 'month', label: 'month(s)' }]} className="w-32" /></div>
          {c.unit === 'week' && weekdays()}
          {c.unit === 'month' && monthDays()}
          {c.unit === 'day' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!c.working_days_only} onChange={(e) => onChange(frequency, { ...c, working_days_only: e.target.checked })} /> Working days only</label>}
          <p className="muted text-xs">Counted from the start date.</p>
        </div>
      )}
    </div>
  );
}

function AssignmentEditor({ value, onChange, depts }: { value: any; onChange: (v: any) => void; depts: any[] }) {
  return (
    <div className="space-y-2">
      <Chips value={value.mode} onChange={(m: string) => onChange({ ...value, mode: m })} options={[{ value: 'all', label: 'All active employees' }, { value: 'departments', label: 'Departments' }, { value: 'users', label: 'Selected employees' }, { value: 'none', label: 'Not assigned' }]} />
      {value.mode === 'departments' && <Chips multi value={value.department_ids.map(String)} onChange={(v: string[]) => onChange({ ...value, department_ids: v.map(Number) })} options={depts.map((d: any) => ({ value: String(d.id), label: d.name }))} />}
      {value.mode === 'users' && <UserPicker multi value={value.user_ids} onChange={(v: number[]) => onChange({ ...value, user_ids: v })} placeholder="Choose employees…" />}
    </div>
  );
}

function assignmentFrom(rows: any[] = []) {
  if (rows.some((a) => a.target_type === 'all')) return { mode: 'all', department_ids: [], user_ids: [] };
  const d = rows.filter((a) => a.target_type === 'department').map((a) => a.department_id);
  const u = rows.filter((a) => a.target_type === 'user').map((a) => a.user_id);
  if (d.length && !u.length) return { mode: 'departments', department_ids: d, user_ids: [] };
  if (u.length && !d.length) return { mode: 'users', department_ids: [], user_ids: u };
  if (d.length && u.length) return { mode: 'departments', department_ids: d, user_ids: u, mixed: true };
  return { mode: 'none', department_ids: [], user_ids: [] };
}

function OptionsEditor({ type, options, onChange }: { type: string; options: any; onChange: (o: any) => void }) {
  const o = options ?? {};
  if (type === 'single_choice' || type === 'multiple_choice') {
    const choices: string[] = o.choices ?? [];
    return (
      <div className="space-y-2"><span className="label">Choices</span>
        {choices.map((c, i) => (
          <div key={i} className="flex gap-2">
            <input className="input" value={c} onChange={(e) => onChange({ ...o, choices: choices.map((x, j) => (j === i ? e.target.value : x)) })} aria-label={`Choice ${i + 1}`} />
            <button type="button" className="btn-ghost btn-sm" aria-label="Remove choice" onClick={() => onChange({ ...o, choices: choices.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        <button type="button" className="btn-secondary btn-sm" onClick={() => onChange({ ...o, choices: [...choices, ''] })}><Plus className="h-3.5 w-3.5" /> Add choice</button>
      </div>
    );
  }
  if (type === 'number') {
    const num = (k: string, v: string) => { const n = { ...o }; if (v === '') delete n[k]; else n[k] = Number(v); onChange(n); };
    return (
      <div className="grid grid-cols-3 gap-2">
        <Field label="Minimum"><input className="input" type="number" value={o.min ?? ''} onChange={(e) => num('min', e.target.value)} /></Field>
        <Field label="Maximum"><input className="input" type="number" value={o.max ?? ''} onChange={(e) => num('max', e.target.value)} /></Field>
        <Field label="Unit"><input className="input" value={o.unit ?? ''} placeholder="records" onChange={(e) => onChange({ ...o, unit: e.target.value || undefined })} /></Field>
      </div>
    );
  }
  if (['text', 'long_text'].includes(type)) return <Field label="Placeholder (optional)"><input className="input" value={o.placeholder ?? ''} onChange={(e) => onChange({ ...o, placeholder: e.target.value || undefined })} /></Field>;
  return null;
}

const cleanOptions = (type: string, o: any) => {
  const out: any = {};
  if (type === 'single_choice' || type === 'multiple_choice') out.choices = (o.choices ?? []).map((c: string) => c.trim()).filter(Boolean);
  if (type === 'number') { for (const k of ['min', 'max']) if (o[k] !== undefined && o[k] !== '') out[k] = o[k]; if (o.unit) out.unit = o.unit; }
  if (['text', 'long_text'].includes(type) && o.placeholder) out.placeholder = o.placeholder;
  return out;
};

function QuestionForm({ item, sections, depts, questions, onClose }: { item: any; sections: any[]; depts: any[]; questions: any[]; onClose: () => void }) {
  const isNew = !item.id;
  const { data: detail } = useApi<any>(['question', item.id], item.id ? `/questions/${item.id}` : null);
  const [f, setF] = useState<any>(() => ({
    text: item.text ?? '', help_text: item.help_text ?? '', section_id: item.section_id ?? '', answer_type: item.answer_type ?? 'text', options: item.options ?? {},
    is_required: item.is_required ?? true, priority: item.priority ?? 'medium', report_tag: item.report_tag ?? 'other',
    frequency: item.frequency ?? 'daily', frequency_config: item.frequency_config ?? { working_days_only: true }, start_date: item.start_date ?? '', end_date: item.end_date ?? '',
    deadline_time: item.deadline_time ?? '18:00', reminder_offsets: item.reminder_offsets ?? [60],
    condition_question_id: item.condition_question_id ?? '', condition_operator: item.condition_operator ?? 'equals', condition_value: item.condition_value ?? '',
    is_active: item.is_active ?? true, assignment: assignmentFrom(item.assignments),
  }));
  useEffect(() => { if (detail) setF((x: any) => ({ ...x, assignment: assignmentFrom(detail.assignments) })); }, [detail?.id]);
  const s = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const controller = questions.find((q) => q.id === Number(f.condition_question_id));
  const needsValue = !['answered', 'not_answered'].includes(f.condition_operator);
  const body = () => {
    const a = f.assignment;
    return {
      text: f.text, help_text: f.help_text || null, section_id: f.section_id ? Number(f.section_id) : null, answer_type: f.answer_type, options: cleanOptions(f.answer_type, f.options),
      is_required: f.is_required, priority: f.priority, report_tag: f.report_tag, frequency: f.frequency, frequency_config: f.frequency_config,
      start_date: f.start_date || null, end_date: f.end_date || null, deadline_time: f.deadline_time, reminder_offsets: f.reminder_offsets,
      condition_question_id: f.condition_question_id ? Number(f.condition_question_id) : null,
      ...(f.condition_question_id ? { condition_operator: f.condition_operator, condition_value: needsValue ? coerce(controller?.answer_type, f.condition_value) : null } : {}),
      is_active: f.is_active,
      assignment: a.mixed ? undefined : { mode: a.mode, department_ids: a.department_ids, user_ids: a.user_ids },
    };
  };
  const save = useAction(() => api(isNew ? '/questions' : `/questions/${item.id}`, { method: isNew ? 'POST' : 'PATCH', body: body() }), { invalidate: [['questions'], ['question-sections'], ['question', item.id]], success: isNew ? 'Question created' : 'Question saved', onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={isNew ? 'New question' : 'Edit question'} size="xl" footer={<>
      <button className="btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn-primary" disabled={f.text.trim().length < 2 || save.isPending} onClick={() => save.mutate(undefined)}>{isNew ? 'Create question' : 'Save changes'}</button>
    </>}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Question" className="md:col-span-2"><input className="input" value={f.text} maxLength={1000} onChange={(e) => s('text', e.target.value)} autoFocus /></Field>
        <Field label="Help text (optional)" className="md:col-span-2"><input className="input" value={f.help_text} onChange={(e) => s('help_text', e.target.value)} /></Field>
        <Field label="Answer type"><Select value={f.answer_type} onChange={(v) => s('answer_type', v)} options={Object.entries(ANSWER_TYPE_LABELS).map(([value, label]) => ({ value, label }))} /></Field>
        <Field label="Section"><Select value={f.section_id} onChange={(v) => s('section_id', v)} placeholder="No section" options={sections.map((x: any) => ({ value: x.id, label: x.name }))} /></Field>
        <div className="md:col-span-2"><OptionsEditor type={f.answer_type} options={f.options} onChange={(o) => s('options', o)} /></div>
        <Field label="Priority"><Select value={f.priority} onChange={(v) => s('priority', v)} options={['low', 'medium', 'high', 'critical'].map((p) => ({ value: p, label: humanize(p) }))} /></Field>
        <Field label="Use in EOD report as" hint="Decides which EOD section the answer is consolidated into"><Select value={f.report_tag} onChange={(v) => s('report_tag', v)} options={Object.entries(REPORT_TAG_LABELS).map(([value, label]) => ({ value, label }))} /></Field>
        <div className="flex flex-wrap items-center gap-5 md:col-span-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_required} onChange={(e) => s('is_required', e.target.checked)} /> Mandatory</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.is_active} onChange={(e) => s('is_active', e.target.checked)} /> Active</label>
        </div>

        <div className="md:col-span-2"><span className="label">Frequency</span><FrequencyEditor frequency={f.frequency} config={f.frequency_config} onChange={(fr, c) => setF((x: any) => ({ ...x, frequency: fr, frequency_config: c }))} /></div>
        <Field label="Start date (optional)"><input className="input" type="date" value={f.start_date ?? ''} onChange={(e) => s('start_date', e.target.value)} /></Field>
        <Field label="End date (optional)"><input className="input" type="date" value={f.end_date ?? ''} onChange={(e) => s('end_date', e.target.value)} /></Field>
        <Field label="Submission deadline (each employee’s local time)"><input className="input" type="time" value={f.deadline_time} onChange={(e) => s('deadline_time', e.target.value)} /></Field>
        <div><span className="label">Reminders before the deadline</span>
          <Chips multi value={f.reminder_offsets.map(String)} onChange={(v: string[]) => s('reminder_offsets', v.map(Number).sort((a, b) => b - a).slice(0, 5))} options={[[15, '15 min'], [30, '30 min'], [60, '1 h'], [120, '2 h'], [240, '4 h'], [1440, '1 day']].map(([v, l]) => ({ value: String(v), label: String(l) }))} />
        </div>

        <div className="space-y-2 md:col-span-2">
          <span className="label">Show this question only when… (optional)</span>
          <div className="grid gap-2 md:grid-cols-3">
            <Select value={f.condition_question_id} onChange={(v) => s('condition_question_id', v)} placeholder="Always show" options={questions.filter((q) => q.id !== item.id).map((q) => ({ value: q.id, label: q.text.slice(0, 80) }))} />
            {f.condition_question_id && <Select value={f.condition_operator} onChange={(v) => s('condition_operator', v)} options={Object.entries(OPS).map(([value, label]) => ({ value, label }))} />}
            {f.condition_question_id && needsValue && (controller?.answer_type === 'yes_no'
              ? <Select value={String(f.condition_value)} onChange={(v) => s('condition_value', v)} options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} />
              : ['single_choice', 'multiple_choice'].includes(controller?.answer_type)
                ? <Select value={f.condition_value} onChange={(v) => s('condition_value', v)} options={(controller.options?.choices ?? []).map((c: string) => ({ value: c, label: c }))} placeholder="Choose…" />
                : <input className="input" value={f.condition_value ?? ''} onChange={(e) => s('condition_value', e.target.value)} placeholder="Value" />)}
          </div>
        </div>

        <div className="md:col-span-2"><span className="label">Who answers this question</span>
          {f.assignment.mixed ? <p className="muted text-sm">Assigned to departments and individual employees. <button className="text-brand-600 hover:underline" onClick={() => s('assignment', { ...f.assignment, mixed: false })}>Replace assignment</button></p>
            : <AssignmentEditor value={f.assignment} onChange={(a) => s('assignment', a)} depts={depts} />}
        </div>

        {detail?.history?.length > 0 && (
          <div className="md:col-span-2">
            <span className="label">Change history</span>
            <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
              {detail.history.map((h: any) => <li key={h.id} className="muted"><span className="text-slate-700 dark:text-slate-300">{fmtDateTime(h.created_at)}</span> · {h.actor_name ?? 'System'} · {humanize(h.action.replace('question.', ''))}{h.after && Object.keys(h.after).length ? ` (${Object.keys(h.after).join(', ')})` : ''}</li>)}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

function coerce(type: string | undefined, v: any) {
  if (type === 'yes_no') return v === true || v === 'true';
  if (type === 'number' || type === 'rating') return Number(v);
  return v;
}

// =========================================================================== sections
function Sections() {
  const { data = [], isLoading } = useApi<any[]>(['question-sections'], '/questions/sections');
  const [edit, setEdit] = useState<any>(null);
  const act = useAction((f: () => Promise<any>) => f(), { invalidate: [['question-sections'], ['questions']] });
  const move = (i: number, dir: -1 | 1) => { const ids = data.map((s: any) => s.id); const j = i + dir; [ids[i], ids[j]] = [ids[j], ids[i]]; act.mutate(() => api('/questions/sections/reorder', { method: 'POST', body: { ids } })); };
  if (isLoading) return <Loading />;
  return (
    <Card title="Sections" actions={<button className="btn-primary btn-sm" onClick={() => setEdit({})}><Plus className="h-4 w-4" /> New section</button>} pad={false}>
      {!data.length ? <Empty title="No sections" hint="Sections group questions on the employee checklist." /> : (
        <ul className="divide-y dark:divide-slate-800">
          {data.map((s: any, i: number) => (
            <li key={s.id} className={clsx('flex items-center gap-2 px-4 py-3 sm:px-5', !s.is_active && 'opacity-60')}>
              <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{s.name}</p><p className="muted truncate text-xs">{s.question_count} question(s){s.description ? ` · ${s.description}` : ''}</p></div>
              {!s.is_active && <StatusBadge status="paused" label="Inactive" />}
              <button className="btn-ghost btn-sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></button>
              <button className="btn-ghost btn-sm" aria-label="Move down" disabled={i === data.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></button>
              <button className="btn-ghost btn-sm" aria-label="Edit" onClick={() => setEdit(s)}><Pencil className="h-4 w-4" /></button>
              <button className="btn-ghost btn-sm" aria-label={s.is_active ? 'Deactivate' : 'Activate'} onClick={() => act.mutate(() => api(`/questions/sections/${s.id}`, { method: 'PATCH', body: { is_active: !s.is_active } }))}><Power className="h-4 w-4" /></button>
              <button className="btn-ghost btn-sm" aria-label="Delete" onClick={async () => { if (await confirm({ title: `Delete “${s.name}”?`, message: 'Its questions are kept and become unsectioned.', danger: true, confirmLabel: 'Delete' })) act.mutate(() => api(`/questions/sections/${s.id}`, { method: 'DELETE' })); }}><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
        </ul>
      )}
      {edit && <SectionForm item={edit} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function SectionForm({ item, onClose }: { item: any; onClose: () => void }) {
  const [name, setName] = useState(item.name ?? '');
  const [description, setDescription] = useState(item.description ?? '');
  const save = useAction(() => api(item.id ? `/questions/sections/${item.id}` : '/questions/sections', { method: item.id ? 'PATCH' : 'POST', body: { name, description: description || null } }), { invalidate: [['question-sections'], ['questions']], success: 'Section saved', onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={item.id ? 'Edit section' : 'New section'} size="sm" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!name.trim()} onClick={() => save.mutate(undefined)}>Save</button></>}>
      <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <Field label="Description" className="mt-3"><textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
    </Modal>
  );
}

// =========================================================================== templates
function Templates() {
  const { data = [], isLoading } = useApi<any[]>(['question-templates'], '/questions/templates');
  const { data: depts = [] } = useApi<any[]>(['departments'], '/org/departments');
  const [apply, setApply] = useState<any>(null);
  const [item, setItem] = useState<any>(null);
  const [newTpl, setNewTpl] = useState(false);
  const act = useAction((f: () => Promise<any>) => f(), { invalidate: [['question-templates']] });
  if (isLoading) return <Loading />;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="muted text-sm">Editable starting points. Applying a template copies its questions into a new section and assigns them.</p>
        <button className="btn-secondary shrink-0" onClick={() => setNewTpl(true)}><Plus className="h-4 w-4" /> New template</button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {data.map((t: any) => (
          <Card key={t.id} title={t.name} actions={<>
            <button className="btn-primary btn-sm" disabled={!t.items.length} onClick={() => setApply(t)}><FileStack className="h-4 w-4" /> Apply</button>
            <button className="btn-ghost btn-sm" aria-label="Delete template" onClick={async () => { if (await confirm({ title: `Delete template “${t.name}”?`, message: 'Questions already created from it are not affected.', danger: true, confirmLabel: 'Delete' })) act.mutate(() => api(`/questions/templates/${t.id}`, { method: 'DELETE' })); }}><Trash2 className="h-4 w-4" /></button>
          </>} pad={false}>
            {t.description && <p className="muted px-4 pt-3 text-xs sm:px-5">{t.description}</p>}
            <ul className="divide-y dark:divide-slate-800">
              {t.items.map((i: any) => (
                <li key={i.id} className="flex items-center gap-2 px-4 py-2 sm:px-5">
                  <div className="min-w-0 flex-1"><p className="truncate text-sm">{i.text}{i.is_required && <span className="text-rose-600">*</span>}</p><p className="muted text-xs">{ANSWER_TYPE_LABELS[i.answer_type]} · {REPORT_TAG_LABELS[i.report_tag]?.split(' (')[0]}</p></div>
                  <button className="btn-ghost btn-sm" aria-label="Edit template question" onClick={() => setItem({ ...i, template_id: t.id })}><Pencil className="h-4 w-4" /></button>
                  <button className="btn-ghost btn-sm" aria-label="Remove template question" onClick={() => act.mutate(() => api(`/questions/template-items/${i.id}`, { method: 'DELETE' }))}><Trash2 className="h-4 w-4" /></button>
                </li>
              ))}
            </ul>
            <div className="px-4 py-3 sm:px-5"><button className="btn-secondary btn-sm" onClick={() => setItem({ template_id: t.id })}><Plus className="h-3.5 w-3.5" /> Add question</button></div>
          </Card>
        ))}
      </div>
      {apply && <ApplyTemplate tpl={apply} depts={depts} onClose={() => setApply(null)} />}
      {item && <TemplateItemForm item={item} onClose={() => setItem(null)} />}
      {newTpl && <NewTemplate onClose={() => setNewTpl(false)} />}
    </div>
  );
}

function NewTemplate({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const save = useAction(() => api('/questions/templates', { method: 'POST', body: { name, description: description || null } }), { invalidate: [['question-templates']], success: 'Template created', onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title="New template" size="sm" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={name.trim().length < 2} onClick={() => save.mutate(undefined)}>Create</button></>}>
      <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <Field label="Description" className="mt-3"><textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
    </Modal>
  );
}

function TemplateItemForm({ item, onClose }: { item: any; onClose: () => void }) {
  const [f, setF] = useState<any>({ text: item.text ?? '', help_text: item.help_text ?? '', answer_type: item.answer_type ?? 'text', options: item.options ?? {}, is_required: item.is_required ?? true, priority: item.priority ?? 'medium', report_tag: item.report_tag ?? 'other' });
  const s = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const save = useAction(() => api(item.id ? `/questions/template-items/${item.id}` : `/questions/templates/${item.template_id}/items`, { method: item.id ? 'PATCH' : 'POST', body: { ...f, help_text: f.help_text || null, options: cleanOptions(f.answer_type, f.options) } }), { invalidate: [['question-templates']], success: 'Template question saved', onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={item.id ? 'Edit template question' : 'Add template question'} size="lg" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={f.text.trim().length < 2} onClick={() => save.mutate(undefined)}>Save</button></>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Question" className="md:col-span-2"><input className="input" value={f.text} onChange={(e) => s('text', e.target.value)} autoFocus /></Field>
        <Field label="Help text" className="md:col-span-2"><input className="input" value={f.help_text} onChange={(e) => s('help_text', e.target.value)} /></Field>
        <Field label="Answer type"><Select value={f.answer_type} onChange={(v) => s('answer_type', v)} options={Object.entries(ANSWER_TYPE_LABELS).map(([value, label]) => ({ value, label }))} /></Field>
        <Field label="Use in EOD report as"><Select value={f.report_tag} onChange={(v) => s('report_tag', v)} options={Object.entries(REPORT_TAG_LABELS).map(([value, label]) => ({ value, label }))} /></Field>
        <div className="md:col-span-2"><OptionsEditor type={f.answer_type} options={f.options} onChange={(o) => s('options', o)} /></div>
        <Field label="Priority"><Select value={f.priority} onChange={(v) => s('priority', v)} options={['low', 'medium', 'high', 'critical'].map((p) => ({ value: p, label: humanize(p) }))} /></Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={f.is_required} onChange={(e) => s('is_required', e.target.checked)} /> Mandatory</label>
      </div>
    </Modal>
  );
}

function ApplyTemplate({ tpl, depts, onClose }: { tpl: any; depts: any[]; onClose: () => void }) {
  const [a, setA] = useState<any>({ mode: 'departments', department_ids: [], user_ids: [] });
  const [section, setSection] = useState(tpl.name);
  const [deadline, setDeadline] = useState('18:00');
  const [freq, setFreq] = useState<{ f: string; c: any }>({ f: 'daily', c: { working_days_only: true } });
  const save = useAction(() => api(`/questions/templates/${tpl.id}/apply`, { method: 'POST', body: { ...a, section_name: section, deadline_time: deadline, reminder_offsets: [60], frequency: freq.f, frequency_config: freq.c } }),
    { invalidate: [['questions'], ['question-sections']], success: (r: any) => `${r.questionIds.length} questions created`, onSuccess: onClose });
  const ok = a.mode === 'all' || (a.mode === 'departments' && a.department_ids.length) || (a.mode === 'users' && a.user_ids.length);
  return (
    <Modal open onClose={onClose} title={`Apply “${tpl.name}” template`} size="lg" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!ok || save.isPending} onClick={() => save.mutate(undefined)}>Create {tpl.items.length} questions</button></>}>
      <div className="space-y-4">
        <Field label="Section name"><input className="input" value={section} onChange={(e) => setSection(e.target.value)} /></Field>
        <div><span className="label">Assign to</span><AssignmentEditor value={a} onChange={setA} depts={depts.filter(Boolean)} /></div>
        <div><span className="label">Frequency</span><FrequencyEditor frequency={freq.f} config={freq.c} onChange={(f, c) => setFreq({ f, c })} /></div>
        <Field label="Deadline (employee local time)" className="w-48"><input className="input" type="time" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></Field>
        <p className="muted text-xs">Every created question stays fully editable afterwards.</p>
      </div>
    </Modal>
  );
}

// =========================================================================== escalation rules
function Escalations() {
  const { data = [], isLoading } = useApi<any[]>(['checklist-escalations'], '/questions/escalation-rules');
  const { data: depts = [] } = useApi<any[]>(['departments'], '/org/departments');
  const [edit, setEdit] = useState<any>(null);
  const act = useAction((f: () => Promise<any>) => f(), { invalidate: [['checklist-escalations']] });
  if (isLoading) return <Loading />;
  return (
    <Card title="Incomplete checklist escalations" actions={<button className="btn-primary btn-sm" onClick={() => setEdit({})}><Plus className="h-4 w-4" /> New rule</button>} pad={false}>
      <p className="muted px-4 pt-3 text-xs sm:px-5">Each rule fires once per checklist when mandatory questions are still unanswered the given time after the deadline. Supervisors receive one combined message per run.</p>
      <div className="px-4 sm:px-0">
        <DataTable rows={data} onRowClick={setEdit} empty={<Empty title="No escalation rules" />} columns={[
          { key: 'name', header: 'Rule', render: (r: any) => <span className={clsx(!r.is_active && 'opacity-60')}>{r.name}</span> },
          { key: 'level', header: 'Level', render: (r: any) => `L${r.level}` },
          { key: 'offset_minutes', header: 'After deadline', render: (r: any) => (r.offset_minutes === 0 ? 'At deadline' : r.offset_minutes < 60 ? `${r.offset_minutes} min` : `${Math.round(r.offset_minutes / 60 * 10) / 10} h`) },
          { key: 'notify_roles', header: 'Notify', render: (r: any) => r.notify_roles.map((x: string) => ESC_ROLES[x]).join(', ') },
          { key: 'channels', header: 'Channels', render: (r: any) => r.channels.map(humanize).join(', ') },
          { key: 'department_name', header: 'Department', render: (r: any) => r.department_name ?? 'All' },
          { key: 'fired', header: 'Fired' },
          { key: 'actions', header: '', render: (r: any) => <button className="btn-ghost btn-sm" aria-label="Delete rule" onClick={async (e) => { e.stopPropagation(); if (await confirm({ title: 'Delete rule?', danger: true, confirmLabel: 'Delete' })) act.mutate(() => api(`/questions/escalation-rules/${r.id}`, { method: 'DELETE' })); }}><Trash2 className="h-4 w-4" /></button> },
        ]} />
      </div>
      {edit && <EscalationForm item={edit} depts={depts} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function EscalationForm({ item, depts, onClose }: { item: any; depts: any[]; onClose: () => void }) {
  const [f, setF] = useState<any>({ name: item.name ?? '', level: item.level ?? 1, offset_minutes: item.offset_minutes ?? 60, notify_roles: item.notify_roles ?? ['employee'], channels: item.channels ?? ['in_app', 'email'], department_id: item.department_id ?? '', is_active: item.is_active ?? true });
  const s = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const save = useAction(() => api(item.id ? `/questions/escalation-rules/${item.id}` : '/questions/escalation-rules', { method: item.id ? 'PATCH' : 'POST', body: { ...f, level: Number(f.level), offset_minutes: Number(f.offset_minutes), department_id: f.department_id ? Number(f.department_id) : null } }),
    { invalidate: [['checklist-escalations']], success: 'Rule saved', onSuccess: onClose });
  return (
    <Modal open onClose={onClose} title={item.id ? 'Edit escalation rule' : 'New escalation rule'} size="lg" footer={<><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={f.name.trim().length < 2 || !f.notify_roles.length || !f.channels.length} onClick={() => save.mutate(undefined)}>Save</button></>}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name" className="md:col-span-2"><input className="input" value={f.name} onChange={(e) => s('name', e.target.value)} /></Field>
        <Field label="Level"><input className="input" type="number" min={1} max={10} value={f.level} onChange={(e) => s('level', e.target.value)} /></Field>
        <Field label="Minutes after the deadline (0 = at deadline)"><input className="input" type="number" min={0} max={20160} value={f.offset_minutes} onChange={(e) => s('offset_minutes', e.target.value)} /></Field>
        <div className="md:col-span-2"><span className="label">Notify</span><Chips multi value={f.notify_roles} onChange={(v) => s('notify_roles', v)} options={Object.entries(ESC_ROLES).map(([value, label]) => ({ value, label }))} /></div>
        <div className="md:col-span-2"><span className="label">Channels</span><Chips multi value={f.channels} onChange={(v) => s('channels', v)} options={CHANNEL_OPTS} /></div>
        <Field label="Only for department"><Select value={f.department_id} onChange={(v) => s('department_id', v)} placeholder="All departments" options={depts.map((d: any) => ({ value: d.id, label: d.name }))} /></Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={f.is_active} onChange={(e) => s('is_active', e.target.checked)} /> Active</label>
      </div>
    </Modal>
  );
}

// =========================================================================== preview
function Preview() {
  const [user, setUser] = useState<number | null>(null);
  const [date, setDate] = useState(todayIso());
  const { data, isLoading } = useApi<any>(['question-preview', user, date], user ? '/questions/preview' : null, { user_id: user, date });
  return (
    <Card title="Which questions does an employee get on a date?">
      <div className="grid gap-3 md:grid-cols-[1fr_200px]">
        <Field label="Employee"><UserPicker value={user} onChange={setUser} placeholder="Choose an employee…" /></Field>
        <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <div className="mt-4">
        {!user ? <Empty icon={Eye} title="Choose an employee to preview" /> : isLoading ? <Loading /> : !data?.questions?.length ? <Empty title="No questions on this date" hint="Check the frequency, start/end dates and assignment." /> : (
          <ul className="divide-y text-sm dark:divide-slate-800">
            {data.questions.map((q: any) => <li key={q.id} className="flex justify-between gap-3 py-2"><span className="min-w-0">{q.text}<span className="muted block text-xs">{q.section_name ?? 'No section'}</span></span><span className="muted shrink-0 text-xs">due {q.deadline_time} · via {q.via === 'all' ? 'everyone' : q.via}</span></li>)}
          </ul>
        )}
      </div>
    </Card>
  );
}
