import { expect, test } from '@playwright/test';

test('Mosaic and Scribble follow nearby pointers, stay inside their eyes, and release their gaze', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  await page.getByRole('button', { name: 'Detail · 112px', exact: true }).click();
  for (const style of ['mosaic', 'scribble']) {
    let captured = false;
    for (const mood of ['idle', 'busy']) {
      for (const blob of await page.locator(`[data-style="${style}"][data-state="${mood}"] .blob`).all()) {
        await blob.scrollIntoViewIfNeeded();
        const box = (await blob.boundingBox())!;
        const pupils = blob.locator(`.${style}-pupil`);
        for (const side of [-1, 1]) {
          await page.mouse.move(box.x + box.width / 2 + side * 70, box.y + box.height / 2 - 25);
          await expect(blob).toHaveAttribute('data-pupil-tracking', 'true');
          await expect.poll(() => pupils.evaluateAll(nodes => nodes.every(node => {
            const pupil = node.querySelector('circle, ellipse') as SVGCircleElement | SVGEllipseElement;
            const eye = (node.closest('.mosaic-eye-open')?.querySelector('[data-mosaic-eye]') ??
              node.closest('.scribble-eye-blink')!.querySelector('[data-scribble-eye]')) as SVGGeometryElement;
            const rx = 'r' in pupil ? pupil.r.baseVal.value : pupil.rx.baseVal.value;
            const ry = 'r' in pupil ? pupil.r.baseVal.value : pupil.ry.baseVal.value;
            const relative = eye.getScreenCTM()!.inverse().multiply(pupil.getScreenCTM()!);
            return Array.from({ length: 16 }, (_, index) => index * Math.PI / 8).every(angle =>
              eye.isPointInFill(new DOMPoint(rx * Math.cos(angle), ry * Math.sin(angle)).matrixTransform(relative)));
          }))).toBe(true);
          const gaze = await pupils.evaluateAll((nodes, direction) => nodes.map(node => {
            const matrix = (node as SVGGElement).transform.baseVal.consolidate()!.matrix;
            return matrix.e * direction > 0 && matrix.f < 0 && getComputedStyle(node).animationName === 'none';
          }), side);
          expect(gaze).toEqual([true, true]);
          if (side === 1 && !captured) {
            await page.locator(`.gallery-style:has([data-style="${style}"])`).screenshot({ path: `/tmp/ember-${style}-tracking.png` });
            captured = true;
          }
        }
        await page.mouse.move(1590, 0);
        await expect(blob).not.toHaveAttribute('data-pupil-tracking');
        for (const pupil of await pupils.all()) await expect(pupil).not.toHaveAttribute('transform');
        if (style === 'mosaic' && mood === 'busy') await expect(pupils.first()).toHaveCSS('animation-name', 'mosaic-working-gaze');
      }
    }
    for (const mood of ['thinking', 'unknown', 'error']) {
      const blob = page.locator(`[data-style="${style}"][data-state="${mood}"] .blob`).first();
      await blob.hover();
      await expect(blob).not.toHaveAttribute('data-pupil-tracking');
    }
  }
  // Keyboard toggles leave the pointer in place, exercising cleanup when interaction is disabled.
  const buddy = page.locator('[data-style="buddy"][data-state="idle"] .blob').first();
  await buddy.hover();
  await expect(buddy).toHaveAttribute('data-pupil-tracking', 'true');
  await page.getByRole('button', { name: 'Pause animations', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(buddy).not.toHaveAttribute('data-pupil-tracking');
  for (const pupil of await buddy.locator('.blob-pupil').all()) await expect(pupil).not.toHaveAttribute('transform');
  await page.getByRole('button', { name: 'Play animations', exact: true }).click();
  await page.getByLabel('Reduced motion', { exact: true }).check();
  await buddy.hover();
  await expect(buddy).not.toHaveAttribute('data-pupil-tracking');
});

test('notification circles align with question badges and Clay uses readable, distinct status colours', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/blob-gallery.html');
  await page.getByLabel('Theme', { exact: true }).selectOption('clay');
  for (const label of ['Rail · 55px', 'Detail · 112px']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    for (const style of ['buddy', 'scribble', 'mosaic', 'lava', 'crystal']) {
      const measurements = await page.locator(`[data-style="${style}"] .gallery-example[data-example="1"] .blob-badge`).evaluateAll(badges =>
        badges.filter(badge => ['unread', 'question', 'input'].includes(badge.getAttribute('data-badge')!)).map(badge => {
          const circle = badge.querySelector('circle')!;
          const svg = badge.closest('svg')!.getBoundingClientRect();
          const rect = circle.getBoundingClientRect();
          return {
            mood: badge.getAttribute('data-badge'),
            x: rect.x - svg.x, y: rect.y - svg.y, width: rect.width, height: rect.height,
            fill: getComputedStyle(circle).fill,
            symbol: badge.querySelector('text, rect') ? getComputedStyle(badge.querySelector('text, rect')!).fill : null,
          };
        }));
      const question = measurements.find(badge => badge.mood === 'question')!;
      const input = measurements.find(badge => badge.mood === 'input')!;
      const unread = measurements.find(badge => badge.mood === 'unread')!;
      for (const dimension of ['x', 'y', 'width', 'height'] as const) {
        expect(unread[dimension]).toBeCloseTo(question[dimension], 3);
        expect(input[dimension]).toBeCloseTo(question[dimension], 3);
      }
      expect(question.fill).toBe(input.fill);
      expect(question.fill).not.toBe(unread.fill);
      expect(question.symbol).toBe('rgb(17, 17, 17)');
      expect(input.symbol).toBe(question.symbol);
    }
  }
  await page.getByRole('region', { name: 'Crystal states', exact: true }).screenshot({ path: '/tmp/ember-clay-badges.png' });
});

