import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Blob from '../src/blob/Blob';
import { SCRIBBLE_SHAPES, scribbleGeometry } from '../src/blob/scribble';
import { seedIdentity } from '../src/blob/seed';
import { blobColor } from '../src/blob/color';
import { contrastRatio } from '../src/blob/contrast';

test('Scribble keeps a stable, bounded drawing with distinct silhouettes', () => {
  const signatures = new Set<string>();
  for (const shape of SCRIBBLE_SHAPES) {
    for (let i = 0; i < 10; i++) {
      const identity = { ...seedIdentity(`chat-${i}`), shapeName: shape.name };
      const art = scribbleGeometry(identity);
      expect(scribbleGeometry(identity)).toEqual(art);
      expect(art.name).toBe(shape.name);
      expect(art.strokes.length).toBeLessThanOrEqual(130);
      expect(new Set(art.strokes.map(stroke => stroke.tip))).toEqual(new Set(['sharp', 'round', 'bent']));
      for (const stroke of art.strokes) {
        const coordinates = stroke.path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
        expect(coordinates.every(n => Number.isFinite(n) && n >= 0 && n <= 100)).toBe(true);
      }
      signatures.add(art.core + art.strokes[0].path);
    }
  }
  expect(signatures.size).toBe(60);
});

test('pale and dark custom colours keep the same clearly outlined eyes', () => {
  expect(contrastRatio('#fffdf5', '#29212f')).toBeGreaterThan(10);
  for (const color of ['#fff4c2', '#111111', '#f8cddd', '#158bb2']) {
    const identity = { ...seedIdentity('chat'), color };
    const html = renderToStaticMarkup(<Blob style="scribble" seed="chat" identity={identity} />);
    expect(blobColor('scribble', identity)).toBe(color);
    expect(html).toContain(`fill="${color}"`);
    expect(html.match(/data-scribble-eye/g)).toHaveLength(2);
    expect(html.match(/stroke="#29212f"/g)).toHaveLength(2);
    expect(html).not.toContain('<filter');
  }
});

test('Scribble keeps decisions and unread indicators while thinking belongs to the creature', () => {
  for (const mood of ['input', 'question', 'error'] as const) {
    expect(renderToStaticMarkup(<Blob style="scribble" seed="chat" mood={mood} />)).toContain('blob-badge');
  }
  expect(renderToStaticMarkup(<Blob style="scribble" seed="chat" mood="thinking" />)).not.toContain('blob-arc');
  expect(renderToStaticMarkup(<Blob style="scribble" seed="chat" mood="unread" />)).toContain('bg-highlight');
});


test('the raised hand belongs only to a question', () => {
  for (const mood of ['idle', 'busy', 'thinking', 'input', 'question', 'error', 'unread', 'unknown'] as const) {
    const html = renderToStaticMarkup(<Blob style="scribble" seed="chat" mood={mood} />);
    expect(html.includes('class="scribble-wave"')).toBe(mood === 'question');
  }
});
