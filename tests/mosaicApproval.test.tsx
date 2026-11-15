import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import MosaicBlob from '../src/blob/MosaicBlob';
import { MOSAIC_SHAPES, mosaicField, mosaicGeometry } from '../src/blob/mosaic';
import { hashString, mulberry32, seedIdentity, resolveAvatarIdentity } from '../src/blob/seed';
import { allocateAvatar, identityShape } from '../src/blob/allocateIdentity';
import { parseAvatarAssignments, parseAvatarOverrides } from '../electron/transport';
import { galleryExamples } from '../src/dev/blobGalleryExamples';
import { loadBlobComponent } from '../src/blob/dockIcon';
import approvedRows from './fixtures/mosaicApprovedRows.json';

const originalNames = ['tuft', 'sprig', 'pebble', 'crown', 'ribbon', 'sail'];
const moods = ['idle', 'busy', 'thinking', 'input', 'question', 'error', 'unread', 'unknown'] as const;

test('approved masks retain every coordinate, including split tips, empty rows and Star centre', () => {
  expect(MOSAIC_SHAPES.slice(0, 6).map(shape => shape.name)).toEqual(originalNames);
  expect(MOSAIC_SHAPES.slice(6).map(shape => shape.name).sort()).toEqual(Object.keys(approvedRows).sort());
  for (const [shapeName, rows] of Object.entries(approvedRows)) {
    const orientations = new Set<boolean>();
    for (let i = 0; i < 16; i++) {
      const geometry = mosaicGeometry({ ...seedIdentity('approval-' + i), shapeName });
      orientations.add(geometry.mirrored);
      const coordinates = geometry.cells.map(({ x, y }) => [geometry.mirrored ? 11 - x : x, y]);
      expect(coordinates).toEqual(rows.flatMap((row, y) => Array.from(row).flatMap((ink, x) => ink === '#' ? [[x, y + 1]] : [])));
    }
    expect(orientations.size).toBe(2);
  }
  const star = mosaicGeometry({ ...seedIdentity('star'), shapeName: 'star' });
  expect(star.eyes).toEqual([{ x: 3, y: 6 }, { x: 6, y: 6 }]);
  expect(star.errorEyes).toEqual([{ x: 2, y: 5 }, { x: 6, y: 5 }]);
});

test('Candidate A exact coordinate pigments (not broad field or 50% midpoint)', () => {
  const cells = [{ x: 0, y: 1 }, { x: 5, y: 6 }, { x: 11, y: 12 }, { x: 2, y: 7 }, { x: 9, y: 3 }];
  expect(mosaicField('#15a5ba', cells, 'approved', ['#d9d9d5', '#d0d0cb', '#e5e5e3']).colors)
    .toEqual(['#41b793', '#15a8b9', '#4f80bb', '#129ea1', '#2eb2cf']);
  expect(mosaicField('#15a5ba', cells, 'approved', ['#222222', '#333333', '#111111']).colors)
    .toEqual(['#4ec19d', '#15a8b9', '#4f80bb', '#129ea1', '#3dbcd9']);
});

test('old automatic and persisted allocation seeds keep their original six-way shape draw', () => {
  for (let i = 0; i < 200; i++) for (const shapeSeed of ['old-chat-' + i, 'allocated:local::old:' + i]) {
    const identity = { ...seedIdentity('old'), shapeSeed };
    const rng = mulberry32(hashString('mosaic:' + shapeSeed));
    const name = originalNames[Math.floor(rng() * 6)];
    const mirrored = rng() > .5;
    rng(); // Historical diagonal draw, followed by gaze.
    const lookRight = rng() > .5;
    expect(mosaicGeometry(identity)).toMatchObject({ name, mirrored, lookRight });
    expect(identityShape('mosaic', identity)).toBe(name);
  }
});

