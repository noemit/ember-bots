import { expect, test } from '@playwright/test';

for (const width of [390, 1600]) {
  test(`folder selection is above the child folders at ${width}px`, async ({ page }, info) => {
    await page.goto('/?fixture=project-picker');
    await page.getByRole('button', { name: 'New bot', exact: true }).first().click();
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: 'New bot project', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Find a project' });
    await picker.getByRole('button', { name: 'Browse folders on this host' }).click();
    const choose = picker.getByRole('button', { name: 'Choose this folder', exact: true });
    await expect(choose).toBeEnabled();
    const firstChild = picker.getByRole('button', { name: /^Open folder / }).first();
    await expect(firstChild).toBeVisible();
    const actionBox = await choose.boundingBox();
    const folderBox = await firstChild.boundingBox();
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(folderBox!.y);
    expect(actionBox!.y).toBeGreaterThanOrEqual(0);
    expect(actionBox!.y + actionBox!.height).toBeLessThan(900);
    await page.screenshot({ path: info.outputPath('folder-action-top.png') });
    await choose.click();
    await expect(picker).toHaveCount(0);
  });
}
