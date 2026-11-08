import { expect, test } from '@playwright/test';

test.use({ video: { mode: 'on', size: { width: 1200, height: 800 } }, viewport: { width: 1200, height: 800 } });
const moods = ['busy', 'thinking', 'idle', 'input', 'question', 'error'];

test('Buddy preserves the visible pose across every mood pair and rapid reversals', async ({ page }, testInfo) => {
  await page.goto('/buddy-motion.html');
  const measurements: { from: string; to: string; jump: number }[] = [];
  for (const from of moods) for (const to of moods.filter(mood => mood !== from)) {
    await page.getByRole('button', { name: from, exact: true }).click();
    await page.waitForTimeout(320);
    const jump = await page.evaluate(({ from, to }) => {
      // Include the otherwise rare middle of a somersault, and the top of a hop.
      for (const blob of document.querySelectorAll('.blob-buddy')) {
        for (const animation of blob.getAnimations({ subtree: true })) {
          if (animation instanceof CSSAnimation) {
            const timing = animation.effect!.getTiming();
            const duration = Number(timing.duration);
            animation.currentTime = Number(timing.delay) + duration * (animation.animationName === 'blob-flip' ? .90 : .46);
          }
        }
      }
      const pose = () => [...document.querySelectorAll<SVGGraphicsElement>('.blob-body, .blob-eyes')].flatMap(node => {
        const matrix = node.getScreenCTM()!;
        return [[20, 20], [80, 20], [20, 80], [80, 80]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
      });
      const before = pose();
      (document.querySelector(`button[aria-pressed="false"]`) as HTMLElement)?.blur();
      [...document.querySelectorAll('button')].find(button => button.textContent === to)!.click();
      const after = pose();
      if (document.querySelector('[data-current-mood]')?.textContent !== to) throw new Error(`Mood did not change from ${from}`);
      return Math.max(...before.map((point, index) => Math.hypot(point.x - after[index].x, point.y - after[index].y)));
    }, { from, to });
    measurements.push({ from, to, jump });
    expect(jump, `${from} → ${to}: first-frame corner displacement`).toBeLessThan(0.5);
    await expect(page.locator('.blob-buddy').first().locator('.blob-overlay')).toHaveCount(1);
  }
  // Interrupt the finite bridge itself rather than letting each handoff finish.
  for (const mood of ['busy', 'thinking', 'question', 'busy', 'idle']) {
    const jump = await page.evaluate(mood => {
      const body = document.querySelector<SVGGraphicsElement>('.blob-body')!;
      const point = () => new DOMPoint(80, 80).matrixTransform(body.getScreenCTM()!);
      const before = point();
      [...document.querySelectorAll('button')].find(button => button.textContent === mood)!.click();
      const after = point();
      return Math.hypot(before.x - after.x, before.y - after.y);
    }, mood);
    expect(jump, 'interrupted handoff preserves its current pose').toBeLessThan(.5);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(320);
  expect(await page.locator('.blob-buddy').evaluateAll(nodes => nodes.every(node => node.getAnimations({ subtree: true }).length === 0))).toBe(true);
  await testInfo.attach('first-frame-displacement.json', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
});

test('Buddy preserves nearby gaze, anchors badges, and settles without hidden or reduced-motion work', async ({ page }) => {
  await page.goto('/buddy-motion.html');
  const blob = page.locator('.blob-buddy').first();
  const box = (await blob.boundingBox())!;
  await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2);
  await expect(blob).toHaveAttribute('data-pupil-tracking', 'true');
  const pupil = blob.locator('.blob-pupil').first();
  const gaze = await pupil.getAttribute('transform');
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'thinking')!.click());
  await expect(pupil).toHaveAttribute('transform', gaze!);
  await expect(blob).toHaveAttribute('data-pupil-tracking', 'true');
  // Pointer takeover during a fresh thinking bridge cancels only the autonomous gaze correction.
  await page.mouse.move(1190, 790);
  await page.getByRole('button', { name: 'idle', exact: true }).click();
  await page.waitForTimeout(320);
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'thinking')!.click());
  await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2);
  await expect(blob).toHaveAttribute('data-pupil-tracking', 'true');
  await expect.poll(() => blob.locator('.buddy-gaze').evaluateAll(nodes => nodes.every(node => node.getAnimations().length === 0))).toBe(true);
  await page.getByRole('button', { name: 'question', exact: true }).click();
  const overlay = blob.locator('.blob-overlay');
  const before = await overlay.boundingBox();
  await page.waitForTimeout(400);
  expect(await overlay.boundingBox()).toEqual(before);
  await page.getByRole('button', { name: 'busy', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => blob.evaluate(node => node.getAnimations({ subtree: true }).every(animation => animation.playState === 'paused'))).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const mood of moods) {
    await page.getByRole('button', { name: mood, exact: true }).click();
    await expect.poll(() => blob.evaluate(node => node.getAnimations({ subtree: true }).length), { message: mood }).toBe(0);
  }
});
