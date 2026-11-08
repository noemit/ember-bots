import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Blob from '../src/blob/Blob';

/**
 * The blob layers, pinned. Buddy's hop/flip wrappers are DOM elements so a transform on them can be
 * composited (Chromium will not composite an SVG child), which means the things that must *not* move
 * with the body — the mood badges — have to live in their own overlay layer.
 */
const layers = (html: string) => {
  const hopStart = html.indexOf('blob-hop');
  const overlayStart = html.indexOf('blob-overlay');
  expect(hopStart).toBeGreaterThan(-1);
  expect(overlayStart).toBeGreaterThan(hopStart);
  return { moving: html.slice(hopStart, overlayStart), overlay: html.slice(overlayStart) };
};

describe('blob layers', () => {
  test('thinking belongs to each creature, without the generic loading ring', () => {
    for (const style of ['buddy', 'scribble', 'mosaic', 'lava', 'crystal'] as const) {
      expect(renderToStaticMarkup(<Blob style={style} seed="seed" mood="thinking" />)).not.toContain('blob-arc');
    }
  });

  test('mood badges stay out of the moving wrappers too', () => {
    for (const mood of ['input', 'question', 'error'] as const) {
      const { moving, overlay } = layers(renderToStaticMarkup(<Blob style="buddy" seed="seed" mood={mood} />));
      expect(moving).not.toContain('blob-badge');
      expect(overlay).toContain('blob-badge');
    }
  });

  test('working and thinking Crystal render reflections without any heat filter or halo', () => {
    for (const mood of ['busy', 'thinking'] as const) {
      const html = renderToStaticMarkup(<Blob style="crystal" seed="seed" mood={mood} />);
      expect(html).toContain('crystal-reflection-sweep');
      expect(html).toContain('crystal-sparkle');
      expect(html).not.toContain('blob-heat');
      expect(html).not.toContain('<filter');
      expect(html).not.toContain('feGaussianBlur');
    }
    const idle = renderToStaticMarkup(<Blob style="crystal" seed="seed" mood="idle" />);
    expect(idle).not.toContain('crystal-working-light');
    expect(idle).not.toContain('crystal-sparkle');
  });
  test('crystal keeps attention heat under the body and its badge over it', () => {
    const html = renderToStaticMarkup(<Blob style="crystal" seed="seed" mood="question" />);
    expect(html).toContain('blob-heat');
    expect(html.indexOf('blob-heat')).toBeLessThan(html.indexOf('blob-body'));
  });

  test('unread and question circles share their size and position for every style', () => {
    for (const style of ['buddy', 'scribble', 'mosaic', 'lava', 'crystal'] as const) {
      const render = (mood: 'unread' | 'question' | 'input') =>
        renderToStaticMarkup(<Blob style={style} seed="seed" mood={mood} />);
      const circle = (html: string) => /data-badge="[^"]+"><circle ([^>]+)>/.exec(html)?.[1];
      const geometry = (html: string) => circle(html)?.match(/(?:cx|cy|r|stroke-width)="[^"]+"/g);
      expect(geometry(render('unread'))).toBeDefined();
      expect(geometry(render('unread'))).toEqual(geometry(render('question')));
      expect(geometry(render('input'))).toEqual(geometry(render('question')));
      expect(circle(render('unread'))).toContain('fill="var(--highlight)"');
      expect(circle(render('question'))).toContain('fill="var(--attention)"');
      expect(circle(render('input'))).toContain('fill="var(--attention)"');
    }
  });
});


test('only Crystal carries an orbit ring when asking the human', () => {
  for (const style of ['buddy', 'scribble', 'mosaic', 'lava', 'crystal'] as const) {
    for (const mood of ['input', 'question'] as const) {
      const html = renderToStaticMarkup(<Blob style={style} seed="seed" mood={mood} />);
      expect(html.includes('blob-orbit')).toBe(style === 'crystal');
      expect(html).toContain('blob-badge');
    }
  }
});
