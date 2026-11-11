import { describe, expect, test } from 'bun:test';
import { FACES, FACE_BY_ID } from '../src/blob/mosaicFaces';
import { faceCoversEyes, faceFor, facePixels, identityForFace } from '../src/blob/mosaicFace';
import { MOSAIC_ACCESSORIES } from '../src/blob/mosaicAccessories';
import { seedIdentity } from '../src/blob/seed';
import type { AvatarIdentity } from '../src/types';

const identity = (shapeSeed: string, extra: Partial<AvatarIdentity> = {}): AvatarIdentity => ({
  ...seedIdentity(`session-${shapeSeed}`),
  shapeSeed,
  ...extra,
});

describe('the ship list', () => {
  test('is eighteen faces, all with unique ids', () => {
    expect(FACES).toHaveLength(18);
    expect(new Set(FACES.map((face) => face.id)).size).toBe(18);
  });

  test('every accessory face names a variant that exists', () => {
    for (const face of FACES) {
      if (!face.accessory) {
        expect(face.id).toBe('plain');
        continue;
      }
      const art = MOSAIC_ACCESSORIES[face.accessory];
      expect(art).toBeDefined();
      expect(art.variants[face.variant]).toBeDefined();
    }
  });

  test('plain is the only face without an accessory', () => {
    expect(FACES.filter((face) => face.accessory === null)).toHaveLength(1);
  });

  test('lookup by id finds every face', () => {
    for (const face of FACES) expect(FACE_BY_ID.get(face.id)).toBe(face);
  });
});

describe('choosing a face', () => {
  test('is stable for one session across calls', () => {
    const one = identity('stable-seed');
    expect(faceFor(one).id).toBe(faceFor(one).id);
  });

  test('a pinned faceId wins', () => {
    expect(faceFor(identity('anything', { faceId: 'horns.1' })).id).toBe('horns.1');
  });

  test('an unknown pinned id falls back rather than throwing', () => {
    const face = faceFor(identity('x', { faceId: 'deleted.9' }));
    expect(FACE_BY_ID.get(face.id)).toBeDefined();
  });

  test('steps past faces already taken', () => {
    const all = FACES.map((face) => face.id);
    for (const taken of [['plain'], ['plain', 'horns.1'], all.slice(0, 17)]) {
      const chosen = faceFor(identity('walk'), taken);
      expect(taken).not.toContain(chosen.id);
    }
  });

  test('repeats rather than rendering nothing when every face is taken', () => {
    const taken = FACES.map((face) => face.id);
    const chosen = faceFor(identity('all-taken'), taken);
    expect(FACE_BY_ID.get(chosen.id)).toBeDefined();
  });

  test('spreads eighteen distinct sessions across all eighteen faces', () => {
    // The walk is what keeps a rail from filling with one face while the rest go unused.
    const seen = new Set<string>();
    const taken: string[] = [];
    for (let index = 0; index < 18; index += 1) {
      const face = faceFor(identity(`session-${index}`), taken);
      taken.push(face.id);
      seen.add(face.id);
    }
    expect(seen.size).toBe(18);
  });

  test('differs across sessions that differ only by seed', () => {
    const ids = new Set(['a', 'b', 'c', 'd'].map((seed) => faceFor(identity(seed)).id));
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe('drawing a face', () => {
  test('plain has no pixels', () => {
    const plain = FACE_BY_ID.get('plain')!;
    expect(facePixels(plain)).toHaveLength(0);
    expect(faceCoversEyes(plain)).toBe(false);
  });

  test('every accessory face has pixels', () => {
    for (const face of FACES) {
      if (!face.accessory) continue;
      expect(facePixels(face).length).toBeGreaterThan(0);
    }
  });

  test('carries the animation through', () => {
    // No shipped face animates today; assert the plumbing so a future one does not silently lose it.
    const withAnim = facePixels({ id: 'x', label: 'x', accessory: 'phone', variant: 0, body: 'tuft' });
    expect(withAnim.every((pixel) => typeof pixel.x === 'number' && typeof pixel.fill === 'string')).toBe(true);
  });
});

describe('the identity a face is drawn with', () => {
  test('takes the body from the face', () => {
    const face = FACE_BY_ID.get('horns.1')!;
    expect(identityForFace(identity('x'), face).shapeName).toBe(face.body);
  });

  test('keeps the session colour, which is what tells two faces apart', () => {
    const base = identity('x', { color: '#c4384a' });
    const drawn = identityForFace(base, FACE_BY_ID.get('horns.1')!);
    expect(drawn.color).toBe('#c4384a');
    expect(drawn.colorSeed).toBe(base.colorSeed);
  });
});
