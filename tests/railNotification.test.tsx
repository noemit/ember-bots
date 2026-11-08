import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Blob from '../src/blob/Blob';
import { MoodBadge, NotificationSizeContext } from '../src/blob/overlays';
import type { BallMood, BlobStyle } from '../src/types';

const styles: BlobStyle[] = ['buddy', 'crystal', 'mosaic', 'lava', 'scribble'];
const badgeTag = (html: string) => html.match(/<g class="blob-badge"[^>]*>/)?.[0] ?? '';

describe('rail notification diameter', () => {
  for (const style of styles) {
    test(`${style} caps unread circles including the outline at all rail avatar sizes`, () => {
      for (const size of [20, 30, 40, 48, 55, 60, 69, 83]) {
        const html = renderToStaticMarkup(<NotificationSizeContext.Provider value={10}>
          <Blob style={style} seed="rail-cap" size={size} mood="unread" />
        </NotificationSizeContext.Provider>);
        const badge = badgeTag(html);
        expect(badge).toContain('data-badge="unread"');
        const scale = Number(badge.match(/scale\(([^)]+)\)/)?.[1] ?? 1);
        expect(size * .35 * scale).toBeLessThanOrEqual(10.000001);
        expect(size * .35 * scale).toBeCloseTo(Math.min(10, size * .35));
        const transform = badge.match(/translate\(([^ ]+) ([^)]+)\) scale\([^)]+\) translate\(([^ ]+) ([^)]+)\)/)!;
        const [anchorX, anchorY, inverseX, inverseY] = transform.slice(1).map(Number);
        const inset = style === 'crystal' || style === 'lava' ? -2 : 0;
        expect(inverseX).toBe(-(78 - inset));
        expect(inverseY).toBe(-(22 + inset));
        const radius = 17.5 * scale;
        expect(anchorX - radius).toBeGreaterThanOrEqual(0);
        expect(anchorX + radius).toBeLessThanOrEqual(100.000001);
        expect(anchorY - radius).toBeGreaterThanOrEqual(-.000001);
        expect(anchorY + radius).toBeLessThanOrEqual(100);
        expect(anchorX).toBeGreaterThan(78 - inset);
        expect(anchorY).toBeLessThan(22 + inset);
        if (size >= 55) {
          expect(anchorX).toBe(88 - inset);
          expect(anchorY).toBe(12 + inset);
        }
      }
    });
  }

  test('unread notifications outside the rail keep their existing geometry', () => {
    const html = renderToStaticMarkup(<MoodBadge mood="unread" size={83} />);
    expect(badgeTag(html)).not.toContain('transform=');
    expect(html).toContain('r="16"');
    expect(html).toContain('cx="78" cy="22"');
  });

  test('rail question, permission and warning badges retain their symbols and size', () => {
    for (const mood of ['question', 'input', 'error'] as BallMood[]) for (const inset of [0, -2, -4]) {
      const original = renderToStaticMarkup(<MoodBadge mood={mood} size={83} inset={inset} />);
      const capped = renderToStaticMarkup(<NotificationSizeContext.Provider value={10}>
        <MoodBadge mood={mood} size={83} inset={inset} />
      </NotificationSizeContext.Provider>);
      expect(capped).toBe(original);
      expect(badgeTag(capped)).not.toContain('transform=');
    }
  });
});
