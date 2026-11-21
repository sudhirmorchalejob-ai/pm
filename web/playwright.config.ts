import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against a live stack (API + worker + web) seeded with demo data:
 *   server: npm run seed -- --reset --demo && npm run dev   (RUN_WORKERS_IN_API=true)
 *   web:    npm run dev
 *   then:   E2E_BASE_URL=http://localhost:5173 npx playwright test
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
