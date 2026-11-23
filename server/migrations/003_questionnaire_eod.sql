-- =====================================================================
-- 003: Department/employee history, dynamic questionnaire, daily checklists,
--      checklist escalations and End-of-Day (EOD) reports.
-- Purely additive: no existing table or column is changed or dropped.
-- History tables are backfilled from the current state of existing users so
-- every employee starts with an accurate "current" record.
-- All new tables are tenant tables with forced row-level security (see 002).
-- =====================================================================

-- ---------------------------------------------------------------- history
CREATE TABLE department_history (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id    bigint REFERENCES departments(id) ON DELETE SET NULL,
  team_id          bigint REFERENCES teams(id) ON DELETE SET NULL,
  effective_from   timestamptz NOT NULL DEFAULT now(),
  effective_to     timestamptz,
  reason           text,
  changed_by       bigint REFERENCES users(id) ON DELETE SET NULL,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX department_history_user_idx ON department_history(user_id, effective_from DESC);
CREATE INDEX department_history_dept_idx ON department_history(department_id, effective_from DESC);
-- at most one open (current) record per employee
CREATE UNIQUE INDEX department_history_current_idx ON department_history(user_id) WHERE effective_to IS NULL;

INSERT INTO department_history (organization_id, user_id, department_id, team_id, effective_from, reason)
SELECT organization_id, id, department_id, team_id, LEAST(coalesce(joining_date::timestamptz, created_at), created_at), 'Initial record (migration 003)'
FROM users WHERE deleted_at IS NULL;

CREATE TABLE employee_status_history (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id    bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  user_id            bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_active          boolean NOT NULL,
  employment_status  text NOT NULL,
  reason             text,
  changed_by         bigint REFERENCES users(id) ON DELETE SET NULL,
  changed_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employee_status_history_user_idx ON employee_status_history(user_id, changed_at DESC);

INSERT INTO employee_status_history (organization_id, user_id, is_active, employment_status, reason, changed_at)
SELECT organization_id, id, is_active, employment_status, 'Initial record (migration 003)', created_at FROM users;

-- ---------------------------------------------------------------- question builder
CREATE TABLE question_sections (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description      text,
  sort_order       int NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  created_by       bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_by       bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);

CREATE TABLE questions (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id        bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  section_id             bigint REFERENCES question_sections(id) ON DELETE SET NULL,
  text                   text NOT NULL CHECK (length(text) BETWEEN 2 AND 1000),
  help_text              text,
  answer_type            text NOT NULL CHECK (answer_type IN
                         ('text','long_text','number','date','time','yes_no','url','url_list','single_choice','multiple_choice','file','rating','email')),
  options                jsonb NOT NULL DEFAULT '{}',   -- {choices:[], min, max, unit, placeholder}
  is_required            boolean NOT NULL DEFAULT true,
  priority               text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  -- How the answer is consolidated in EOD reports
  report_tag             text NOT NULL DEFAULT 'other' CHECK (report_tag IN
                         ('work_done','plan','pending','blocker','delay','progress','deadline','campaign','url','metric','other')),
  sort_order             int NOT NULL DEFAULT 0,
  frequency              text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily','weekly','monthly','specific_dates','custom')),
  frequency_config       jsonb NOT NULL DEFAULT '{}',
  start_date             date,
  end_date               date,
  deadline_time          time NOT NULL DEFAULT '18:00',  -- local time of each employee
  reminder_offsets       int[] NOT NULL DEFAULT '{60}',  -- minutes before the deadline
  condition_question_id  bigint REFERENCES questions(id) ON DELETE SET NULL,
  condition_operator     text CHECK (condition_operator IN ('equals','not_equals','contains','gt','lt','answered','not_answered')),
  condition_value        jsonb,
  is_active              boolean NOT NULL DEFAULT true,
  template_key           text,
  version                int NOT NULL DEFAULT 1,
  created_by             bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_by             bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz,
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  CHECK (condition_question_id IS NULL OR condition_question_id <> id)
);
CREATE INDEX questions_section_idx ON questions(section_id, sort_order) WHERE deleted_at IS NULL;

CREATE TABLE question_assignments (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  question_id      bigint NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  target_type      text NOT NULL CHECK (target_type IN ('user','department','all')),
  user_id          bigint REFERENCES users(id) ON DELETE CASCADE,
  department_id    bigint REFERENCES departments(id) ON DELETE CASCADE,
  created_by       bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((target_type = 'user' AND user_id IS NOT NULL AND department_id IS NULL)
      OR (target_type = 'department' AND department_id IS NOT NULL AND user_id IS NULL)
      OR (target_type = 'all' AND user_id IS NULL AND department_id IS NULL))
);
CREATE UNIQUE INDEX question_assignments_uniq ON question_assignments(question_id, target_type, coalesce(user_id, 0), coalesce(department_id, 0));
CREATE INDEX question_assignments_user_idx ON question_assignments(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX question_assignments_dept_idx ON question_assignments(department_id) WHERE department_id IS NOT NULL;

-- Editable starter templates (seeded per organization; never hard-wired into checklists)
CREATE TABLE question_templates (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  key              text NOT NULL,
  name             text NOT NULL,
  description      text,
  is_active        boolean NOT NULL DEFAULT true,
  created_by       bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

CREATE TABLE question_template_items (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  template_id      bigint NOT NULL REFERENCES question_templates(id) ON DELETE CASCADE,
  text             text NOT NULL CHECK (length(text) BETWEEN 2 AND 1000),
  help_text        text,
  answer_type      text NOT NULL CHECK (answer_type IN
                   ('text','long_text','number','date','time','yes_no','url','url_list','single_choice','multiple_choice','file','rating','email')),
  options          jsonb NOT NULL DEFAULT '{}',
  is_required      boolean NOT NULL DEFAULT true,
  priority         text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  report_tag       text NOT NULL DEFAULT 'other' CHECK (report_tag IN
                   ('work_done','plan','pending','blocker','delay','progress','deadline','campaign','url','metric','other')),
  sort_order       int NOT NULL DEFAULT 0
);
CREATE INDEX question_template_items_tpl_idx ON question_template_items(template_id, sort_order);

-- ---------------------------------------------------------------- daily checklists
CREATE TABLE checklists (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id     bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checklist_date      date NOT NULL,                  -- employee's local date
  department_id       bigint REFERENCES departments(id) ON DELETE SET NULL,  -- department at generation time
  timezone            text NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','submitted')),
  due_at              timestamptz,                    -- earliest deadline among applicable required items
  total_items         int NOT NULL DEFAULT 0,         -- applicable items (conditions evaluated)
  required_items      int NOT NULL DEFAULT 0,
  answered_items      int NOT NULL DEFAULT 0,         -- submitted
  required_answered   int NOT NULL DEFAULT 0,
  completion_percent  int NOT NULL DEFAULT 0 CHECK (completion_percent BETWEEN 0 AND 100),
  first_submitted_at  timestamptz,
  submitted_at        timestamptz,                    -- when all required items were submitted
  is_late             boolean NOT NULL DEFAULT false,
  last_activity_at    timestamptz,
  generated_at        timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, checklist_date)                    -- duplicate generation is impossible
);
CREATE INDEX checklists_date_idx ON checklists(organization_id, checklist_date);
CREATE INDEX checklists_dept_date_idx ON checklists(department_id, checklist_date);
CREATE INDEX checklists_open_due_idx ON checklists(due_at) WHERE status <> 'submitted';

CREATE TABLE checklist_items (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id        bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  checklist_id           bigint NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  question_id            bigint REFERENCES questions(id) ON DELETE SET NULL,
  assignment_id          bigint REFERENCES question_assignments(id) ON DELETE SET NULL,
  assigned_by            bigint REFERENCES users(id) ON DELETE SET NULL,
  -- snapshot of the question at generation time (later edits don't rewrite history)
  section_name           text,
  question_text          text NOT NULL,
  help_text              text,
  answer_type            text NOT NULL,
  options                jsonb NOT NULL DEFAULT '{}',
  is_required            boolean NOT NULL DEFAULT true,
  priority               text NOT NULL DEFAULT 'medium',
  report_tag             text NOT NULL DEFAULT 'other',
  sort_order             int NOT NULL DEFAULT 0,
  section_order          int NOT NULL DEFAULT 0,
  condition_question_id  bigint,
  condition_operator     text,
  condition_value        jsonb,
  reminder_offsets       int[] NOT NULL DEFAULT '{}',
  due_at                 timestamptz NOT NULL,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','draft','submitted','skipped')),
  draft                  jsonb,                       -- {value, note, supporting_urls, file_ids}
  draft_saved_at         timestamptz,
  answer                 jsonb,                       -- submitted typed value
  answer_text            text,                        -- human-readable submitted value
  note                   text,
  supporting_urls        text[] NOT NULL DEFAULT '{}',
  file_ids               bigint[] NOT NULL DEFAULT '{}',
  revision               int NOT NULL DEFAULT 0,      -- 1 = first submission, 2+ = revisions
  submitted_at           timestamptz,
  submitted_by           bigint REFERENCES users(id) ON DELETE SET NULL,
  is_late                boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checklist_id, question_id)
);
CREATE INDEX checklist_items_checklist_idx ON checklist_items(checklist_id, section_order, sort_order);
CREATE INDEX checklist_items_open_due_idx ON checklist_items(due_at) WHERE status IN ('pending','draft');
CREATE INDEX checklist_items_question_idx ON checklist_items(question_id);

-- Every submission and revision is kept; rows can never be changed or removed.
CREATE TABLE checklist_answer_revisions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  item_id          bigint NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  revision         int NOT NULL,
  answer           jsonb,
  answer_text      text,
  note             text,
  supporting_urls  text[] NOT NULL DEFAULT '{}',
  file_ids         bigint[] NOT NULL DEFAULT '{}',
  reason           text,
  submitted_by     bigint REFERENCES users(id) ON DELETE SET NULL,
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, revision)
);

CREATE OR REPLACE FUNCTION checklist_revisions_immutable() RETURNS trigger AS $$
BEGIN
  -- cascades from deleting the organization/checklist are allowed; direct edits are not
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'checklist_answer_revisions is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER checklist_revisions_no_update BEFORE UPDATE OR DELETE ON checklist_answer_revisions
  FOR EACH ROW EXECUTE FUNCTION checklist_revisions_immutable();

-- Configurable escalation intervals for incomplete checklists (relative to the checklist deadline)
CREATE TABLE checklist_escalation_rules (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  level            int NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 10),
  offset_minutes   int NOT NULL CHECK (offset_minutes BETWEEN 0 AND 20160),  -- after the deadline (0 = at deadline)
  notify_roles     text[] NOT NULL CHECK (notify_roles <@ ARRAY['employee','team_leader','hod','manager','admin','director']::text[] AND cardinality(notify_roles) > 0),
  channels         text[] NOT NULL DEFAULT '{in_app,email}',
  department_id    bigint REFERENCES departments(id) ON DELETE CASCADE,
  is_active        boolean NOT NULL DEFAULT true,
  created_by       bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE checklist_escalations (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id    bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  checklist_id       bigint NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  rule_id            bigint NOT NULL REFERENCES checklist_escalation_rules(id) ON DELETE CASCADE,
  level              int NOT NULL,
  notified_user_ids  bigint[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (checklist_id, rule_id)                     -- each rule fires once per checklist
);

-- ---------------------------------------------------------------- EOD reports
CREATE TABLE eod_reports (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  report_date      date NOT NULL,
  trigger          text NOT NULL CHECK (trigger IN ('auto','manual')),
  generated_by     bigint REFERENCES users(id) ON DELETE SET NULL,
  generated_at     timestamptz NOT NULL DEFAULT now(),
  timezone         text NOT NULL,
  summary          jsonb NOT NULL,
  data             jsonb NOT NULL
);
CREATE INDEX eod_reports_date_idx ON eod_reports(organization_id, report_date DESC, generated_at DESC);
CREATE UNIQUE INDEX eod_reports_auto_once_idx ON eod_reports(organization_id, report_date) WHERE trigger = 'auto';

-- ---------------------------------------------------------------- tenant isolation for the new tables
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['department_history','employee_status_history','question_sections','questions','question_assignments',
    'question_templates','question_template_items','checklists','checklist_items','checklist_answer_revisions',
    'checklist_escalation_rules','checklist_escalations','eod_reports'] LOOP
    EXECUTE format('CREATE INDEX %I ON %I (organization_id)', t || '_org_idx', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_current_org() IS NULL OR organization_id = app_current_org())
      WITH CHECK (app_current_org() IS NULL OR organization_id = app_current_org())$p$, t);
  END LOOP;
END $$;
