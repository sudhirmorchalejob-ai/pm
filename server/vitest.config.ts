import { defineConfig } from 'vitest/config';

const env = {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/orgpm_test',
  QUEUE_PREFIX: 'orgpm-test',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789',
  UPLOAD_DIR: 'uploads-test',
  SMTP_HOST: '',
  VAPID_PUBLIC_KEY: '',
  VAPID_PRIVATE_KEY: '',
};

export default defineConfig({
  test: {
    env,
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
