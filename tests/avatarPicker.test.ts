import { expect, test } from 'bun:test';
import { ACTIVE_BLOB_STYLES } from '../src/blob/styles';
import { BUDDY_SHAPES } from '../src/blob/buddy';
import { CRYSTAL_SHAPES } from '../src/blob/crystal';
import { MOSAIC_SHAPES } from '../src/blob/mosaic';
import { LAVA_SHAPES } from '../src/blob/lava';

const shapes = { buddy: BUDDY_SHAPES, crystal: CRYSTAL_SHAPES, mosaic: MOSAIC_SHAPES, lava: LAVA_SHAPES };

test('each supported global style has its own named shape catalogue', () => {
  for (const style of ACTIVE_BLOB_STYLES) expect(shapes[style].length).toBeGreaterThan(0);
});
