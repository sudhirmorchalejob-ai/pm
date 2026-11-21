import knexFactory, { Knex } from 'knex';
import pg from 'pg';
import { config } from '../config';

// bigint ids / counts as JS numbers (ids stay far below 2^53), numerics as floats.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => parseFloat(v));
// Keep DATE columns as 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);

/**
 * TLS: 'true' forces SSL, 'false' disables it, 'auto' (default) enables it for managed hosts
 * that require it (e.g. Render external URLs, *.render.com) or when the URL has sslmode=require.
 */
function sslOption() {
  const mode = config.DATABASE_SSL;
  const url = config.DATABASE_URL;
  const want = mode === 'true' || (mode === 'auto' && (/\.render\.com|sslmode=require/i.test(url)));
  return want ? { rejectUnauthorized: config.DATABASE_SSL_REJECT_UNAUTHORIZED } : false;
}

export const db: Knex = knexFactory({
  client: 'pg',
  connection: { connectionString: config.DATABASE_URL.replace(/[?&]sslmode=[^&]*/i, ''), ssl: sslOption() },
  pool: { min: 0, max: config.DATABASE_POOL_MAX },
});

export type Tx = Knex | Knex.Transaction;
