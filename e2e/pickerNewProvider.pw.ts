import { expect, test } from '@playwright/test';

/**
 * Adding a provider starts where the need appears: in the model picker.
 *
 * The button used to exist only in the picker's empty state, so a host that already had one model
 * pointed at a screen you could only reach by leaving the composer and finding Settings. That is the
 * shape of the complaint this covers — a host with *some* models was not a dead end, it was a detour.
 */

const openPicker = async (page: import('@playwright/test').Page) => {
  await page.goto('/?fixture=performance&noDock&legacy');
  await expect(page.locator('textarea')).toHaveCount(2);
  await page.getByRole('button', { name: 'Choose model' }).first().click();
  return page.getByRole('dialog', { name: 'Choose a model' });
};

test('the picker footer offers a new provider beside Refresh, and it lands on Providers', async ({ page }) => {
  const picker = await openPicker(page);
  const add = picker.getByRole('button', { name: 'Add a model provider to this instance' });
  await expect(add).toBeVisible();
  await expect(add).toHaveText(/New provider/);
  // Beside Refresh, not somewhere else in the dialog: the two are the "this list is wrong" pair.
  await expect(picker.getByRole('button', { name: /Refresh the model list/ })).toBeVisible();

  await add.click();
  // The picker closes first — the Providers screen is behind it, and leaving both open reads as
  // nothing having happened.
  await expect(picker).toBeHidden();
  await expect(page.getByRole('dialog', { name: /Settings/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Providers' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('MODEL PROVIDERS')).toBeVisible();
});

test('the empty catalogue uses the same words, so the two are one feature', async ({ page }) => {
  // A host with no credentials has nothing to pick; the button is the only way forward.
  const picker = await openPicker(page);
  await picker.getByRole('searchbox', { name: 'Search models' }).fill('nothing matches this at all');
  await expect(picker.getByText('No models match your search.')).toBeVisible();
  // The footer button is present even while the list is filtered, so it never depends on the
  // search state to be reachable.
  await expect(picker.getByRole('button', { name: 'Add a model provider to this instance' })).toBeVisible();
  await expect(picker.getByRole('button', { name: /Add providers/ })).toHaveCount(0);
});
