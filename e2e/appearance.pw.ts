import { expect, test, type Locator } from '@playwright/test';

const paints = (blob: Locator) => blob.locator('svg').first().locator('[fill], stop').evaluateAll(elements =>
  elements.map(el => el.tagName === 'stop' ? getComputedStyle(el).stopColor : getComputedStyle(el).fill)
    .filter(color => !color.startsWith('url('))
);

for (const style of ['Buddy', 'Crystal', 'Mosaic', 'Lava', 'Scribble']) {
  test(`${style}: colour choices match preview, saved avatar, reopened picker and restart`, async ({ page }) => {
    await page.goto('/?noDock');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(`^${style}`) }).click();
    await page.getByRole('button', { name: 'Graphite', exact: true }).click();
    await page.keyboard.press('Escape');
    const row = page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ });
    const dialog = page.getByRole('dialog');
    const open = async () => {
      await row.click({ button: 'right' });
      await page.getByRole('menuitem', { name: /Customize appearance/ }).click();
      await expect(dialog.getByLabel('Custom agent color')).toBeVisible();
    };
    const selector = `.blob-${style.toLowerCase()}`;
    const saveMatching = async () => {
      const expected = await paints(dialog.locator(selector).first());
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => paints(row.locator(selector))).toEqual(expected);
      return expected;
    };
    await row.click();
    await open();
    await dialog.getByLabel('Custom agent color').fill('#d25b87');
    await saveMatching();
    await open();
    await expect(dialog.getByLabel('Custom agent color')).toHaveValue('#d25b87');
    await dialog.getByLabel('Custom agent color').fill('#158cba');
    await saveMatching();
    await open();
    const swatches = dialog.getByRole('button', { name: /^Color \d+$/ });
    const lastIndex = await swatches.count() - 1;
    await swatches.last().click();
    const selected = await page.evaluate(index => getComputedStyle(document.documentElement).getPropertyValue(`--blob-${index}`).trim(), lastIndex);
    await expect(dialog.getByLabel('Custom agent color')).toHaveValue(selected);
    const expected = await saveMatching();
    await open();
    await expect(dialog.getByLabel('Custom agent color')).toHaveValue(selected);
    await expect.poll(() => paints(dialog.locator(selector).first())).toEqual(expected);
    await page.keyboard.press('Escape');
    await page.reload();
    await expect.poll(() => paints(row.locator(selector))).toEqual(expected);
    await open();
    await expect(dialog.getByLabel('Custom agent color')).toHaveValue(selected);
    if (style === 'Mosaic') await page.screenshot({ path: '/tmp/ember-appearance-mosaic.png' });
  });
}

test('changing only a shape keeps the folder colour through desktop validation and restart', async ({ page }) => {
  await page.goto('/');
  const row = page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ });
  const dialog = page.getByRole('dialog');
  const open = async () => {
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /Customize appearance/ }).click();
  };
  await open();
  await dialog.getByRole('combobox', { name: 'Appearance scope' }).click();
  await page.getByRole('option', { name: /Project:|Folder:/ }).click();
  await dialog.getByLabel('Custom agent color').fill('#d25b87');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await open();
  await dialog.getByRole('button', { name: 'cloud', exact: true }).click();
  await expect(dialog.getByLabel('Custom agent color')).toHaveValue('#d25b87');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row.locator('path[fill="#d25b87"]')).toHaveCount(1);
  await page.reload();
  await expect(row.locator('path[fill="#d25b87"]')).toHaveCount(1);
  await open();
  await expect(dialog.getByLabel('Custom agent color')).toHaveValue('#d25b87');
  await dialog.getByLabel('Custom agent color').fill('#158cba');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await open();
  await dialog.getByRole('combobox', { name: 'Appearance scope' }).click();
  await page.getByRole('option', { name: /Project:|Folder:/ }).click();
  await dialog.getByLabel('Custom agent color').fill('#ff8648');
  await expect(dialog.getByText('This chat uses a separate colour.', { exact: false })).toBeVisible();
  await expect(dialog.locator('.blob-buddy').first().locator('path[fill="#158cba"]')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row.locator('path[fill="#158cba"]')).toHaveCount(1);
});
