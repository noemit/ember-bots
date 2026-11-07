import { expect, test } from '@playwright/test';

test('gallery shows every state and previews three distinct Scribble gestures', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/blob-gallery.html');
  await expect(page.getByRole('heading', { name: 'A little more character.' })).toBeVisible();
  await expect(page.locator('.gallery-state')).toHaveCount(40);
  expect(await page.evaluate(() => Boolean(window.ember))).toBe(false);
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  const scribble = page.locator('[data-preview="scribble"] > .blob');
  await page.getByRole('button', { name: 'Head scratch', exact: true }).click();
  await expect(scribble.locator('.scribble-scratch')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: '/tmp/ember-blob-gallery-scratch.png', fullPage: true });
  await page.getByRole('button', { name: 'Turn around', exact: true }).click();
  await expect(scribble.locator('.scribble-face')).toHaveCSS('opacity', '0');
  await expect(scribble.locator('.scribble-scratch')).toHaveCSS('opacity', '0');
  await page.screenshot({ path: '/tmp/ember-blob-gallery-turn.png' });
  await page.getByRole('button', { name: 'Little stretch', exact: true }).click();
  await expect(scribble.locator('.scribble-face')).toHaveCSS('opacity', '1');
  expect(await scribble.locator('.scribble-dance').evaluate(node => new DOMMatrix(getComputedStyle(node).transform).d)).toBeGreaterThan(1);
  await page.getByLabel('Theme', { exact: true }).selectOption('graphite');
  await page.getByLabel('Creature colour').fill('#fff4c2');
  await expect(scribble.locator('[data-scribble-eye]').first()).toHaveAttribute('stroke', '#29212f');
  await page.getByRole('button', { name: 'Head scratch', exact: true }).click();
  await page.screenshot({ path: '/tmp/ember-blob-gallery-dark.png' });
  await page.getByLabel('Reduced motion', { exact: true }).check();
  await expect(scribble.locator('.scribble-dance')).toHaveCSS('animation-name', 'none');
  expect(await scribble.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(scribble.locator('.scribble-scratch')).toHaveCSS('opacity', '0');
  await page.setViewportSize({ width: 430, height: 900 });
  await page.getByRole('heading', { name: 'Crystal', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('heading', { name: 'Crystal', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Mosaic pixels change on both sides while the body stays anchored, with a static reduced-motion pose', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  const mosaic = page.locator('[data-preview="mosaic"] > .blob');
  await expect(mosaic).toBeVisible();
  for (const side of ['left', 'right']) {
    const changes = await mosaic.locator(`.mosaic-pixel[data-side="${side}"]`).evaluateAll(nodes => {
      const frames: string[] = [];
      for (const time of [0, 600, 1200, 1800]) {
        nodes.forEach(node => {
          const pixel = node as SVGElement;
          pixel.style.animationPlayState = 'paused';
          pixel.style.animationDelay = `-${time}ms`;
        });
        frames.push(nodes.map(node => getComputedStyle(node).opacity).join(','));
      }
      return new Set(frames).size;
    });
    expect(changes).toBeGreaterThan(1);
  }
  await expect(mosaic.locator('.mosaic-step')).toHaveCSS('transform', 'none');
  expect(await page.locator('[data-style="mosaic"][data-state="idle"] .blob').evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(mosaic.locator('.mosaic-pixel').first()).toHaveCSS('animation-name', 'none');
  expect(await mosaic.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(mosaic.locator('.mosaic-pixel').first()).toHaveCSS('opacity', '0.45');
  const scribble = page.locator('[data-preview="scribble"] > .blob');
  expect(await scribble.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
});


test('thinking is distinct for every style, and a turning Scribble keeps its volume', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  const scribble = page.locator('[data-preview="scribble"] > .blob');
  const samples = await scribble.evaluate(node => {
    const widths: number[] = [];
    const wirePoses = new Set<string>();
    for (let step = 0; step <= 24; step++) {
      (node as HTMLElement).style.setProperty('--scribble-delay', `-${step / 2}s`);
      widths.push(node.querySelector('.scribble-head')!.getBoundingClientRect().width);
      wirePoses.add([...node.querySelectorAll('.scribble-wire')].map(wire => getComputedStyle(wire).transform).join('|'));
    }
    return { ratio: Math.min(...widths) / Math.max(...widths), poses: wirePoses.size };
  });
  expect(samples.ratio).toBeGreaterThan(.75);
  expect(samples.poses).toBeGreaterThan(3);
  const thinking = page.locator('.gallery-thinking');
  await expect(thinking.locator('.blob-arc')).toHaveCount(0);
  const signatures: string[] = [];
  for (const style of ['buddy', 'scribble', 'mosaic', 'lava', 'crystal']) {
    const blob = thinking.locator(`.blob-${style}`);
    const animation = await blob.evaluate(node => [...node.querySelectorAll('*')]
      .map(child => getComputedStyle(child).animationName).filter(name => name !== 'none').sort().join(','));
    expect(animation.length).toBeGreaterThan(0);
    signatures.push(animation);
  }
  expect(new Set(signatures).size).toBe(5);
  await expect(page.locator('[data-style="mosaic"][data-state="error"] .mosaic-error-eye')).toHaveCount(2);
  const crystal = page.locator('[data-style="crystal"][data-state="busy"]');
  await expect(crystal.locator('circle.blob-heat')).toHaveCount(0);
  expect(Number(await crystal.locator('.blob-heat').evaluate(node => getComputedStyle(node).opacity))).toBeLessThan(.3);
  await page.screenshot({ path: '/tmp/ember-blob-revision-light.png', fullPage: true });
  await page.getByLabel('Theme', { exact: true }).selectOption('graphite');
  await page.screenshot({ path: '/tmp/ember-blob-revision-dark.png', fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.blob').evaluateAll(nodes => nodes.flatMap(node => node.getAnimations({ subtree: true })).length)).toBe(0);
});

test('Mosaic glances and briefly blinks while working and thinking, keeping pupils inside the eyes', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  for (const mood of ['busy', 'thinking']) {
    const blob = page.locator(`[data-style="mosaic"][data-state="${mood}"] .blob`);
    const frames = await blob.evaluate(node => [0, .25, .4, .545, .55, .56, .8].map(phase => {
      node.querySelectorAll('.mosaic-eyes, .mosaic-pupil, .mosaic-eye-open, .mosaic-eye-closed').forEach(element => {
        const duration = parseFloat(getComputedStyle(element).animationDuration);
        // Pausing retains elapsed time. Offset it so short blink samples land at the intended phase.
        const elapsed = element.getAnimations()[0]?.currentTime;
        (element as SVGElement).style.animationDelay = `${-duration * phase + (typeof elapsed === 'number' ? elapsed / 1000 : 0)}s`;
      });
      const pupils = [...node.querySelectorAll('.mosaic-pupil rect')];
      const eyes = [...node.querySelectorAll('.mosaic-eye-open > rect')];
      return {
        gaze: getComputedStyle(node.querySelector('.mosaic-pupil')!).transform,
        peek: getComputedStyle(node.querySelector('.mosaic-eyes')!).transform,
        open: getComputedStyle(node.querySelector('.mosaic-eye-open')!).opacity,
        lid: getComputedStyle(node.querySelector('.mosaic-eye-closed')!).opacity,
        inside: pupils.every((pupil, index) => {
          const p = pupil.getBoundingClientRect();
          const e = eyes[index].getBoundingClientRect();
          return p.left >= e.left - .1 && p.right <= e.right + .1 && p.top >= e.top - .1 && p.bottom <= e.bottom + .1;
        }),
      };
    }));
    expect(new Set(frames.map(frame => frame.gaze)).size).toBe(2);
    expect(frames.every(frame => frame.inside)).toBe(true);
    expect(frames.map(frame => frame.open)).toEqual(['1', '1', '1', '0', '0', '1', '1']);
    expect(frames.map(frame => frame.lid)).toEqual(['0', '0', '0', '1', '1', '0', '0']);
    expect(new Set(frames.map(frame => frame.peek)).size).toBe(mood === 'thinking' ? 2 : 1);
  }
  // Put the two faces in a glance and a blink for a close visual review.
  await page.locator('[data-style="mosaic"][data-state="thinking"] .blob').evaluate(node => {
    node.querySelectorAll('.mosaic-eyes, .mosaic-pupil, .mosaic-eye-open, .mosaic-eye-closed').forEach(element => {
      const elapsed = element.getAnimations()[0]?.currentTime;
      (element as SVGElement).style.animationDelay = `${-parseFloat(getComputedStyle(element).animationDuration) * .25 + (typeof elapsed === 'number' ? elapsed / 1000 : 0)}s`;
    });
  });
  await page.locator('[data-style="mosaic"][data-state="busy"] .blob').evaluate(node => {
    node.querySelectorAll('.mosaic-pupil, .mosaic-eye-open, .mosaic-eye-closed').forEach(element => {
      const elapsed = element.getAnimations()[0]?.currentTime;
      (element as SVGElement).style.animationDelay = `${-parseFloat(getComputedStyle(element).animationDuration) * .545 + (typeof elapsed === 'number' ? elapsed / 1000 : 0)}s`;
    });
  });
  await page.getByRole('region', { name: 'Mosaic states', exact: true }).screenshot({ path: '/tmp/ember-mosaic-eyes.png' });
  for (const mood of ['idle', 'error']) {
    expect(await page.locator(`[data-style="mosaic"][data-state="${mood}"] .blob`).evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const mood of ['busy', 'thinking']) {
    const blob = page.locator(`[data-style="mosaic"][data-state="${mood}"] .blob`);
    await expect(blob.locator('.mosaic-eye-open').first()).toHaveCSS('opacity', '1');
    await expect(blob.locator('.mosaic-eye-closed').first()).toHaveCSS('opacity', '0');
    expect(await blob.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  }
});
