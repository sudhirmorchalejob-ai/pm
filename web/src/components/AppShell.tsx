import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity, BarChart3, Bell, BriefcaseBusiness, Building2, CalendarDays, CheckCheck, ChevronsLeft, ChevronsRight, ClipboardCheck, ClipboardList, FileClock,
  GanttChartSquare, Gauge, LayoutDashboard, ListChecks, ListTodo, LogOut, FileBarChart2, MessageSquareText, ShieldCheck as ComplianceIcon, Menu, Moon, NotebookPen, Rocket, Search, Settings, ShieldCheck, Sun, UserRound, Users, Video, X,
} from 'lucide-react';
import clsx from 'clsx';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { fromNow } from '../lib/format';
import { useApi, useDebounced, usePref } from '../lib/hooks';
import { onRealtime } from '../lib/socket';
import { toast } from './Toast';
import { Avatar } from './ui';

interface NavItem { to: string; label: string; icon: any; perms?: string[]; end?: boolean }
const NAV: { section: string; items: NavItem[] }[] = [
  { section: '', items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true }] },
  { section: 'Work', items: [
    { to: '/my-work', label: 'My daily work', icon: Activity, perms: ['activities.log'] },
    { to: '/tasks', label: 'Tasks', icon: ListTodo, perms: ['tasks.view'] },
    { to: '/checklist', label: 'My checklist', icon: ListChecks, perms: ['checklists.submit'] },
    { to: '/daily-reports', label: 'Daily reports', icon: NotebookPen, perms: ['reports.daily.submit', 'reports.daily.review'] },
    { to: '/calendar', label: 'Calendar', icon: CalendarDays },
    { to: '/agenda', label: 'My agenda', icon: ClipboardList, perms: ['agenda.use'] },
    { to: '/notifications', label: 'Reminders', icon: Bell, perms: ['notifications.schedule'] },
  ] },
  { section: 'Projects', items: [
    { to: '/projects', label: 'Projects', icon: BriefcaseBusiness, perms: ['projects.view'] },
    { to: '/future-projects', label: 'Future projects', icon: Rocket, perms: ['projects.view'] },
    { to: '/gantt', label: 'Gantt & timeline', icon: GanttChartSquare, perms: ['projects.view'] },
    { to: '/meetings', label: 'Meetings', icon: Video },
  ] },
  { section: 'Management', items: [
    { to: '/approvals', label: 'Approvals', icon: ClipboardCheck, perms: ['tasks.review', 'approvals.decide', 'projects.manage'] },
    { to: '/monitoring', label: 'Employee monitoring', icon: Gauge, perms: ['monitoring.employees'], end: true },
    { to: '/monitoring/departments', label: 'Department monitoring', icon: Building2, perms: ['monitoring.departments'] },
    { to: '/resources', label: 'Resources', icon: Users, perms: ['resources.view'] },
    { to: '/compliance', label: 'Checklist compliance', icon: ComplianceIcon, perms: ['checklists.monitor'] },
    { to: '/eod', label: 'EOD reports', icon: FileBarChart2, perms: ['eod.view', 'eod.generate'] },
    { to: '/reports', label: 'Reports & analytics', icon: BarChart3, perms: ['analytics.view'] },
  ] },
  { section: 'Administration', items: [
    { to: '/organization', label: 'Organization', icon: Building2, perms: ['org.view', 'users.view'] },
    { to: '/questions', label: 'Question builder', icon: MessageSquareText, perms: ['questions.manage'] },
    { to: '/audit', label: 'Audit log', icon: FileClock, perms: ['audit.view'] },
    { to: '/settings', label: 'Settings', icon: Settings, perms: ['settings.manage', 'roles.manage', 'notifications.rules.manage', 'escalations.manage'] },
  ] },
];

function useNav() {
  const { can } = useAuth();
  return NAV.map((s) => ({ ...s, items: s.items.filter((i) => !i.perms || can(...i.perms)) })).filter((s) => s.items.length);
}