test('new allocations cover all twelve shapes and survive storage without changing palette semantics', () => {
  const active = [];
  for (let i = 0; i < 12; i++) {
    const assignment = allocateAvatar('new-' + i, active, 'mosaic');
    expect(assignment.shapeSeed).toStartWith('allocated:mosaic-v2:');
    const saved = parseAvatarAssignments(JSON.parse(JSON.stringify({ chat: assignment }))).chat;
    expect(saved).toEqual(assignment);
    const identity = { ...seedIdentity('new-' + i), ...saved };
    expect(mosaicGeometry(identity).name).toBe(identityShape('mosaic', identity));
    active.push(identity);
  }
  expect(new Set(active.map(identity => mosaicGeometry(identity).name)).size).toBe(12);
});

test('picker, desktop validator, inheritance, gallery and dock SSR accept every new saved silhouette', async () => {
  const DockMosaic = await loadBlobComponent('mosaic');
  for (const shapeName of Object.keys(approvedRows)) {
    const stored = parseAvatarOverrides({ 'directory:local::/work': { color: '#123456', colorIndex: 4 }, 'session:local::chat': { shapeName } });
    const identity = resolveAvatarIdentity({ id: 'chat', instanceId: 'local', directory: '/work' }, [], {}, stored);
    expect(identity).toMatchObject({ shapeName, color: '#123456', colorIndex: 4 });
    expect(renderToStaticMarkup(<DockMosaic seed="dock" identity={identity} interactive={false} size={358.4} />)).toContain('data-shape="' + shapeName + '"');
  }
  const galleryNames = new Set(Array.from({ length: 100 }, (_, i) => galleryExamples('mosaic', 'gallery-' + i)).flat().map(identity => identity.shapeName));
  for (const shape of MOSAIC_SHAPES) expect(galleryNames.has(shape.name)).toBe(true);
});

test('all silhouettes and moods retain exact historical pixel whites, pupils and error Xs at rail and larger sizes', () => {
  for (const shape of MOSAIC_SHAPES) for (const size of [55, 156]) for (const mood of moods) {
    const identity = { ...seedIdentity('pixels'), shapeName: shape.name, faceId: 'horns.1' };
    const geometry = mosaicGeometry(identity);
    const html = renderToStaticMarkup(<MosaicBlob seed="pixels" identity={identity} size={size} mood={mood} />);
    const grid = html.split('data-mosaic-grid')[1].split('</svg>')[0];
    expect(grid).not.toMatch(/<(?:path|circle|ellipse|clipPath)|\b(?:rx|ry|stroke)=/);
    expect(grid).not.toContain('acc:');
    for (const { x, y } of mood === 'error' ? geometry.errorEyes : geometry.eyes) {
      expect(grid).toContain('data-mosaic-eye="true" x="' + x + '" y="' + y + '" width="' + (mood === 'error' ? 3 : 2) + '" height="' + (mood === 'error' ? 3 : 1) + '"');
      if (mood !== 'error') expect(grid).toContain('x="' + (x + (geometry.lookRight ? 1 : 0)) + '" y="' + y + '" width="1" height="1" fill="#14111a"');
    }
    expect(html).not.toMatch(/NaN|undefined/);
  }
});

test('Mosaic reduced motion stops every animated pixel layer without losing decision badges', () => {
  const css = readFileSync(new URL('../src/blob/blob-mosaic.css', import.meta.url), 'utf8');
  const reduced = css.split('@media (prefers-reduced-motion: reduce)')[1];
  for (const layer of ['mosaic-eyes', 'mosaic-pupil', 'mosaic-eye-open', 'mosaic-eye-closed', 'mosaic-thought', 'mosaic-pixel']) expect(reduced).toContain('.' + layer);
  expect(reduced.match(/animation: none !important/g)).toHaveLength(3);
  expect(css).toContain('animation-timing-function: steps(1, end)');
  expect(css).toContain('transform: translateY(-1px)');
  expect(css).not.toMatch(/translateY\(-?0\.\d|translateX\(-?0\.\d/);
});
