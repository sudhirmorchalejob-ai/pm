import { FormEvent, useState } from 'react';
import { Loader2, LockKeyhole } from 'lucide-react';
import { useAuth } from '../lib/auth';

const DEMO = [
  ['Super Admin', 'admin@orgpm.dev'], ['Director', 'director@orgpm.dev'], ['Project Manager', 'pm@orgpm.dev'],
  ['HOD (IT)', 'hod.it@orgpm.dev'], ['Team Leader', 'tl.dev@orgpm.dev'], ['Employee', 'employee@orgpm.dev'], ['Mgmt Viewer', 'viewer@orgpm.dev'],
];

export function Login() {
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
    <div className="flex min-h-dvh flex-col items-center justify-center bg-gradient-to-b from-brand-50 to-slate-50 px-4 py-10 dark:from-slate-900 dark:to-slate-950">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <img src="/icon.svg" alt="" className="h-12 w-12" />
          <h1 className="text-2xl font-bold tracking-tight">OrgPM</h1>
          <p className="muted text-sm">Projects, people and performance in one place</p>
        </div>
        <form onSubmit={submit} className="card space-y-4 p-6" noValidate>
          <label className="block"><span className="label">Work email</span>
            <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label className="block"><span className="label">Password</span>
            <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-900/30 dark:text-rose-300" role="alert">{error}</p>}
          <button className="btn-primary w-full" disabled={busy || !email || !password}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LockKeyhole className="h-4 w-4" />} Sign in</button>
        </form>
        {import.meta.env.DEV && (
          <div className="card mt-4 p-4">
            <p className="muted mb-2 text-xs">Development seed accounts (password from the seed script):</p>
            <div className="flex flex-wrap gap-1.5">
              {DEMO.map(([r, e]) => <button key={e} type="button" className="chip chip-off" onClick={() => setEmail(e)}>{r}</button>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
