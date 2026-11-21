/**
 * Permission catalogue. Seeded into the `permissions` table; the role → permission
 * matrix is editable at runtime by Super Admin (Settings → Roles & permissions).
 * Data visibility is controlled separately by each role's `scope_level`.
 */
export const PERMISSIONS = {
  'org.view': ['organization', 'View departments, teams and designations'],
  'org.manage': ['organization', 'Create/edit/deactivate departments, teams, designations'],
  'users.view': ['users', 'View employee profiles within scope'],
  'users.manage': ['users', 'Create/edit employees, assign HODs/leaders, reporting lines'],
  'roles.manage': ['users', 'Edit the role/permission matrix'],
  'projects.view': ['projects', 'View projects within scope'],
  'projects.create': ['projects', 'Create projects'],
  'projects.manage': ['projects', 'Edit projects they manage (milestones, risks, members)'],
  'projects.manage_all': ['projects', 'Edit any project'],
  'future_projects.manage': ['projects', 'Create and plan future projects'],
  'future_projects.convert': ['projects', 'Convert a future project to an active project'],
  'tasks.view': ['tasks', 'View tasks within scope'],
  'tasks.create': ['tasks', 'Create tasks'],
  'tasks.assign': ['tasks', 'Assign/reassign tasks to others'],
  'tasks.update_own': ['tasks', 'Update progress/submit tasks assigned to them'],
  'tasks.review': ['tasks', 'Approve/reject submissions and deadline extensions'],
  'tasks.delete': ['tasks', 'Archive/delete tasks'],
  'tasks.manage_all': ['tasks', 'Edit any task in the organization'],
  'reports.daily.submit': ['daily_reports', 'Submit daily work reports'],
  'reports.daily.review': ['daily_reports', 'Review daily reports of their people'],
  'monitoring.employees': ['monitoring', 'Employee monitoring screen'],
  'monitoring.departments': ['monitoring', 'Department monitoring screen'],
  'approvals.decide': ['approvals', 'Decide project, milestone, budget, scope and resource approvals'],
  'analytics.view': ['analytics', 'View analytics within scope'],
  'analytics.view_all': ['analytics', 'View organization-wide analytics'],
  'reports.export': ['analytics', 'Export reports to Excel/PDF'],
  'resources.view': ['resources', 'View capacity and workload'],
  'resources.manage': ['resources', 'Manage project resource requirements/allocations'],
  'meetings.manage': ['communication', 'Schedule meetings and record minutes'],
  'agenda.use': ['notifications', 'Personal management agenda'],
  'notifications.schedule': ['notifications', 'Create personal reminders'],
  'notifications.schedule_others': ['notifications', 'Create reminders for other recipients'],
  'notifications.rules.manage': ['notifications', 'Manage event notification rules'],
  'notifications.logs.view_all': ['notifications', 'View all notification delivery logs'],
  'escalations.manage': ['notifications', 'Manage deadline escalation rules'],
  'audit.view': ['audit', 'View audit logs'],
  'settings.manage': ['settings', 'Configure application settings'],
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export type ScopeLevel = 'organization' | 'project' | 'department' | 'team' | 'self';

export const ROLE_DEFS: Array<{ key: string; name: string; scope: ScopeLevel; rank: number; description: string; permissions: Permission[] }> = [
  {
    key: 'super_admin', name: 'Super Admin', scope: 'organization', rank: 100,
    description: 'Full system access', permissions: ALL_PERMISSIONS,
  },
  {
    key: 'director', name: 'Director / Management', scope: 'organization', rank: 90,
    description: 'Organization-wide monitoring, escalations and approvals',
    permissions: ['org.view', 'users.view', 'projects.view', 'projects.create', 'future_projects.manage', 'future_projects.convert',
      'tasks.view', 'tasks.create', 'tasks.assign', 'tasks.review', 'monitoring.employees', 'monitoring.departments', 'approvals.decide',
      'analytics.view', 'analytics.view_all', 'reports.export', 'resources.view', 'meetings.manage', 'agenda.use',
      'notifications.schedule', 'notifications.schedule_others', 'notifications.logs.view_all', 'audit.view'],
  },
  {
    key: 'project_manager', name: 'Project Manager', scope: 'project', rank: 70,
    description: 'Manages authorized projects, milestones and resources',
    permissions: ['org.view', 'users.view', 'projects.view', 'projects.create', 'projects.manage', 'future_projects.manage',
      'future_projects.convert', 'tasks.view', 'tasks.create', 'tasks.assign', 'tasks.review', 'tasks.delete', 'tasks.update_own',
      'monitoring.employees', 'analytics.view', 'reports.export', 'resources.view', 'resources.manage', 'meetings.manage',
      'agenda.use', 'notifications.schedule', 'notifications.schedule_others', 'reports.daily.submit'],
  },
  {
    key: 'hod', name: 'Head of Department', scope: 'department', rank: 60,
    description: 'Manages a department, reviews and approves work',
    permissions: ['org.view', 'users.view', 'projects.view', 'tasks.view', 'tasks.create', 'tasks.assign', 'tasks.review',
      'tasks.delete', 'tasks.update_own', 'reports.daily.submit', 'reports.daily.review', 'monitoring.employees',
      'monitoring.departments', 'analytics.view', 'reports.export', 'resources.view', 'meetings.manage', 'agenda.use',
      'notifications.schedule', 'notifications.schedule_others'],
  },
  {
    key: 'management_viewer', name: 'Management Viewer', scope: 'organization', rank: 50,
    description: 'Read-only organization-wide visibility',
    permissions: ['org.view', 'users.view', 'projects.view', 'tasks.view', 'monitoring.employees', 'monitoring.departments',
      'analytics.view', 'analytics.view_all', 'reports.export', 'resources.view', 'notifications.schedule'],
  },
  {
    key: 'team_leader', name: 'Team Leader', scope: 'team', rank: 40,
    description: 'Distributes and monitors team work',
    permissions: ['org.view', 'users.view', 'projects.view', 'tasks.view', 'tasks.create', 'tasks.assign', 'tasks.update_own',
      'reports.daily.submit', 'reports.daily.review', 'monitoring.employees', 'analytics.view', 'resources.view',
      'meetings.manage', 'agenda.use', 'notifications.schedule', 'notifications.schedule_others'],
  },
  {
    key: 'employee', name: 'Employee', scope: 'self', rank: 10,
    description: 'Works on assigned tasks and submits daily reports',
    permissions: ['projects.view', 'tasks.view', 'tasks.update_own', 'reports.daily.submit', 'analytics.view', 'notifications.schedule'],
  },
];
