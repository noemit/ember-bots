import { expect, test, type Locator, type Page } from '@playwright/test';

// In-memory Vite mock only: no host, provider, profile or user transcript is accessed.
const historyFor = (page: Page) => page.getByLabel('Conversation history', { exact: true }).first();
const metrics = (history: Locator) => history.evaluate(el => ({
  top: el.scrollTop, height: el.clientHeight, scroll: el.scrollHeight,
  gap: el.scrollHeight - el.clientHeight - el.scrollTop,
}));
const settle = async (page: Page) => {
  // Covers native wheel scrollend (~100ms), React paint and ResizeObserver delivery.
  await page.waitForTimeout(350);
};
async function openLong(page: Page) {
  await page.goto('/?fixture=long-messages&noDock');
  const history = historyFor(page);
  await expect(history).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await metrics(history)).top).toBeGreaterThan(1000);
  await settle(page);
  await expect.poll(async () => (await metrics(history)).gap).toBeLessThan(2);
  return history;
}
async function record(page: Page, history: Locator, label: string, before: unknown) {
  const after = await metrics(history);
  console.log(JSON.stringify({ label, before, after }));
  await test.info().attach(label, { body: JSON.stringify({ before, after }), contentType: 'application/json' });
  return after;
}

for (const delta of [-8, -1]) {
  test('idle small wheel ' + delta + ' escapes bottom after native scrollend', async ({ page }) => {
    const history = await openLong(page);
    const before = await metrics(history);
    await history.hover();
    await page.mouse.wheel(0, delta);
    await settle(page);
    const after = await record(page, history, 'idle-wheel-' + delta, before);
    await page.screenshot({ path: '/tmp/scroll-escape-desktop-' + Math.abs(delta) + '.png' });
    expect(after.gap).toBeGreaterThanOrEqual(Math.abs(delta) - .5);
    await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
  });
}

for (const key of ['ArrowUp', 'PageUp']) {
  test(key + ' yields immediately before content grows', async ({ page }) => {
    const history = await openLong(page);
    await history.focus();
    const before = await metrics(history);
    // Holding keydown lets us inspect intent before Chromium's smooth keyboard scroll completes.
    await page.keyboard.down(key);
    await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible({ timeout: 200 });
    await page.keyboard.up(key);
    await settle(page);
    const after = await record(page, history, key, before);
    expect(after.gap).toBeGreaterThan(0);
  });
}

test('finger moving down disengages before native touch scrolling starts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const history = await openLong(page);
  const before = await metrics(history);
  // Touch events deliberately test the React direction handler *before* a native scroll event.
  // This is not an assertion about OS kinetic scrolling or Chromium's drag threshold.
  await history.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: 200, clientY: 300 }] });
  await history.dispatchEvent('touchmove', { touches: [{ identifier: 1, clientX: 200, clientY: 308 }] });
  await page.screenshot({ path: '/tmp/scroll-escape-mobile-touch.png' });
  await record(page, history, 'finger-down-8', before);
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible({ timeout: 500 });
  await history.dispatchEvent('touchend', { touches: [] });
});

