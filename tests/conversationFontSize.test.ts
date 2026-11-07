import { expect, test } from 'bun:test';
import { isConversationFontSize } from '../electron/transport';

test('conversation text accepts readable whole-pixel sizes and rejects malformed stored values', () => {
  for (const size of [12, 14, 16, 18, 20]) expect(isConversationFontSize(size)).toBe(true);
  for (const value of [undefined, null, '16', 0, -14, 11, 21, 14.5, NaN, Infinity, {}, []]) {
    expect(isConversationFontSize(value)).toBe(false);
  }
});
