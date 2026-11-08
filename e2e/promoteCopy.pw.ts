import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

/**
 * The promote control at a full width and in a narrow column, where a long label would wrap the
 * header: the visible word stays short, the phrase the owner chose stays in the accessible name
 * and tooltip, and the dialog states the outcome with a next step when the thread is busy.
 */
const workerColumn = (page: Page) => page.locator('main[data-session-key="pi:hearth::18"]');
// `/tmp` is a small tmpfs on this machine; keep review shots somewhere with room.
const shot = (name: string) => join(process.env.SHOT_DIR ?? '/tmp', `${name}.png`);

test('the promote control reads as a persistent bot, and fits a narrow header', async ({ page }) => {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  await page.locator('main[data-session-key="pi:hearth::16"]').getByRole('button', { name: 'Migrate schema', exact: true }).click();
  const worker = workerColumn(page);
  await expect(worker).toBeVisible();

  const button = worker.getByRole('button', { name: 'Promote to a persistent bot' });
  await expect(button).toHaveText(/^Promote$/);
  await expect(button).toHaveAttribute('title', /persistent bot: .*keeps running on its own/);
  await page.screenshot({ path: shot('ember-promote-copy-desktop') });

  for (const width of [760, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(button).toBeVisible();
    // The title keeps its own line and the header does not overflow its column.
    await expect(worker.locator('header').getByText('Migrate schema', { exact: true })).toBeInViewport();
    const overflow = await worker.locator('header').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, `header overflow at ${width}px`).toBeLessThanOrEqual(1);
    expect((await button.boundingBox())!.height).toBeLessThanOrEqual(30);
  }
  await page.screenshot({ path: shot('ember-promote-copy-narrow') });
  await page.setViewportSize({ width: 1600, height: 1000 });

  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Promote to a persistent bot' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('“Migrate schema” becomes its own bot');
  await expect(dialog).toContainText('keeps');
  await expect(dialog).toContainText('running whether or not its parent does');
  await expect(dialog).toContainText('stays in its parent’s crew as history');
  await page.screenshot({ path: shot('ember-promote-copy-dialog') });

  await dialog.getByLabel('Name', { exact: true }).fill('Schema guardian');
  await dialog.getByRole('button', { name: 'Make persistent', exact: true }).click();
  await expect(page.getByText('“Schema guardian” is persistent now', { exact: false })).toBeVisible();
  await expect(page.locator('aside').getByRole('button', { name: /Schema guardian/ }).first()).toBeVisible({ timeout: 10_000 });
  // The promoted thread's former column is gone; its crew row now says bot.
  await expect(worker).toHaveCount(0);
});

test('a busy thread says what stands in the way and what to do about it', async ({ page }) => {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  await page.locator('main[data-session-key="pi:hearth::16"]').getByRole('button', { name: 'Parse config', exact: true }).click();
  const worker = page.locator('main[data-session-key="pi:hearth::17"]');
  const button = worker.getByRole('button', { name: 'Promote to a persistent bot' });
  await expect(button).toBeVisible();
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Promote to a persistent bot' });
  await expect(dialog).toContainText('still working');
  await expect(dialog).toContainText(/wait for it to finish, or stop it first/);
  await expect(dialog.getByRole('button', { name: 'Make persistent' })).toBeDisabled();
});
