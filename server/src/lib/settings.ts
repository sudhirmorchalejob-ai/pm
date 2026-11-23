import { currentOrgId, db } from '../db/knex';

export const DEFAULT_SETTINGS = {
  organization_name: 'OrgPM',
  default_timezone: 'Asia/Kolkata',
  // What happens to pending reminders when a task is completed or cancelled: 'cancel' | 'keep'
  reminders_on_task_close: 'cancel',
  // Weekly allocation above this % of capacity flags an employee as overloaded
  overload_threshold_percent: 110,
  // Roles required to submit a daily report (keys from roles table)
  daily_report_roles: ['employee', 'team_leader'],
  // Daily report reminder (local time in default timezone); empty disables
  daily_report_reminder_time: '18:00',
  working_days: [1, 2, 3, 4, 5],
  allow_self_approval_for_super_admin: true,
  // Daily questionnaire / checklists
  checklist_channels: ['in_app', 'email'],          // channels for checklist assignment notices, reminders and escalations
  checklist_notify_new_questions: true,             // tell employees when new questions appear in their checklist
  // Automatic End-of-Day report (local time in default timezone, working days only)
  eod_auto_enabled: true,
  eod_generation_time: '19:00',
  eod_notify_roles: ['super_admin', 'director'],    // HODs are also told (their department's slice)
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;

// Settings are per organization (app_settings is tenant-scoped by RLS); cache per org + key.
const cache = new Map<string, { at: number; v: any }>();
const ck = (key: string) => `${currentOrgId() ?? 0}:${key}`;

export async function getSetting<K extends SettingKey>(key: K): Promise<(typeof DEFAULT_SETTINGS)[K] | any> {
  const c = cache.get(ck(key));
  if (c && Date.now() - c.at < 15_000) return c.v;
  const row = currentOrgId() ? await db('app_settings').where({ key }).first('value') : null;
  const v = row ? row.value : DEFAULT_SETTINGS[key];
  cache.set(ck(key), { at: Date.now(), v });
  return v;
}

export async function getAllSettings() {
  const rows = await db('app_settings').select('key', 'value');
  const out: Record<string, any> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
  return out;
}

/** Must be called inside a tenant context (organization_id defaults from it). */
export async function setSetting(key: SettingKey, value: unknown, userId: number | null) {
  await db('app_settings').insert({ key, value: JSON.stringify(value), updated_by: userId, updated_at: db.fn.now() })
    .onConflict(['organization_id', 'key']).merge();
  cache.delete(ck(key));
}