test('layout resize without a gesture keeps following; explicit latest resumes it', async ({ page }) => {
  const history = await openLong(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await settle(page);
  expect((await metrics(history)).gap).toBeLessThan(2);
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toHaveCount(0);
  await history.hover();
  await page.mouse.wheel(0, -250);
  await settle(page);
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await expect.poll(async () => (await metrics(history)).gap).toBeLessThan(2);
});

test('short transcript has no upward range and needs no escape control', async ({ page }) => {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const history = historyFor(page);
  await expect(history).toBeVisible({ timeout: 20000 });
  await settle(page);
  expect((await metrics(history)).top).toBe(0);
  await history.hover();
  await page.mouse.wheel(0, -8);
  await settle(page);
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toHaveCount(0);
});

// Modify only the dev mock's live document, then use its normal invalidation/REST path.
// PATCH emits run_end in this mock, but busy remains true and pi.live is still in flight.
async function streamChunk(page: Page, text: string) {
  await page.evaluate(async text => {
    const modulePath = '/src/dev/mockPi.ts';
    const { mockInternals } = await import(/* @vite-ignore */ modulePath);
    const conversation = mockInternals.conversations.find((entry: { id: number }) => entry.id === 10);
    conversation.busy = true;
    conversation.liveGeneration = { provider: conversation.model.provider, model: conversation.model.modelId, thinking: '', text };
    await window.ember.piRequest!('pi:hearth', '/conversations/10', { method: 'PATCH', body: { title: conversation.title } });
  }, text);
  await expect(page.getByText(text.split('\n')[0], { exact: false }).last()).toBeVisible({ timeout: 15000 });
}

test('live text growth respects small upward wheel and resumes only after explicit latest', async ({ page }) => {
  const history = await openLong(page);
  await streamChunk(page, 'Scroll escape live first chunk');
  await expect.poll(async () => (await metrics(history)).gap).toBeLessThan(2);
  const before = await metrics(history);
  await history.hover();
  await page.mouse.wheel(0, -8);
  await settle(page);
  expect((await metrics(history)).gap).toBeGreaterThanOrEqual(7.5);
  const stopped = await metrics(history);
  await streamChunk(page, 'Scroll escape live second chunk\n\n' + 'More streamed lines.\n\n'.repeat(15));
  await settle(page);
  const after = await record(page, history, 'stream-growth-while-released', before);
  expect(after.scroll).toBeGreaterThan(stopped.scroll);
  expect(after.top).toBeCloseTo(stopped.top, 0);
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click();
  await expect.poll(async () => (await metrics(history)).gap).toBeLessThan(2);
});

test('virtualized transcript escapes on one pixel and composer resize does not recapture it', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const history = await openLong(page);
  // Add batches below the mock's 20-entry tail window so every entry reaches App's cache.
  // 94 messages exercise the real >80-row virtualizer without the separate 10k load fixture.
  for (let batch = 0; batch < 6; batch += 1) {
    await page.evaluate(async batch => {
      const modulePath = '/src/dev/mockPi.ts';
      const { mockInternals } = await import(/* @vite-ignore */ modulePath);
      const conversation = mockInternals.conversations.find((entry: { id: number }) => entry.id === 10);
      const template = conversation.entries[3].model[0];
      for (let offset = 0; offset < 15; offset += 1) {
        const i = batch * 15 + offset;
        conversation.entries.push({ id: 1000 + i, kind: 'pi.assistant', model: [{ ...template, content: [{ type: 'text', text: 'Virtual scroll escape row ' + i + '. ' + 'A wrapped line of text. '.repeat(i % 4 + 1) }] }] });
      }
      await window.ember.piRequest!('pi:hearth', '/conversations/10', { method: 'PATCH', body: { title: conversation.title } });
    }, batch);
    await expect(page.getByText('Virtual scroll escape row ' + (batch * 15 + 14) + '.', { exact: false })).toBeAttached({ timeout: 15000 });
  }
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await settle(page);
  expect(await column.locator('[data-message-history] > [role="article"]').count()).toBeLessThan(80);
  await expect.poll(async () => (await metrics(history)).gap).toBeLessThan(2);
  await history.hover();
  const before = await metrics(history);
  await page.mouse.wheel(0, -1);
  await settle(page);
  expect((await metrics(history)).gap).toBeGreaterThanOrEqual(.5);
  await expect(column.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
  await column.locator('textarea').fill('Composer grows\n' + 'Another draft line\n'.repeat(6));
  await settle(page);
  const after = await record(page, history, 'virtualized-composer-resize', before);
  expect(after.gap).toBeGreaterThan(0);
  await expect(column.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
});

test('repeated tiny upward ticks stay released and downward return to the actual end resumes', async ({ page }) => {
  const history = await openLong(page);
  const before = await metrics(history);
  await history.hover();
  for (let tick = 0; tick < 3; tick += 1) {
    await page.mouse.wheel(0, -1);
    await settle(page);
    expect((await metrics(history)).gap).toBeGreaterThanOrEqual(tick + .5);
  }
  await page.mouse.wheel(0, 1);
  await settle(page);
  expect((await metrics(history)).gap).toBeCloseTo(2, 0);
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
  await page.mouse.wheel(0, 2);
  await settle(page);
  expect((await metrics(history)).gap).toBeLessThan(.5);
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toHaveCount(0);
  await record(page, history, 'tiny-ticks-downward-return', before);
});

test('handled keys and transcript controls do not preemptively disengage following', async ({ page }) => {
  const history = await openLong(page);
  await history.focus();
  await history.evaluate(el => el.addEventListener('keydown', event => event.preventDefault(), { once: true }));
  await page.keyboard.press('PageUp');
  await settle(page);
  expect((await metrics(history)).gap).toBeLessThan(2);
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toHaveCount(0);
  // A bubbled control key is not a request to navigate the history. An untrusted key event
  // exercises the React target guard without triggering native scrolling.
  const control = history.getByRole('button', { name: 'Copy', exact: true }).last();
  await control.evaluate(el => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('button', { name: 'Jump to latest', exact: true })).toHaveCount(0);
});

test('inactive split history yields only to its own input, not its sibling composer', async ({ page }) => {
  await openLong(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Split view', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  await expect(page.locator('main[data-session-key]')).toHaveCount(2);
  const long = page.locator('main[data-session-key="pi:hearth::10"]');
  const sibling = page.locator('main[data-session-key="pi:hearth::11"]');
  const history = long.getByLabel('Conversation history', { exact: true });
  await expect(sibling.getByLabel('Conversation history', { exact: true })).toBeVisible({ timeout: 20000 });
  await settle(page);
  // Start the split scenario at its new end after width/wrapping changes, without a user gesture.
  await history.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await settle(page);
  await sibling.locator('textarea').focus();
  await page.keyboard.press('ArrowUp');
  await expect(long.getByRole('button', { name: 'Jump to latest', exact: true })).toHaveCount(0);
  await expect.poll(async () => (await metrics(history)).gap).toBeLessThan(2);
  await history.hover();
  await page.mouse.wheel(0, -8);
  await settle(page);
  await expect(long.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
  await expect(sibling.getByRole('button', { name: 'Jump to latest', exact: true })).toHaveCount(0);
  const released = await metrics(history);
  await sibling.locator('textarea').fill('Sibling draft grows\n' + 'Another line\n'.repeat(6));
  await settle(page);
  await record(page, history, 'split-sibling-composer-growth', released);
  await page.screenshot({ path: '/tmp/scroll-escape-desktop-split.png' });
  await expect(long.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
  const afterResize = await metrics(history);
  await streamChunk(page, 'Split history live growth\n\n' + 'More streamed lines.\n\n'.repeat(15));
  await settle(page);
  const afterGrowth = await record(page, history, 'split-released-live-growth', afterResize);
  expect(afterGrowth.scroll).toBeGreaterThan(afterResize.scroll);
  // Split layout/scroll anchoring can move the absolute top; the pin must not reclaim the end.
  expect(afterGrowth.gap).toBeGreaterThan(48);
  await expect(long.getByRole('button', { name: 'Jump to latest', exact: true })).toBeVisible();
});
