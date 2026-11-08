import { expect, test, type Page } from '@playwright/test';

const marks = (page: Page) => page.evaluate(() => window.ember.getSettings().then(s => s.readMarks));
const openHabit = async (page: Page) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  return page.locator('main[data-session-key="pi:hearth::10"]');
};

test('plain message clicks acknowledge only that reply and persist; navigation and user messages stay passive', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::16"]');
  const latest = column.locator('[data-message-id="e93"]');
  const earlier = column.locator('[data-message-id="e91"]');
  const before = await marks(page);
  await column.getByRole('button', { name: /Go to new messages/ }).click();
  await column.locator('[data-message-id="e90"] .conversation-prose').click();
  await page.waitForTimeout(400);
  expect(await marks(page)).toEqual(before);
  await latest.locator('p').click();
  await expect(latest.locator('[data-unread-dot]')).toHaveCount(0);
  await expect(earlier.locator('[data-unread-dot]')).toHaveCount(1);
  // Whitespace in the row (outside prose and footer) is also an acknowledgement.
  await earlier.click({ position: { x: 2, y: 15 } });
  await expect(earlier.locator('[data-unread-dot]')).toHaveCount(0);
  await page.reload();
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  await expect(latest).toBeVisible();
  await expect(column.locator('[data-unread-dot]')).toHaveCount(0);
});

test('native drag and double-click selection do not acknowledge a reply', async ({ page }) => {
  const column = await openHabit(page);
  const message = column.locator('[data-message-id="e2"]');
  const prose = message.locator('p');
  const before = await marks(page);
  const bounds = await prose.boundingBox();
  if (!bounds) throw new Error('Reply prose is not laid out');
  await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 130, bounds.y + bounds.height / 2, { steps: 15 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Found');
  await page.waitForTimeout(400);
  expect(await marks(page)).toEqual(before);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await prose.dblclick({ position: { x: 35, y: 10 } });
  expect(await page.evaluate(() => window.getSelection()?.toString().length)).toBeGreaterThan(0);
  await page.waitForTimeout(400);
  expect(await marks(page)).toEqual(before);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await prose.click();
  await expect(message.locator('[data-unread-dot]')).toHaveCount(0);
});

test('top Copy sits before the first line; copy, reply and reasoning controls remain independent of reading', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const column = await openHabit(page);
  const message = column.locator('[data-message-id="e2"]');
  const before = await marks(page);
  const copy = message.getByRole('button', { name: 'Copy', exact: true });
  await page.mouse.move(5, 5);
  await expect(copy).toHaveCSS('opacity', '0');
  await message.locator('p').hover();
  await expect(copy).toHaveCSS('opacity', '1');
  const button = await copy.boundingBox();
  const firstWord = await message.locator('p').evaluate(el => {
    const node = el.firstChild!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 5);
    const rect = range.getBoundingClientRect();
    return { x: rect.x, y: rect.y, height: rect.height };
  });
  expect(button!.x + button!.width).toBeLessThanOrEqual(firstWord.x);
  expect(firstWord.x - (button!.x + button!.width)).toBeLessThanOrEqual(12);
  expect(Math.abs(button!.y + button!.height / 2 - (firstWord.y + firstWord.height / 2))).toBeLessThan(8);
  await page.screenshot({ path: '/tmp/ember-message-read-placement.png' });
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Found a regression: the step counter shows **3/2** on the last step.');
  const footer = message.locator('[data-message-footer]');
  await footer.getByRole('button', { name: 'Copy message', exact: true }).click();
  await footer.getByRole('button', { name: 'Reply to this message' }).click();
  await expect(column.getByText('Replying with context', { exact: true })).toBeVisible();
  await message.getByRole('button', { name: /Thinking/ }).click();
  await expect(message.getByText('A checklist regression, most likely in the progress math.')).toBeVisible();
  await page.waitForTimeout(400);
  expect(await marks(page)).toEqual(before);
  await expect(message.locator('[data-unread-dot]')).toHaveCount(1);
});

test('links and folded tool disclosures do their own work without marking the reply', async ({ page }) => {
  await page.goto('/?fixture=tool-unread');
  await page.locator('aside').getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  const reply = column.locator('[data-message-id="e9"]');
  const before = await marks(page);
  await page.evaluate(() => {
    window.ember.openExternal = async (target: string) => {
      document.documentElement.setAttribute('data-opened-link', target);
    };
  });
  await reply.getByRole('link', { name: 'http://localhost:5179' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-opened-link', 'http://localhost:5179');
  await reply.getByRole('button', { name: /Used 1 tool/ }).click();
  await expect(reply).toContainText('bun test');
  await page.waitForTimeout(400);
  expect(await marks(page)).toEqual(before);
  await reply.locator('p').first().click();
  await expect(reply.locator('[data-unread-dot]')).toHaveCount(0);
});

test('clicking live output cannot acknowledge it before settlement', async ({ page }) => {
  const column = await openHabit(page);
  await column.getByRole('button', { name: 'Mark this message as read' }).click();
  const composer = column.locator('textarea');
  await composer.fill('slow hello click-read guard');
  await composer.press('Enter');
  const liveProse = column.locator('[data-message-id] p').filter({ hasText: 'Hello! ember-harness is listening.' });
  await expect(liveProse).toBeVisible({ timeout: 15_000 });
  const liveId = await liveProse.evaluate(el => el.closest('[data-message-id]')!.getAttribute('data-message-id'));
  const before = await marks(page);
  await liveProse.click();
  await page.waitForTimeout(400);
  expect(await marks(page)).toEqual(before);
  const settled = column.locator('[data-message-id]').filter({ has: page.getByText('Hello! ember-harness is listening.', { exact: true }) });
  await expect(settled.locator('[data-unread-dot]')).toHaveCount(1, { timeout: 15_000 });
  expect(await settled.getAttribute('data-message-id')).not.toBe(liveId);
  await settled.locator('p').click();
  await expect(settled.locator('[data-unread-dot]')).toHaveCount(0);
});
