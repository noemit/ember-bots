import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MosaicBlob from '../src/blob/MosaicBlob';
import { FACES } from '../src/blob/mosaicFaces';
import { MOSAIC_ACCESSORIES } from '../src/blob/mosaicAccessories';
import { faceFor, facePixels, identityForFace } from '../src/blob/mosaicFace';
import { MOSAIC_SHAPES, mosaicActivityPixels, mosaicGeometry } from '../src/blob/mosaic';
import { seedIdentity } from '../src/blob/seed';
import type { BallMood } from '../src/types';

const moods: BallMood[] = ['idle', 'busy', 'thinking', 'error', 'unknown', 'question', 'input', 'unread'];

const yellowFlowerPixels = [
  [8,1,'#d97a2b'], [7,2,'#c4384a'], [8,2,'#e8c35a'], [9,2,'#c4384a'],
  [6,3,'#d97a2b'], [7,3,'#e8c35a'], [8,3,'#733c0c'], [9,3,'#e8c35a'],
  [10,3,'#d97a2b'], [7,4,'#c4384a'], [8,4,'#e8c35a'], [9,4,'#c4384a'],
  [8,5,'#d97a2b'],
] as const;

const scientistPixels = [
  [2,5,'#2f9fc4'], [3,5,'#2f9fc4'], [4,5,'#2f9fc4'], [5,5,'#2f9fc4'],
  [6,5,'#2f9fc4'], [7,5,'#2f9fc4'], [8,5,'#2f9fc4'], [2,6,'#2f9fc4'],
  [3,6,'#2f9fc4'], [4,6,'#2f9fc4'], [5,6,'#2f9fc4'], [6,6,'#2f9fc4'],
  [7,6,'#2f9fc4'], [8,6,'#2f9fc4'], [9,6,'#2f9fc4'], [10,6,'#2f9fc4'],
  [2,7,'#2f9fc4'], [3,7,'#2f9fc4'], [4,7,'#2f9fc4'], [5,7,'#2f9fc4'],
  [6,7,'#2f9fc4'], [7,7,'#2f9fc4'], [8,7,'#2f9fc4'], [1,9,'#2f9fc4'],
  [1,10,'#2f9fc4'], [1,11,'#3f8f4a'], [1,12,'#3f8f4a'],
] as const;

test('yellow flower and scientist production art retain the exact requested pixel data', () => {
  const yellowFace = FACES.filter(face => face.label === 'Flower, yellow');
  expect(yellowFace).toHaveLength(1);
  expect(yellowFace[0]).toMatchObject({ id: 'flower.3', accessory: 'flower', variant: 2 });
  expect(MOSAIC_ACCESSORIES.flower.variants[2]).toEqual({ coversEyes: false, pixels: yellowFlowerPixels });

  const scientistFace = FACES.filter(face => face.label === 'Scientist');
  expect(scientistFace).toHaveLength(1);
  expect(scientistFace[0]).toMatchObject({ id: 'scientist.1', accessory: 'scientist', variant: 0 });
  expect(MOSAIC_ACCESSORIES.scientist.variants[0]).toEqual({ coversEyes: false, pixels: scientistPixels });
});

test('all eighteen production faces are reached by stable chat identities, independent of allocator seeds', () => {
  expect(FACES).toHaveLength(18);
  expect(new Set(FACES.map(face => face.id)).size).toBe(18);
  const reached = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const identity = seedIdentity('face-chat-' + i);
    const face = faceFor(identity);
    reached.add(face.id);
    expect(faceFor({ ...identity, shapeSeed: 'changed-allocator', projectKey: 'another-project' })).toEqual(face);
    expect(faceFor({ ...identity })).toEqual(face);
    const automatic = { ...identity, shapeName: 'automatic' };
    expect(faceFor(automatic)).toEqual(face);
    expect(identityForFace(automatic, face).shapeName).toBe(face.body);
  }
  expect([...reached].sort()).toEqual(FACES.map(face => face.id).sort());
});

test('explicit saved shapes win even over an incompatible pinned face; compatible accessories fit their original body', () => {
  for (const shape of MOSAIC_SHAPES) for (const pinned of FACES) {
    const identity = { ...seedIdentity('explicit'), shapeName: shape.name, faceId: pinned.id, color: '#123456', colorIndex: 4 };
    const face = faceFor(identity);
    const resolved = identityForFace(identity, face);
    expect(resolved.shapeName).toBe(shape.name);
    expect(face.body).toBe(shape.name);
    expect(resolved.color).toBe(identity.color);
    expect(resolved.colorIndex).toBe(identity.colorIndex);
    expect(resolved.motionSeed).toBe(identity.motionSeed);
    expect(identityForFace(identity, pinned).shapeName).toBe(shape.name);
    const html = renderToStaticMarkup(<MosaicBlob seed="explicit" identity={identity} />);
    expect(html).toContain('data-shape="' + shape.name + '"');
  }
  const identity = { ...seedIdentity('legacy'), shapeName: 'retired-body' };
  expect(facePixels(faceFor(identity))).toEqual([]);
  expect(identityForFace(identity, FACES[0]).shapeName).toBe('retired-body');
});

test('all production faces render at recognition sizes and in every mood without changing identity', () => {
  for (const face of FACES) for (const size of [24, 30, 44, 55, 69, 83]) for (const mood of moods) {
    const identity = { ...seedIdentity('pinned-' + face.id), faceId: face.id };
    const html = renderToStaticMarkup(<MosaicBlob seed={identity.sessionKey} identity={identity} size={size} mood={mood} />);
    expect(html).toContain('data-face="' + face.id + '"');
    expect(html).toContain('data-shape="' + face.body + '"');
    expect(html).toContain('data-mood="' + mood + '"');
    expect(html).not.toMatch(/NaN|undefined/);
    for (const pixel of facePixels(face)) expect(html).toContain('fill="' + pixel.fill + '"');
  }
}, 15_000);

test('horns shift body, normal eyes, error eyes and busy pixels together, but not the accessory', () => {
  const face = FACES.find(face => face.id === 'horns.1')!;
  const identity = { ...seedIdentity('shift'), faceId: face.id };
  const geometry = mosaicGeometry(identityForFace(identity, face));
  const render = (mood: BallMood) => renderToStaticMarkup(<MosaicBlob seed="shift" identity={identity} mood={mood} />);
  const idle = render('idle');
  for (const cell of geometry.cells) expect(idle).toContain('x="' + cell.x + '" y="' + (cell.y + 1) + '" width="1"');
  for (const eye of geometry.eyes) expect(idle).toContain('data-mosaic-eye="true" x="' + eye.x + '" y="' + (eye.y + 1) + '"');
  const error = render('error');
  for (const eye of geometry.errorEyes) expect(error).toContain('data-mosaic-eye="true" x="' + eye.x + '" y="' + (eye.y + 1) + '"');
  const busy = render('busy');
  const activity = [...busy.matchAll(/class="mosaic-pixel"[^>]* x="([^"]+)" y="([^"]+)"/g)].map(match => [Number(match[1]), Number(match[2])]);
  expect(activity).toEqual(mosaicActivityPixels(geometry.cells).map(pixel => [pixel.x, pixel.y + 1]));
  expect(idle).toContain('x="0" y="0" width="1" height="1" fill="#6d071d"');
});
