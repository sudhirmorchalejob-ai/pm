-- =====================================================================
-- Multi-tenancy: every business row belongs to an organization.
-- Isolation is enforced by PostgreSQL Row-Level Security (FORCE, so it also
-- applies to the table owner). The API sets `app.org_id` per transaction
-- (SET LOCAL via set_config); inserts default organization_id from it.
-- When app.org_id is unset (login, registration, background job dispatch)
-- the policy is permissive; those code paths filter explicitly and every
-- authenticated request / job body runs inside an org-scoped transaction.
-- NOTE: superusers bypass RLS entirely — run the application as a normal role.
-- =====================================================================

CREATE TABLE organizations (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  slug        citext NOT NULL UNIQUE,
  timezone    text NOT NULL DEFAULT 'Asia/Kolkata',
  plan        text NOT NULL DEFAULT 'standard',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Existing data (if any) becomes the default organization.
INSERT INTO organizations (name, slug) VALUES ('Default Organization', 'default');

CREATE OR REPLACE FUNCTION app_current_org() RETURNS bigint
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.org_id', true), '')::bigint $$;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'users','departments','designations','teams','reporting_hierarchy','skills','user_skills','files',
    'recurring_schedules','projects','future_projects','project_members','project_milestones','project_deliverables',
    'project_dependencies','project_risks','project_resources','project_documents','project_discussions',
    'tasks','task_assignees','subtasks','task_checklist_items','task_updates','task_comments','task_attachments',
    'task_dependencies','task_approvals','time_entries','approval_requests','daily_reports',
    'notification_rules','escalation_rules','escalation_history','management_agenda','notification_schedules',
    'notification_recipients','notification_logs','user_notification_preferences','push_subscriptions','device_tokens',
    'meetings','meeting_attendees','meeting_action_items','app_settings','role_permissions','audit_logs'];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN organization_id bigint DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE', t);
    IF t <> 'audit_logs' THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN organization_id SET NOT NULL', t);
    END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN organization_id SET DEFAULT app_current_org()', t);
    EXECUTE format('CREATE INDEX %I ON %I (organization_id)', t || '_org_idx', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_current_org() IS NULL OR organization_id = app_current_org())
      WITH CHECK (app_current_org() IS NULL OR organization_id = app_current_org())$p$, t);
  END LOOP;
END $$;

-- Uniqueness that was global becomes per-organization.
ALTER TABLE users DROP CONSTRAINT users_employee_code_key;
ALTER TABLE users ADD CONSTRAINT users_org_employee_code_key UNIQUE (organization_id, employee_code);
-- (users.email stays globally unique: the email identifies the tenant at sign-in.)
ALTER TABLE departments DROP CONSTRAINT departments_code_key;
ALTER TABLE departments ADD CONSTRAINT departments_org_code_key UNIQUE (organization_id, code);
ALTER TABLE projects DROP CONSTRAINT projects_code_key;
ALTER TABLE projects ADD CONSTRAINT projects_org_code_key UNIQUE (organization_id, code);
ALTER TABLE skills DROP CONSTRAINT skills_name_key;
ALTER TABLE skills ADD CONSTRAINT skills_org_name_key UNIQUE (organization_id, name);
ALTER TABLE designations DROP CONSTRAINT designations_title_department_id_key;
ALTER TABLE designations ADD CONSTRAINT designations_org_title_dept_key UNIQUE (organization_id, title, department_id);
ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
ALTER TABLE app_settings ADD PRIMARY KEY (organization_id, key);
ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_pkey;
ALTER TABLE role_permissions ADD PRIMARY KEY (organization_id, role_id, permission_id);
