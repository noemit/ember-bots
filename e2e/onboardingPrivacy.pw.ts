import { expect, test } from '@playwright/test';

for (const theme of ['stone', 'graphite']) {
  test(theme + ' privacy finale is readable, linked and cannot bypass model setup', async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem('ember-pi-read-state', JSON.stringify({ theme })), theme);
    await page.goto('/?fixture=onboarding&noDock');
    const wizard = page.getByTestId('onboarding');
    await wizard.getByRole('button', { name: /6\. Yours to use/ }).click();
    await expect(wizard.getByRole('heading', { name: 'Free, open source, and private.' })).toBeVisible();
    await expect(wizard).toContainText('Your chosen AI provider receives');
    await expect(wizard).toContainText('updates and model catalogues');
    await expect(wizard.getByRole('button', { name: 'Finish', exact: true })).toBeDisabled();
    await expect(wizard.getByRole('button', { name: 'Back', exact: true })).toBeInViewport();
    await page.evaluate(() => {
      const opened: string[] = [];
      Object.assign(window, { privacyOpened: opened });
      window.ember.openExternal = async url => { opened.push(url); };
    });
    await wizard.getByRole('link', { name: 'Em', exact: true }).click();
    await wizard.getByRole('link', { name: 'Email me.', exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { privacyOpened: string[] }).privacyOpened))
      .toEqual(['https://x.com/noemititarenco', 'mailto:em-bot@mail.grokbot.com']);
    await wizard.getByRole('button', { name: /4\. Choose an AI/ }).click();
    const model = wizard.getByLabel('Default model for');
    await expect.poll(() => model.locator('option').count()).toBeGreaterThan(1);
    await model.selectOption((await model.locator('option').nth(1).getAttribute('value'))!);
    await wizard.getByRole('button', { name: /6\. Yours to use/ }).click();
    await expect(wizard.getByRole('button', { name: 'Finish', exact: true })).toBeEnabled();
    await page.screenshot({ path: '/tmp/ember-onboarding-privacy/' + theme + '-final.png', fullPage: true });
    await wizard.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(wizard.getByRole('heading', { name: 'Where does your work live?' })).toBeVisible();
  });
}
