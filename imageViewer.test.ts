import { describe, expect, test } from 'bun:test';

/**
 * The image viewer's percentage has to mean one thing at every window size: `scale * fitScale`,
 * where `fitScale` is the ratio between the fitted box and the image's natural pixels. The old
 * viewer showed `scale` alone, so "100%" was really "fitted to this window" and the same number
 * meant different sizes on different screens.
 */
const actualPercent = (
  scale: number,
  natural: { w: number; h: number },
  box: { w: number; h: number }
): number => {
  const fitScale = Math.min(box.w / natural.w, box.h / natural.h, 1);
  return Math.round(scale * fitScale * 100);
};

/** The `scale` that shows the image at 1:1, i.e. one image pixel per screen pixel. */
const scaleForActual = (natural: { w: number; h: number }, box: { w: number; h: number }): number => {
  const fitScale = Math.min(box.w / natural.w, box.h / natural.h, 1);
  return 1 / (fitScale || 1);
};

describe('image viewer scale', () => {
  const big = { w: 2400, h: 1600 };

  test('a large image is shrunk to fit, so 100% of the fitted box is not actual size', () => {
    const box = { w: 1200, h: 800 };
    // fitScale = 0.5, so the fitted view is half size.
    expect(actualPercent(1, big, box)).toBe(50);
    expect(scaleForActual(big, box)).toBe(2);
  });

  test('the percentage does not depend on the window once you are at actual size', () => {
    for (const box of [
      { w: 1200, h: 800 },
      { w: 900, h: 600 },
      { w: 1600, h: 1000 },
    ]) {
      expect(actualPercent(scaleForActual(big, box), big, box)).toBe(100);
    }
  });

  test('a small image is never upscaled to fit, so it opens at 100%', () => {
    const small = { w: 300, h: 200 };
    const box = { w: 1200, h: 800 };
    expect(actualPercent(1, small, box)).toBe(100);
    expect(scaleForActual(small, box)).toBe(1);
  });

  test('fit always reads as the fitted percentage, which may be well under 100', () => {
    const box = { w: 600, h: 400 };
    expect(actualPercent(1, big, box)).toBe(25);
  });

  test('a zero-size box or image does not divide by zero', () => {
    expect(scaleForActual(big, { w: 0, h: 0 })).toBe(1);
    expect(Number.isFinite(scaleForActual({ w: 0, h: 0 }, { w: 100, h: 100 }))).toBe(true);
  });
});
