import { expect, test } from '@playwright/test';

test('rail unread notifications stay within ten CSS pixels at every avatar size and rail width', async ({ page }) => {
  await page.goto('/?noDock');
  const rail = page.getByTestId('session-rail');
  await expect(rail.locator('[data-badge="unread"]').first()).toBeVisible();
  for (const label of ['Standard', 'Large', 'Extra large']) {
    await rail.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: `${label} avatars`, exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    for (const mode of ['normal', 'wide', 'mini']) {
      const circles = rail.locator('[data-badge="unread"] > circle');
      await expect(circles.first()).toBeVisible();
      // Measure settled geometry after the shared-avatar handover animation.
      await expect(async () => {
        const diameters = await circles.evaluateAll(elements => elements.map(element => {
          const circle = element as SVGCircleElement;
          const matrix = circle.getScreenCTM()!;
          const diameter = circle.r.baseVal.value * 2 + Number(getComputedStyle(circle).strokeWidth.replace('px', ''));
          // BoundingClientRect omits SVG stroke: include the outline explicitly.
          return { x: diameter * Math.hypot(matrix.a, matrix.b), y: diameter * Math.hypot(matrix.c, matrix.d) };
        }));
        for (const diameter of diameters) {
          expect(diameter.x).toBeGreaterThan(0);
          expect(diameter.x).toBeLessThanOrEqual(10.001);
          expect(diameter.y).toBeLessThanOrEqual(10.001);
        }
      }).toPass();
      await page.screenshot({ animations: 'disabled', path: `/tmp/rail-notification-${label.replace(' ', '-')}-${mode}.png` });
      await page.keyboard.press('ControlOrMeta+b');
    }
  }
});

test('collapsed rail previews use readable tooltip foreground in light and dark themes', async ({ page }) => {
  await page.goto('/?noDock');
  const rail = page.getByTestId('session-rail');
  await expect(rail.locator('[data-badge="unread"]').first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.press('ControlOrMeta+b');
  for (const theme of ['Stone', 'Graphite']) {
    await rail.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: theme, exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await rail.locator('[data-mini-session="pi:hearth::10"]').hover();
    const tooltip = page.locator('[data-slot="tooltip-content"]').filter({ hasText: 'Habit onboarding QA' });
    await expect(tooltip).toBeVisible();
    const preview = tooltip.locator('span').first();
    await expect(preview).not.toBeEmpty();
    const colors = await preview.evaluate(element => {
      const parent = element.closest('[data-slot="tooltip-content"]')!;
      const foreground = getComputedStyle(element).color;
      const background = getComputedStyle(parent).backgroundColor;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d')!;
      const luminance = (color: string) => {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const rgb = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3).map(channel => {
          const value = channel / 255;
          return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
        });
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const a = luminance(foreground);
      const b = luminance(background);
      return { foreground, tooltipForeground: getComputedStyle(parent).color,
        contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
    expect(colors.foreground).toBe(colors.tooltipForeground);
    expect(colors.contrast).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ animations: 'disabled', path: '/tmp/rail-tooltip-' + theme.toLowerCase() + '.png' });
    await page.mouse.move(1200, 100);
  }
});

test('rail unread bubbles never exceed ten pixels while avatar sizes and rail modes animate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/?noDock');
  const rail = page.getByTestId('session-rail');
  await expect(rail.locator('[data-badge="unread"]').first()).toBeVisible();
  const sampleDuring = async (change: () => Promise<void>) => {
    const sampling = page.evaluate(() => new Promise<{ max: number; frames: number }>(resolve => {
      let max = 0;
      let frames = 0;
      const start = performance.now();
      const sample = () => {
        for (const element of document.querySelectorAll('#session-sidebar [data-badge="unread"] > circle')) {
          const circle = element as SVGCircleElement;
          const matrix = circle.getScreenCTM()!;
          const diameter = 2 * circle.r.baseVal.value + parseFloat(getComputedStyle(circle).strokeWidth);
          max = Math.max(max, diameter * Math.hypot(matrix.a, matrix.b), diameter * Math.hypot(matrix.c, matrix.d));
        }
        frames++;
        if (performance.now() - start < 1800 || frames < 20) requestAnimationFrame(sample);
        else resolve({ max, frames });
      };
      requestAnimationFrame(sample);
    }));
    const [measurements] = await Promise.all([sampling, change()]);
    expect(measurements.frames).toBeGreaterThan(10);
    expect(measurements.max).toBeGreaterThan(0);
    expect(measurements.max).toBeLessThanOrEqual(10.001);
  };
  for (const size of ['Extra large', 'Standard', 'Large']) {
    await rail.getByRole('button', { name: 'Settings', exact: true }).click();
    await sampleDuring(() => page.getByRole('button', { name: `${size} avatars`, exact: true }).click());
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    for (let mode = 0; mode < 3; mode++) {
      await sampleDuring(() => page.keyboard.press('ControlOrMeta+b'));
    }
  }
});
