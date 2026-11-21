-- =====================================================================
-- OrgPM — initial schema
-- Conventions: bigint identity PKs, timestamptz everywhere (stored UTC),
-- soft delete via deleted_at where history matters, CHECK constraints
-- for enumerations (cheaper to evolve than PG enums).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------
CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint
);

-- ---------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------
CREATE TABLE roles (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key          text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text,
  -- data visibility scope applied by the backend on every query
  scope_level  text NOT NULL CHECK (scope_level IN ('organization','project','department','team','self')),
  rank         int  NOT NULL DEFAULT 0,          -- higher = more senior; used for hierarchy guards
  is_system    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key          text NOT NULL UNIQUE,
  module       text NOT NULL,
  description  text NOT NULL
);

CREATE TABLE role_permissions (
  role_id        bigint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id  bigint NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- ---------------------------------------------------------------------
-- Organization
-- ---------------------------------------------------------------------
CREATE TABLE departments (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text NOT NULL,
  code         citext NOT NULL UNIQUE,
  description  text,
  hod_id       bigint,                            -- FK added after users
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE TABLE designations (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title          text NOT NULL,
  level          int NOT NULL DEFAULT 1,
  department_id  bigint REFERENCES departments(id) ON DELETE SET NULL,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (title, department_id)
);

CREATE TABLE teams (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text NOT NULL,
  department_id  bigint NOT NULL REFERENCES departments(id),
  leader_id      bigint,                          -- FK added after users
  description    text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department_id, name)
);

CREATE TABLE users (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_code           citext NOT NULL UNIQUE,
  name                    text NOT NULL,
  email                   citext NOT NULL UNIQUE,
  password_hash           text NOT NULL,
  phone                   text,
  role_id                 bigint NOT NULL REFERENCES roles(id),
  department_id           bigint REFERENCES departments(id),
  designation_id          bigint REFERENCES designations(id),
  team_id                 bigint REFERENCES teams(id) ON DELETE SET NULL,
  manager_id              bigint REFERENCES users(id) ON DELETE SET NULL,
  timezone                text NOT NULL DEFAULT 'UTC',
  employment_status       text NOT NULL DEFAULT 'active'
                          CHECK (employment_status IN ('active','on_leave','notice','exited')),
  joining_date            date,
  exit_date               date,
  capacity_hours_per_week numeric(5,2) NOT NULL DEFAULT 40 CHECK (capacity_hours_per_week >= 0),
  avatar_url              text,
  is_active               boolean NOT NULL DEFAULT true,
  must_change_password    boolean NOT NULL DEFAULT false,
  failed_logins           int NOT NULL DEFAULT 0,
  locked_until            timestamptz,
  last_login_at           timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  CHECK (exit_date IS NULL OR joining_date IS NULL OR exit_date >= joining_date)
);
CREATE INDEX users_department_idx ON users(department_id) WHERE deleted_at IS NULL;
CREATE INDEX users_team_idx ON users(team_id) WHERE deleted_at IS NULL;
CREATE INDEX users_manager_idx ON users(manager_id);
CREATE INDEX users_role_idx ON users(role_id);

ALTER TABLE departments ADD CONSTRAINT departments_hod_fk FOREIGN KEY (hod_id) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE teams ADD CONSTRAINT teams_leader_fk FOREIGN KEY (leader_id) REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX teams_department_idx ON teams(department_id);

-- History of reporting relationships (users.manager_id is the current one)
CREATE TABLE reporting_hierarchy (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manager_id      bigint REFERENCES users(id) ON DELETE SET NULL,
  relation_type   text NOT NULL DEFAULT 'direct' CHECK (relation_type IN ('direct','dotted')),
  effective_from  timestamptz NOT NULL DEFAULT now(),
  effective_to    timestamptz,
  changed_by      bigint REFERENCES users(id),
  CHECK (user_id <> manager_id)
);
CREATE INDEX reporting_hierarchy_user_idx ON reporting_hierarchy(user_id, effective_from DESC);

CREATE TABLE skills (
  id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name  citext NOT NULL UNIQUE
);

CREATE TABLE user_skills (
  user_id   bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id  bigint NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  level     int NOT NULL DEFAULT 3 CHECK (level BETWEEN 1 AND 5),
  PRIMARY KEY (user_id, skill_id)
);

CREATE TABLE refresh_tokens (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  family_id    uuid NOT NULL,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  bigint REFERENCES refresh_tokens(id),
  user_agent   text,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens(user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens(family_id);

-- ---------------------------------------------------------------------
-- Files (generic, referenced by attachments / documents)
-- ---------------------------------------------------------------------
CREATE TABLE files (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  original_name  text NOT NULL,
  stored_name    text NOT NULL UNIQUE,
  mime_type      text NOT NULL,
  size_bytes     bigint NOT NULL CHECK (size_bytes >= 0),
  sha256         text NOT NULL,
  uploaded_by    bigint NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Recurrence definitions (shared by tasks, reminders, agenda)
-- ---------------------------------------------------------------------
CREATE TABLE recurring_schedules (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  freq           text NOT NULL CHECK (freq IN ('minutely','hourly','daily','weekly','monthly','yearly')),
  interval       int  NOT NULL DEFAULT 1 CHECK (interval BETWEEN 1 AND 1000),
  by_weekday     int[],                 -- ISO weekday 1=Mon..7=Sun (weekly)
  by_month_day   int CHECK (by_month_day BETWEEN 1 AND 31),
  time_of_day    time NOT NULL,         -- local wall-clock time in `timezone`
  timezone       text NOT NULL,
  starts_on      date NOT NULL,         -- local date of first eligible occurrence
  ends_on        date,                  -- inclusive local date
  max_count      int CHECK (max_count > 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------
CREATE TABLE projects (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                citext NOT NULL UNIQUE,
  name                text NOT NULL,
  description         text,
  business_objective  text,
  client_name         text,
  client_contact      text,
  client_email        text,
  manager_id          bigint REFERENCES users(id) ON DELETE SET NULL,
  department_id       bigint REFERENCES departments(id),
  hod_id              bigint REFERENCES users(id) ON DELETE SET NULL,
  start_date          date,
  end_date            date,
  priority            text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  estimated_budget    numeric(14,2) CHECK (estimated_budget >= 0),
  actual_cost         numeric(14,2) NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'proposed' CHECK (status IN
                      ('proposed','under_evaluation','approved','planned','ready_to_start','in_progress','on_hold','completed','cancelled')),
  is_future           boolean NOT NULL DEFAULT false,   -- true while in the future-planning pipeline
  progress            int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  created_by          bigint REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX projects_status_idx ON projects(status) WHERE deleted_at IS NULL;
CREATE INDEX projects_manager_idx ON projects(manager_id);
CREATE INDEX projects_department_idx ON projects(department_id);
CREATE INDEX projects_future_idx ON projects(is_future, start_date) WHERE deleted_at IS NULL;

-- Planning data specific to future projects. Kept after conversion (converted_at set).
CREATE TABLE future_projects (
  project_id                bigint PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  expected_start_date       date NOT NULL,
  expected_end_date         date,
  planning_horizon          text NOT NULL DEFAULT 'custom'
                            CHECK (planning_horizon IN ('next_week','next_month','next_quarter','six_months','next_year','custom')),
  required_employees        int NOT NULL DEFAULT 0 CHECK (required_employees >= 0),
  required_skills           text[] NOT NULL DEFAULT '{}',
  expected_deliverables     text,
  approval_status           text NOT NULL DEFAULT 'draft'
                            CHECK (approval_status IN ('draft','pending','approved','rejected')),
  chk_requirements          boolean NOT NULL DEFAULT false,
  chk_budget_approved       boolean NOT NULL DEFAULT false,
  chk_resources_identified  boolean NOT NULL DEFAULT false,
  chk_team_allocated        boolean NOT NULL DEFAULT false,
  chk_technology_selected   boolean NOT NULL DEFAULT false,
  chk_dependencies_resolved boolean NOT NULL DEFAULT false,
  chk_documentation         boolean NOT NULL DEFAULT false,
  chk_management_approval   boolean NOT NULL DEFAULT false,
  readiness_percent         int GENERATED ALWAYS AS (
                              ( chk_requirements::int + chk_budget_approved::int + chk_resources_identified::int
                              + chk_team_allocated::int + chk_technology_selected::int + chk_dependencies_resolved::int
                              + chk_documentation::int + chk_management_approval::int) * 100 / 8 ) STORED,
  converted_at              timestamptz,
  converted_by              bigint REFERENCES users(id),
  CHECK (expected_end_date IS NULL OR expected_end_date >= expected_start_date)
);
CREATE INDEX future_projects_start_idx ON future_projects(expected_start_date);

CREATE TABLE project_members (
  project_id          bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id             bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_in_project     text NOT NULL DEFAULT 'member',
  allocation_percent  int NOT NULL DEFAULT 100 CHECK (allocation_percent BETWEEN 0 AND 100),
  added_by            bigint REFERENCES users(id),
  added_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members(user_id);

CREATE TABLE project_milestones (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id    bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         text NOT NULL,
  description   text,
  due_date      date NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','awaiting_approval','completed','missed')),
  completed_at  timestamptz,
  sort_order    int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_milestones_project_idx ON project_milestones(project_id, due_date);

CREATE TABLE project_deliverables (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id   bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        text NOT NULL,
  description  text,
  due_date     date,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','delivered','accepted')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_dependencies (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id             bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  depends_on_project_id  bigint REFERENCES projects(id) ON DELETE CASCADE,
  description            text NOT NULL,
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (depends_on_project_id IS NULL OR depends_on_project_id <> project_id)
);

CREATE TABLE project_risks (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id   bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        text NOT NULL,
  description  text,
  probability  text NOT NULL DEFAULT 'medium' CHECK (probability IN ('low','medium','high')),
  impact       text NOT NULL DEFAULT 'medium' CHECK (impact IN ('low','medium','high','critical')),
  mitigation   text,
  owner_id     bigint REFERENCES users(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','mitigating','closed','occurred')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_risks_project_idx ON project_risks(project_id);

-- Resource requirements / allocations (by person or by skill)
CREATE TABLE project_resources (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id      bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_id        bigint REFERENCES skills(id) ON DELETE SET NULL,
  user_id         bigint REFERENCES users(id) ON DELETE SET NULL,
  department_id   bigint REFERENCES departments(id) ON DELETE SET NULL,
  required_count  int NOT NULL DEFAULT 1 CHECK (required_count > 0),
  hours_per_week  numeric(6,2) NOT NULL DEFAULT 40 CHECK (hours_per_week >= 0),
  start_date      date,
  end_date        date,
  status          text NOT NULL DEFAULT 'required' CHECK (status IN ('required','requested','allocated','released')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_resources_project_idx ON project_resources(project_id);

CREATE TABLE project_documents (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id   bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_id      bigint NOT NULL REFERENCES files(id),
  title        text NOT NULL,
  category     text NOT NULL DEFAULT 'general',
  uploaded_by  bigint NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_discussions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id  bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id   bigint REFERENCES project_discussions(id) ON DELETE CASCADE,
  author_id   bigint NOT NULL REFERENCES users(id),
  body        text NOT NULL,
  mentions    bigint[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  edited_at   timestamptz,
  deleted_at  timestamptz
);
CREATE INDEX project_discussions_project_idx ON project_discussions(project_id, created_at);

-- ---------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------
CREATE SEQUENCE task_key_seq START 1000;

CREATE TABLE tasks (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_key               text NOT NULL UNIQUE DEFAULT ('TSK-' || nextval('task_key_seq')),
  title                  text NOT NULL,
  description            text,
  department_id          bigint REFERENCES departments(id),
  project_id             bigint REFERENCES projects(id) ON DELETE SET NULL,
  milestone_id           bigint REFERENCES project_milestones(id) ON DELETE SET NULL,
  parent_task_id         bigint REFERENCES tasks(id) ON DELETE CASCADE,
  assigned_by            bigint REFERENCES users(id),
  priority               text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  complexity             int NOT NULL DEFAULT 3 CHECK (complexity BETWEEN 1 AND 5),
  task_type              text NOT NULL DEFAULT 'general',
  start_date             date,
  deadline               timestamptz,
  estimated_hours        numeric(7,2) CHECK (estimated_hours >= 0),
  actual_hours           numeric(9,2) NOT NULL DEFAULT 0,
  status                 text NOT NULL DEFAULT 'not_started' CHECK (status IN
                         ('not_started','in_progress','on_hold','blocked','submitted','under_review','revision_required','completed','cancelled')),
  progress               int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  remarks                text,
  blocker_note           text,
  quality_rating         int CHECK (quality_rating BETWEEN 1 AND 5),
  revision_count         int NOT NULL DEFAULT 0,
  submitted_at           timestamptz,
  completed_at           timestamptz,       -- set only on approval
  approved_by            bigint REFERENCES users(id),
  is_overdue             boolean NOT NULL DEFAULT false,
  is_archived            boolean NOT NULL DEFAULT false,
  -- Recurring tasks: a template row (is_recurring_template) spawns instances (recurrence_parent_id)
  is_recurring_template  boolean NOT NULL DEFAULT false,
  recurring_schedule_id  bigint REFERENCES recurring_schedules(id) ON DELETE SET NULL,
  recurrence_next_at     timestamptz,
  recurrence_count       int NOT NULL DEFAULT 0,
  recurrence_parent_id   bigint REFERENCES tasks(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CHECK (parent_task_id IS NULL OR parent_task_id <> id)
);
CREATE INDEX tasks_recurrence_idx ON tasks(recurrence_next_at) WHERE is_recurring_template AND deleted_at IS NULL;
CREATE UNIQUE INDEX tasks_recurrence_instance_uq ON tasks(recurrence_parent_id, deadline) WHERE recurrence_parent_id IS NOT NULL;
CREATE INDEX tasks_project_idx ON tasks(project_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_department_idx ON tasks(department_id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_status_deadline_idx ON tasks(status, deadline) WHERE deleted_at IS NULL;
CREATE INDEX tasks_deadline_open_idx ON tasks(deadline)
  WHERE deleted_at IS NULL AND status NOT IN ('completed','cancelled');
CREATE INDEX tasks_parent_idx ON tasks(parent_task_id);

CREATE TABLE task_assignees (
  task_id      bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_primary   boolean NOT NULL DEFAULT false,
  assigned_by  bigint REFERENCES users(id),
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_assignees_user_idx ON task_assignees(user_id);

CREATE TABLE subtasks (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id      bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title        text NOT NULL,
  assignee_id  bigint REFERENCES users(id) ON DELETE SET NULL,
  due_date     date,
  is_done      boolean NOT NULL DEFAULT false,
  done_at      timestamptz,
  sort_order   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subtasks_task_idx ON subtasks(task_id);

CREATE TABLE task_checklist_items (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id     bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label       text NOT NULL,
  is_done     boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0
);
CREATE INDEX task_checklist_task_idx ON task_checklist_items(task_id);

-- Immutable progress/status log
CREATE TABLE task_updates (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id      bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id      bigint NOT NULL REFERENCES users(id),
  kind         text NOT NULL DEFAULT 'progress',  -- progress | status | blocker | deadline | assignment | submission | review
  status_from  text,
  status_to    text,
  progress     int CHECK (progress BETWEEN 0 AND 100),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_updates_task_idx ON task_updates(task_id, created_at DESC);
CREATE INDEX task_updates_user_idx ON task_updates(user_id, created_at DESC);

CREATE TABLE task_comments (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id     bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id   bigint NOT NULL REFERENCES users(id),
  body        text NOT NULL,
  mentions    bigint[] NOT NULL DEFAULT '{}',
  is_feedback boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  edited_at   timestamptz,
  deleted_at  timestamptz
);
CREATE INDEX task_comments_task_idx ON task_comments(task_id, created_at);

CREATE TABLE task_attachments (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id      bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_id      bigint NOT NULL REFERENCES files(id),
  uploaded_by  bigint NOT NULL REFERENCES users(id),
  is_deliverable boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_attachments_task_idx ON task_attachments(task_id);

CREATE TABLE task_dependencies (
  task_id             bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id  bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dependency_type     text NOT NULL DEFAULT 'finish_to_start' CHECK (dependency_type IN ('finish_to_start','start_to_start','finish_to_finish')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX task_dependencies_dep_idx ON task_dependencies(depends_on_task_id);

-- Completion reviews and deadline-extension requests
CREATE TABLE task_approvals (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id             bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  approval_type       text NOT NULL CHECK (approval_type IN ('completion','extension')),
  requested_by        bigint NOT NULL REFERENCES users(id),
  requested_at        timestamptz NOT NULL DEFAULT now(),
  request_note        text,
  previous_deadline   timestamptz,
  requested_deadline  timestamptz,
  reviewer_id         bigint REFERENCES users(id),
  decision            text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','approved','rejected','revision_required','withdrawn')),
  comments            text,
  quality_rating      int CHECK (quality_rating BETWEEN 1 AND 5),
  decided_at          timestamptz
);
CREATE INDEX task_approvals_task_idx ON task_approvals(task_id, requested_at DESC);
CREATE INDEX task_approvals_pending_idx ON task_approvals(decision) WHERE decision = 'pending';
-- at most one pending request of each type per task
CREATE UNIQUE INDEX task_approvals_one_pending ON task_approvals(task_id, approval_type) WHERE decision = 'pending';

CREATE TABLE time_entries (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id     bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id     bigint NOT NULL REFERENCES users(id),
  entry_date  date NOT NULL,
  hours       numeric(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX time_entries_user_date_idx ON time_entries(user_id, entry_date);
CREATE INDEX time_entries_task_idx ON time_entries(task_id);

-- Generic approvals for project-level changes
CREATE TABLE approval_requests (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  approval_type  text NOT NULL CHECK (approval_type IN
                 ('project_approval','milestone','resource_allocation','scope_change','budget_change')),
  project_id     bigint REFERENCES projects(id) ON DELETE CASCADE,
  entity_id      bigint,                -- milestone id / resource id when applicable
  title          text NOT NULL,
  details        text,
  payload        jsonb NOT NULL DEFAULT '{}',  -- proposed change (e.g. {"estimated_budget": 120000})
  requested_by   bigint NOT NULL REFERENCES users(id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  reviewer_id    bigint REFERENCES users(id),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  comments       text,
  decided_at     timestamptz
);
CREATE INDEX approval_requests_status_idx ON approval_requests(status, requested_at DESC);

-- ---------------------------------------------------------------------
-- Daily reports
-- ---------------------------------------------------------------------
CREATE TABLE daily_reports (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_date       date NOT NULL,
  work_planned      text,
  work_completed    text NOT NULL,
  work_pending      text,
  hours_spent       numeric(4,2) NOT NULL DEFAULT 0 CHECK (hours_spent >= 0 AND hours_spent <= 24),
  delay_reason      text,
  challenges        text,
  next_actions      text,
  support_required  text,
  status            text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','reviewed','needs_info')),
  reviewer_id       bigint REFERENCES users(id),
  review_comment    text,
  reviewed_at       timestamptz,
  submitted_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, report_date)
);
CREATE INDEX daily_reports_date_idx ON daily_reports(report_date);

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
-- Event-triggered rules (task.assigned, task.submitted, ...)
CREATE TABLE notification_rules (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name              text NOT NULL,
  event_type        text NOT NULL,
  channels          text[] NOT NULL DEFAULT '{in_app}',
  recipient_roles   text[] NOT NULL DEFAULT '{assignee}',   -- assignee|assigner|hod|team_leader|project_manager|admin|mentioned
  title_template    text NOT NULL,
  message_template  text NOT NULL,
  priority_filter   text[],
  department_id     bigint REFERENCES departments(id) ON DELETE CASCADE,
  project_id        bigint REFERENCES projects(id) ON DELETE CASCADE,
  is_active         boolean NOT NULL DEFAULT true,
  created_by        bigint REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_rules_event_idx ON notification_rules(event_type) WHERE is_active;

-- Deadline & escalation rules
CREATE TABLE escalation_rules (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             text NOT NULL,
  level            int NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 10),
  -- minutes relative to deadline: negative = before deadline, 0 = at deadline, positive = overdue by
  offset_minutes   int NOT NULL,
  notify_roles     text[] NOT NULL,                       -- assignee|hod|team_leader|project_manager|admin|director
  channels         text[] NOT NULL DEFAULT '{in_app,email}',
  priority_filter  text[],
  department_id    bigint REFERENCES departments(id) ON DELETE CASCADE,
  project_id       bigint REFERENCES projects(id) ON DELETE CASCADE,
  task_type        text,
  message_template text,
  is_active        boolean NOT NULL DEFAULT true,
  created_by       bigint REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE escalation_history (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id            bigint NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rule_id            bigint REFERENCES escalation_rules(id) ON DELETE SET NULL,
  level              int NOT NULL,
  deadline_snapshot  timestamptz NOT NULL,
  notified_user_ids  bigint[] NOT NULL DEFAULT '{}',
  note               text,
  escalated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, rule_id, deadline_snapshot)
);
CREATE INDEX escalation_history_task_idx ON escalation_history(task_id);

CREATE TABLE management_agenda (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id               bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                  text NOT NULL,
  description            text,
  due_at                 timestamptz NOT NULL,
  timezone               text NOT NULL,
  priority               text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  notes                  text,
  reminder_minutes_before int CHECK (reminder_minutes_before >= 0),
  recurring_schedule_id  bigint REFERENCES recurring_schedules(id) ON DELETE SET NULL,
  related_department_id  bigint REFERENCES departments(id) ON DELETE SET NULL,
  related_project_id     bigint REFERENCES projects(id) ON DELETE SET NULL,
  completed_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX management_agenda_owner_idx ON management_agenda(owner_id, due_at);

-- Custom reminders (one-time, recurring, deadline-relative)
CREATE TABLE notification_schedules (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title                  text NOT NULL,
  description            text,
  message                text,
  created_by             bigint NOT NULL REFERENCES users(id),
  task_id                bigint REFERENCES tasks(id) ON DELETE CASCADE,
  project_id             bigint REFERENCES projects(id) ON DELETE CASCADE,
  department_id          bigint REFERENCES departments(id) ON DELETE SET NULL,
  agenda_id              bigint REFERENCES management_agenda(id) ON DELETE CASCADE,
  schedule_type          text NOT NULL CHECK (schedule_type IN ('one_time','recurring','deadline_offset')),
  run_at                 timestamptz,       -- one_time: absolute UTC instant
  timezone               text NOT NULL,
  offset_minutes         int,               -- deadline_offset: minutes BEFORE the task deadline
  recurring_schedule_id  bigint REFERENCES recurring_schedules(id) ON DELETE SET NULL,
  channels               text[] NOT NULL DEFAULT '{in_app}',
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','cancelled')),
  next_run_at            timestamptz,
  last_run_at            timestamptz,
  run_count              int NOT NULL DEFAULT 0,
  source                 text NOT NULL DEFAULT 'user' CHECK (source IN ('user','agenda','system')),
  cancelled_at           timestamptz,
  cancelled_by           bigint REFERENCES users(id),
  cancel_reason          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (schedule_type <> 'one_time' OR run_at IS NOT NULL),
  CHECK (schedule_type <> 'deadline_offset' OR (task_id IS NOT NULL AND offset_minutes IS NOT NULL)),
  CHECK (schedule_type <> 'recurring' OR recurring_schedule_id IS NOT NULL)
);
CREATE INDEX notification_schedules_due_idx ON notification_schedules(next_run_at) WHERE status = 'active';
CREATE INDEX notification_schedules_task_idx ON notification_schedules(task_id);
CREATE INDEX notification_schedules_creator_idx ON notification_schedules(created_by);

CREATE TABLE notification_recipients (
  schedule_id  bigint NOT NULL REFERENCES notification_schedules(id) ON DELETE CASCADE,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (schedule_id, user_id)
);

-- One row per (occurrence, recipient, channel). Also backs the in-app notification centre.
CREATE TABLE notification_logs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedupe_key      text NOT NULL UNIQUE,     -- prevents duplicate delivery of the same occurrence
  schedule_id     bigint REFERENCES notification_schedules(id) ON DELETE SET NULL,
  rule_id         bigint REFERENCES notification_rules(id) ON DELETE SET NULL,
  escalation_id   bigint REFERENCES escalation_history(id) ON DELETE SET NULL,
  user_id         bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('in_app','email','browser_push','mobile_push','whatsapp')),
  category        text NOT NULL DEFAULT 'reminder',  -- reminder|event|escalation|system
  title           text NOT NULL,
  body            text NOT NULL,
  link            text,
  status          text NOT NULL DEFAULT 'scheduled' CHECK (status IN
                  ('scheduled','sent','delivered','failed','retried','read','cancelled','skipped')),
  occurrence_at   timestamptz NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  provider_ref    text,
  sent_at         timestamptz,
  delivered_at    timestamptz,
  read_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_logs_user_inapp_idx ON notification_logs(user_id, created_at DESC) WHERE channel = 'in_app';
CREATE INDEX notification_logs_status_idx ON notification_logs(status, created_at DESC);
CREATE INDEX notification_logs_schedule_idx ON notification_logs(schedule_id);

CREATE TABLE user_notification_preferences (
  user_id              bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  in_app               boolean NOT NULL DEFAULT true,
  email                boolean NOT NULL DEFAULT true,
  browser_push         boolean NOT NULL DEFAULT true,
  mobile_push          boolean NOT NULL DEFAULT true,
  whatsapp             boolean NOT NULL DEFAULT false,
  whatsapp_number      text,
  quiet_hours_start    time,
  quiet_hours_end      time,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE push_subscriptions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE device_tokens (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  platform    text NOT NULL CHECK (platform IN ('android','ios','web')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Meetings
-- ---------------------------------------------------------------------
CREATE TABLE meetings (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title          text NOT NULL,
  project_id     bigint REFERENCES projects(id) ON DELETE SET NULL,
  department_id  bigint REFERENCES departments(id) ON DELETE SET NULL,
  organizer_id   bigint NOT NULL REFERENCES users(id),
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  location       text,
  agenda         text,
  minutes        text,
  status         text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX meetings_starts_idx ON meetings(starts_at);

CREATE TABLE meeting_attendees (
  meeting_id  bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE meeting_action_items (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meeting_id   bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  title        text NOT NULL,
  assignee_id  bigint REFERENCES users(id) ON DELETE SET NULL,
  due_date     date,
  task_id      bigint REFERENCES tasks(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id     bigint REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    bigint,
  summary      text,
  before       jsonb,
  after        jsonb,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_id, created_at DESC);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC);

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
