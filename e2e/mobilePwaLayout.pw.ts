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
  await expect(questionPanel.locator('textarea')).toHaveCount(0);
  const answerComposer = leader.locator('[data-question-answer-composer]');
  await expect(answerComposer).toBeVisible();
  const noteInput = answerComposer.getByRole('textbox', { name: 'Add a note' });
  await noteInput.tap();
  await expect(noteInput).toBeFocused();
  await answerComposer.getByRole('button', { name: /Back to chat/ }).tap();
  await expect(leader.getByRole('textbox', { name: 'Message your bot' })).toHaveValue('A draft remains available');

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
