import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import { useAction, useApi } from '../../lib/hooks';
import { Card, DataTable, Empty, Field, Loading, Modal, Pagination, Select, StatusBadge, Tabs } from '../../components/ui';
import { ActivityItem } from './common';

/** Settings → Activity categories: add, rename, re-map, reorder and deactivate quick categories. */
export function ActivityCategoriesAdmin() {
  const { data = [], isLoading } = useApi<any[]>(['activity-categories', 'all'], '/activities/categories', { all: 'true' });
  const { data: meta } = useApi<any>(['activity-meta'], '/activities/meta', undefined, { staleTime: Infinity });
  const [edit, setEdit] = useState<any>(null);
  const inv = { invalidate: [['activity-categories']] };
  const save = useAction((b: any) => (edit?.id ? api(`/activities/categories/${edit.id}`, { method: 'PATCH', body: b }) : api('/activities/categories', { body: b })), { ...inv, success: 'Category saved', onSuccess: () => setEdit(null) });
  const toggle = useAction((c: any) => api(`/activities/categories/${c.id}`, { method: 'PATCH', body: { is_active: !c.is_active } }), { ...inv, success: 'Updated' });
  const move = useAction((ids: number[]) => api('/activities/categories/reorder', { body: { ids } }), inv);
  const sorted = [...data].sort((a, b) => a.sort_order - b.sort_order);
  const shift = (i: number, d: number) => { const ids = sorted.map((c) => c.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; move.mutate(ids); };
  const sections = meta?.report_sections ?? [];
  return (
    <Card title="Quick activity categories" pad={false} actions={<button className="btn-primary btn-sm" onClick={() => setEdit({ name: '', group_name: 'Other', report_section: 'other', suggests_employee: false })}><Plus className="h-3.5 w-3.5" /> Category</button>}>
      <p className="muted px-4 pt-3 text-sm sm:px-5">Shown in “Add Daily Activity”. Each person sees their most-used categories first. Categories in use can be deactivated, not deleted, so history stays intact.</p>
      {isLoading ? <Loading /> : (
        <div className="px-4 sm:px-0">
          <DataTable rows={sorted} onRowClick={(c: any) => setEdit(c)} columns={[
            { key: 'order', header: '', render: (c: any) => { const i = sorted.indexOf(c); return <span className="flex" onClick={(e) => e.stopPropagation()}><button className="btn-ghost btn-sm" aria-label="Move up" disabled={i === 0} onClick={() => shift(i, -1)}><ArrowUp className="h-3.5 w-3.5" /></button><button className="btn-ghost btn-sm" aria-label="Move down" disabled={i === sorted.length - 1} onClick={() => shift(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></button></span>; } },
            { key: 'name', header: 'Category', render: (c: any) => <span className="font-medium">{c.name}</span> },
            { key: 'group_name', header: 'Group' },
            { key: 'report_section', header: 'EOD section', render: (c: any) => sections.find((s: any) => s.value === c.report_section)?.label ?? c.report_section },
            { key: 'suggests_employee', header: 'Employee first', render: (c: any) => (c.suggests_employee ? 'Yes' : '') },
            { key: 'total_uses', header: 'Used' },
            { key: 'is_active', header: 'Status', render: (c: any) => <span onClick={(e) => e.stopPropagation()} className="flex items-center gap-2"><StatusBadge status={c.is_active ? 'active' : 'cancelled'} label={c.is_active ? 'Active' : 'Inactive'} /><button className="btn-ghost btn-sm" onClick={() => toggle.mutate(c)}>{c.is_active ? 'Deactivate' : 'Activate'}</button></span> },
          ]} />
        </div>
      )}
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? `Edit “${edit.name}”` : 'New category'}
          footer={<><button className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button><button className="btn-primary" disabled={edit.name.trim().length < 2 || save.isPending} onClick={() => save.mutate({ name: edit.name.trim(), group_name: edit.group_name.trim() || 'Other', report_section: edit.report_section, suggests_employee: edit.suggests_employee })}>Save</button></>}>
          <div className="grid gap-3">
            <Field label="Name"><input className="input" value={edit.name} maxLength={80} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Group" hint="Groups organise the full category list."><input className="input" value={edit.group_name} maxLength={60} onChange={(e) => setEdit({ ...edit, group_name: e.target.value })} list="activity-groups" /></Field>
            <datalist id="activity-groups">{[...new Set(data.map((c: any) => c.group_name))].map((g: any) => <option key={g} value={g} />)}</datalist>
            <Field label="Personal EOD report section"><Select value={edit.report_section} onChange={(v) => setEdit({ ...edit, report_section: v })} options={sections} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.suggests_employee} onChange={(e) => setEdit({ ...edit, suggests_employee: e.target.checked })} /> Usually involves an employee</label>
          </div>
        </Modal>
      )}
    </Card>
  );
}

/** Employee profile: the activities they recorded, and the coordination history involving them. */
export function EmployeeWorkTabs({ userId }: { userId: number }) {
  const [tab, setTab] = useState('coordination');
  const [page, setPage] = useState(1);
  const own = useApi<any>(['activities', 'employee', userId, page], tab === 'activities' ? '/activities' : null, { user_id: userId, page, pageSize: 30 });
  const coord = useApi<any>(['coordination', 'employee', userId, undefined, page], tab === 'coordination' ? `/activities/coordination/employee/${userId}` : null, { page, pageSize: 30 });
  const q = tab === 'activities' ? own : coord;
  return (
    <Card title="Daily work & coordination">
      <Tabs value={tab} onChange={(v) => { setTab(v); setPage(1); }} tabs={[{ value: 'coordination', label: 'Coordination history' }, { value: 'activities', label: 'Their activities' }]} />
      {tab === 'coordination' && coord.data && (
        <p className="muted mb-3 text-xs">{coord.data.stats.total} entries · {coord.data.stats.open_follow_ups} open follow-ups · {coord.data.stats.resolved} issues resolved{coord.data.stats.last_at ? ` · last ${fmtDate(coord.data.stats.last_at)}` : ''}. A management record of coordination and guidance — not a performance rating.</p>
      )}
      {q.isLoading ? <Loading /> : q.error ? <p className="muted text-sm">Not available.</p> : !q.data?.items.length ? <Empty title={tab === 'coordination' ? 'No coordination recorded' : 'No activities recorded'} /> : (
        <>
          {q.data.items.map((a: any) => (
            <div key={a.id}>
              <div className="muted mb-1 ml-[4.25rem] text-xs">{fmtDate(a.activity_date)}{tab === 'coordination' ? ` · recorded by ${a.user_name}` : ''}</div>
              <ol><ActivityItem a={a} /></ol>
            </div>
          ))}
          <Pagination page={page} pageSize={30} total={q.data.total} onPage={setPage} />
        </>
      )}
    </Card>
  );
}
