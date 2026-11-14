import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MosaicBlob from '../src/blob/MosaicBlob';
import { FACES } from '../src/blob/mosaicFaces';
import { MOSAIC_ACCESSORIES } from '../src/blob/mosaicAccessories';
import { MOSAIC_SHAPES, mosaicGeometry } from '../src/blob/mosaic';
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

test('retained face identities never render accessories or replace saved/automatic geometry', () => {
  for (const face of FACES) for (const shapeName of [undefined, ...MOSAIC_SHAPES.map(shape => shape.name)]) {
    const identity = { ...seedIdentity('pinned-' + face.id), faceId: face.id, shapeName };
    const plain = { ...identity, faceId: undefined };
    for (const mood of moods) {
      const html = renderToStaticMarkup(<MosaicBlob seed="old-face" identity={identity} size={55} mood={mood} />);
      expect(html).toEqual(renderToStaticMarkup(<MosaicBlob seed="old-face" identity={plain} size={55} mood={mood} />));
      expect(html).toContain('data-shape="' + mosaicGeometry(identity).name + '"');
      expect(html).not.toContain('data-face');
    }
  }
}, 15_000);
