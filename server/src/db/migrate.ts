import fs from 'fs';
import path from 'path';
import { db } from './knex';
import { logger } from '../lib/logger';

/**
 * Forward-only SQL migration runner.
 * Applies migrations/NNN_name.sql in order, each inside its own transaction,
 * recording applied files in schema_migrations. An advisory lock prevents two
 * processes (e.g. API + worker containers) from migrating concurrently.
 */
export async function migrate(dir = path.resolve(__dirname, '../../migrations')) {
  await db.raw('SELECT pg_advisory_lock(727001)');
  try {
    await db.raw(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set((await db('schema_migrations').select('name')).map((r) => r.name));
    const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await db.transaction(async (trx) => {
        await trx.raw(sql);
        await trx('schema_migrations').insert({ name: file });
      });
      logger.info({ file }, 'migration applied');
    }
  } finally {
    await db.raw('SELECT pg_advisory_unlock(727001)');
  }
}

if (require.main === module) {
  migrate()
    .then(() => { logger.info('migrations complete'); return db.destroy(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