test('gallery shows every state and previews distinct Scribble working gestures', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/blob-gallery.html');
  await expect(page.getByRole('heading', { name: 'A little more character.' })).toBeVisible();
  await expect(page.locator('.gallery-state')).toHaveCount(40);
  const examples = await page.locator('.gallery-state').evaluateAll(states => states.map(state => ({
    style: state.getAttribute('data-style'),
    shapes: [...state.querySelectorAll('.gallery-example')].map(example => example.getAttribute('data-shape')),
  })));
  for (const example of examples) {
    expect(new Set(example.shapes).size).toBe(3);
    expect(example.shapes).toEqual(examples.find(other => other.style === example.style)!.shapes);
  }
  expect(await page.evaluate(() => Boolean(window.ember))).toBe(false);
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  const scribble = page.locator('[data-preview="scribble"] .gallery-example[data-example="1"] > .blob');
  await page.getByRole('button', { name: 'Look left', exact: true }).click();
  expect(await scribble.locator('.scribble-face').evaluate(node => new DOMMatrix(getComputedStyle(node).transform).e)).toBeLessThan(-4);
  await expect(scribble.locator('.scribble-face')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: '/tmp/ember-blob-gallery-left.png' });
  await page.getByRole('button', { name: 'Look right', exact: true }).click();
  expect(await scribble.locator('.scribble-face').evaluate(node => new DOMMatrix(getComputedStyle(node).transform).e)).toBeGreaterThan(4);
  await expect(scribble.locator('.scribble-face')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: '/tmp/ember-blob-gallery-right.png' });
  await page.getByRole('button', { name: 'Turn around', exact: true }).click();
  await expect(scribble.locator('.scribble-face')).toHaveCSS('opacity', '0');
  await expect(scribble.locator('.scribble-wave')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/ember-blob-gallery-turn.png' });
  await page.getByRole('button', { name: 'Little stretch', exact: true }).click();
  await expect(scribble.locator('.scribble-face')).toHaveCSS('opacity', '1');
  expect(await scribble.locator('.scribble-dance').evaluate(node => new DOMMatrix(getComputedStyle(node).transform).d)).toBeGreaterThan(1);
  await page.getByLabel('Theme', { exact: true }).selectOption('graphite');
  await page.getByLabel('Creature colour').fill('#fff4c2');
  await expect(scribble.locator('[data-scribble-eye]').first()).toHaveAttribute('stroke', '#29212f');
  await page.getByRole('button', { name: 'Look left', exact: true }).click();
  await page.screenshot({ path: '/tmp/ember-blob-gallery-dark.png' });
  await page.getByLabel('Reduced motion', { exact: true }).check();
  await expect(scribble.locator('.scribble-dance')).toHaveCSS('animation-name', 'none');
  expect(await scribble.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(scribble.locator('.scribble-wave')).toHaveCount(0);
  for (const width of [900, 700, 430]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('heading', { name: 'Crystal', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('heading', { name: 'Crystal', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Crystal facets cover the stone once and working reflections follow those same cuts', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  await page.getByRole('button', { name: 'Detail · 112px', exact: true }).click();
  const crystals = page.locator('[data-style="crystal"][data-state="busy"] .blob');
  const surfaces = await crystals.evaluateAll(nodes => nodes.map(node => {
    const body = node.querySelector('.blob-body > path') as SVGPathElement;
    const faces = [...node.querySelectorAll<SVGPathElement>('[data-crystal-facet]')];
    let checked = 0;
    let misaligned = 0;
    for (let x = 4.137; x < 96; x += 3.71) for (let y = 4.293; y < 96; y += 3.67) {
      const point = new DOMPoint(x, y);
      if (!body.isPointInFill(point)) continue;
      checked++;
      if (faces.filter(face => face.isPointInFill(point)).length !== 1) misaligned++;
    }
    const clips = [...node.querySelectorAll('.crystal-working-light > g')].map(light => {
      const id = light.getAttribute('clip-path')!.slice(5, -1);
      return node.querySelector(`[id="${id}"] path`)!.getAttribute('d');
    });
    return { checked, misaligned, clips, faces: faces.map(face => face.getAttribute('d')) };
  }));
  expect(surfaces).toHaveLength(3);
  for (const surface of surfaces) {
    expect(surface.checked).toBeGreaterThan(200);
    expect(surface.misaligned).toBe(0);
    expect(surface.clips).toEqual(surface.faces);
  }
  await page.getByRole('region', { name: 'Crystal states', exact: true }).screenshot({ path: '/tmp/ember-crystal-facets.png' });
});

test('Lava changes course between separations, keeps colour with its lobes, and stops when reduced', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  await page.getByRole('button', { name: 'Rail · 55px', exact: true }).click();
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  const lava = page.locator('[data-style="lava"][data-state="busy"] .blob');
  const samples = await lava.evaluateAll(nodes => nodes.map(node => {
    const bud = node.querySelector('circle.blob-lava-bud')!;
    const budPool = node.querySelector('g.blob-lava-bud')!;
    const duration = Number(bud.getAnimations()[0].effect!.getTiming().duration);
    const animations = node.getAnimations({ subtree: true });
    const frames = [0, 1800, duration, duration + 1800].map(time => {
      animations.forEach(animation => { animation.currentTime = time; });
      const bodyStyle = getComputedStyle(bud);
      const poolStyle = getComputedStyle(budPool);
      return {
        body: bodyStyle.transform,
        flow: bodyStyle.translate,
        colourFollows: bodyStyle.transform === poolStyle.transform && bodyStyle.translate === poolStyle.translate,
      };
    });
    const positions = Array.from({ length: 9 }, (_, index) => {
      animations.forEach(animation => { animation.currentTime = index * 1500; });
      const rect = bud.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    const travel = positions.slice(1).reduce((total, position, index) =>
      total + Math.hypot(position.x - positions[index].x, position.y - positions[index].y), 0);
    const poseCount = new Set(bud.getAnimations()[0].effect!.getKeyframes().map(frame => frame.transform)).size;
    const cores = [...node.querySelectorAll('.blob-lava-core')];
    const coreColourFollows = getComputedStyle(cores[0]).transform === getComputedStyle(cores[1]).transform;
    return { duration, frames, travel, poseCount, coreColourFollows };
  }));
  expect(new Set(samples.map(sample => sample.duration)).size).toBe(3);
  for (const { frames, travel, poseCount, coreColourFollows } of samples) {
    expect(frames.every(frame => frame.colourFollows)).toBe(true);
    expect(frames[0].body).not.toBe(frames[1].body);
    expect(frames[0].flow).not.toBe(frames[2].flow);
    expect(travel).toBeGreaterThan(20); // Noticeable movement over 12 seconds, even at 55px.
    expect(poseCount).toBeGreaterThan(25);
    expect(coreColourFollows).toBe(true);
  }
  await page.getByRole('button', { name: 'Detail · 112px', exact: true }).click();
  await page.getByRole('region', { name: 'Lava states', exact: true }).screenshot({ path: '/tmp/ember-lava-variations.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await lava.evaluateAll(nodes => nodes.flatMap(node => node.getAnimations({ subtree: true })).length)).toBe(0);
  await expect(lava.first().locator('circle.blob-lava-bud')).toHaveCSS('translate', 'none');
});

test('Lava waits with fluid motion while approval and question badges stay anchored', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  await page.getByLabel('Theme', { exact: true }).selectOption('clay');
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  const waiting = page.locator('[data-style="lava"]:is([data-state="input"], [data-state="question"]) .blob');
  await expect(waiting).toHaveCount(6);
  for (const size of ['Rail · 55px', 'Detail · 112px']) {
    await page.getByRole('button', { name: size, exact: true }).click();
    const samples = await waiting.evaluateAll(nodes => nodes.map(node => {
      const animations = node.getAnimations({ subtree: true });
      const badge = node.querySelector('.blob-badge')!;
      const core = node.querySelector('.blob-lava-core')!;
      const frames = [0, 350, 1050, 1400, 4800, 11000, 23000].map(time => {
        animations.forEach(animation => { animation.currentTime = time; });
        const rect = badge.getBoundingClientRect();
        return {
          badge: [rect.x, rect.y, rect.width, rect.height],
          body: getComputedStyle(core).transform,
          wrapper: getComputedStyle(node).transform,
        };
      });
      return { frames, paused: animations.every(animation => animation.playState === 'paused') };
    }));
    for (const { frames, paused } of samples) {
      expect(paused).toBe(true);
      expect(new Set(frames.map(frame => frame.body)).size).toBeGreaterThan(1);
      for (const frame of frames) {
        expect(frame.wrapper).toBe('none');
        expect(frame.badge).toEqual(frames[0].badge);
      }
    }
  }
  await page.getByRole('region', { name: 'Lava states', exact: true }).screenshot({ path: '/tmp/ember-lava-waiting.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await waiting.evaluateAll(nodes => nodes.flatMap(node => node.getAnimations({ subtree: true })).length)).toBe(0);
  for (const badge of await waiting.locator('.blob-badge').all()) await expect(badge).toBeVisible();
});

test('Mosaic pixels change on both sides while the body stays anchored, with a static reduced-motion pose', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  const mosaic = page.locator('[data-preview="mosaic"] .gallery-example[data-example="1"] > .blob');
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
  expect(await page.locator('[data-style="mosaic"][data-state="idle"] .blob').first().evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(mosaic.locator('.mosaic-pixel').first()).toHaveCSS('animation-name', 'none');
  expect(await mosaic.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(mosaic.locator('.mosaic-pixel').first()).toHaveCSS('opacity', '0.45');
  const scribble = page.locator('[data-preview="scribble"] .gallery-example[data-example="1"] > .blob');
  expect(await scribble.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
});


test('thinking is distinct for every style, and a turning Scribble keeps its volume', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  const scribble = page.locator('[data-preview="scribble"] .gallery-example[data-example="1"] > .blob');
  const samples = await scribble.evaluate(node => {
    const widths: number[] = [];
    const wirePoses = new Set<string>();
    for (let step = 0; step <= 32; step++) {
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
    const blob = thinking.locator(`.blob-${style}`).first();
    const animation = await blob.evaluate(node => [...node.querySelectorAll('*')]
      .map(child => getComputedStyle(child).animationName).filter(name => name !== 'none').sort().join(','));
    expect(animation.length).toBeGreaterThan(0);
    signatures.push(animation);
  }
  expect(new Set(signatures).size).toBe(5);
  await expect(page.locator('[data-style="mosaic"][data-state="error"] .mosaic-error-eye')).toHaveCount(6);
  await expect(page.locator('[data-style="mosaic"][data-state="error"] .mosaic-error-eye rect')).toHaveCount(30);
  const crystal = page.locator('[data-style="crystal"][data-state="busy"]');
  await expect(crystal.locator('circle.blob-heat')).toHaveCount(0);
  expect(Number(await crystal.locator('.blob-heat').first().evaluate(node => getComputedStyle(node).opacity))).toBeLessThan(.3);
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
    const blob = page.locator(`[data-style="mosaic"][data-state="${mood}"] .blob`).first();
    const frames = await blob.evaluate(node => [0, .25, .4, .545, .55, .56, .8].map(phase => {
      node.querySelectorAll('.mosaic-eyes, .mosaic-pupil, .mosaic-eye-open, .mosaic-eye-closed').forEach(element => {
        const duration = parseFloat(getComputedStyle(element).animationDuration);
        // Pausing retains elapsed time. Offset it so short blink samples land at the intended phase.
        const elapsed = element.getAnimations()[0]?.currentTime;
        (element as SVGElement).style.animationDelay = `${-duration * phase + (typeof elapsed === 'number' ? elapsed / 1000 : 0)}s`;
      });
      const pupils = [...node.querySelectorAll<SVGCircleElement>('.mosaic-pupil > circle:first-child')];
      const eyes = [...node.querySelectorAll<SVGPathElement>('[data-mosaic-eye]')];
      return {
        gaze: getComputedStyle(node.querySelector('.mosaic-pupil')!).transform,
        peek: getComputedStyle(node.querySelector('.mosaic-eyes')!).transform,
        open: getComputedStyle(node.querySelector('.mosaic-eye-open')!).opacity,
        lid: getComputedStyle(node.querySelector('.mosaic-eye-closed')!).opacity,
        inside: pupils.every((pupil, index) => {
          const eye = eyes[index];
          const relative = eye.getScreenCTM()!.inverse().multiply(pupil.getScreenCTM()!);
          return Array.from({ length: 16 }, (_, point) => point * Math.PI / 8).every(angle =>
            eye.isPointInFill(new DOMPoint(pupil.r.baseVal.value * Math.cos(angle), pupil.r.baseVal.value * Math.sin(angle)).matrixTransform(relative)));
        }),
      };
    }));
    expect(new Set(frames.map(frame => frame.gaze)).size).toBeGreaterThan(3);
    const offsets = frames.map(frame => frame.gaze.match(/matrix\(([^)]+)\)/)![1].split(',').map(Number));
    expect(Math.max(...offsets.map(matrix => matrix[4])) - Math.min(...offsets.map(matrix => matrix[4]))).toBeGreaterThan(3);
    expect(Math.max(...offsets.map(matrix => matrix[5])) - Math.min(...offsets.map(matrix => matrix[5]))).toBeGreaterThan(2);
    expect(frames.every(frame => frame.inside)).toBe(true);
    expect(frames.map(frame => frame.open)).toEqual(['1', '1', '1', '0', '0', '1', '1']);
    expect(frames.map(frame => frame.lid)).toEqual(['0', '0', '0', '1', '1', '0', '0']);
    expect(new Set(frames.map(frame => frame.peek)).size).toBe(mood === 'thinking' ? 2 : 1);
  }
  // Put the two faces in a glance and a blink for a close visual review.
  await page.locator('[data-style="mosaic"][data-state="thinking"] .blob').first().evaluate(node => {
    node.querySelectorAll('.mosaic-eyes, .mosaic-pupil, .mosaic-eye-open, .mosaic-eye-closed').forEach(element => {
      const elapsed = element.getAnimations()[0]?.currentTime;
      (element as SVGElement).style.animationDelay = `${-parseFloat(getComputedStyle(element).animationDuration) * .25 + (typeof elapsed === 'number' ? elapsed / 1000 : 0)}s`;
    });
  });
  await page.locator('[data-style="mosaic"][data-state="busy"] .blob').first().evaluate(node => {
    node.querySelectorAll('.mosaic-pupil, .mosaic-eye-open, .mosaic-eye-closed').forEach(element => {
      const elapsed = element.getAnimations()[0]?.currentTime;
      (element as SVGElement).style.animationDelay = `${-parseFloat(getComputedStyle(element).animationDuration) * .545 + (typeof elapsed === 'number' ? elapsed / 1000 : 0)}s`;
    });
  });
  await page.getByRole('region', { name: 'Mosaic states', exact: true }).screenshot({ path: '/tmp/ember-mosaic-eyes.png' });
  for (const mood of ['idle', 'error']) {
    expect(await page.locator(`[data-style="mosaic"][data-state="${mood}"] .blob`).first().evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const mood of ['busy', 'thinking']) {
    const blob = page.locator(`[data-style="mosaic"][data-state="${mood}"] .blob`).first();
    await expect(blob.locator('.mosaic-eye-open').first()).toHaveCSS('opacity', '1');
    await expect(blob.locator('.mosaic-eye-closed').first()).toHaveCSS('opacity', '0');
    expect(await blob.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  }
});

test('question waves are exclusive, thinking has body motion, and only Crystal orbits', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  const question = page.locator('[data-style="scribble"][data-state="question"] .scribble-wave').first();
  await expect(question).toHaveCount(1);
  await expect(question).toHaveCSS('opacity', '1');
  for (const mood of ['busy', 'thinking', 'idle', 'input']) {
    await expect(page.locator(`[data-style="scribble"][data-state="${mood}"] .scribble-wave`)).toHaveCount(0);
  }
  await expect(page.locator('.blob-lava .blob-orbit')).toHaveCount(0);
  await expect(page.locator('[data-style="crystal"][data-state="question"] .blob-orbit')).toHaveCount(6);
  for (const [style, part] of [['buddy', '.blob-hop'], ['lava', '.blob-lava-core']]) {
    const samples = await page.locator(`[data-style="${style}"][data-state="thinking"] ${part}`).first().evaluate(node => {
      const frames = [];
      // Uneven motion can reach its extremes between the old five evenly spaced samples.
      for (const phase of Array.from({ length: 25 }, (_, index) => index / 25)) {
        const duration = parseFloat(getComputedStyle(node).animationDuration);
        const elapsed = node.getAnimations()[0]?.currentTime;
        (node as SVGElement).style.animationDelay = `${-duration * phase + (typeof elapsed === 'number' ? elapsed / 1000 : 0)}s`;
        const matrix = new DOMMatrix(getComputedStyle(node).transform);
        frames.push({ scaleX: Math.hypot(matrix.a, matrix.b), scaleY: Math.hypot(matrix.c, matrix.d), tilt: Math.atan2(matrix.b, matrix.a) });
      }
      return frames;
    });
    expect(Math.max(...samples.map(frame => frame.scaleY)) - Math.min(...samples.map(frame => frame.scaleY))).toBeGreaterThan(.15);
    if (style === 'buddy') expect(Math.max(...samples.map(frame => frame.tilt)) - Math.min(...samples.map(frame => frame.tilt))).toBeGreaterThan(.3);
  }
  await page.screenshot({ path: '/tmp/ember-gestures-light.png', fullPage: true });
  await page.getByLabel('Theme', { exact: true }).selectOption('graphite');
  await page.screenshot({ path: '/tmp/ember-gestures-dark.png', fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(question).toHaveCSS('opacity', '1');
  expect(await page.locator('.blob').evaluateAll(nodes => nodes.flatMap(node => node.getAnimations({ subtree: true })).length)).toBe(0);
});
