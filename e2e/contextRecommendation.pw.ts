import { expect, test, type Page } from '@playwright/test';

// Drive only the in-memory dev bridge: no provider credentials, host or paid model calls.
const snapshot = (page: Page, tokens: number, epoch = 'initial', busy = false) =>
  page.evaluate(async ({ tokens, epoch, busy }) => {
    // Vite serves this dev module; importing it returns the same bridge instance App uses.
    const path = '/src/dev/mockPi.ts';
    const { mockInternals } = await import(/* @vite-ignore */ path);
    mockInternals.setCurrentContext(10, tokens, epoch, busy, tokens);
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

test('large old chat → new draft → first request never inherits usage or promises to compact instructions', async ({ page }, testInfo) => {
  await page.goto('/?slowCreate&noDock');
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  await snapshot(page, 140_000);
  await expect(page.getByRole('region', { name: 'Context recommendation' })).toContainText('summarize older turns');
  await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'New bot project' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Context recommendation' })).toHaveCount(0);
  await expect(page.locator('[data-context-meter]')).toHaveCount(0);
  const composer = page.locator('textarea').first();
  await composer.fill('Hello from a brand-new chat');
  await composer.press('Enter');
  await expect(page.getByText(/Starting this session on/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Context recommendation' })).toHaveCount(0);
  await page.evaluate(() => window.emberCreateFixture?.releaseCreate());
  const column = page.locator('main[data-session-key]').first();
  await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('Hello! ember-harness is listening.');
  await expect(page.getByRole('region', { name: 'Context recommendation' })).toHaveCount(0);
  // A first request can have a huge instruction/tool prefix. The summary is high, but history is zero.
  const id = Number((await column.getAttribute('data-session-key'))!.split('::')[1]);
  await page.evaluate(async (id) => {
    const path = '/src/dev/mockPi.ts';
    (await import(/* @vite-ignore */ path)).mockInternals.setCurrentContext(id, 140_000, 'initial', true, 0);
  }, id);
  const advice = column.getByRole('region', { name: 'Context recommendation' });
  await expect(advice).toBeVisible();
  await expect(advice).toContainText('Compact keeps instructions and tools');
  await expect(advice.getByRole('button', { name: 'Compact', exact: true })).toHaveCount(0);
  await expect(advice).not.toContainText('when the running turn finishes');
  await column.screenshot({ path: testInfo.outputPath('first-request-instructions-after.png') });
  await advice.screenshot({ path: testInfo.outputPath('advice-after.png') });
  expect(await calls(page)).toBe(0);
  // Removing the snapshot on a loading/older host does not resurrect any previous count.
  await page.evaluate(async (id) => {
    const path = '/src/dev/mockPi.ts';
    (await import(/* @vite-ignore */ path)).mockInternals.setCurrentContext(id, undefined);
  }, id);
  await expect(advice).toHaveCount(0);
});

test('model switches and missing/loading windows never invent a ratio or a compaction reason', async ({ page }) => {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await snapshot(page, 90_000);
  const advice = column.getByRole('region', { name: 'Context recommendation' });
  await expect(advice).toHaveCount(0); // million-token model: reminder ceiling is 100k
  // Override just the mock catalogue response, then drive the real model refresh/selection path.
  await page.evaluate(() => {
    const original = window.ember.piRequest;
    window.ember.piRequest = async (...args: Parameters<typeof original>) => {
      const response = await original(...args);
      if (args[1] === '/models' && response.ok) {
        const data = response.data as { models: { id: string; contextWindow?: number }[] };
        data.models = data.models.map(model => ({ ...model, contextWindow: model.id === 'deepseek-v4.1-flash' ? 100_000 : 0 }));
      }
      return response;
    };
  });
  await column.getByRole('button', { name: 'Choose model' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose a model' });
  await picker.getByRole('searchbox', { name: 'Search models' }).fill('DeepSeek');
  await picker.getByRole('button', { name: 'DeepSeek V4.1 Flash', exact: true }).click();
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(advice.getByRole('button', { name: 'Compact', exact: true })).toBeVisible();
  await column.getByRole('button', { name: 'Choose model' }).click();
  await picker.getByRole('searchbox', { name: 'Search models' }).fill('GLM');
  await picker.getByRole('button', { name: 'GLM-5.3 Flash', exact: true }).first().click();
  await picker.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(advice).toHaveCount(0); // zero/unknown window retains conservative 100k ceiling
  await snapshot(page, 140_000);
  await expect(advice.getByRole('button', { name: 'Compact', exact: true })).toBeVisible();
  expect(await calls(page)).toBe(0);
});
