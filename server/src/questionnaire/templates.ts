import { db } from '../db/knex';

type Item = { text: string; answer_type: string; report_tag: string; is_required?: boolean; priority?: string; help_text?: string; options?: any };

/**
 * Starter templates. They are copied into each organization's own `question_templates`
 * tables, where administrators can edit, extend or delete them. Checklists are generated
 * only from the organization's `questions` table — nothing here is hard-wired.
 */
export const DEFAULT_TEMPLATES: { key: string; name: string; description: string; items: Item[] }[] = [
  {
    key: 'development', name: 'Development', description: 'Daily update for software development teams',
    items: [
      { text: 'Features developed today', answer_type: 'long_text', report_tag: 'work_done', priority: 'high' },
      { text: 'Work completed yesterday', answer_type: 'long_text', report_tag: 'work_done', is_required: false },
      { text: 'Next planned activities', answer_type: 'long_text', report_tag: 'plan' },
      { text: 'Project deadline', answer_type: 'date', report_tag: 'deadline', is_required: false },
      { text: 'Development progress (%)', answer_type: 'number', report_tag: 'progress', options: { min: 0, max: 100, unit: '%' } },
      { text: 'Technical blockers', answer_type: 'long_text', report_tag: 'blocker', is_required: false, help_text: 'Leave empty if there are none' },
      { text: 'Pending development activities', answer_type: 'long_text', report_tag: 'pending' },
    ],
  },
  {
    key: 'data_scrapper', name: 'Data Scrapper', description: 'Daily update for data scraping / research teams',
    items: [
      { text: 'Industry being scraped', answer_type: 'text', report_tag: 'work_done' },
      { text: 'Records scraped today', answer_type: 'number', report_tag: 'metric', priority: 'high', options: { min: 0, unit: 'records' } },
      { text: 'Total records completed', answer_type: 'number', report_tag: 'metric', options: { min: 0, unit: 'records' } },
      { text: 'Remaining target', answer_type: 'number', report_tag: 'metric', options: { min: 0, unit: 'records' } },
      { text: 'Data quality and validation status', answer_type: 'single_choice', report_tag: 'progress', options: { choices: ['Validated', 'Partially validated', 'Not validated', 'Issues found'] } },
      { text: 'Issues and blockers', answer_type: 'long_text', report_tag: 'blocker', is_required: false, help_text: 'Leave empty if there are none' },
    ],
  },
  {
    key: 'digital_marketing', name: 'Digital Marketing', description: 'Daily update for digital marketing teams',
    items: [
      { text: 'Number of posts created', answer_type: 'number', report_tag: 'metric', options: { min: 0, unit: 'posts' } },
      { text: 'Number of videos created', answer_type: 'number', report_tag: 'metric', options: { min: 0, unit: 'videos' } },
      { text: 'All published URLs with publication timings', answer_type: 'url_list', report_tag: 'url', is_required: false, help_text: 'Add each published link with the time it went live' },
      { text: 'Campaigns executed today', answer_type: 'long_text', report_tag: 'campaign' },
      { text: 'Campaign type and details', answer_type: 'long_text', report_tag: 'campaign', is_required: false },
      { text: 'Source of campaign data', answer_type: 'text', report_tag: 'campaign', is_required: false },
      { text: 'Previous campaign performance and results', answer_type: 'long_text', report_tag: 'campaign', is_required: false },
    ],
  },
  {
    key: 'implementation', name: 'Implementation', description: 'Daily update for client implementation teams',
    items: [
      { text: 'Implementations completed today', answer_type: 'number', report_tag: 'metric', priority: 'high', options: { min: 0, unit: 'implementations' } },
      { text: 'Total remaining implementations', answer_type: 'number', report_tag: 'metric', options: { min: 0, unit: 'implementations' } },
      { text: 'Client feedback follow-ups', answer_type: 'long_text', report_tag: 'work_done', is_required: false },
      { text: 'Implementations scheduled for the previous day', answer_type: 'long_text', report_tag: 'work_done', is_required: false },
      { text: 'Upcoming implementation schedule', answer_type: 'long_text', report_tag: 'plan' },
      { text: 'Pending client dependencies', answer_type: 'long_text', report_tag: 'blocker', is_required: false },
      { text: 'Delayed implementations and reasons', answer_type: 'long_text', report_tag: 'delay', is_required: false, help_text: 'Leave empty if nothing is delayed' },
    ],
  },
];

