import { expect, test } from '@playwright/test';

test('unread navigation is passive; message bubbles acknowledge only their own reply', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::16"]');
  const marks = () => page.evaluate(() => window.ember.getSettings().then(s => s.readMarks));
  const before = await marks();
  const navigation = column.locator('[data-unread-navigation]');
  await expect(navigation.getByRole('button', { name: 'Mark all as read', exact: true })).toBeVisible();
  await navigation.getByRole('button', { name: /New unread messages/ }).click();
  const latest = column.locator('[data-message-id="e93"]');
  await expect(latest).toHaveAttribute('data-highlighted', 'true');
  await expect(latest).toBeInViewport();
  expect(await marks()).toEqual(before);
  await page.screenshot({ path: '/tmp/ember-unread-navigation.png' });

  const bubble = latest.getByRole('button', { name: 'Mark this message as read', exact: true });
  await bubble.hover();
  const tooltip = page.getByRole('tooltip', { name: 'Mark as read', exact: true });
  await expect(tooltip).toBeVisible();
  await expect(page.locator('[data-slot="tooltip-content"]').filter({ hasText: 'Mark as read' }).first()).toHaveAttribute('data-side', /left|right/);
  const bounds = await bubble.boundingBox();
  expect(bounds?.width).toBeGreaterThanOrEqual(44);
  expect(bounds?.height).toBeGreaterThanOrEqual(44);
  // Click well outside the visible dot: the generous hover/click area is real.
  await bubble.click({ position: { x: 5, y: 22 } });
  await expect(latest.getByRole('button', { name: 'Message marked as read' })).toBeVisible();
  await expect(tooltip).toHaveCount(0);
  const confirmation = latest.locator('.message-read-confirmation');
  await expect(confirmation.locator('svg')).toHaveClass(/lucide-check/);
  // Visibility assertions alone ignore opacity: verify the check stays painted long enough to see.
  await page.waitForTimeout(200);
  expect(await confirmation.evaluate(el => Number(getComputedStyle(el).opacity))).toBeGreaterThan(.95);

  await expect(latest.locator('[data-unread-dot]')).toHaveCount(0);
  await expect(latest.locator('[data-read-confirming]')).toHaveCount(0);
  await expect(column.locator('[data-message-id="e91"]').getByRole('button', { name: 'Mark this message as read' })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Mark all as read', exact: true })).toHaveCount(0);

  await page.reload();
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  await expect(latest.locator('[data-unread-dot]')).toHaveCount(0);
  await navigation.getByRole('button', { name: /New unread messages/ }).click();
  const remaining = column.locator('[data-message-id="e91"]').getByRole('button', { name: 'Mark this message as read' });
  await remaining.focus();
  await remaining.press('Enter');
  await expect(navigation).toHaveCount(0);
});

test('mark all clears multiple unread replies and persists across reload', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::16"]');
  await column.getByRole('button', { name: 'Mark all as read', exact: true }).click();
  await expect(column.locator('[data-unread-navigation]')).toHaveCount(0);
  await expect(column.locator('[data-unread-dot]')).toHaveCount(0);
  await page.reload();
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  await expect(column.locator('[data-message-id="e93"]')).toBeVisible();
  await expect(column.locator('[data-unread-dot]')).toHaveCount(0);
});

test('a single unread reply uses its bubble, with reduced-motion confirmation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::10"]');
  await expect(column.getByRole('button', { name: /New unread messages/ })).toBeVisible();
  await expect(column.getByRole('button', { name: 'Mark all as read', exact: true })).toHaveCount(0);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await column.getByRole('button', { name: 'Mark this message as read' }).click();
  await expect(column.getByRole('button', { name: 'Message marked as read' })).toBeVisible();
  const confirmation = column.locator('.message-read-confirmation');
  expect(await confirmation.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  expect(await confirmation.evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);

  await page.clock.runFor(700);
  await expect(column.locator('[data-read-confirming]')).toHaveCount(0);
  await expect(column.locator('[data-unread-navigation]')).toHaveCount(0);
});

test('tool steps need no acknowledgement and folded tools preserve the reply read bubble', async ({ page }) => {
  await page.goto('/?fixture=tool-unread');
  await page.locator('aside').getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  const toolStep = column.locator('[data-message-id="e4"]');
  const reply = column.locator('[data-message-id="e9"]');
  await expect(toolStep).toContainText('Reading the auth code now.');
  await expect(toolStep.getByRole('button', { name: 'Mark this message as read' })).toHaveCount(0);
  await expect(reply).toContainText('Used 1 tool');
  await expect(reply.getByRole('button', { name: 'Mark this message as read' })).toBeVisible();
  await expect(column.getByRole('button', { name: 'Mark all as read', exact: true })).toHaveCount(0);
  await column.getByRole('button', { name: /New unread messages/ }).click();
  await expect(reply).toHaveAttribute('data-highlighted', 'true');
  await reply.getByRole('button', { name: 'Mark this message as read' }).click();
  await expect(column.locator('[data-unread-navigation]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.ember.getSettings().then(s => s.readMarks['pi:hearth::11']?.through))).toBe(9);
  await page.reload();
  await page.locator('aside').getByRole('button', { name: /Remote access hardening/ }).first().click();
  await expect(reply).toBeVisible();
  await expect(column.locator('[data-unread-dot]')).toHaveCount(0);
});
