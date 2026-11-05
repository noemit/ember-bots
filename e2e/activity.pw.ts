import { expect, test, type Locator, type Page } from '@playwright/test';

const home = (page: Page): Locator => page.getByTestId('home-view');
const timeline = (page: Page): Locator => page.getByTestId('activity-timeline');
const activity = (page: Page): Locator => page.getByTestId('home-activity');

/**
 * The durable activity log, now the collapsed "Activity" section at the bottom of Home. The log is
 * still what survives a restart; Home's cards describe only what is unread right now.
 */
test.beforeEach(async ({ page }) => {
  // The legacy fixture has the paged activity history; the pi mock has none.
  await page.goto('/?legacy');
  await expect(home(page)).toBeVisible();
});

const openActivity = async (page: Page): Promise<void> => {
  // The section renders its contents even while collapsed, so presence is not "open".
  const open = await activity(page).evaluate((element) => (element as HTMLDetailsElement).open);
  if (!open) await activity(page).locator('summary').click();
  await expect(timeline(page)).toBeVisible();
};

test('home is the default view when nothing is open', async ({ page }) => {
  await expect(page.getByTestId('home-session-card').first()).toBeVisible();
  // Opening a session from a Home card leaves Home for that column.
  const firstCard = page.locator('[data-testid="home-session-card"]').first();
  await firstCard.getByRole('button', { name: /Open/ }).first().click();
  await expect(home(page)).toHaveCount(0);
  await expect(page.locator('main[data-session-key]').first()).toBeVisible();
});

test('the activity log renders persisted entries, collapses tool runs, and mutes dead sessions', async ({ page }) => {
  await openActivity(page);
  // The mock pages history in tens; the first page holds the ten newest entries.
  await expect(timeline(page)).toContainText('waiting for permission');
  await expect(timeline(page)).toContainText('Invalid request Error');

  // Four consecutive tool successes from one session collapse into a block row.
  await expect(timeline(page).getByTestId('activity-block').filter({ hasText: '4 tool calls' })).toBeVisible();

  // Entries whose session is gone (or archived) stay in the log as muted, non-linking rows.
  await expect(timeline(page).locator('[data-testid="activity-row"][data-muted="true"]')).toHaveCount(1);

  // Older days arrive on demand.
  await expect(timeline(page)).not.toContainText('Daily channel brief');
  await page.getByRole('button', { name: 'Load earlier days' }).click();
  await expect(timeline(page)).toContainText('scheduled task ran · Daily channel brief');
  await expect(timeline(page).locator('[data-testid="activity-row"][data-muted="true"]').first()).toBeVisible();
});

test('clicking an entry opens that session as a column', async ({ page }) => {
  await openActivity(page);
  await timeline(page).getByRole('button', { name: /finished a turn/ }).first().click();
  await expect(home(page)).toHaveCount(0);
  await expect(page.locator('main[data-session-key]').first()).toBeVisible();
});

test('the Home button and Esc toggle home over open columns', async ({ page }) => {
  await page.locator('[data-testid="home-session-card"]').first().getByRole('button', { name: /Open/ }).first().click();
  await expect(home(page)).toHaveCount(0);
  const column = page.locator('main[data-session-key]').first();
  await expect(column).toBeVisible();
  const key = await column.getAttribute('data-session-key');

  // Home over open columns, and back to the same column.
  await page.getByRole('button', { name: /Home — unread messages/ }).click();
  await expect(home(page)).toBeVisible();
  await expect(page.locator('main[data-session-key]')).toHaveCount(0);
  await page.getByRole('button', { name: /Back to workspace/ }).click();
  await expect(page.locator(`main[data-session-key="${key}"]`)).toBeVisible();

  // Esc leaves home the same way.
  await page.getByRole('button', { name: /Home — unread messages/ }).click();
  await expect(home(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(home(page)).toHaveCount(0);
});

test('the command palette offers Home', async ({ page }) => {
  await page.locator('[data-testid="home-session-card"]').first().getByRole('button', { name: /Open/ }).first().click();
  await expect(home(page)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('option', { name: /unread messages & recent activity/ }).click();
  await expect(home(page)).toBeVisible();
});