export const DEFAULT_CHECKLIST_ESCALATIONS = [
  { name: 'Checklist overdue → employee', level: 1, offset_minutes: 0, notify_roles: ['employee'], channels: ['in_app', 'email'] },
  { name: 'Incomplete 1h after deadline → Team Leader', level: 2, offset_minutes: 60, notify_roles: ['team_leader'], channels: ['in_app'] },
  { name: 'Incomplete 3h after deadline → HOD', level: 3, offset_minutes: 180, notify_roles: ['hod'], channels: ['in_app', 'email'] },
];

/** Seed starter templates and checklist escalation rules for the current organization (idempotent). */
export async function seedQuestionnaireDefaults() {
  for (const t of DEFAULT_TEMPLATES) {
    const [tpl] = await db('question_templates').insert({ key: t.key, name: t.name, description: t.description })
      .onConflict(['organization_id', 'key']).ignore().returning('id');
    if (!tpl) continue; // already present (possibly edited by an admin) → leave as is
    await db('question_template_items').insert(t.items.map((it, j) => ({
      template_id: tpl.id, text: it.text, answer_type: it.answer_type, report_tag: it.report_tag, is_required: it.is_required ?? true,
      priority: it.priority ?? 'medium', help_text: it.help_text ?? null, options: JSON.stringify(it.options ?? {}), sort_order: (j + 1) * 10,
    })));
  }
  if (!(await db('checklist_escalation_rules').first('id'))) {
    await db('checklist_escalation_rules').insert(DEFAULT_CHECKLIST_ESCALATIONS);
  }
}

export interface ApplyTemplateInput {
  templateId: number;
  actorId: number | null;
  sectionName?: string;
  target: { type: 'department'; departmentIds: number[] } | { type: 'user'; userIds: number[] } | { type: 'all' };
  deadlineTime?: string;
  reminderOffsets?: number[];
  frequency?: string;
  frequencyConfig?: any;
}

/** Create a section + questions (copies) from a template and assign them. Returns created question ids. */
export async function applyTemplate(i: ApplyTemplateInput): Promise<{ sectionId: number; questionIds: number[] }> {
  const tpl = await db('question_templates').where({ id: i.templateId }).first();
  if (!tpl) throw new Error('Template not found');
  const items = await db('question_template_items').where({ template_id: tpl.id }).orderBy('sort_order');
  const maxSort = await db('question_sections').whereNull('deleted_at').max({ m: 'sort_order' }).first();
  const [section] = await db('question_sections').insert({
    name: i.sectionName?.trim() || tpl.name, description: tpl.description, sort_order: Number(maxSort?.m ?? 0) + 10, created_by: i.actorId, updated_by: i.actorId,
  }).returning('id');
  const questionIds: number[] = [];
  for (const it of items) {
    const [q] = await db('questions').insert({
      section_id: section.id, text: it.text, help_text: it.help_text, answer_type: it.answer_type, options: JSON.stringify(it.options ?? {}),
      is_required: it.is_required, priority: it.priority, report_tag: it.report_tag, sort_order: it.sort_order,
      frequency: i.frequency ?? 'daily', frequency_config: JSON.stringify(i.frequencyConfig ?? { working_days_only: true }),
      deadline_time: i.deadlineTime ?? '18:00', reminder_offsets: i.reminderOffsets ?? [60], template_key: tpl.key,
      created_by: i.actorId, updated_by: i.actorId,
    }).returning('id');
    questionIds.push(q.id);
    const rows = i.target.type === 'all' ? [{ target_type: 'all' }]
      : i.target.type === 'department' ? i.target.departmentIds.map((d) => ({ target_type: 'department', department_id: d }))
        : i.target.userIds.map((u) => ({ target_type: 'user', user_id: u }));
    if (rows.length) await db('question_assignments').insert(rows.map((r) => ({ ...r, question_id: q.id, created_by: i.actorId })));
  }
  return { sectionId: section.id, questionIds };
}
