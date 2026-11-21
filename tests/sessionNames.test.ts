import { expect, test } from 'bun:test';
import { deriveSessionName } from '../src/lib/sessionNames';
test('the fallback entry point cannot resurrect invented characters', () => {
  expect(deriveSessionName({ text: 'go', directory: '/GitHub' })).toBe('New conversation');
  expect(deriveSessionName({ text: 'Fix page copy and add MIT license' })).toBe('Page copy and MIT license');
});
