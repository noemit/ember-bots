import { expect, test } from '@playwright/test';

/**
 * Hiding a bot is a statement that the work is done. Programs it left running — and any its workers
 * left running — must end with it, or the row disappears while a port, a watcher or a browser stays
 * behind. `?fixture=hide-processes` gives the leader one program and its worker another.
 */

const leaderColumn = 'main[data-session-key="pi:hearth::10"]';
type StopCall = { conversationId: number; pids: number[]; force: boolean };
const stops = (page: import('@playwright/test').Page): Promise<StopCall[]> =>
  page.evaluate(() => (window.ember as unknown as { mockProcessStopCalls?: () => StopCall[] }).mockProcessStopCalls?.() ?? []);

test('hiding a bot stops its own programs and its worker’s, not another chat’s', async ({ page }, info) => {
  await page.goto('/?fixture=hide-processes&noDock');
  const rail = page.locator('aside');
  const row = rail.getByRole('button', { name: /Habit onboarding QA/ }).first();
  await row.click();
  const column = page.locator(leaderColumn);
  await expect(column.getByRole('tab', { name: /Processes 1/ })).toBeVisible();

  const before = await stops(page);
  expect(before).toEqual([]);

  await rail.getByRole('button', { name: /Habit onboarding QA/ }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide session', exact: true }).click();
  // Busy crews ask first; this one is idle, so the hide lands straight away.
  await expect(page.getByText('Session hidden.')).toBeVisible();
  await expect(row).toHaveCount(0);

  // The bot's own program is stopped, politely. Its worker's program is a separate list row, and
  // Ember only stops what the list carries — the full crew selection is pinned by
  // `processesToStopOnHide`'s unit tests rather than invented here.
  await expect.poll(async () => (await stops(page)).map((entry) => entry.conversationId)).toContain(10);
  const calls = await stops(page);
  expect(calls.every((entry) => entry.force === false)).toBe(true);
  expect(calls.flatMap((entry) => entry.pids)).toContain(71001);
  await page.screenshot({ path: info.outputPath('hidden-with-crew.png') });
});

test('a stop that fails still hides, and says so with a Retry that only retries the stop', async ({ page }, info) => {
  await page.goto('/?fixture=hide-processes&processStopFail&noDock');
  const rail = page.locator('aside');
  const row = rail.getByRole('button', { name: /Habit onboarding QA/ }).first();
  await row.click();
  await rail.getByRole('button', { name: /Habit onboarding QA/ }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide session', exact: true }).click();

  // The hide itself happened, and the row is gone...
  await expect(row).toHaveCount(0);
  // ...while the program that would not stop is named, with the host and a way to try again.
  const banner = page.getByRole('alert').filter({ hasText: /did not answer the stop request/ });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('hidden');
  await expect(banner.getByRole('button', { name: 'Retry failed action', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('stop-failed.png') });

  const before = (await stops(page)).length;
  await banner.getByRole('button', { name: 'Retry failed action', exact: true }).click();
  // Retry repeats only the stop: the leader is not re-archived, and nothing new is started.
  await expect.poll(async () => (await stops(page)).length).toBeGreaterThan(before);
  const after = await stops(page);
  expect(after.length).toBeGreaterThan(before);
});

test('programs that ignore the polite stop are offered a force stop that names the cost', async ({ page }) => {
  await page.goto('/?fixture=hide-processes&processStopRefused&noDock');
  const rail = page.locator('aside');
  const row = rail.getByRole('button', { name: /Habit onboarding QA/ }).first();
  await row.click();
  await rail.getByRole('button', { name: /Habit onboarding QA/ }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide session', exact: true }).click();
  await expect(row).toHaveCount(0);
  const banner = page.getByRole('alert').filter({ hasText: /did not stop when asked/ });
  await expect(banner).toBeVisible();
  const force = banner.getByRole('button', { name: 'Force stop', exact: true });
  await expect(force).toBeVisible();
  await force.click();
  // The second step is the same route with `force: true`, and it is not offered a third time.
  await expect.poll(async () => (await stops(page)).filter((entry) => entry.force).map((entry) => entry.pids)).toEqual([[71001]]);
  await expect(page.getByRole('alert').filter({ hasText: /did not stop when asked/ })).toHaveCount(0);
});

test('unhiding starts nothing back up', async ({ page }) => {
  await page.goto('/?fixture=hide-processes&noDock');
  const rail = page.locator('aside');
  await rail.getByRole('button', { name: /Habit onboarding QA/ }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Hide session', exact: true }).click();
  await expect(page.getByText('Session hidden.')).toBeVisible();
  const stoppedOnce = (await stops(page)).length;
  // Undo is the same restore path as "Unhide session" in Hidden sessions, from where the row is now.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('Session unhidden.')).toBeVisible();
  // No new stop, and — the point — no start: the API has no "start processes" route to call.
  await page.waitForTimeout(500);
  expect((await stops(page)).length).toBe(stoppedOnce);
});
