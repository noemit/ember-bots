import { expect, test } from '@playwright/test';

/**
 * Interface zoom must never move the window: every preset keeps one page, no scrollbars, and the
 * composer's send row on screen. The QA pass found Large pushing the composer below the fold and a
 * horizontal strip at Small, both from `100dvh`/`100vw` resolving inside the zoomed body.
 */
const presets = [
  { label: 'Small', zoom: '0.92' },
  { label: 'Medium', zoom: '1' },
  { label: 'Large', zoom: '1.08' },
] as const;

const viewports = [
  { width: 1600, height: 1000 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

for (const [index, size] of viewports.entries()) {
  const title = 'interface presets keep one window, no overflow and a visible composer at ' + size.width + 'x' + size.height;
  test(title, async ({ page }) => {
    await page.setViewportSize(size);
    // Below md the rail is a closed drawer; open it from the top bar before choosing a chat.
    await page.addInitScript(() => { try { ['ember-pi-mobile-rail-open'].forEach(k => localStorage.removeItem(k)); } catch { /* no storage */ } });
    await page.goto('/?noDock');
    await page.getByRole('button', { name: 'Toggle sessions sidebar' }).click({ timeout: 5000 }).catch(() => undefined);
    await page.getByTestId('session-rail').getByRole('button', { name: /Habit onboarding QA/ }).first().click();
    for (const preset of presets) {
      await page.evaluate((zoom) => document.documentElement.style.setProperty('--interface-zoom', zoom), preset.zoom);
      await expect(page.locator('body')).toHaveCSS('zoom', preset.zoom);
      const metrics = await page.evaluate(() => {
        const root = document.scrollingElement!;
        const surface = document.querySelector('[data-composer-surface]');
        const bottom = surface ? Math.round(surface.getBoundingClientRect().bottom) : 0;
        return {
          scrollHeight: root.scrollHeight,
          clientHeight: root.clientHeight,
          scrollWidth: root.scrollWidth,
          clientWidth: root.clientWidth,
          composerBottom: bottom,
          innerHeight: window.innerHeight,
        };
      });
      expect(metrics.scrollHeight, preset.label + ': no vertical overflow').toBeLessThanOrEqual(metrics.clientHeight);
      expect(metrics.scrollWidth, preset.label + ': no horizontal overflow').toBeLessThanOrEqual(metrics.clientWidth);
      expect(metrics.composerBottom, preset.label + ': composer inside the window').toBeLessThanOrEqual(metrics.innerHeight);
    }
    await page.screenshot({ path: '/tmp/ember-zoom-' + index + '.png' });
  });
}
