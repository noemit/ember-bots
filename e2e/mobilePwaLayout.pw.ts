import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('phone layout keeps chat, composer trays and keyboard focus inside the viewport', async ({ page }) => {
  await page.goto('/?fixture=async-questions');
  const leader = page.locator('main[data-session-key="pi:hearth::16"]');
  await expect(leader).toBeVisible();
  const composer = leader.locator('textarea').last();
  await composer.fill('A draft remains available');
  const questionTab = leader.getByRole('tab', { name: /Questions/ });
  if (await questionTab.getAttribute('aria-expanded') !== 'true') await questionTab.tap();
  const questionPanel = leader.getByRole('tabpanel', { name: /Questions/ });
  await expect(questionPanel).toBeVisible();
  await expect(questionPanel).toContainText('Keep the migration backup?');
  await questionPanel.locator('textarea').first().tap();
  await expect(questionPanel.locator('textarea').first()).toBeFocused();
  await expect(composer).toHaveValue('A draft remains available');

  const scroll = leader.locator('[data-transcript-scroll]');
  await expect(scroll).toBeVisible();
  const metrics = await page.evaluate(() => ({
    docWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    bodyHeight: document.body.clientHeight,
    viewportHeight: window.innerHeight,
    safeBottom: getComputedStyle(document.querySelector('.safe-composer')!).paddingBottom,
    overscroll: getComputedStyle(document.querySelector('[data-transcript-scroll]')!).overscrollBehaviorY,
  }));
  expect(metrics.docWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.bodyHeight).toBeLessThanOrEqual(metrics.viewportHeight);
  expect(metrics.safeBottom).not.toBe('0px');
  expect(metrics.overscroll).toBe('contain');
  await page.screenshot({ path: '/tmp/ember-mobile-pwa-layout.png', animations: 'disabled' });
});
