import { useState } from 'react';
import { api, setAccessToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fromNow, browserTz } from '../lib/format';
import { useAction, useApi } from '../lib/hooks';
import { Card, Field, KV, PageHeader, Select } from '../components/ui';
import { toast } from '../components/Toast';
import { Preferences } from './notifications/NotificationsPage';

export default function Profile({ forced = false }: { forced?: boolean }) {
  const { user, setUser, logout } = useAuth();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [p, setP] = useState({ name: user!.name, phone: user!.phone ?? '', timezone: user!.timezone });
  const { data: tzs = [] } = useApi<string[]>(['timezones'], forced ? null : '/timezones', undefined, { staleTime: Infinity });
  const { data: sessions = [] } = useApi<any[]>(['sessions'], forced ? null : '/auth/sessions');
  const change = useAction(() => api('/auth/change-password', { body: { currentPassword: pw.currentPassword, newPassword: pw.newPassword } }), {
    success: 'Password changed — other sessions were signed out', onSuccess: (r: any) => { setAccessToken(r.accessToken); setUser(r.user); setPw({ currentPassword: '', newPassword: '', confirm: '' }); },
  });
  const save = useAction(() => api('/auth/me', { method: 'PATCH', body: { name: p.name, phone: p.phone || null, timezone: p.timezone } }), { success: 'Profile saved', onSuccess: (u: any) => setUser(u) });
  const revoke = useAction(() => api('/auth/sessions/revoke-all', { method: 'POST' }), { onSuccess: () => { toast.success('All sessions revoked'); logout(); } });
  const pwForm = (
    <Card title={forced ? 'Set a new password to continue' : 'Change password'}>
      <form className="grid gap-3 sm:max-w-md" onSubmit={(e) => { e.preventDefault(); if (pw.newPassword !== pw.confirm) return toast.error('Passwords do not match'); change.mutate(undefined); }}>
        <Field label={forced ? 'Temporary password' : 'Current password'}><input className="input" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required /></Field>
        <Field label="New password" hint="At least 8 characters with a letter and a number"><input className="input" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required minLength={8} /></Field>
        <Field label="Confirm new password"><input className="input" type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required /></Field>
        <button className="btn-primary" disabled={change.isPending}>Update password</button>
      </form>
    </Card>
  );
  if (forced) return <div className="mx-auto max-w-lg px-4 py-10">{pwForm}<button className="btn-ghost mt-4" onClick={logout}>Sign out</button></div>;
  return (
    <div className="space-y-5">
      <PageHeader title="Profile & preferences" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="My details">
          <KV items={[['Email', user!.email], ['Employee code', user!.employee_code], ['Role', user!.role_name], ['Department', user!.department_name], ['Team', user!.team_name], ['Designation', user!.designation]]} />
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <Field label="Name"><input className="input" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
            <Field label="Phone"><input className="input" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} /></Field>
            <Field label="My timezone" hint={`Browser: ${browserTz()}`} className="sm:col-span-2"><Select value={p.timezone} onChange={(v) => setP({ ...p, timezone: v })} options={(tzs.length ? tzs : [p.timezone]).map((z) => ({ value: z, label: z }))} /></Field>
          </div>
          <button className="btn-primary mt-4" onClick={() => save.mutate(undefined)}>Save</button>
        </Card>
        {pwForm}
      </div>
      <Preferences />
      <Card title="Active sessions" actions={<button className="btn-secondary btn-sm" onClick={() => revoke.mutate(undefined)}>Sign out everywhere</button>}>
        <ul className="divide-y text-sm">{sessions.map((s: any) => <li key={s.id} className="py-2"><p className="truncate">{s.user_agent ?? 'Unknown device'}</p><p className="muted text-xs">{s.ip} · started {fromNow(s.created_at)}</p></li>)}</ul>
      </Card>
    </div>
  );
}
