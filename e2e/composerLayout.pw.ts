import { expect, test, type Locator } from '@playwright/test';

const assertColumnWidth = async (column: Locator, message: Locator) => {
  await message.locator('.conversation-prose').first().hover();
  // Read all geometry in the same frame: split-view handovers animate column widths.
  await expect(async () => {
    const layout = await message.evaluate(el => {
      const history = el.closest('[aria-label="Conversation history"]')!;
      const column = el.closest('main')!;
      const prose = el.querySelector('.conversation-prose')!;
      const copy = el.querySelector('button[aria-label="Copy"]')!;
      const historyStyle = getComputedStyle(history);
      const rowStyle = getComputedStyle(el);
      const row = el.getBoundingClientRect();
      const body = prose.getBoundingClientRect();
      const button = copy.getBoundingClientRect();
      return {
        rowWidth: row.width, bodyWidth: body.width, bodyLeft: body.x, rowLeft: row.x,
        historyWidth: history.clientWidth,
        historyPadding: parseFloat(historyStyle.paddingLeft) + parseFloat(historyStyle.paddingRight),
        rowPadding: parseFloat(rowStyle.paddingLeft) + parseFloat(rowStyle.paddingRight),
        copyLeft: button.x, copyRight: button.right, columnLeft: column.getBoundingClientRect().x,
      };
    });
    expect(Math.abs(layout.rowWidth - (layout.historyWidth - layout.historyPadding))).toBeLessThan(2);
    expect(Math.abs(layout.bodyWidth - (layout.rowWidth - layout.rowPadding))).toBeLessThan(2);
    expect(layout.bodyLeft).toBeGreaterThan(layout.rowLeft);
    expect(layout.copyLeft).toBeGreaterThanOrEqual(layout.columnLeft);
    expect(layout.copyRight).toBeLessThanOrEqual(layout.bodyLeft);
  }).toPass();
  await expect(message.locator('[data-unread-dot]')).toHaveCount(1);
};

test('composer text and placeholder stay 18px independently of transcript size, and auto-height uses those metrics', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const input = column.locator('[data-composer-surface] textarea');
  const reply = column.locator('[data-message-id="e2"] .conversation-prose');
  await expect(reply).toHaveCSS('font-size', '14px');
  const assertInput = async () => {
    await expect(input).toHaveCSS('font-size', '18px');
    expect(await input.evaluate(el => getComputedStyle(el, '::placeholder').fontSize)).toBe('18px');
  };
  await assertInput();
  for (const size of ['12', '20']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Conversation text size', { exact: true }).selectOption(size);
    await page.keyboard.press('Escape');
    await expect(reply).toHaveCSS('font-size', size + 'px');
    await assertInput();
  }
  await input.fill('First line\nSecond line\nThird line');
  const height = await input.evaluate(el => {
    const style = getComputedStyle(el);
    return { visible: parseFloat(style.height), content: el.scrollHeight,
      required: 3 * parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) };
  });
  expect(Math.abs(height.visible - height.required)).toBeLessThan(3);
  expect(height.content).toBeLessThanOrEqual(height.visible + 1);
  await expect(input).toHaveCSS('overflow-y', 'hidden');
  await page.screenshot({ path: '/tmp/ember-composer-18px.png' });
  await input.fill('A longer draft line\n'.repeat(30));
  await expect(input).toHaveCSS('overflow-y', 'auto');
  expect((await input.boundingBox())!.height).toBeLessThanOrEqual(322);
  // The draft composer follows the same fixed metrics, not just an existing conversation.
  await page.getByRole('button', { name: 'New bot', exact: true }).click();
  await expect(page.locator('[data-composer-surface] textarea')).toHaveCSS('font-size', '18px');
});

test('messages fill wide and narrow columns with side padding and independent copy/unread gutters', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const reply = column.locator('[data-message-id="e2"]');
  await assertColumnWidth(column, reply);
  expect((await reply.boundingBox())!.width).toBeGreaterThan(1000);
  await page.screenshot({ path: '/tmp/ember-column-width-wide.png' });
  await page.setViewportSize({ width: 430, height: 900 });
  await assertColumnWidth(column, reply);
  await expect(column.locator('[data-composer-surface] textarea')).toHaveCSS('font-size', '18px');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/ember-column-width-narrow.png' });
});

test('split messages fill only their own column, retaining padding and composers', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Split view', exact: true }).click();
  await page.keyboard.press('Escape');
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  // Workers now open in a modal; use another ordinary session to exercise split columns.
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  await expect(page.locator('main[data-session-key]')).toHaveCount(2);
  await assertColumnWidth(leader, leader.locator('[data-message-id="e93"]'));
  const columns = page.locator('main[data-session-key]');
  for (const column of await columns.all()) {
    await expect(column.locator('[data-composer-surface] textarea')).toHaveCSS('font-size', '18px');
    const row = column.locator('[data-message-id]').first();
    const [columnBox, rowBox] = await Promise.all([column.boundingBox(), row.boundingBox()]);
    expect(rowBox!.x).toBeGreaterThanOrEqual(columnBox!.x);
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(columnBox!.x + columnBox!.width);
  }
  await page.screenshot({ path: '/tmp/ember-column-width-split.png' });
});
