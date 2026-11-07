import { describe, expect, test } from 'bun:test';
import { instanceMarkerColor, MARKER_OFF, suggestMarkerColor } from '../src/lib/instanceMarker';
import { INSTANCE_MARKER_COLORS } from '../src/blob/contrast';

/**
 * The instance underline is chrome on every session row, so it is off unless someone asked for it.
 * An earlier version derived a colour automatically for every instance, which painted the rail
 * without being asked — these pin the corrected rule.
 */

describe('instance underline', () => {
  test('nothing is underlined by default', () => {
    expect(instanceMarkerColor('pi:tower', undefined)).toBeUndefined();
    expect(instanceMarkerColor('pi:tower', {})).toBeUndefined();
    expect(instanceMarkerColor('pi:tower', { bypass: true })).toBeUndefined();
  });

  test('an explicit colour is honoured', () => {
    expect(instanceMarkerColor('pi:tower', { markerColor: 7 })).toBe(7);
    expect(instanceMarkerColor('pi:tower', { markerColor: 0 })).toBe(0);
  });

  test('off stays off even when the other defaults are set', () => {
    expect(instanceMarkerColor('pi:tower', { markerColor: MARKER_OFF, model: undefined })).toBeUndefined();
  });

  test('an index outside the palette is ignored rather than drawn wrong', () => {
    expect(instanceMarkerColor('pi:tower', { markerColor: 999 })).toBeUndefined();
    expect(instanceMarkerColor('pi:tower', { markerColor: -5 })).toBeUndefined();
  });

  test('the suggestion is a valid palette index and is only a suggestion', () => {
    for (const id of ['pi:tower', 'pi:moat', 'local', '']) {
      const suggestion = suggestMarkerColor(id);
      expect(suggestion).toBeGreaterThanOrEqual(0);
      expect(suggestion).toBeLessThan(INSTANCE_MARKER_COLORS.length);
      expect(suggestMarkerColor(id)).toBe(suggestion);
      // Suggesting a colour must not mean applying one.
      expect(instanceMarkerColor(id, {})).toBeUndefined();
    }
  });
});
