import { expect, test } from '@playwright/test';

test('Mosaic replaces Pip in settings and keeps custom shape and colour in the rail', async ({ page }) => {
  await page.goto('/?noDock');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: /Pip/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Mosaic/ }).click();
  await expect.poll(() => page.evaluate(() => window.ember.getSettings().then(s => s.blobStyle))).toBe('mosaic');
  await page.keyboard.press('Escape');
  const row = page.locator('aside').getByRole('button', { name: /Habit onboarding QA/ });
  await expect(row.locator('.blob-mosaic')).toBeVisible();
  await row.click();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Customize appearance/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Custom bot color').fill('#158cba');
  await dialog.getByRole('button', { name: 'crown', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row.locator('.blob-mosaic')).toHaveAttribute('data-shape', 'crown');
  await expect(page.locator('main[data-session-key="pi:hearth::10"] [data-agent-glow]')).toHaveAttribute('style', /rgb\(21, 140, 186\)/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await row.locator('.mosaic-step').evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  await page.screenshot({ path: '/tmp/ember-mosaic-rail.png' });
});

test('every style rasterises its body and overlay as a valid dock image', async ({ page }) => {
  await page.goto('/?noDock');
  await expect(page.locator('aside')).toBeVisible();
  const images = await page.evaluate(async () => {
    const source = '/src/blob/dockIcon.ts';
    const { renderDockIcon } = await import(/* @vite-ignore */ source);
    const identity = { sessionKey: 'demo', colorSeed: 'demo', shapeSeed: 'demo', motionSeed: 'demo', color: '#ff8648' };
    const results = [];
    for (const style of ['buddy', 'crystal', 'mosaic', 'lava', 'scribble']) results.push(await renderDockIcon(style, identity, 'question'));
    return results;
  });
  for (const image of images) expect(image).toMatch(/^data:image\/png;base64,/);
});

test('Mosaic pointer gaze stays on whole body cells in every pupil-bearing mood', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  await page.getByRole('button', { name: 'Detail · 112px', exact: true }).click();
  for (const mood of ['idle', 'busy', 'thinking', 'input', 'question', 'unread']) {
    const blob = page.locator(`[data-style="mosaic"][data-state="${mood}"] .blob`).first();
    await blob.scrollIntoViewIfNeeded();
    const box = (await blob.boundingBox())!;
    const positions = [];
    for (const side of [-1, 1]) {
      await page.mouse.move(box.x + box.width / 2 + side * 70, box.y + box.height / 2 - 25);
      await expect(blob).toHaveAttribute('data-pupil-tracking', 'true');
      positions.push(await blob.locator('.mosaic-pupil').evaluateAll(nodes => nodes.map(node => {
        const pupil = node.querySelector('rect')!;
        const offset = (node as SVGGElement).transform.baseVal.consolidate()!.matrix;
        const eye = node.closest('.mosaic-eye-open')!.querySelector('[data-mosaic-eye]')!;
        return { x: Number(pupil.getAttribute('x')) + offset.e - Number(eye.getAttribute('x')), y: offset.f,
          animation: getComputedStyle(node).animationName };
      })));
    }
    expect(positions).toEqual([
      [{ x: 0, y: 0, animation: 'none' }, { x: 0, y: 0, animation: 'none' }],
      [{ x: 1, y: 0, animation: 'none' }, { x: 1, y: 0, animation: 'none' }],
    ]);
    await page.mouse.move(1590, 0);
    await expect(blob).not.toHaveAttribute('data-pupil-tracking');
  }
  for (const mood of ['unknown', 'error']) {
    const blob = page.locator(`[data-style="mosaic"][data-state="${mood}"] .blob`).first();
    await blob.hover();
    await expect(blob).not.toHaveAttribute('data-pupil-tracking');
  }
  await page.getByRole('region', { name: 'Mosaic states', exact: true }).screenshot({ path: '/tmp/ember-mosaic-pixel-large.png' });
  await page.getByRole('button', { name: 'Rail · 55px', exact: true }).click();
  await page.getByRole('region', { name: 'Mosaic states', exact: true }).screenshot({ path: '/tmp/ember-mosaic-pixel-rail-gallery.png' });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  for (const mood of ['busy', 'thinking']) {
    const blob = page.locator(`[data-style="mosaic"][data-state="${mood}"] .blob`).first();
    expect(await blob.evaluate(node => node.getAnimations({ subtree: true }).every(animation => animation.playState === 'paused'))).toBe(true);
  }
});
