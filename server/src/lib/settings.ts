import { db } from '../db/knex';

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
} as const;

export type SettingKey = keyof typeof DEFAULT_SETTINGS;

const cache = new Map<string, { at: number; v: any }>();

export async function getSetting<K extends SettingKey>(key: K): Promise<(typeof DEFAULT_SETTINGS)[K] | any> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < 15_000) return c.v;
  const row = await db('app_settings').where({ key }).first('value');
  const v = row ? row.value : DEFAULT_SETTINGS[key];
  cache.set(key, { at: Date.now(), v });
  return v;
}

export async function getAllSettings() {
  const rows = await db('app_settings').select('key', 'value');
  const out: Record<string, any> = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function setSetting(key: SettingKey, value: unknown, userId: number) {
  await db('app_settings').insert({ key, value: JSON.stringify(value), updated_by: userId, updated_at: db.fn.now() })
    .onConflict('key').merge();
  cache.delete(key);
}
