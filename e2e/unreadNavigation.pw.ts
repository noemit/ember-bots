import { expect, test } from '@playwright/test';

test('unread navigation is passive; message bubbles acknowledge only their own reply', async ({ page }) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  const column = page.locator('main[data-session-key="pi:hearth::16"]');
  const marks = () => page.evaluate(() => window.ember.getSettings().then(s => s.readMarks));
  const before = await marks();
  const navigation = column.locator('[data-unread-navigation]');
  await expect(navigation.getByRole('button', { name: 'Mark all as read', exact: true })).toBeVisible();
  await navigation.getByRole('button', { name: /Go to new messages/ }).click();
  const latest = column.locator('[data-message-id="e93"]');
  await expect(latest).toHaveAttribute('data-highlighted', 'true');
  await expect(latest).toBeInViewport();
  expect(await marks()).toEqual(before);
  await page.screenshot({ path: '/tmp/ember-unread-navigation.png' });

  const bubble = latest.getByRole('button', { name: 'Mark this message as read', exact: true });
  const bounds = await bubble.boundingBox();
  expect(bounds?.width).toBeGreaterThanOrEqual(44);
  expect(bounds?.height).toBeGreaterThanOrEqual(44);
  // Click well outside the visible dot: the generous hover/click area is real.
  await bubble.click({ position: { x: 5, y: 22 } });
  await expect(latest.getByRole('button', { name: 'Message marked as read' })).toBeVisible();
  await expect(latest.locator('[data-unread-dot]')).toHaveCount(0);
  await expect(latest.locator('[data-read-confirming]')).toHaveCount(0);
  await expect(column.locator('[data-message-id="e91"]').getByRole('button', { name: 'Mark this message as read' })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Mark all as read', exact: true })).toHaveCount(0);

  await page.reload();
  await page.locator('aside').getByRole('button', { name: /Crew: auth refactor/ }).click();
  await expect(latest.locator('[data-unread-dot]')).toHaveCount(0);
  await navigation.getByRole('button', { name: /Go to new messages/ }).click();
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
  await expect(column.getByRole('button', { name: /Go to new messages/ })).toBeVisible();
  await expect(column.getByRole('button', { name: 'Mark all as read', exact: true })).toHaveCount(0);
  await column.getByRole('button', { name: 'Mark this message as read' }).click();
  await expect(column.getByRole('button', { name: 'Message marked as read' })).toBeVisible();
  await expect(column.locator('[data-read-confirming]')).toHaveCount(0);
  await expect(column.locator('[data-unread-navigation]')).toHaveCount(0);
});
