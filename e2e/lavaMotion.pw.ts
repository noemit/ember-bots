import { expect, test } from '@playwright/test';

test('every Lava shape separates and reforms in active states, with stationary decision badges', async ({ page }) => {
  await page.goto('/blob-gallery.html');
  await page.getByRole('button', { name: 'Pause animations', exact: true }).click();
  const seen = new Set<string>();
  for (let seed = 0; seed < 40 && seen.size < 6; seed++) {
    await page.getByLabel('Character', { exact: true }).fill(`Flow ${seed}`);
    const shape = await page.locator('[data-style="lava"][data-state="busy"] .blob').getAttribute('data-shape');
    if (!shape || seen.has(shape)) continue;
    seen.add(shape);
    const samples = await page.locator('[data-style="lava"]').evaluateAll(rows => rows
      .filter(row => ['busy', 'thinking', 'input', 'question'].includes((row as HTMLElement).dataset.state!))
      .map(row => {
        const blob = row.querySelector('.blob')!;
        const svg = blob.querySelector('svg')!;
        const badge = blob.querySelector('.blob-badge');
        const badgeBefore = badge?.getBoundingClientRect();
        const parts = [...blob.querySelectorAll<SVGElement>('*')]
          .filter(node => getComputedStyle(node).animationName !== 'none')
          .map(node => ({ node, delay: parseFloat(getComputedStyle(node).animationDelay) }));
        const frames = [];
        // Independent clocks must be sampled over several cycles, not at one convenient pose.
        for (let time = 0; time <= 24; time += .5) {
          for (const { node, delay } of parts) {
            const elapsed = node.getAnimations()[0]?.currentTime;
            node.style.animationDelay = `${delay - time + (typeof elapsed === 'number' ? elapsed / 1000 : 0)}s`;
          }
          const bodies = [...blob.querySelectorAll<SVGCircleElement>('.blob-lava-rise > .blob-lava-core > circle, .blob-lava-rise > circle')].map(circle => {
            const matrix = svg.getScreenCTM()!.inverse().multiply(circle.getScreenCTM()!);
            const centre = new DOMPoint(circle.cx.baseVal.value, circle.cy.baseVal.value).matrixTransform(matrix);
            const radius = circle.r.baseVal.value;
            return { x: centre.x, y: centre.y, rx: radius * Math.hypot(matrix.a, matrix.c), ry: radius * Math.hypot(matrix.b, matrix.d) };
          });
          const bud = bodies.at(-1)!;
          const clearance = Math.min(...bodies.slice(0, -1).map(body => Math.hypot(body.x - bud.x, body.y - bud.y) - Math.max(body.rx, body.ry) - Math.max(bud.rx, bud.ry)));
          frames.push({ clearance, extent: Math.max(...bodies.map(body => Math.max(50 - body.x + body.rx, body.x + body.rx - 50, 50 - body.y + body.ry, body.y + body.ry - 50))) });
        }
        const badgeAfter = badge?.getBoundingClientRect();
        return {
          mood: (row as HTMLElement).dataset.state,
          minimumGap: Math.min(...frames.map(frame => frame.clearance)),
          maximumGap: Math.max(...frames.map(frame => frame.clearance)),
          maximumExtent: Math.max(...frames.map(frame => frame.extent)),
          badgeStill: !badgeBefore || (badgeBefore.x === badgeAfter!.x && badgeBefore.y === badgeAfter!.y),
        };
      }));
    for (const sample of samples) {
      const context = `${shape}: ${sample.mood}`;
      expect(sample.minimumGap, context).toBeLessThan(-2);
      // Clear the filter's bridging distance; a stretched neck alone is not separation.
      expect(sample.maximumGap, context).toBeGreaterThan(3.6 * 1.6);
      // The filter extends 64 units from centre; leave room for its softened edge.
      expect(sample.maximumExtent, context).toBeLessThan(60);
      expect(sample.badgeStill, context).toBe(true);
    }
  }
  expect(seen.size).toBe(6);
  for (const mood of ['idle', 'unread', 'unknown', 'error']) {
    expect(await page.locator(`[data-style="lava"][data-state="${mood}"] .blob`).evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('[data-style="lava"] .blob').evaluateAll(nodes => nodes.flatMap(node => node.getAnimations({ subtree: true })).length)).toBe(0);
  for (const mood of ['input', 'question']) await expect(page.locator(`[data-style="lava"][data-state="${mood}"] .blob-badge`)).toBeVisible();
});
