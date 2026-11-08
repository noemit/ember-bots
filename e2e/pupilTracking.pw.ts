import { expect, test, type Locator, type Page } from '@playwright/test';

type Point = { x: number; y: number };
const thinkingBuddy = (page: Page) => page.locator('[data-style="buddy"][data-state="thinking"] .blob').first();
const nextFrames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function pointNear(page: Page, blob: Locator): Promise<Point> {
  await blob.scrollIntoViewIfNeeded();
  // Dock handovers/dialog entry can still be moving; acquire the pointer after they settle.
  await blob.hover({ trial: true });
  const box = (await blob.boundingBox())!;
  const point = { x: Math.round(box.x + box.width / 2 + 70), y: Math.round(box.y + box.height / 2 - 25) };
  await page.mouse.move(point.x, point.y);
  return point;
}

// Check the actual SVG translation against the *current* wrapper geometry, not just a flag.
async function expectGaze(blob: Locator, point: Point) {
  await expect.poll(() => blob.evaluate((node, pointer) => {
    const box = node.getBoundingClientRect();
    const dx = pointer.x - box.left - box.width / 2;
    const dy = pointer.y - box.top - box.height / 2;
    const distance = Math.hypot(dx, dy) || 1;
    const near = Math.max(0, 1 - distance / 260);
    const pupils = [...node.querySelectorAll<SVGGElement>('.blob-pupil')];
    if (!near) return !node.hasAttribute('data-pupil-tracking') && pupils.every(pupil => !pupil.hasAttribute('transform'));
    const pull = near * near * (3 - 2 * near) * 5.5;
    return pupils.length === 2 && node.getAttribute('data-pupil-tracking') === 'true' && pupils.every(pupil => {
      const matrix = pupil.transform.baseVal.consolidate()?.matrix;
      return matrix && Math.abs(matrix.e - dx / distance * pull) < .015 && Math.abs(matrix.f - dy / distance * pull) < .015;
    });
  }, point)).toBe(true);
}

async function expectReleased(blob: Locator) {
  await expect(blob).not.toHaveAttribute('data-pupil-tracking');
  for (const pupil of await blob.locator('.blob-pupil').all()) await expect(pupil).not.toHaveAttribute('transform');
}

test('thinking Buddy follows nearby pointers and refreshes gaze after stationary-pointer geometry changes', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  await page.getByRole('button', { name: 'Detail · 112px', exact: true }).click();
  const blob = thinkingBuddy(page);
  const point = await pointNear(page, blob);
  await expectGaze(blob, point);
  const beforeScroll = await blob.locator('.blob-pupil').first().getAttribute('transform');
  await page.evaluate(() => window.scrollBy(0, 100));
  await expectGaze(blob, point);
  await expect(blob.locator('.blob-pupil').first()).not.toHaveAttribute('transform', beforeScroll!);

  // No mousemove: window resizing reflows the gallery under the stationary pointer.
  await page.setViewportSize({ width: 1200, height: 850 });
  await expectGaze(blob, point);
  const resizedPoint = await pointNear(page, blob);
  await expectGaze(blob, resizedPoint);
  const beforeResize = await blob.locator('.blob-pupil').first().getAttribute('transform');
  // A local wrapper resize does not emit window.resize; ResizeObserver must refresh the gaze.
  await blob.evaluate(node => { node.style.width = '192px'; node.style.height = '152px'; });
  await expectGaze(blob, resizedPoint);
  await expect(blob.locator('.blob-pupil').first()).not.toHaveAttribute('transform', beforeResize!);
  await page.screenshot({ path: '/tmp/ember-pupil-geometry.png' });

  // Crossing the radius by scrolling releases tracking without another pointer movement.
  await page.evaluate(() => window.scrollBy(0, 400));
  await expectGaze(blob, resizedPoint);
  await expectReleased(blob);
  await page.evaluate(() => window.scrollBy(0, -400));
  await expectGaze(blob, resizedPoint);
  await page.mouse.move(1190, 0);
  await expectReleased(blob);
});

test('pointer exit, blur and disable release gaze without reviving stale coordinates', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  const blob = thinkingBuddy(page);
  await expectGaze(blob, await pointNear(page, blob));
  await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
  await expectReleased(blob);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await nextFrames(page);
  await expectReleased(blob);

  await expectGaze(blob, await pointNear(page, blob));
  // Queue a move and blur in the same task: the pending shared RAF must not restore it.
  await blob.evaluate(node => {
    const box = node.getBoundingClientRect();
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: box.x + 30, clientY: box.y + 30 }));
    window.dispatchEvent(new Event('blur'));
  });
  await expectReleased(blob);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); window.scrollBy(0, 20); });
  await page.setViewportSize({ width: 1500, height: 900 });
  await blob.evaluate(node => { node.style.width = '80px'; });
  await nextFrames(page);
  await expectReleased(blob);

  await expectGaze(blob, await pointNear(page, blob));
  // DOM activation leaves the pointer stationary, unlike clicking the toolbar with the mouse.
  await page.getByRole('button', { name: 'Pause animations', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
  await expectReleased(blob);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await nextFrames(page);
  await expectReleased(blob);
  await page.getByRole('button', { name: 'Play animations', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
  await nextFrames(page);
  await expectReleased(blob);
  await expectGaze(blob, await pointNear(page, blob));
});

for (const reduced of ['system', 'gallery'] as const) {
  test(`reduced motion (${reduced}) stops autonomous thinking but preserves direct nearby gaze`, async ({ page }) => {
    if (reduced === 'system') await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/blob-gallery.html');
    if (reduced === 'gallery') await page.getByLabel('Reduced motion', { exact: true }).check();
    const blob = thinkingBuddy(page);
    await expectGaze(blob, await pointNear(page, blob));
    expect(await blob.evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length)).toBe(0);
    const box = (await blob.boundingBox())!;
    const opposite = { x: Math.round(box.x + box.width / 2 - 50), y: Math.round(box.y + box.height / 2 + 30) };
    await page.mouse.move(opposite.x, opposite.y);
    await expectGaze(blob, opposite);
    await page.screenshot({ path: `/tmp/ember-pupil-reduced-${reduced}.png` });
    await page.mouse.move(1590, 0);
    await expectReleased(blob);
  });
}

test('live composer dock, settings and appearance previews track nearby pointers', async ({ page }) => {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: /Habit onboarding QA/ }).first().click();
  const dock = page.locator('[data-active-chat]');
  await expect(dock).toContainText('Habit onboarding QA');
  // Shared-layout handover lasts 600ms and is not a wrapper resize. Test the settled dock.
  await page.waitForTimeout(800);
  await expectGaze(dock.locator('.blob').first(), await pointNear(page, dock.locator('.blob').first()));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settingsBlob = page.getByRole('dialog').locator('.blob-buddy').first();
  await page.waitForTimeout(800);
  await expectGaze(settingsBlob, await pointNear(page, settingsBlob));
  await page.keyboard.press('Escape');
  await dock.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Customize appearance/ }).click();
  const preview = page.getByRole('dialog').locator('.blob-buddy').first();
  await page.waitForTimeout(800);
  await expectGaze(preview, await pointNear(page, preview));
  await page.screenshot({ path: '/tmp/ember-pupil-appearance.png' });
});
