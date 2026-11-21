import { lazy, ReactNode, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { AppShell } from './components/AppShell';
import { Toaster } from './components/Toast';
import { ConfirmHost, Loading } from './components/ui';
import { Login } from './pages/Login';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const TasksPage = lazy(() => import('./pages/tasks/TasksPage'));
const TaskDetail = lazy(() => import('./pages/tasks/TaskDetail'));
const ProjectsPage = lazy(() => import('./pages/projects/ProjectsPage'));
const ProjectDetail = lazy(() => import('./pages/projects/ProjectDetail'));
const FutureProjects = lazy(() => import('./pages/projects/FutureProjects'));
const DailyReports = lazy(() => import('./pages/DailyReports'));
const Approvals = lazy(() => import('./pages/Approvals'));
const EmployeesMonitor = lazy(() => import('./pages/monitoring/EmployeesMonitor'));
const EmployeeDetail = lazy(() => import('./pages/monitoring/EmployeeDetail'));
const DepartmentsMonitor = lazy(() => import('./pages/monitoring/DepartmentsMonitor'));
const NotificationsPage = lazy(() => import('./pages/notifications/NotificationsPage'));
const Agenda = lazy(() => import('./pages/Agenda'));
const CalendarPage = lazy(() => import('./pages/CalendarPage'));
const GanttPage = lazy(() => import('./pages/GanttPage'));
const Resources = lazy(() => import('./pages/Resources'));
const Meetings = lazy(() => import('./pages/Meetings'));
const Reports = lazy(() => import('./pages/Reports'));
const Organization = lazy(() => import('./pages/Organization'));
const Audit = lazy(() => import('./pages/Audit'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const Profile = lazy(() => import('./pages/Profile'));

function Guard({ perms, children }: { perms?: string[]; children: ReactNode }) {
  const { can } = useAuth();
  if (perms && !can(...perms)) return <div className="card p-8 text-center"><p className="font-medium">You don’t have access to this page.</p><p className="muted text-sm">Ask an administrator if you need it.</p></div>;
  return <>{children}</>;
}

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="flex min-h-dvh items-center justify-center"><Loading label="Starting…" /></div>;
  if (!user) return <><Login /><Toaster /></>;
  if (user.must_change_password) return <><Profile forced /><Toaster /></>;
  return (
    <AppShell>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/tasks" element={<Guard perms={['tasks.view']}><TasksPage /></Guard>} />
          <Route path="/tasks/:id" element={<Guard perms={['tasks.view']}><TaskDetail /></Guard>} />
          <Route path="/projects" element={<Guard perms={['projects.view']}><ProjectsPage /></Guard>} />
          <Route path="/projects/:id" element={<Guard perms={['projects.view']}><ProjectDetail /></Guard>} />
          <Route path="/future-projects" element={<Guard perms={['projects.view']}><FutureProjects /></Guard>} />
          <Route path="/daily-reports" element={<Guard perms={['reports.daily.submit', 'reports.daily.review']}><DailyReports /></Guard>} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/monitoring" element={<Guard perms={['monitoring.employees']}><EmployeesMonitor /></Guard>} />
          <Route path="/monitoring/employees/:id" element={<Guard perms={['monitoring.employees']}><EmployeeDetail /></Guard>} />
          <Route path="/monitoring/departments" element={<Guard perms={['monitoring.departments']}><DepartmentsMonitor /></Guard>} />
          <Route path="/monitoring/departments/:id" element={<Guard perms={['monitoring.departments']}><DepartmentsMonitor /></Guard>} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/agenda" element={<Guard perms={['agenda.use']}><Agenda /></Guard>} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/gantt" element={<Guard perms={['projects.view']}><GanttPage /></Guard>} />
          <Route path="/resources" element={<Guard perms={['resources.view']}><Resources /></Guard>} />
          <Route path="/meetings" element={<Meetings />} />
          <Route path="/reports" element={<Guard perms={['analytics.view']}><Reports /></Guard>} />
          <Route path="/organization" element={<Guard perms={['org.view', 'users.view']}><Organization /></Guard>} />
          <Route path="/audit" element={<Guard perms={['audit.view']}><Audit /></Guard>} />
          <Route path="/settings" element={<Guard perms={['settings.manage', 'roles.manage', 'notifications.rules.manage', 'escalations.manage']}><SettingsPage /></Guard>} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <Toaster />
      <ConfirmHost />
    </AppShell>
  );
}
