import { expect, test } from '@playwright/test';

for (const fixture of ['', '?fixture=scheduled-archived']) {
  test(`scheduled unread survives navigation and reload, then clears on acknowledgement ${fixture}`, async ({ page }) => {
    await page.goto(`/${fixture}`);
    const plan = page.getByTestId('rail-scheduled-plan');
    const indicator = plan.getByRole('img', { name: 'Unread messages from Nightly brief' });
    await expect(indicator).toBeVisible();
    await expect(page.getByTestId('scheduled-count')).toHaveText('1');
    const marks = () => page.evaluate(() => window.ember.getSettings().then(s => s.readMarks));
    const before = await marks();
    await page.getByRole('button', { name: 'Scheduled — runs and recurring plans' }).click();
    await expect(page.getByTestId('scheduled-count')).toHaveText('1');
    expect(await marks()).toEqual(before);
    await page.reload();
    await expect(indicator).toBeVisible();
    await plan.getByRole('button', { name: 'Nightly brief', exact: true }).click();
    const column = page.locator('main[data-session-key="pi:hearth::11"]');
    await expect(column.getByRole('button', { name: /Go to new messages/ })).toBeVisible();
    await expect(indicator).toBeVisible();
    expect(await marks()).toEqual(before);
    await page.screenshot({ path: `/tmp/ember-scheduled-unread${fixture ? '-archived' : ''}.png` });
    await column.getByRole('button', { name: 'Mark this message as read', exact: true }).click();
    await expect(indicator).toHaveCount(0);
    await expect(page.getByTestId('scheduled-count')).toHaveCount(0);
    await page.reload();
    await expect(plan).toBeVisible();
    await expect(indicator).toHaveCount(0);
    await expect(page.getByTestId('scheduled-count')).toHaveCount(0);
  });
}
