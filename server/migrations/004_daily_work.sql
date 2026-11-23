-- =====================================================================
-- Companies (business entities), additional designations, personal daily
-- work: quick activities (with coordination history), personal tasks
-- (one-off and recurring), and personal EOD reports.
-- Additive only: no existing table, column or row is changed or dropped.
-- =====================================================================

-- ---------------------------------------------------------------- companies / business entities
CREATE TABLE companies (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  code             citext NOT NULL,
  description      text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  UNIQUE (organization_id, code)
);
CREATE UNIQUE INDEX companies_org_name_uq ON companies (organization_id, lower(name)) WHERE deleted_at IS NULL;

ALTER TABLE users ADD COLUMN company_id bigint REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX users_company_idx ON users(company_id) WHERE deleted_at IS NULL;

-- Additional designations (users.designation_id stays the primary one)
CREATE TABLE user_designations (
  organization_id  bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  designation_id   bigint NOT NULL REFERENCES designations(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, designation_id)
);

-- ---------------------------------------------------------------- quick activity categories
CREATE TABLE activity_categories (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id    bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  key                text,                         -- stable key for the built-in categories (NULL for admin-created)
  name               text NOT NULL,
  group_name         text NOT NULL DEFAULT 'Other',
  report_section     text NOT NULL DEFAULT 'other' CHECK (report_section IN
                     ('coordination','updates','assignment','review','guidance','issue_resolution','testing','missing_functionality',
                      'improvements','client_meeting','client_requirements','client_coordination','development','documentation',
                      'follow_up','meeting','other')),
  suggests_employee  boolean NOT NULL DEFAULT false, -- show the employee picker first
  sort_order         int NOT NULL DEFAULT 0,
  is_active          boolean NOT NULL DEFAULT true,
  created_by         bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);
CREATE UNIQUE INDEX activity_categories_name_uq ON activity_categories (organization_id, lower(name));

-- ---------------------------------------------------------------- activities (timeline entries)
CREATE TABLE activities (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id     bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,       -- who performed it
  category_id         bigint NOT NULL REFERENCES activity_categories(id),
  activity_date       date NOT NULL,                 -- local date of the performer
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  duration_minutes    int CHECK (duration_minutes BETWEEN 1 AND 1440),
  description         text NOT NULL CHECK (length(trim(description)) > 0),
  status              text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','in_progress','pending')),
  project_id          bigint REFERENCES projects(id) ON DELETE SET NULL,
  department_ids      bigint[] NOT NULL DEFAULT '{}', -- whole departments selected
  follow_up_required  boolean NOT NULL DEFAULT false,
  follow_up_note      text,
  follow_up_due       date,
  follow_up_done_at   timestamptz,
  issue_resolved      boolean,                       -- NULL = not applicable
  bugs_found          int CHECK (bugs_found BETWEEN 0 AND 10000),
  file_ids            bigint[] NOT NULL DEFAULT '{}',
  revision            int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE INDEX activities_user_date_idx ON activities(user_id, activity_date DESC, occurred_at) WHERE deleted_at IS NULL;
CREATE INDEX activities_date_idx ON activities(organization_id, activity_date) WHERE deleted_at IS NULL;
CREATE INDEX activities_followup_idx ON activities(user_id) WHERE follow_up_required AND follow_up_done_at IS NULL AND deleted_at IS NULL;

-- Employees involved (coordination history). via_department_id is set when added through a department selection.
CREATE TABLE activity_participants (
  organization_id    bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  activity_id        bigint NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id            bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  via_department_id  bigint REFERENCES departments(id) ON DELETE SET NULL,
  PRIMARY KEY (activity_id, user_id)
);
CREATE INDEX activity_participants_user_idx ON activity_participants(user_id);

-- Every edit keeps the previous version (append-only)
CREATE TABLE activity_revisions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  activity_id      bigint NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  revision         int NOT NULL,
  action           text NOT NULL CHECK (action IN ('created','updated','deleted','restored')),
  snapshot         jsonb NOT NULL,
  reason           text,
  changed_by       bigint REFERENCES users(id) ON DELETE SET NULL,
  changed_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (activity_id, revision, action)
);

CREATE OR REPLACE FUNCTION activity_revisions_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'activity_revisions is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER activity_revisions_no_update BEFORE UPDATE OR DELETE ON activity_revisions
  FOR EACH ROW EXECUTE FUNCTION activity_revisions_immutable();

-- ---------------------------------------------------------------- personal tasks
-- A recurring personal task is a series; each day it occurs gets its own row with its own status.
CREATE TABLE personal_task_series (
  id                       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id          bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  user_id                  bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                    text NOT NULL,
  description              text,
  priority                 text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  project_id               bigint REFERENCES projects(id) ON DELETE SET NULL,
  frequency                text NOT NULL CHECK (frequency IN ('daily','weekly','monthly','specific_dates','custom')),
  frequency_config         jsonb NOT NULL DEFAULT '{}',
  start_date               date NOT NULL,
  end_date                 date,
  due_time                 time,
  reminder_offset_minutes  int CHECK (reminder_offset_minutes BETWEEN 0 AND 1440),
  is_active                boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz,
  CHECK (end_date IS NULL OR end_date >= start_date)
);

CREATE TABLE personal_tasks (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  series_id        bigint REFERENCES personal_task_series(id) ON DELETE SET NULL,
  title            text NOT NULL,
  description      text,
  priority         text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  project_id       bigint REFERENCES projects(id) ON DELETE SET NULL,
  due_date         date,
  due_at           timestamptz,                      -- due_date + time in the owner's timezone
  remind_at        timestamptz,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','cancelled')),
  completed_at     timestamptz,
  completion_note  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE UNIQUE INDEX personal_tasks_occurrence_uq ON personal_tasks(series_id, due_date) WHERE series_id IS NOT NULL;
CREATE INDEX personal_tasks_user_idx ON personal_tasks(user_id, status, due_date) WHERE deleted_at IS NULL;
CREATE INDEX personal_tasks_remind_idx ON personal_tasks(remind_at) WHERE status = 'pending' AND deleted_at IS NULL AND remind_at IS NOT NULL;

-- ---------------------------------------------------------------- personal EOD report
CREATE TABLE personal_eod_reports (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id      bigint NOT NULL DEFAULT app_current_org() REFERENCES organizations(id) ON DELETE CASCADE,
  user_id              bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_date          date NOT NULL,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  content              text NOT NULL,              -- what the user reviewed/edited (copied to Bitrix24)
  generated_content    text,                       -- last generated text, for "reset to generated"
  next_day_priorities  text,
  data                 jsonb NOT NULL DEFAULT '{}', -- structured sections the text was generated from
  revision             int NOT NULL DEFAULT 1,
  finalized_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, report_date)
);

-- ---------------------------------------------------------------- tenant isolation for the new tables
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['companies','user_designations','activity_categories','activities','activity_participants',
    'activity_revisions','personal_task_series','personal_tasks','personal_eod_reports'] LOOP
    EXECUTE format('CREATE INDEX %I ON %I (organization_id)', t || '_org_idx', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_current_org() IS NULL OR organization_id = app_current_org())
      WITH CHECK (app_current_org() IS NULL OR organization_id = app_current_org())$p$, t);
  END LOOP;
END $$;