function NavList({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const nav = useNav();
  const { data: pending } = useApi<any>(['approvals-count'], '/approvals/pending', undefined, { refetchInterval: 60_000 });
  const approvals = pending ? pending.counts.completions + pending.counts.extensions + pending.counts.requests : 0;
  return (
    <nav className="flex flex-col gap-4" aria-label="Main">
      {nav.map((s) => (
        <div key={s.section}>
          {s.section && !collapsed && <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{s.section}</div>}
          <ul className="flex flex-col gap-0.5">
            {s.items.map((i) => (
              <li key={i.to}>
                <NavLink to={i.to} end={i.end} onClick={onNavigate} title={collapsed ? i.label : undefined}
                  className={({ isActive }) => clsx('flex min-h-[40px] items-center gap-3 rounded-lg px-3 text-sm font-medium transition',
                    collapsed && 'justify-center px-0',
                    isActive ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-200' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800')}>
                  <span className="relative"><i.icon className="h-[18px] w-[18px] shrink-0" />
                    {i.to === '/approvals' && approvals > 0 && collapsed && <span className="absolute -right-1.5 -top-1.5 h-2 w-2 rounded-full bg-rose-500" />}
                  </span>
                  {!collapsed && <span className="flex-1 truncate">{i.label}</span>}
                  {!collapsed && i.to === '/approvals' && approvals > 0 && <span className="rounded-full bg-rose-500 px-1.5 text-[11px] font-semibold text-white">{approvals}</span>}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  return (
    <button className="btn-ghost btn-sm h-9 w-9 p-0" aria-label="Toggle dark mode" onClick={() => {
      const d = !dark; setDark(d); document.documentElement.classList.toggle('dark', d);
      try { localStorage.setItem('theme', d ? 'dark' : 'light'); } catch { /* ignore */ }
    }}>{dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}</button>
  );
}

function GlobalSearch({ onDone }: { onDone?: () => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const nav = useNavigate();
  const { data } = useApi<any>(['search', dq], dq.length >= 2 ? '/search' : null, { q: dq });
  const go = (to: string) => { setQ(''); onDone?.(); nav(to); };
  const has = data && (data.tasks.length || data.projects.length || data.people.length);
  return (
    <div className="relative w-full">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input className="input h-9 min-h-0 pl-9" placeholder="Search tasks, projects, people…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Global search" />
      {dq.length >= 2 && data && (
        <div className="card absolute z-50 mt-1 max-h-96 w-full overflow-auto p-1 shadow-lg">
          {!has && <p className="muted p-3 text-sm">No results</p>}
          {data.tasks.map((t: any) => <button key={`t${t.id}`} className="block w-full truncate rounded px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => go(`/tasks/${t.id}`)}><span className="muted mr-2 text-xs">{t.task_key}</span>{t.title}</button>)}
          {data.projects.map((p: any) => <button key={`p${p.id}`} className="block w-full truncate rounded px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => go(`/projects/${p.id}`)}><span className="muted mr-2 text-xs">{p.code}</span>{p.name}</button>)}
          {data.people.map((u: any) => <button key={`u${u.id}`} className="block w-full truncate rounded px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => go(`/monitoring/employees/${u.id}`)}><UserRound className="mr-2 inline h-3.5 w-3.5" />{u.name}</button>)}
        </div>
      )}
    </div>
  );
}

function NotificationBell() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: count } = useApi<{ count: number }>(['unread'], '/notifications/inbox/unread-count', undefined, { refetchInterval: 120_000 });
  const { data: list } = useApi<any>(['inbox-mini'], open ? '/notifications/inbox' : null, { pageSize: 8 });
  useEffect(() => onRealtime('notification', (n) => {
    qc.invalidateQueries({ queryKey: ['unread'] }); qc.invalidateQueries({ queryKey: ['inbox-mini'] }); qc.invalidateQueries({ queryKey: ['inbox'] });
    toast.info(`${n.title}`);
  }), [qc]);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const read = async (n: any) => {
    await api(`/notifications/inbox/${n.id}/read`, { method: 'POST' });
    qc.invalidateQueries({ queryKey: ['unread'] }); qc.invalidateQueries({ queryKey: ['inbox-mini'] });
    setOpen(false);
    if (n.link) nav(n.link);
  };
  const c = count?.count ?? 0;
  return (
    <div className="relative" ref={ref}>
      <button className="btn-ghost btn-sm relative h-9 w-9 p-0" aria-label={`Notifications (${c} unread)`} onClick={() => setOpen((o) => !o)}>
        <Bell className="h-[18px] w-[18px]" />
        {c > 0 && <span className="absolute right-0.5 top-0.5 min-w-[16px] rounded-full bg-rose-500 px-1 text-[10px] font-bold leading-4 text-white">{c > 99 ? '99+' : c}</span>}
      </button>
      {open && (
        <div className="card fixed inset-x-2 top-14 z-50 shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 sm:w-96">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            <button className="btn-ghost btn-sm" onClick={async () => { await api('/notifications/inbox/read-all', { method: 'POST' }); qc.invalidateQueries({ queryKey: ['unread'] }); qc.invalidateQueries({ queryKey: ['inbox-mini'] }); }}><CheckCheck className="h-4 w-4" /> Mark all read</button>
          </div>
          <ul className="max-h-[60dvh] divide-y overflow-auto">
            {list?.items?.length === 0 && <li className="muted p-6 text-center text-sm">You’re all caught up</li>}
            {list?.items?.map((n: any) => (
              <li key={n.id}>
                <button className={clsx('flex w-full gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800', !n.read_at && 'bg-brand-50/60 dark:bg-brand-900/10')} onClick={() => read(n)}>
                  <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : n.category === 'escalation' ? 'bg-rose-500' : 'bg-brand-500')} />
                  <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{n.title}</span><span className="muted line-clamp-2 block text-xs">{n.body}</span><span className="muted mt-0.5 block text-[11px]">{fromNow(n.created_at)}</span></span>
                </button>
              </li>
            ))}
          </ul>
          <Link to="/notifications?tab=inbox" onClick={() => setOpen(false)} className="block border-t px-4 py-2.5 text-center text-sm font-medium text-brand-600">Open notification center</Link>
        </div>
      )}
    </div>
  );
}

function ProfileMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button className="flex items-center gap-2 rounded-lg p-1 hover:bg-slate-100 dark:hover:bg-slate-800" onClick={() => setOpen((o) => !o)} aria-label="Account menu">
        <Avatar name={user?.name} />
        <span className="hidden text-left lg:block"><span className="block text-sm font-medium leading-tight">{user?.name}</span><span className="muted block text-[11px] leading-tight">{user?.role_name}</span></span>
      </button>
      {open && (
        <div className="card absolute right-0 top-12 z-50 w-60 p-1 shadow-xl">
          <div className="border-b px-3 py-2"><p className="truncate text-sm font-medium">{user?.name}</p><p className="muted truncate text-xs">{user?.email}</p><p className="mt-1 truncate text-xs font-medium text-brand-600" title="Organization">{user?.organization_name}</p></div>
          <Link to="/profile" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"><UserRound className="h-4 w-4" /> Profile & preferences</Link>
          <button onClick={logout} className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-rose-600 hover:bg-slate-100 dark:hover:bg-slate-800"><LogOut className="h-4 w-4" /> Sign out</button>
        </div>
      )}
    </div>
  );
}

const BOTTOM: NavItem[] = [
  { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/tasks', label: 'Tasks', icon: ListTodo },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/notifications?tab=inbox', label: 'Inbox', icon: Bell },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [collapsed, setCollapsed] = usePref('sidebar-collapsed', false);
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  useEffect(() => setDrawer(false), [loc.pathname]);
  return (
    <div className="min-h-dvh">
      {/* Sidebar: md = icon rail (collapsible), lg+ = full */}
      <aside className={clsx('fixed inset-y-0 left-0 z-30 hidden flex-col border-r bg-white transition-[width] dark:bg-slate-900 md:flex', collapsed ? 'w-[68px]' : 'w-[68px] lg:w-64')}>
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <img src="/icon.svg" alt="" className="h-7 w-7" />
          <span className={clsx('min-w-0 leading-tight', collapsed ? 'hidden' : 'hidden lg:block')}>
            <span className="block text-base font-bold tracking-tight">OrgPM</span>
            <span className="muted block truncate text-[11px]" title={user?.organization_name}>{user?.organization_name}</span>
          </span>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto px-2 py-3">
          <div className={collapsed ? '' : 'lg:hidden'}><NavList collapsed /></div>
          <div className={collapsed ? 'hidden' : 'hidden lg:block'}><NavList /></div>
        </div>
        <button className="hidden h-11 items-center justify-center border-t text-slate-500 hover:text-slate-800 lg:flex" onClick={() => setCollapsed(!collapsed)} aria-label="Toggle sidebar">
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
        </button>
      </aside>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-[80] md:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[82%] max-w-xs flex-col bg-white shadow-xl dark:bg-slate-900">
            <div className="flex h-14 items-center justify-between border-b px-4">
              <span className="flex min-w-0 items-center gap-2"><img src="/icon.svg" alt="" className="h-7 w-7" /><span className="min-w-0 leading-tight"><span className="block font-bold">OrgPM</span><span className="muted block truncate text-[11px]">{user?.organization_name}</span></span></span>
              <button className="btn-ghost btn-sm" onClick={() => setDrawer(false)} aria-label="Close menu"><X className="h-5 w-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-3"><NavList onNavigate={() => setDrawer(false)} /></div>
          </div>
        </div>
      )}

      <div className={clsx('flex min-h-dvh flex-col transition-[padding]', collapsed ? 'md:pl-[68px]' : 'md:pl-[68px] lg:pl-64')}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-white/90 px-3 backdrop-blur dark:bg-slate-900/90 sm:px-4">
          <button className="btn-ghost btn-sm h-9 w-9 p-0 md:hidden" onClick={() => setDrawer(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          <div className="hidden max-w-md flex-1 sm:block"><GlobalSearch /></div>
          <Link to="/" className="flex items-center gap-2 font-bold sm:hidden"><img src="/icon.svg" alt="" className="h-6 w-6" />OrgPM</Link>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <NotificationBell />
            <ProfileMenu />
          </div>
        </header>
        <div className="border-b bg-white px-3 py-2 dark:bg-slate-900 sm:hidden"><GlobalSearch /></div>
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 pb-24 pt-4 sm:px-6 sm:pt-6 md:pb-10">{children}</main>
      </div>

      {/* Mobile bottom navigation */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-white dark:bg-slate-900 md:hidden" aria-label="Quick navigation">
        {BOTTOM.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => clsx('flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium', isActive && !i.to.includes('?') ? 'text-brand-600' : 'text-slate-500')}>
            <i.icon className="h-5 w-5" />{i.label}
          </NavLink>
        ))}
        <button className="flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-slate-500" onClick={() => setDrawer(true)}>
          <ShieldCheck className="h-5 w-5" />More
        </button>
      </nav>
    </div>
  );
}
