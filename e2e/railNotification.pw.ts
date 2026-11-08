import { expect, test } from '@playwright/test';

// Run in the browser: getBoundingClientRect excludes SVG strokes, so transform the
// circle centre and stroke-inclusive radius separately. Compare with the SVG's
// matrix, not the badge's own matrix, to catch scaling around the wrong anchor.
function measureRailNotifications() {
  return Array.from(document.querySelectorAll('#session-sidebar [data-badge="unread"] > circle')).map(element => {
    const circle = element as SVGCircleElement;
    const svg = circle.ownerSVGElement!;
    const matrix = circle.getScreenCTM()!;
    const svgMatrix = svg.getScreenCTM()!;
    const inset = circle.closest('.blob-crystal, .blob-lava') ? -2 : 0;
    const scale = Math.min(1, 10 / (svg.width.baseVal.value * .35));
    const expectedRadius = 17.5 * scale;
    const anchor = new DOMPoint(
      Math.min(88 - inset, 100 - expectedRadius),
      Math.max(12 + inset, expectedRadius),
    ).matrixTransform(svgMatrix);
    const center = new DOMPoint(circle.cx.baseVal.value, circle.cy.baseVal.value).matrixTransform(matrix);
    const radius = circle.r.baseVal.value + parseFloat(getComputedStyle(circle).strokeWidth) / 2;
    const halfWidth = radius * Math.hypot(matrix.a, matrix.c);
    const halfHeight = radius * Math.hypot(matrix.b, matrix.d);
    const rect = circle.getBoundingClientRect();
    const viewport = svg.getBoundingClientRect();
    const strokeX = (radius - circle.r.baseVal.value) * Math.hypot(matrix.a, matrix.c);
    const strokeY = (radius - circle.r.baseVal.value) * Math.hypot(matrix.b, matrix.d);
    return {
      width: halfWidth * 2, height: halfHeight * 2,
      overflow: Math.max(0, viewport.left - (center.x - halfWidth),
        center.x + halfWidth - viewport.right, viewport.top - (center.y - halfHeight),
        center.y + halfHeight - viewport.bottom),
      centerError: Math.hypot(center.x - anchor.x, center.y - anchor.y),
      // Actual browser bounds, expanded for the outline, must surround that anchor.
      boundsError: Math.max(
        Math.abs(rect.left - strokeX - (anchor.x - halfWidth)),
        Math.abs(rect.right + strokeX - (anchor.x + halfWidth)),
        Math.abs(rect.top - strokeY - (anchor.y - halfHeight)),
        Math.abs(rect.bottom + strokeY - (anchor.y + halfHeight))),
    };
  });
}

for (const style of ['Buddy', 'Crystal', 'Mosaic', 'Lava']) {
  test(style + ' rail unread anchors and stroke-inclusive caps survive every size and animated rail mode', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/?noDock');
    const rail = page.getByTestId('session-rail');
    await expect(rail.locator('[data-badge="unread"]').first()).toBeVisible();
    await rail.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: new RegExp('^' + style + ' ') }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const assertGeometry = (samples: ReturnType<typeof measureRailNotifications>) => {
      expect(samples.length).toBeGreaterThan(0);
      // Aggregate across every badge/frame without emitting thousands of trace steps.
      expect(Math.min(...samples.flatMap(sample => [sample.width, sample.height]))).toBeGreaterThan(0);
      expect(Math.max(...samples.flatMap(sample => [sample.width, sample.height]))).toBeLessThanOrEqual(10.001);
      expect(Math.max(...samples.map(sample => sample.centerError))).toBeLessThan(.05);
      expect(Math.max(...samples.map(sample => sample.boundsError))).toBeLessThan(.05);
      expect(Math.max(...samples.map(sample => sample.overflow))).toBeLessThan(.05);
    };
    const sampleDuring = async (change: () => Promise<void>) => {
      // Install the same measurement function before the action, then sample every
      // animation frame, including the .6s shared-avatar handover, not just its end.
      await page.evaluate(source => {
        const measure = new Function('return (' + source + ')')() as typeof measureRailNotifications;
        const state = { frames: 0, samples: [] as ReturnType<typeof measureRailNotifications>, done: false };
        Object.assign(window, { railNotificationSamples: state });
        const start = performance.now();
        const sample = () => {
          state.samples.push(...measure());
          state.frames++;
          if (performance.now() - start < 1000 || state.frames < 20) requestAnimationFrame(sample);
          else state.done = true;
        };
        sample();
      }, measureRailNotifications.toString());
      await change();
      await page.waitForFunction(() => (window as unknown as { railNotificationSamples: { done: boolean } }).railNotificationSamples.done);
      const result = await page.evaluate(() => (window as unknown as {
        railNotificationSamples: { frames: number; samples: ReturnType<typeof measureRailNotifications> };
      }).railNotificationSamples);
      expect(result.frames).toBeGreaterThanOrEqual(20);
      assertGeometry(result.samples);
    };

    for (const label of ['Standard', 'Large', 'Extra large']) {
      await rail.getByRole('button', { name: 'Settings', exact: true }).click();
      await sampleDuring(() => page.getByRole('button', { name: label + ' avatars', exact: true }).click());
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      for (const mode of ['normal', 'wide', 'mini']) {
        await expect(async () => assertGeometry(await page.evaluate(measureRailNotifications))).toPass();
        if (label === 'Extra large') {
          const path = testInfo.outputPath(style.toLowerCase() + '-extra-large-' + mode + '.png');
          await page.screenshot({ animations: 'disabled', path });
          await testInfo.attach(style + ' extra-large ' + mode, { path, contentType: 'image/png' });
        }
        await sampleDuring(() => page.keyboard.press('ControlOrMeta+b'));
      }
    }
  });
}

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
