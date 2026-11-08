import { expect, test } from 'bun:test';
import { pickerStyleDraft } from '../src/components/AvatarPicker';
import { previewDraftAppearance } from '../src/lib/draftAppearance';
import type { AvatarIdentity } from '../src/types';
import { ACTIVE_BLOB_STYLES } from '../src/blob/styles';
import { BUDDY_SHAPES } from '../src/blob/buddy';
import { CRYSTAL_SHAPES } from '../src/blob/crystal';
import { MOSAIC_SHAPES } from '../src/blob/mosaic';
import { LAVA_SHAPES } from '../src/blob/lava';

const shapes = { buddy: BUDDY_SHAPES, crystal: CRYSTAL_SHAPES, mosaic: MOSAIC_SHAPES, lava: LAVA_SHAPES };

test('picker style choices keep colour edits and mask incompatible shapes without mutating the draft', () => {
  for (const style of ACTIVE_BLOB_STYLES) {
    const draft = { color: '#123456', colorIndex: 2, shapeName: 'not-a-shape' };
    const next = pickerStyleDraft(draft, style);
    expect(next).toEqual({ color: draft.color, colorIndex: draft.colorIndex, style, shapeName: 'automatic' });
    expect(draft.shapeName).toBe('not-a-shape');
  }
});

test('compatible shapes survive a style choice and style-only edits remain sparse', () => {
  for (const style of ACTIVE_BLOB_STYLES) {
    const shapeName = shapes[style][0].name;
    expect(pickerStyleDraft({ shapeName }, style)).toEqual({ shapeName, style });
    expect(pickerStyleDraft({}, style)).toEqual({ style });
    expect(pickerStyleDraft({}, style, shapeName)).toEqual({ style, shapeName });
  }
});

test('switching Crystal to Lava and back masks the frozen quartz shape instead of resurrecting it', () => {
  const base: AvatarIdentity = {
    sessionKey: 'draft', colorSeed: 'color', shapeSeed: 'shape', motionSeed: 'motion',
    style: 'crystal', shapeName: 'quartz',
  };
  // Even a shape inherited from the preview (absent from the editable override) must be cleared.
  const lavaDraft = pickerStyleDraft({}, 'lava', base.shapeName);
  const lavaPreview = previewDraftAppearance(base, lavaDraft);
  expect(lavaPreview.style).toBe('lava');
  expect(lavaPreview.shapeName).toBe('automatic');
  const crystalDraft = pickerStyleDraft(lavaDraft, 'crystal', lavaPreview.shapeName);
  const crystalPreview = previewDraftAppearance(base, crystalDraft);
  expect(crystalPreview.style).toBe('crystal');
  expect(crystalPreview.shapeName).toBe('automatic');
  for (const style of ACTIVE_BLOB_STYLES) {
    expect(shapes[style].some(shape => shape.name === 'automatic')).toBe(false);
  }
});
