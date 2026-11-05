import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Queued-message editing and merging against the pi mock. The server-owned queue has no edit, so
 * both are "enqueue the new text, then remove the originals"; these drive the dialog and the merge
 * controls through Hearth's real wire.
 *
 * `?staleBusy` parks every follow-up in Hearth's inbox and leaves it there, so the queue under test
 * does not drain into the transcript while the assertions run.
 */

/** Park `texts` in Hearth's inbox, one plain send each, and return the column. */
const queueFollowUps = async (page: Page, texts: string[]): Promise<Locator> => {
  await page.goto('/?staleBusy');
  await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
  const column = page.locator('main[data-session-key="pi:hearth::11"]');
  await expect(column).toBeVisible();
  const composer = column.locator('textarea');
  for (const text of texts) {
    await composer.fill(text);
    await composer.press('Enter');
    await expect(
      column.getByRole('button', { name: new RegExp(`Cancel queued message: ${text}`) })
    ).toBeVisible({ timeout: 10_000 });
  }
  return column;
};

test('editing a queued message opens a dialog and replaces the row', async ({ page }) => {
  const column = await queueFollowUps(page, ['first follow-up']);
  const rows = column.locator('ol > li');
  await expect(rows).toHaveCount(1);

  await column.getByRole('button', { name: /Edit queued message: first follow-up/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Edit queued message')).toBeVisible();
  await expect(dialog.getByText('follow-up', { exact: true })).toBeVisible();
  const box = dialog.getByRole('textbox', { name: 'Queued message text' });
  await expect(box).toHaveValue('first follow-up');
  // Save is inert until the text actually changes.
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();

  // Esc changes nothing: the original is still queued.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(column.getByRole('button', { name: /Cancel queued message: first follow-up/ })).toBeVisible();

  await column.getByRole('button', { name: /Edit queued message: first follow-up/ }).click();
  await page.getByRole('textbox', { name: 'Queued message text' }).fill('edited follow-up');
  await page.getByRole('button', { name: 'Save' }).click();

  // The new text is queued first and only then is the original removed. A row still being enqueued
  // carries a Cancel of its own, so briefly two rows can answer to the new text: the local one and
  // the host's. Wait for the row itself, not a unique button.
  await expect(
    column.getByRole('button', { name: /Cancel queued message: edited follow-up/ }).first()
  ).toBeVisible({ timeout: 10_000 });
  await expect(column.getByRole('button', { name: /Cancel queued message: first follow-up/ })).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  // An edit never sends: it stays a queued row.
  await expect(column.getByRole('log', { name: 'Conversation' })).not.toContainText('edited follow-up');
});

test('merge up joins a row into the one above and keeps the lower position', async ({ page }) => {
  const column = await queueFollowUps(page, ['first follow-up', 'second follow-up', 'third follow-up']);
  const rows = column.locator('ol > li');
  await expect(rows).toHaveCount(3);

  // Merging is one of the rare actions, so it lives behind the row's "…" rather than spending a
  // word of every row on it.
  await column.getByRole('button', { name: /More actions for queued message: second follow-up/ }).click();
  await page.getByRole('menuitem', { name: /Merge into the one above/ }).click();

  await expect(rows).toHaveCount(2, { timeout: 10_000 });
  await expect(rows.nth(0)).toContainText('first follow-up');
  await expect(rows.nth(0)).toContainText('second follow-up');
  await expect(rows.nth(1)).toContainText('third follow-up');
  // The row now at the top has nothing above it, so its "…" offers no merge; the one below does.
  await column.getByRole('button', { name: /More actions for queued message: first follow-up/ }).click();
  await expect(page.getByRole('menuitem', { name: /Merge into the one above/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await column.getByRole('button', { name: /More actions for queued message: third follow-up/ }).click();
  await expect(page.getByRole('menuitem', { name: /Merge into the one above/ })).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('merge all appears past three rows and folds the queue into one', async ({ page }) => {
  const column = await queueFollowUps(page, ['one', 'two', 'three']);
  const rows = column.locator('ol > li');
  await expect(rows).toHaveCount(3);
  // Three rows is not enough to offer the whole-queue merge.
  await expect(column.getByRole('button', { name: /Merge all/ })).toHaveCount(0);

  const composer = column.locator('textarea');
  await composer.fill('four');
  await composer.press('Enter');
  await expect(rows).toHaveCount(4, { timeout: 10_000 });

  await column.getByRole('button', { name: /Merge all 4 queued messages into one/ }).click();

  await expect(rows).toHaveCount(1, { timeout: 10_000 });
  await expect(rows.nth(0)).toContainText('one');
  await expect(rows.nth(0)).toContainText('four');
  await expect(column.getByRole('button', { name: /Merge all/ })).toHaveCount(0);
});
