import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import PipBlob from './src/blob/PipBlob';
import { PIP_FACES, PIP_ROLL, pipFaceFor, pipFacePlacement } from './src/blob/pip';
import { IDENTITY_COLORS } from './src/blob/contrast';

const MOODS = ['idle', 'thinking', 'busy', 'input', 'question', 'error', 'unread'] as const;

const markup = (mood: (typeof MOODS)[number], seed = 'seed') =>
  renderToStaticMarkup(<PipBlob seed={seed} mood={mood} state="idle" />);

/**
 * Pip is a flat circle with a face that has rolled onto its surface (see the reference sheet). The
 * rules that make that read correctly are the ones worth pinning: every mood has a face, only
 * working states move, and the face is placed and clipped so it looks painted on.
 */
describe('Pip faces', () => {
  test('every mood has a face', () => {
    for (const mood of MOODS) expect(PIP_FACES[mood]).toBeDefined();
  });

  test('no two moods draw the same marks', () => {
    const seen = new Map<string, string>();
    for (const mood of MOODS) {
      const signature = JSON.stringify(PIP_FACES[mood].marks);
      const previous = seen.get(signature);
      expect(previous).toBeUndefined();
      seen.set(signature, mood);
    }
  });

  test('every mood places its face somewhere on the ball', () => {
    for (const mood of MOODS) {
      const face = PIP_FACES[mood];
      // Inside the rim, and off-centre enough to read as rolled rather than stamped.
      expect(face.distance).toBeGreaterThan(0.2);
      expect(face.distance).toBeLessThan(0.95);
      expect(Number.isFinite(face.angle)).toBe(true);
    }
  });

  test('the placement is on the circle and rotates with the ball', () => {
    const face = pipFaceFor('busy');
    const at0 = pipFacePlacement(face, 0);
    const at90 = pipFacePlacement(face, 90);
    // Both land inside the 100-unit box.
    for (const point of [at0, at90]) {
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(100);
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(100);
    }
    // A quarter turn moves the face, and rotates it to match.
    expect(at0.x).not.toBeCloseTo(at90.x, 1);
    expect(at90.rotation - at0.rotation).toBe(90);
  });
});

describe('Pip rolling', () => {
  test('idle, unread and error never move', () => {
    expect(PIP_ROLL.idle).toBe(0);
    expect(PIP_ROLL.unread).toBe(0);
    expect(PIP_ROLL.error).toBe(0);
  });

  test('working states roll, and no faster than a drift', () => {
    for (const mood of ['thinking', 'busy', 'input', 'question'] as const) {
      expect(PIP_ROLL[mood]).toBeGreaterThan(0);
      // Above ~120deg/s it stops reading as a rolling ball and becomes a spinner.
      expect(PIP_ROLL[mood]).toBeLessThanOrEqual(120);
    }
  });

  test('the markup marks still states as non-rolling so CSS can stop them', () => {
    expect(markup('idle')).toContain('data-rolling="false"');
    expect(markup('error')).toContain('data-rolling="false"');
    expect(markup('busy')).toContain('data-rolling="true"');
  });
});

describe('Pip drawing', () => {
  test('the ball is a plain circle in a palette colour, with near-black marks', () => {
    const html = markup('idle');
    // A plain filled circle: no gradient, no gloss.
    expect(html).toMatch(/<circle[^>]*r="46"[^>]*fill="var\(--blob-\d+\)"/i);
    // Drawn from the shared identity palette rather than a private one. A per-style palette made
    // the avatar picker lie: its swatches and preview read `--blob-N`, so a private colour at the
    // same index meant the colour you clicked was never the colour you got.
    const index = Number(/fill="var\(--blob-(\d+)\)"/.exec(html)?.[1]);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(IDENTITY_COLORS.length);
  });

  test('the face is clipped to the ball, so it disappears at the rim', () => {
    // The reference cuts faces off at the edge; without the clip a face near the rim floats outside.
    expect(markup('busy')).toMatch(/clip-path="url\(#.*-ball\)"/);
  });

  test('the same seed always picks the same colour', () => {
    const first = markup('idle', 'pi:tower');
    const second = markup('idle', 'pi:tower');
    expect(first).toBe(second);
  });
});
