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
      }
    });
  }

  test('unread notifications outside the rail keep their existing geometry', () => {
    const html = renderToStaticMarkup(<MoodBadge mood="unread" size={83} />);
    expect(badgeTag(html)).not.toContain('transform=');
    expect(html).toContain('r="16"');
  });

  test('rail question, permission and warning badges retain their symbols and size', () => {
    for (const mood of ['question', 'input', 'error'] as BallMood[]) {
      const original = renderToStaticMarkup(<MoodBadge mood={mood} size={83} />);
      const capped = renderToStaticMarkup(<NotificationSizeContext.Provider value={10}>
        <MoodBadge mood={mood} size={83} />
      </NotificationSizeContext.Provider>);
      expect(capped).toBe(original);
      expect(badgeTag(capped)).not.toContain('transform=');
    }
  });
});
