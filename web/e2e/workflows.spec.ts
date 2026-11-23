import { expect, test, type Page } from '@playwright/test';

const PASSWORD = process.env.E2E_PASSWORD ?? 'Password@123';

async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Good (morning|afternoon|evening)/);
}

async function logout(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
}

test('no horizontal overflow on key pages', async ({ page }) => {
  await login(page, 'admin@orgpm.dev');
  for (const path of ['/', '/tasks', '/projects', '/future-projects', '/calendar', '/gantt', '/notifications', '/reports', '/organization', '/settings', '/questions', '/compliance', '/eod', '/checklist']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `overflow on ${path}`).toBeLessThanOrEqual(1);
  }
});

test('assign → submit → approve workflow through the UI', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'workflow covered once; mobile layout covered above');
  const title = `E2E task ${Date.now()}`;
  // HOD creates and assigns
  await login(page, 'hod.it@orgpm.dev');
  await page.goto('/tasks');
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByLabel('Title *').fill(title);
  await page.getByPlaceholder('Select people…').fill('Ishita');
  await page.getByRole('button', { name: /Ishita Gupta/ }).click();
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page.getByText('Task created')).toBeVisible();
  await logout(page);

  // Employee submits
  await login(page, 'employee@orgpm.dev');
  await page.goto('/tasks?mine=true');
  await page.getByPlaceholder('Search title or ID…').fill(title);
  await page.getByText(title).first().click();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText('Submitted for review').first()).toBeVisible();
  await logout(page);

  // HOD approves → task completed
  await login(page, 'hod.it@orgpm.dev');
  await page.goto('/approvals');
  await page.getByRole('link', { name: new RegExp(title) }).click();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Approve & complete' }).click();
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();
});

test('schedule a custom reminder at any time', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile');
  await login(page, 'director@orgpm.dev');
  await page.goto('/notifications');
  await page.getByRole('button', { name: 'New reminder' }).click();
  await page.getByLabel('Title *').fill('Review future projects');
  await page.getByLabel('Date', { exact: true }).fill('2030-06-03');
  await page.getByLabel('Time', { exact: true }).fill('13:30');
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.getByText('Scheduled on the server')).toBeVisible();
});

test('register a new organization from the login page', async ({ page }) => {
  const stamp = Date.now();
  await page.goto('/');
  await page.getByRole('tab', { name: 'Register organization' }).click();
  await page.getByLabel('Organization name').fill(`E2E Org ${stamp}`);
  await page.getByLabel('Your full name').fill('E2E Owner');
  await page.getByLabel('Work email').fill(`owner-${stamp}@e2e.test`);
  await page.locator('input[autocomplete="new-password"]').first().fill('E2eStrong123');
  await page.getByLabel('Confirm password').fill('E2eStrong123');
  await page.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Good (morning|afternoon|evening), E2E/);
  // brand-new tenant: no demo data visible
  await page.goto('/projects');
  await expect(page.getByText('Nothing here yet')).toBeVisible();
});

test('question builder → employee checklist → EOD report', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'flow covered once; mobile layout covered above');
  const text = `E2E: Was today's data backup verified? ${Date.now()}`;
  await login(page, 'admin@orgpm.dev');
  await page.goto('/questions');
  await page.getByRole('button', { name: 'New question' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Question', { exact: true }).fill(text);
  await dialog.getByLabel('Answer type').selectOption('yes_no');
  await dialog.getByLabel('Working days only').uncheck();
  await dialog.getByRole('button', { name: 'Selected employees' }).click();
  await dialog.getByPlaceholder('Choose employees…').fill('Kabir');
  await dialog.getByRole('button', { name: /Kabir Sethi/ }).click();
  await dialog.getByRole('button', { name: 'Create question' }).click();
  await expect(page.getByText('Question created')).toBeVisible();
  await logout(page);

  await login(page, 'kabir@orgpm.dev');
  await page.goto('/checklist');
  const row = page.locator('li', { hasText: text });
  await row.getByRole('radio', { name: 'Yes' }).click();
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await expect(page.getByText(/answer submitted/)).toBeVisible();
  await expect(row.getByText(/^Submitted /)).toBeVisible();
  await logout(page);

  await login(page, 'admin@orgpm.dev');
  await page.goto('/eod');
  await page.getByRole('button', { name: 'Generate now' }).click();
  await expect(page.getByText('EOD report generated')).toBeVisible();
  await page.getByRole('button', { name: 'Employee-wise' }).click();
  await expect(page.locator('dt', { hasText: text }).locator('xpath=following-sibling::dd')).toHaveText('Yes');
});
