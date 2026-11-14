import { expect, test } from '@playwright/test';

test('root groups all workers; requester links only to its own sibling', async ({ page }, testInfo) => {
  await page.goto('/?fixture=two-level-crew&threads');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  const root = page.locator('main[data-session-key="pi:hearth::16"]');
  const rows = root.locator('[data-crew-brick]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-thread-depth', '1');
  await expect(rows.nth(1)).toHaveAttribute('data-thread-depth', '2');
  await expect(rows.nth(1)).toHaveAttribute('data-thread-group', 'Parse config');
  await expect(rows.nth(2)).toHaveAttribute('data-thread-depth', '1');
  await expect(root.getByRole('button', { name: /\+1 previous/ })).toBeVisible();
  await root.getByRole('button', { name: 'Parse config', exact: true }).click();
  const requester = page.getByTestId('thread-session-modal').locator('main[data-session-key="pi:hearth::17"]');
  const log = requester.getByRole('log', { name: 'Conversation' });
  await expect(log.getByRole('link', { name: 'Audit migration' })).toBeVisible();
  await expect(log.getByRole('link', { name: 'Migrate schema' })).toHaveCount(0);
  await log.getByRole('link', { name: 'Audit migration' }).click();
  const sibling = page.getByTestId('thread-session-modal').locator('main[data-session-key="pi:hearth::22"]');
  await expect(sibling).toBeVisible();
  await expect(sibling.getByRole('log', { name: 'Conversation' })).toContainText('Audit complete');
  await page.keyboard.press('Escape');
  await expect(root).toBeVisible();
  await root.getByRole('button', { name: /\+1 previous/ }).click();
  await page.screenshot({ path: testInfo.outputPath('two-level-threads-desktop.png') });
  const bounds = await rows.evaluateAll((nodes) => nodes.map((node) => {
    const r = node.getBoundingClientRect();
    return { left: r.left, width: r.width, height: r.height };
  }));
  expect(bounds[1].left).toBeGreaterThanOrEqual(bounds[0].left);
  expect(bounds[1].width).toBeGreaterThan(120);
  const textOffsets = await rows.evaluateAll((nodes) => nodes.map((node) => node.querySelector('button')?.getBoundingClientRect().left ?? 0));
  expect(textOffsets[1]).toBeGreaterThan(textOffsets[0]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(root.getByRole('button', { name: 'Inspect migration', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('two-level-threads-mobile.png') });
});
