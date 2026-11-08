import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Blob from '../src/blob/Blob';
import { MOSAIC_SHAPES, mosaicActivityPixels, mosaicGeometry } from '../src/blob/mosaic';
import { seedIdentity } from '../src/blob/seed';
import { blobColor } from '../src/blob/color';
import { BLOB_STYLES, migrateBlobStyle } from '../electron/transport';

test('retired Pip preferences migrate without remaining a selectable style', () => {
  expect(migrateBlobStyle('pip')).toBe('mosaic');
  expect(BLOB_STYLES).not.toContain('pip');
  for (const style of BLOB_STYLES) expect(migrateBlobStyle(style)).toBe(style);
  expect(migrateBlobStyle('missing')).toBeUndefined();
});

test('Mosaic identities are stable, varied, and keep eyes inside every silhouette', () => {
  const signatures = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const identity = seedIdentity(`chat-${i}`);
    const geometry = mosaicGeometry(identity);
    expect(mosaicGeometry(identity)).toEqual(geometry);
    signatures.add(JSON.stringify(geometry));
    for (const shape of MOSAIC_SHAPES) {
      const chosen = mosaicGeometry({ ...identity, shapeName: shape.name });
      expect(chosen.name).toBe(shape.name);
      // Resting eyes, both whole-cell gaze positions, blink, and thinking's raised frame.
      for (const eye of chosen.eyes) for (const dy of [-1, 0]) for (const dx of [0, 1]) {
        expect(chosen.cells.some(cell => cell.x === eye.x + dx && cell.y === eye.y + dy)).toBe(true);
      }
      // Full-size X eyes fit inside the actual body, including its mirrored silhouettes.
      for (const eye of chosen.errorEyes) for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
        expect(chosen.cells.some(cell => cell.x === eye.x + dx && cell.y === eye.y + dy)).toBe(true);
      }
      expect(chosen.cells.length).toBeLessThan(130);
    }
  }
  expect(signatures.size).toBeGreaterThan(20);
});

test('custom colour drives both the pixels and the surrounding identity colour', () => {
  const identity = { ...seedIdentity('chat'), color: '#15a5ba' };
  expect(blobColor('mosaic', identity)).toBe(identity.color);
  const html = renderToStaticMarkup(<Blob style="mosaic" seed="chat" identity={identity} />);
  expect(html).toContain('#15a5ba');
  expect(html).toContain('crispEdges');
  expect(html).not.toContain('<filter');
});

test('working pixels fit the canvas on both sides without replacing the character', () => {
  for (const shape of MOSAIC_SHAPES) for (let i = 0; i < 10; i++) {
    const { cells } = mosaicGeometry({ ...seedIdentity(`pixels-${i}`), shapeName: shape.name });
    const pixels = mosaicActivityPixels(cells);
    expect(new Set(pixels.map(pixel => pixel.side)).size).toBe(2);
    expect(pixels.length).toBeLessThanOrEqual(16);
    expect(new Set(pixels.map(pixel => `${pixel.x}:${pixel.y}`)).size).toBe(pixels.length);
    for (const pixel of pixels) {
      expect(pixel.x * 7 + 8).toBeGreaterThanOrEqual(0);
      expect((pixel.x + 1) * 7 + 8).toBeLessThanOrEqual(100);
      expect(cells.some(cell => cell.x === pixel.x && cell.y === pixel.y)).toBe(false);
    }
  }
});

test('Mosaic preserves explicit unread and decision indicators without relying on motion', () => {
  for (const mood of ['input', 'question', 'error'] as const) {
    expect(renderToStaticMarkup(<Blob style="mosaic" seed="chat" mood={mood} />)).toContain('blob-badge');
  }
  expect(renderToStaticMarkup(<Blob style="mosaic" seed="chat" mood="unread" />)).toContain('data-badge="unread"');
  expect(renderToStaticMarkup(<Blob style="mosaic" seed="chat" mood="thinking" />)).toContain('mosaic-thought');
});

test('Mosaic replaces both pupils with crosses when a turn fails', () => {
  const failed = renderToStaticMarkup(<Blob style="mosaic" seed="chat" mood="error" />);
  const eyes = [...failed.matchAll(/<g class="mosaic-error-eye"[^>]*>(.*?)<\/g>/g)];
  expect(eyes).toHaveLength(2);
  for (const [, eye] of eyes) {
    expect(eye.match(/<rect /g)).toHaveLength(5);
    expect(eye.match(/width="1" height="1"/g)).toHaveLength(5);
    expect(eye).not.toContain('<path');
  }
  expect(renderToStaticMarkup(<Blob style="mosaic" seed="chat" mood="idle" />)).not.toContain('mosaic-error-eye');
});


test('Mosaic eyes and tiles stay on the body pixel grid in every mood', () => {
  for (const mood of ['idle', 'busy', 'thinking', 'input', 'question', 'error', 'unread', 'unknown'] as const) {
    const html = renderToStaticMarkup(<Blob style="mosaic" seed="grid" mood={mood} />);
    const grid = html.split('data-mosaic-grid')[1].split('</svg>')[0];
    expect(grid).toContain('mosaic-eyes');
    expect(grid).not.toMatch(/<(?:path|circle|ellipse)|\b(?:rx|ry|stroke)=/);
    const rects = [...grid.matchAll(/<rect\b([^>]+)>/g)];
    expect(rects.length).toBeGreaterThan(50);
    for (const [, attributes] of rects) for (const field of ['x', 'y', 'width', 'height']) {
      const value = Number(attributes.match(new RegExp(`\\b${field}="([^"\\s]+)"`))?.[1]);
      expect(Number.isInteger(value)).toBe(true);
      if (field === 'width' || field === 'height') expect(value).toBeGreaterThan(0);
    }
  }
});
