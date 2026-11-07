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
      // Thinking raises the eyes by one whole cell; both rows must stay inside the body.
      for (const y of [chosen.eyeY, chosen.eyeY - 1]) for (const x of [3, 4, 6, 7]) {
        expect(chosen.cells.some(cell => cell.x === x && cell.y === y)).toBe(true);
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
  expect(renderToStaticMarkup(<Blob style="mosaic" seed="chat" mood="unread" />)).toContain('bg-highlight');
  expect(renderToStaticMarkup(<Blob style="mosaic" seed="chat" mood="thinking" />)).toContain('mosaic-thought');
});

test('Mosaic replaces both pupils with crosses when a turn fails', () => {
  const failed = renderToStaticMarkup(<Blob style="mosaic" seed="chat" mood="error" />);
  expect(failed.match(/class="mosaic-error-eye"/g)).toHaveLength(2);
  expect(renderToStaticMarkup(<Blob style="mosaic" seed="chat" mood="idle" />)).not.toContain('mosaic-error-eye');
});
