import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Blob from '../src/blob/Blob';

/**
 * The blob layers, pinned. Buddy's hop/flip wrappers are DOM elements so a transform on them can be
 * composited (Chromium will not composite an SVG child), which means the things that must *not* move
 * with the body — the thinking arc and the mood badges — have to live in their own overlay layer.
 */
const layers = (html: string) => {
  const hopStart = html.indexOf('blob-hop');
  const overlayStart = html.indexOf('blob-overlay');
  expect(hopStart).toBeGreaterThan(-1);
  expect(overlayStart).toBeGreaterThan(hopStart);
  return { moving: html.slice(hopStart, overlayStart), overlay: html.slice(overlayStart) };
};

describe('blob layers', () => {
  test('the thinking arc is drawn in the overlay, never inside the moving wrappers', () => {
    const { moving, overlay } = layers(renderToStaticMarkup(<Blob style="buddy" seed="seed" mood="thinking" />));
    expect(overlay).toContain('blob-arc');
    expect(moving).not.toContain('blob-arc');
  });

  test('mood badges stay out of the moving wrappers too', () => {
    for (const mood of ['input', 'question', 'error'] as const) {
      const { moving, overlay } = layers(renderToStaticMarkup(<Blob style="buddy" seed="seed" mood={mood} />));
      expect(moving).not.toContain('blob-badge');
      expect(overlay).toContain('blob-badge');
    }
  });

  test('crystal keeps its heat layer under the body and its badges over it', () => {
    const html = renderToStaticMarkup(<Blob style="crystal" seed="seed" mood="busy" />);
    expect(html.indexOf('blob-heat')).toBeLessThan(html.indexOf('blob-body'));
  });
});
