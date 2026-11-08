import { expect, test } from '@playwright/test';

test('expanded tool output, scripts, inputs and diffs use the transcript scroll at full height', async ({ page }) => {
  await page.goto('/?fixture=performance&longTools&noDock&legacy');
  const column = page.locator('main[data-session-key="local::perf-0"]');
  const history = column.getByRole('log', { name: 'Conversation' });
  await expect(history.getByText('Synthetic message 9999', { exact: true })).toBeVisible();
  await history.locator('..').click({ position: { x: 40, y: 40 } });
  await page.keyboard.press('ControlOrMeta+f');
  await column.getByRole('textbox', { name: 'Find in conversation' }).fill('Full-height tools anchor');
  const row = history.getByRole('article').filter({ hasText: 'Full-height tools anchor' });
  await expect(row).toBeVisible();
  expect(await history.locator('[data-index]').count()).toBeLessThan(100);
  const scroller = history.locator('..');
  const before = await row.evaluate(el => el.getBoundingClientRect().height);
  const live = row.locator('pre').filter({ hasText: 'Live output line 240' });
  await expect(live).toBeVisible();
  expect(await live.evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(64);
  await expect(row.locator('pre').filter({ hasText: 'Retained output line 240' })).toHaveCount(0);

  for (const name of ['Long retained output', 'codemode', 'Long diff', 'Long diagnostic']) {
    await row.getByRole('button', { name: new RegExp(name) }).click();
  }
  for (const text of ['Retained output line 240', '// Script line 180', '+ Added diff line 180', 'input-file-179', 'Diagnostic line 180']) {
    const panel = row.locator('pre').filter({ hasText: text });
    await expect(panel).toHaveCount(1);
    const dimensions = await panel.evaluate(el => ({ height: el.clientHeight, contentHeight: el.scrollHeight, maxHeight: getComputedStyle(el).maxHeight }));
    expect(dimensions.maxHeight).toBe('none');
    expect(dimensions.height).toBeGreaterThan(1000);
    expect(dimensions.contentHeight).toBeLessThanOrEqual(dimensions.height + 1);
  }
  const expanded = await row.evaluate(el => el.getBoundingClientRect().height);
  expect(expanded - before).toBeGreaterThan(10000);
  // ResizeObserver must measure the expanded virtual row and place its neighbour below all output.
  await expect.poll(() => history.locator('[data-index="9998"]').evaluateAll(els => els.length)).toBe(1);
  const next = history.locator('[data-index="9998"]');
  await expect.poll(async () => (await next.boundingBox())!.y - ((await row.boundingBox())!.y + (await row.boundingBox())!.height)).toBeGreaterThanOrEqual(-1);
  await row.locator('pre').filter({ hasText: 'Retained output line 240' }).evaluate(el => el.scrollIntoView({ block: 'end' }));
  const scrollBeforeWheel = await scroller.evaluate(el => el.scrollTop);
  expect(scrollBeforeWheel).toBeGreaterThan(0);
  const output = row.locator('pre').filter({ hasText: 'Retained output line 240' });
  const viewport = await scroller.boundingBox();
  await page.mouse.move(viewport!.x + 100, viewport!.y + viewport!.height - 70);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(scrollBeforeWheel + 100);
  expect(await output.evaluate(el => el.scrollTop)).toBe(0);
  expect(await column.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/ember-full-height-tools.png' });
  // Collapsing remeasures too, without leaving a tool-sized empty hole in the virtual history.
  for (const name of ['Long retained output', 'codemode', 'Long diff', 'Long diagnostic']) {
    await row.getByRole('button', { name: new RegExp(name) }).click();
  }
  await expect.poll(() => row.evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(before + 20);
  expect(await history.locator('[data-index]').count()).toBeLessThan(100);
});
