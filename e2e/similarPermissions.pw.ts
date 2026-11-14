import { expect, test, type Page } from '@playwright/test';

async function approval(page: Page, fixture = 'supported') {
  await page.goto(`/?permissionRules=${fixture}`);
  await page.getByRole('button', { name: /Wire the pi mock/ }).first().click();
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Allow similar…', exact: true }).click();
  return page.getByRole('dialog', { name: 'Allow similar commands', exact: true });
}

test('preview is accessible, cancel preserves approval, edits require a fresh host preview', async ({ page }) => {
  const dialog = await approval(page);
  await expect(dialog.getByRole('textbox', { name: 'Remember this exact command' })).toHaveValue('pwd');
  await expect(dialog.getByRole('textbox', { name: 'Remember this exact command' })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Save rule and allow once' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Preview rule' }).click();
  await expect(dialog.getByRole('region', { name: 'Kiln policy preview' })).toContainText('/usr/bin/pwd');
  await expect(dialog).toContainText('clean-v1');
  await dialog.getByRole('textbox', { name: 'Remember this exact command' }).fill('bun test');
  await expect(dialog.getByRole('button', { name: 'Save rule and allow once' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Preview rule' }).click();
  await expect(dialog).toContainText('Scripts, shell syntax and code runners');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow similar…', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: /Switch to.*Yolo/i })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeVisible();
});

for (const operation of ['Revoke pwd -P', 'Clear all']) {
  test(`save policy atomically, manage without pending approval, ${operation}`, async ({ page }) => {
    const dialog = await approval(page);
    await expect(dialog.getByRole('region', { name: 'Allow once now' })).toContainText('pwd');
    await dialog.getByRole('textbox', { name: 'Remember this exact command' }).fill('pwd -P');
    await dialog.getByRole('button', { name: 'Preview rule' }).click();
    await expect(dialog.getByRole('region', { name: 'Kiln policy preview' })).toContainText('["pwd","-P"]');
    await dialog.getByRole('button', { name: 'Save rule and allow once' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Remembered rules: 1', exact: true }).click();
    const manager = page.getByRole('dialog', { name: 'Remembered permission rules' });
    await expect(manager).toContainText('1 remembered rule');
    await expect(manager).toContainText('/workspace/ember');
    await expect(manager).toContainText('exact-argv-v1');
    await expect(manager).toContainText('["pwd","-P"]');
    await manager.getByRole('button', { name: operation, exact: true }).click();
    await expect(manager).toContainText('0 remembered rules');
    await expect(manager.getByRole('button', { name: 'Clear all', exact: true })).toBeDisabled();
  });
}

for (const fixture of ['unsupported', 'nonLinux']) {
  test(`${fixture} host keeps existing approval paths`, async ({ page }) => {
    const dialog = await approval(page, fixture);
    await dialog.getByRole('button', { name: 'Preview rule' }).click();
    await expect(dialog).toContainText(fixture === 'unsupported' ? 'This Kiln does not offer' : 'Linux local execution');
    await expect(dialog.getByRole('button', { name: 'Save rule and allow once' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await page.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toHaveCount(0);
  });
}
