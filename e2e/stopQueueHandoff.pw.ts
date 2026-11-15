import { expect, test } from '@playwright/test';

for (const yeet of [false, true]) {
  test(`Stop hands off to the next ${yeet ? 'yeeted' : 'queued'} message without another Send`, async ({ page }, info) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Remote access hardening/ }).first().click();
    const column = page.locator('main[data-session-key="pi:hearth::11"]');
    const composer = column.locator('textarea').last();
    await composer.fill('please interrupt this');
    await composer.press('Enter');
    const stop = column.getByRole('button', { name: 'Stop generating' });
    await expect(stop).toBeVisible();
    if (yeet) await column.getByRole('button', { name: /YEET mode off/ }).click();
    await composer.fill('answer the next message after stopping');
    await composer.press('Enter');
    if (yeet) await expect(column.getByText('Waiting for the turn to pause').first()).toBeVisible();
    else await expect(column.getByRole('button', { name: /Cancel queued message: answer the next message after stopping/ })).toBeVisible();
    await stop.click();
    await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('answer the next message after stopping');
    await expect(column.getByRole('log', { name: 'Conversation' })).toContainText('Echo from Hearth: answer the next message after stopping');
    await expect(column.getByRole('button', { name: /Cancel queued message: answer the next message after stopping/ })).toHaveCount(0);
    await expect(column.getByText('Stopped before this was sent.')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('stop-handoff.png') });
  });
}
