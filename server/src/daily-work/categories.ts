import { db } from '../db/knex';

/**
 * Built-in quick activity categories. Seeded once per organization as ordinary rows:
 * admins can rename, reorder, deactivate them and add their own (Settings → Activity categories).
 * `report_section` decides where an activity appears in the personal EOD report.
 */
export const REPORT_SECTIONS = [
  'coordination', 'updates', 'assignment', 'review', 'guidance', 'issue_resolution', 'testing', 'missing_functionality',
  'improvements', 'client_meeting', 'client_requirements', 'client_coordination', 'development', 'documentation',
  'follow_up', 'meeting', 'other',
] as const;
export type ReportSection = typeof REPORT_SECTIONS[number];

export const REPORT_SECTION_LABELS: Record<ReportSection, string> = {
  coordination: 'Team coordination',
  updates: 'Employee updates collected',
  assignment: 'Tasks assigned',
  review: 'Reviews (progress & code)',
  guidance: 'Technical guidance provided',
  issue_resolution: 'Issues resolved',
  testing: 'Projects tested',
  missing_functionality: 'Missing functionality identified',
  improvements: 'Improvements suggested',
  client_meeting: 'Client meetings attended',
  client_requirements: 'Client requirements discussed',
  client_coordination: 'Client coordination',
  development: 'Development work',
  documentation: 'Documentation',
  follow_up: 'Follow-ups completed',
  meeting: 'Team meetings',
  other: 'Other activities',
};

type Cat = [key: string, name: string, group: string, section: ReportSection, suggestsEmployee: boolean];
export const DEFAULT_ACTIVITY_CATEGORIES: Cat[] = [
  ['coordinated_employee', 'Coordinated With Employee', 'Team management', 'coordination', true],
  ['guided_technical', 'Guided Employee to Fix Technical Issue', 'Technical guidance', 'guidance', true],
  ['assigned_task', 'Assigned Task', 'Team management', 'assignment', true],
  ['collected_updates', 'Collected Employee Updates', 'Team management', 'updates', true],
  ['reviewed_progress', 'Reviewed Project Progress', 'Team management', 'review', false],
  ['tested_application', 'Tested Application', 'Testing & QA', 'testing', false],
  ['missing_functionality', 'Identified Missing Functionality', 'Testing & QA', 'missing_functionality', false],
  ['suggested_improvements', 'Suggested Improvements', 'Testing & QA', 'improvements', false],
  ['fixed_issue', 'Fixed Technical Issue', 'Technical guidance', 'issue_resolution', false],
  ['client_meeting', 'Attended Client Meeting', 'Client coordination', 'client_meeting', false],
  ['client_requirements', 'Discussed Client Requirements', 'Client coordination', 'client_requirements', false],
  ['client_coordination', 'Coordinated With Client', 'Client coordination', 'client_coordination', false],
  ['reviewed_api', 'Reviewed API Integration', 'Technical guidance', 'review', false],
  ['checked_deployment', 'Checked Deployment', 'Technical guidance', 'review', false],
  ['reviewed_code', 'Reviewed Code', 'Technical guidance', 'review', true],
  ['followed_up', 'Followed Up on Pending Task', 'Team management', 'follow_up', true],
  ['team_meeting', 'Conducted Team Meeting', 'Team management', 'meeting', false],
  ['development', 'Development Work', 'Development', 'development', false],
  ['documentation', 'Documentation Work', 'Development', 'documentation', false],
  ['other', 'Other Activity', 'Other', 'other', false],
];

/** Adds the built-in categories that this organization does not have yet (by key or by name). Idempotent. */
export async function seedActivityCategories() {
  const existing = await db('activity_categories').select('key', 'name');
  const keys = new Set(existing.map((r: any) => r.key).filter(Boolean));
  const names = new Set(existing.map((r: any) => String(r.name).toLowerCase()));
  const rows = DEFAULT_ACTIVITY_CATEGORIES
    .map(([key, name, group_name, report_section, suggests_employee], i) => ({ key, name, group_name, report_section, suggests_employee, sort_order: (i + 1) * 10 }))
    .filter((r) => !keys.has(r.key) && !names.has(r.name.toLowerCase()));
  if (rows.length) await db('activity_categories').insert(rows).onConflict(['organization_id', 'key']).ignore();
}
