import { expect, test, type Page } from '@playwright/test';

// Drive only the in-memory dev bridge: no provider credentials, host or paid model calls.
const snapshot = (page: Page, tokens: number, epoch = 'initial', busy = false) =>
  page.evaluate(async ({ tokens, epoch, busy }) => {
    // Vite serves this dev module; importing it returns the same bridge instance App uses.
    const path = '/src/dev/mockPi.ts';
    const { mockInternals } = await import(/* @vite-ignore */ path);
    mockInternals.setCurrentContext(10, tokens, epoch, busy);
  }, { tokens, epoch, busy });

const calls = (page: Page) => page.evaluate(async () => {
  const path = '/src/dev/mockPi.ts';
  return (await import(/* @vite-ignore */ path)).mockInternals.contextCompactionCalls.length as number;
});

test('current-context advice is explicit, dismissible, stable across updates, and rearms after compaction', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const advice = column.getByRole('region', { name: 'Context recommendation' });
  const compact = advice.getByRole('button', { name: 'Compact', exact: true });
  const footer = column.locator('.safe-composer');
  await expect(footer).toBeVisible();
  const initialHeight = await footer.evaluate((element) => element.getBoundingClientRect().height);
  await snapshot(page, 99_999);
  await expect(advice).toHaveCount(0);
  await snapshot(page, 100_000);
  await expect(advice).toBeVisible();
  await expect(compact).toBeEnabled();
  expect(await calls(page)).toBe(0);
  // Advice must not enlarge the measured identity/input band or live inside it.
  expect(await footer.evaluate((element) => element.getBoundingClientRect().height)).toBeCloseTo(initialHeight, 0);
  expect(await footer.getByRole('region', { name: 'Context recommendation' }).count()).toBe(0);
  const adviceBox = await advice.boundingBox();
  const footerBox = await footer.boundingBox();
  expect(adviceBox!.y + adviceBox!.height).toBeLessThanOrEqual(footerBox!.y);

  await advice.getByRole('button', { name: 'Dismiss context recommendation' }).focus();
  await page.keyboard.press('Enter');
  await expect(advice).toHaveCount(0);
  for (const count of [100_000, 150_000, 99_999, 130_000]) {
    await snapshot(page, count);
    // Each event triggers the normal REST summary refresh, like repeated polls.
    await page.waitForTimeout(400);
    await expect(advice).toHaveCount(0);
  }
  expect(await calls(page)).toBe(0);

  await snapshot(page, 100_000, 'new-context', true);
  await expect(advice).toBeVisible();
  await expect(compact).toBeDisabled();
  await expect(advice).toContainText('when the running turn finishes');
  expect(await calls(page)).toBe(0);
  await snapshot(page, 100_000, 'new-context', false);
  await expect(compact).toBeEnabled();
  await compact.click();
  await expect.poll(() => calls(page)).toBe(1);
  await expect(advice.getByRole('button', { name: 'Compacting…' })).toBeDisabled();
  await expect(advice).toHaveCount(0); // successful mock compaction reports a smaller active prefix
  // Returning above the threshold after the observed reset is a new episode.
  await snapshot(page, 100_000, 'after-compaction');
  await expect(advice).toBeVisible();
  expect(await calls(page)).toBe(1);
});
