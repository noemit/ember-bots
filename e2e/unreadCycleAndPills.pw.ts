import { expect, test } from '@playwright/test';

/**
 * The unread strip cycles, and the jump pills are chrome.
 *
 * Both changes are about what a reader can see happening: a click that walks down a backlog has to
 * show which reply it landed on and which one is next, and a control that only matters while reading
 * should not sit over the text the rest of the time.
 */

test('cycling walks the unread backlog in reading order and never acknowledges anything', async ({ page }) => {
  await page.goto('/?fixture=long-messages');
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const navigation = column.locator('[data-unread-navigation]');
  const position = navigation.locator('[aria-label="Unread position"]');
  const first = column.locator('[data-message-id="e2"]');
  const second = column.locator('[data-message-id="e4"]');
  const marks = () => page.evaluate(() => window.ember.getSettings().then(s => s.readMarks));
  // The mock bridge installs itself while the page boots; reading marks before it exists is a race.
  await expect(navigation).toBeVisible();
  const before = await marks();

  await expect(navigation).toHaveAttribute('data-unread-count', '2');
  await expect(position).toHaveText('1/2');

  // First click: the OLDEST unread. The control used to start at the newest, skipping everything above.
  await navigation.getByRole('button', { name: /Go to the oldest unread reply/ }).click();
  await expect(first).toHaveAttribute('data-highlighted', 'true');
  await expect(position).toHaveText('1/2');

  await navigation.getByRole('button', { name: /Go to the next unread reply/ }).click();
  await expect(second).toHaveAttribute('data-highlighted', 'true');
  await expect(first).not.toHaveAttribute('data-highlighted', 'true');
  await expect(position).toHaveText('2/2');

  // Browsing is not acknowledging: the denominator is unchanged and no mark was written.
  await expect(navigation).toHaveAttribute('data-unread-count', '2');
  expect(await marks()).toEqual(before);
  await expect(navigation.getByRole('button', { name: 'Mark all as read', exact: true })).toBeVisible();

  // Past the last, round to the first rather than running out.
  await navigation.getByRole('button', { name: /Go to the next unread reply/ }).click();
  await expect(first).toHaveAttribute('data-highlighted', 'true');
  await expect(position).toHaveText('1/2');
});

test('the newest unread stays one click away', async ({ page }) => {
  await page.goto('/?fixture=long-messages');
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const navigation = column.locator('[data-unread-navigation]');
  await navigation.getByRole('button', { name: /Go to the newest of 2 unread replies/ }).click();
  await expect(column.locator('[data-message-id="e4"]')).toHaveAttribute('data-highlighted', 'true');
  // The cursor follows the jump, so the next cycle click continues from the newest.
  await expect(navigation.locator('[aria-label="Unread position"]')).toHaveText('2/2');
  await navigation.getByRole('button', { name: /Go to the next unread reply/ }).click();
  await expect(navigation.locator('[aria-label="Unread position"]')).toHaveText('1/2');
});

test('marking a reply read resets the cursor rather than leaving it past the end', async ({ page }) => {
  await page.goto('/?fixture=long-messages');
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const navigation = column.locator('[data-unread-navigation]');
  // From rest the first click is the oldest; the second advances to position 2.
  await navigation.getByRole('button', { name: /Go to the oldest unread reply/ }).click();
  await navigation.getByRole('button', { name: /Go to the next unread reply/ }).click();
  await expect(navigation.locator('[aria-label="Unread position"]')).toHaveText('2/2');
  // Reading one of the two changes the list the cursor indexes: position 2 no longer exists.
  await column.locator('[data-message-id="e2"]').getByRole('button', { name: 'Mark this message as read' }).click();
  await expect(navigation).toHaveAttribute('data-unread-count', '1');
  await expect(navigation.locator('[aria-label="Unread position"]')).toHaveText('1/1');
});

test('jump pills are hidden at rest, appear on hover, and leave three seconds after scrolling stops', async ({ page }) => {
  await page.goto('/?fixture=long-messages');
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const pills = column.locator('[data-jump-pills]');
  const history = column.getByLabel('Conversation history', { exact: true });

  // A target has to exist for the pills to be possible at all: land away from the first reply.
  await column.getByRole('button', { name: /Go to the newest of/ }).click();
  await page.mouse.move(200, 500);
  await expect(pills).toHaveCount(0);

  await column.locator('[data-session-area]').hover();
  await expect(pills).toBeVisible();
  await expect(pills.getByRole('button', { name: 'Jump to the previous bot message' })).toBeVisible();
  // The row's own surface is what makes it legible over the text underneath.
  const surface = await pills.evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopWidth }));
  expect(surface.border).not.toBe('0px');
  expect(surface.bg).not.toBe('rgba(0, 0, 0, 0)');

  // Clicking one retires it: the jump is served and the pill would sit on the message just landed on.
  await pills.getByRole('button', { name: 'Jump to the previous bot message' }).click();
  await expect(pills).toHaveCount(0);

  // A real scroll raises them for three seconds after the last one. Scroll *within* the long reply
  // rather than past its top: the pills need a target, and at the very top of the transcript there
  // is nothing above to jump to.
  await history.hover();
  await page.mouse.wheel(0, -120);
  await expect(pills).toBeVisible();
  // Away from the area the pills lean on the scroll tail alone, which is the behaviour under test.
  await page.mouse.move(200, 500);
  await expect(pills).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(pills).toBeVisible();
  await expect(pills).toHaveCount(0, { timeout: 4000 });
});

test('a programmatic jump does not arm the pills, so clicking one never makes it flicker back', async ({ page }) => {
  await page.goto('/?fixture=long-messages');
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  const pills = column.locator('[data-jump-pills]');
  await page.mouse.move(200, 500);
  await column.locator('[data-session-area]').hover();
  await pills.getByRole('button', { name: 'Jump to the previous bot message' }).click();
  // The smooth scroll the jump started settles, and the pointer has left: nothing re-shows them.
  await page.mouse.move(200, 500);
  await expect(pills).toHaveCount(0);
  await page.waitForTimeout(3600);
  await expect(pills).toHaveCount(0);
});
