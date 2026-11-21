/** Recreates the test database schema and seeds base + demo data once per test run. */
export default async function setup() {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/orgpm_test';
  process.env.QUEUE_PREFIX = 'orgpm-test';
  const { db } = await import('../src/db/knex');
  const { migrate } = await import('../src/db/migrate');
  const { seedBase, seedDemo } = await import('../src/db/seed');
  await db.raw('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  await seedBase();
  await seedDemo();
  await db.destroy();
}
