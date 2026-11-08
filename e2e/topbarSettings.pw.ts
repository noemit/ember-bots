import { expect, test, type Page } from '@playwright/test';

const toolbar = (page: Page) => page.getByTestId('window-toolbar');
const settings = (page: Page) => page.getByRole('button', { name: 'Settings', exact: true });

async function expectSettingsPosition(page: Page) {
  await expect(settings(page)).toHaveCount(1);
  await expect(settings(page)).toBeVisible();
  await expect(toolbar(page).getByRole('button', { name: 'Settings', exact: true })).toHaveCount(1);
  const views = toolbar(page).getByRole('group', { name: 'Views', exact: true });
  const sessions = views.getByRole('button', { name: /^Sessions/ });
  await expect(sessions).toBeVisible();
  // DOM adjacency protects keyboard order; bounds protect the actual desktop/mobile layout.
  expect(await views.evaluate(element => element.previousElementSibling?.getAttribute('aria-label'))).toBe('Settings');
  const gear = (await settings(page).boundingBox())!;
  const tab = (await sessions.boundingBox())!;
  expect(gear.x + gear.width).toBeLessThanOrEqual(tab.x);
  expect(Math.abs(gear.y + gear.height / 2 - tab.y - tab.height / 2)).toBeLessThan(3);
  expect(gear.x).toBeGreaterThanOrEqual(0);
  expect(tab.x + tab.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`Settings stays before Sessions in every view at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/?noDock');
    for (const view of ['Sessions', 'Usage', 'Scheduled']) {
      await toolbar(page).getByRole('button', { name: new RegExp('^' + view + ' —') }).click();
      await expectSettingsPosition(page);
      await settings(page).click();
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('tab', { name: 'General', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(dialog.getByRole('tabpanel')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    await toolbar(page).getByRole('button', { name: /^Sessions —/ }).click();
    const path = testInfo.outputPath(`topbar-${viewport.width}.png`);
    await page.screenshot({ path, animations: 'disabled' });
    await testInfo.attach('Settings before Sessions', { path, contentType: 'image/png' });
    await toolbar(page).getByRole('button', { name: 'Instances', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Instance settings', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('tab', { name: 'Instances', exact: true })).toHaveAttribute('aria-selected', 'true');
  });
}

// Resolve browser colours through canvas: computed styles may use oklch/color(), not RGB.
async function buttonColours(page: Page) {
  return page.getByTestId('session-rail').getByRole('button', { name: 'New bot', exact: true }).evaluate(element => {
    const context = document.createElement('canvas').getContext('2d')!;
    const rgb = (colour: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    };
    const luminance = (values: number[]) => values.map(value => {
      const channel = value / 255;
      return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const style = getComputedStyle(element);
    const background = rgb(style.backgroundColor);
    const foreground = rgb(style.color);
    const values = [luminance(background), luminance(foreground)].sort((a, b) => a - b);
    return { background, foreground, highlight: rgb(style.getPropertyValue('--highlight').trim()), contrast: (values[1] + .05) / (values[0] + .05) };
  });
}

for (const theme of ['stone', 'clay', 'graphite']) {
  test(`New bot remains accent-coloured, AA and functional in every rail mode: ${theme}`, async ({ page }) => {
    await page.goto('/?noDock');
    await expect(settings(page)).toBeVisible();
    await page.evaluate(async theme => { await window.ember.setSettings({ theme }); }, theme);
    await page.reload();
    for (const mode of ['normal', 'wide', 'mini']) {
      const newBot = page.getByTestId('session-rail').getByRole('button', { name: 'New bot', exact: true });
      await expect(newBot).toBeVisible();
      await page.mouse.move(1000, 500);
      const resting = await buttonColours(page);
      expect(resting.background, mode).toEqual(resting.highlight);
      expect(resting.contrast, `${theme}/${mode} resting contrast`).toBeGreaterThanOrEqual(4.5);
      await newBot.hover();
      await expect.poll(async () => (await buttonColours(page)).background).toEqual(resting.background);
      expect((await buttonColours(page)).contrast, `${theme}/${mode} hover contrast`).toBeGreaterThanOrEqual(4.5);
      await newBot.click();
      await expect(page.getByRole('button', { name: 'New bot project', exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Message your bot', exact: true })).toBeEditable();
      // Return to a real conversation so each mode must open a fresh draft, not reuse it.
      await page.getByTestId('session-rail').getByRole('button', { name: /Habit onboarding QA/ }).first().click();
      await expect(page.getByRole('button', { name: 'New bot project', exact: true })).toHaveCount(0);
      if (mode !== 'mini') {
        await toolbar(page).getByRole('button', { name: mode === 'normal' ? 'Widen the session list' : 'Collapse the session list', exact: true }).click();
      }
    }
  });
}

test('New bot offers the available instances and opens the chosen draft', async ({ page }) => {
  await page.goto('/?noDock&outage');
  await expect(settings(page)).toBeVisible();
  await page.evaluate(() => {
    const original = window.ember.listInstances.bind(window.ember);
    window.ember.listInstances = async (...args) => (await original(...args)).map(instance => ({ ...instance, status: 'ready' as const, attachable: true }));
    window.dispatchEvent(new Event('online'));
  });
  await expect(toolbar(page).getByRole('button', { name: 'Instances', exact: true })).toContainText('2/2');
  await page.getByTestId('session-rail').getByRole('button', { name: 'New bot', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'ember-harness (mock)', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Studio Mac', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'New bot instance', exact: true })).toContainText('Studio Mac');
  await expect(page.getByRole('button', { name: 'New bot project', exact: true })).toBeVisible();
});
