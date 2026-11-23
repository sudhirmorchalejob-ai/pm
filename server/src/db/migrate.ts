import fs from 'fs';
import path from 'path';
import { baseDb } from './knex';
import { logger } from '../lib/logger';

/**
 * Forward-only SQL migration runner.
 * Applies migrations/NNN_name.sql in order inside one transaction guarded by a
 * transaction-scoped advisory lock, so concurrent processes (API + worker containers)
 * never migrate at the same time and a failed migration leaves nothing half-applied.
 */
export async function migrate(dir = path.resolve(__dirname, '../../migrations')) {
  await baseDb.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(727001)');
    await trx.raw(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set((await trx('schema_migrations').select('name')).map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await trx.raw(fs.readFileSync(path.join(dir, file), 'utf8'));
      await trx('schema_migrations').insert({ name: file });
      logger.info({ file }, 'migration applied');
    }
  });
}

/** Warn loudly when connected as a superuser: PostgreSQL superusers bypass row-level security. */
export async function checkTenantSafety() {
  const r = await baseDb.raw(`select current_user as u, current_setting('is_superuser') as su`);
  if (r.rows[0].su === 'on') {
    logger.warn({ user: r.rows[0].u }, 'DATABASE USER IS A SUPERUSER — row-level tenant isolation is NOT enforced. Use a non-superuser role.');
  }
}

if (require.main === module) {
  migrate()
    .then(() => { logger.info('migrations complete'); return baseDb.destroy(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
