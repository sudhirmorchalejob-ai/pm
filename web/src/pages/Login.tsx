import { FormEvent, useEffect, useState } from 'react';
import { Building2, Loader2, LockKeyhole } from 'lucide-react';
import clsx from 'clsx';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { browserTz } from '../lib/format';

const DEMO = [
  ['Super Admin', 'admin@orgpm.dev'], ['Director', 'director@orgpm.dev'], ['Project Manager', 'pm@orgpm.dev'],
  ['HOD (IT)', 'hod.it@orgpm.dev'], ['Team Leader', 'tl.dev@orgpm.dev'], ['Employee', 'employee@orgpm.dev'], ['Mgmt Viewer', 'viewer@orgpm.dev'],
];

export function Login() {
  const [mode, setMode] = useState<'signin' | 'register'>(() => (location.hash === '#register' ? 'register' : 'signin'));
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  useEffect(() => { api<{ enabled: boolean }>('/auth/registration').then((r) => setRegistrationEnabled(r.enabled)).catch(() => undefined); }, []);
  useEffect(() => { history.replaceState(null, '', mode === 'register' ? '#register' : location.pathname); }, [mode]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-brand-50 to-slate-50 px-4 py-10 dark:from-slate-900 dark:to-slate-950">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <img src="/icon.svg" alt="" className="h-12 w-12" />
          <h1 className="text-2xl font-bold tracking-tight">OrgPM</h1>
          <p className="muted text-sm">Projects, people and performance in one place</p>
        </div>
        {registrationEnabled && (
          <div className="mb-4 grid grid-cols-2 rounded-xl border bg-white p-1 dark:bg-slate-900" role="tablist" aria-label="Sign in or register">
            <button role="tab" aria-selected={mode === 'signin'} className={clsx('btn', mode === 'signin' ? 'bg-brand-600 text-white' : 'text-slate-600 dark:text-slate-300')} onClick={() => setMode('signin')}>Sign in</button>
            <button role="tab" aria-selected={mode === 'register'} className={clsx('btn', mode === 'register' ? 'bg-brand-600 text-white' : 'text-slate-600 dark:text-slate-300')} onClick={() => setMode('register')}>Register organization</button>
          </div>
        )}
        {mode === 'signin' || !registrationEnabled ? <SignIn onRegister={registrationEnabled ? () => setMode('register') : undefined} /> : <Register onSignIn={() => setMode('signin')} />}
      </div>
    </div>
  );
}

function SignIn({ onRegister }: { onRegister?: () => void }) {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await login(email.trim(), password); } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <>
      <form onSubmit={submit} className="card space-y-4 p-6" noValidate>
        <label className="block"><span className="label">Work email</span>
          <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="block"><span className="label">Password</span>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/30 dark:text-rose-300" role="alert">{error}</p>}
        <button className="btn-primary w-full" disabled={busy || !email || !password}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />} Sign in</button>
        {onRegister && <p className="muted text-center text-sm">New to OrgPM? <button type="button" className="font-medium text-brand-600 hover:underline" onClick={onRegister}>Register your organization</button></p>}
      </form>
      {import.meta.env.DEV && (
        <div className="card mt-4 p-4">
          <p className="muted mb-2 text-xs">Development seed accounts (password from the seed script):</p>
          <div className="flex flex-wrap gap-1.5">
            {DEMO.map(([r, e]) => <button key={e} type="button" className="chip chip-off" onClick={() => setEmail(e)}>{r}</button>)}
          </div>
        </div>
      )}
    </>
  );
}

function Register({ onSignIn }: { onSignIn: () => void }) {
  const { register } = useAuth();
  const [f, setF] = useState({ organization_name: '', name: '', email: '', password: '', confirm: '', timezone: browserTz() || 'Asia/Kolkata' });
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const mismatch = !!f.confirm && f.confirm !== f.password;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true); setError(''); setErrors({});
    try {
      await register({ organization_name: f.organization_name.trim(), name: f.name.trim(), email: f.email.trim(), password: f.password, timezone: f.timezone });
    } catch (err: any) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setError(err.message === 'Validation failed' ? 'Please fix the highlighted fields' : err.message);
    } finally { setBusy(false); }
  };
  const fe = (k: string) => errors[k]?.[0] && <span className="mt-1 block text-xs text-rose-600">{errors[k][0]}</span>;
  return (
    <form onSubmit={submit} className="card space-y-4 p-6" noValidate>
      <div className="flex items-start gap-3 rounded-lg bg-brand-50 p-3 text-sm text-brand-800 dark:bg-brand-900/20 dark:text-brand-200">
        <Building2 className="mt-0.5 h-4 w-4 shrink-0" />
        <p>Create a new, private workspace for your organization. You become its Super Admin and can then add departments and employees.</p>
      </div>
      <label className="block"><span className="label">Organization name</span>
        <input className="input" autoComplete="organization" required value={f.organization_name} onChange={(e) => set('organization_name', e.target.value)} placeholder="e.g. Acme Industries Pvt Ltd" />{fe('organization_name')}</label>
      <label className="block"><span className="label">Your full name</span>
        <input className="input" autoComplete="name" required value={f.name} onChange={(e) => set('name', e.target.value)} />{fe('name')}</label>
      <label className="block"><span className="label">Work email</span>
        <input className="input" type="email" autoComplete="email" required value={f.email} onChange={(e) => set('email', e.target.value)} />{fe('email')}</label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block"><span className="label">Password</span>
          <input className="input" type="password" autoComplete="new-password" required minLength={8} value={f.password} onChange={(e) => set('password', e.target.value)} />
          {fe('password') ?? <span className="muted mt-1 block text-xs">8+ characters, a letter and a number</span>}</label>
        <label className="block"><span className="label">Confirm password</span>
          <input className="input" type="password" autoComplete="new-password" required value={f.confirm} onChange={(e) => set('confirm', e.target.value)} />
          {mismatch && <span className="mt-1 block text-xs text-rose-600">Passwords do not match</span>}</label>
      </div>
      <label className="block"><span className="label">Timezone</span>
        <input className="input" value={f.timezone} onChange={(e) => set('timezone', e.target.value)} />{fe('timezone')}</label>
      {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/30 dark:text-rose-300" role="alert">{error}</p>}
      <button className="btn-primary w-full" disabled={busy || !f.organization_name || !f.name || !f.email || !f.password || mismatch}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Building2 className="h-4 w-4" />} Create organization
      </button>
      <p className="muted text-center text-sm">Already have an account? <button type="button" className="font-medium text-brand-600 hover:underline" onClick={onSignIn}>Sign in</button></p>
    </form>
  );
}
