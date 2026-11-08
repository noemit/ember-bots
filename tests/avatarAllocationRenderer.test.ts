import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { identityShape } from '../src/blob/allocateIdentity';
import { seedIdentity } from '../src/blob/seed';
import BuddyBlob from '../src/blob/BuddyBlob';
import LavaBlob from '../src/blob/LavaBlob';
import { BUDDY_SHAPES } from '../src/blob/buddy';
import { CRYSTAL_SHAPES, crystalForSeeds } from '../src/blob/crystal';
import { mosaicGeometry } from '../src/blob/mosaic';

test('allocation archetypes match independent renderer geometry and actual markup', () => {
  for (let index = 0; index < 40; index++) {
    const identity = seedIdentity(`renderer-parity-${index}`);
    const buddy = BUDDY_SHAPES.find(shape => shape.name === identityShape('buddy', identity))!;
    expect(renderToStaticMarkup(createElement(BuddyBlob, { seed: '', identity }))).toContain(`d="${buddy.path}"`);
    expect(renderToStaticMarkup(createElement(LavaBlob, { seed: '', identity }))).toContain(`data-shape="${identityShape('lava', identity)}"`);
    expect(crystalForSeeds(`crystal:${identity.shapeSeed}`, `crystal:${identity.motionSeed}`).rimCount).toBe(CRYSTAL_SHAPES.find(shape => shape.name === identityShape('crystal', identity))!.sides);
    expect(mosaicGeometry(identity).name).toBe(identityShape('mosaic', identity));
    expect(identityShape('scribble', identity)).toBe(identityShape('buddy', identity));
  }
});
