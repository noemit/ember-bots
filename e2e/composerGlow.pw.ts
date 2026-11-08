import { expect, test, type Locator } from '@playwright/test';

const expectSubtleFocus = async (surface: Locator) => {
  const opacity = () => surface.evaluate(el => Number(getComputedStyle(el, '::before').opacity));
  await expect.poll(opacity).toBeGreaterThan(0);
  // Check the settled halo, not an early low-opacity frame during the fade-in.
  await surface.evaluate(async el => {
    await Promise.all(el.getAnimations({ subtree: true })
      .filter(animation => animation instanceof CSSTransition && animation.transitionProperty === 'opacity')
      .map(animation => animation.finished.catch(() => undefined)));
  });
  expect(await opacity()).toBeGreaterThan(0);
  expect(await opacity()).toBeLessThanOrEqual(.2);
};

for (const theme of ['stone', 'clay', 'graphite']) {
  test(theme + ` composer blends colour without changing focus geometry`, async ({ page }) => {
    await page.addInitScript((theme) => localStorage.setItem('ember-pi-read-state', JSON.stringify({ theme })), theme);
    await page.goto('/?noDock');
    await page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ }).click();
    const surface = page.locator('main[data-session-key="pi:hearth::10"] [data-composer-surface]');
    await expect(surface).toBeVisible();
    const blend = theme === 'stone' ? 'multiply' : 'color-dodge';
    await expect(surface).toHaveCSS('background-blend-mode', blend);
    const state = () => surface.evaluate(el => {
      const css = getComputedStyle(el);
      const halo = getComputedStyle(el, '::before');
      const rect = el.getBoundingClientRect();
      return { border: css.border, width: rect.width, height: rect.height, blend: halo.mixBlendMode,
        opacity: halo.opacity, pointer: halo.pointerEvents, isolation: getComputedStyle(el.parentElement!).isolation,
        color: (el as HTMLElement).style.getPropertyValue('--composer-glow-color') };
    });
    await page.locator('header').first().click();
    await expect.poll(async () => (await state()).opacity).toBe('0');
    const before = await state();
    expect(before.blend).toBe(blend);
    expect(before.pointer).toBe('none');
    expect(before.isolation).toBe('isolate');
    expect(before.color).toMatch(/var\(--blob-/);
    await page.screenshot({ path: `/tmp/ember-composer-glow-subtle/` + theme + `-unfocused.png` });
    await surface.locator('textarea').focus();
    await expectSubtleFocus(surface);
    const after = await state();
    expect(after.border).toBe(before.border);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    await page.screenshot({ path: `/tmp/ember-composer-glow-subtle/` + theme + `-focused.png` });
  });
}

test('an avatar-free worker keeps the accent fallback and no identity tint', async ({ page }) => {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: /Crew: auth refactor/ }).first().click();
  await page.locator('main[data-session-key="pi:hearth::16"]').getByRole('button', { name: 'Parse config', exact: true }).click();
  const worker = page.locator('main[data-session-key="pi:hearth::17"]');
  const surface = worker.locator('[data-composer-surface]');
  await expect(surface).toBeVisible();
  await expect(worker.locator('[data-corner-tint]')).toHaveCount(0);
  await expect(surface).toHaveCSS('background-image', 'none');
  expect(await surface.evaluate(el => (el as HTMLElement).style.getPropertyValue('--composer-glow-color'))).toBe('');
  await surface.locator('textarea').focus();
  await expectSubtleFocus(surface);
});
