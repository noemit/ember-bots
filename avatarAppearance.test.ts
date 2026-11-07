import { IDENTITY_COLORS } from './src/blob/contrast';
import { blobColor } from './src/blob/color';
import { expect, test } from 'bun:test';
import { parseAvatarOverrides } from './electron/transport';
import { resolveAvatarIdentity } from './src/blob/seed';

const session = { id: 'chat', instanceId: 'local', directory: '/work' };
const resolve = (overrides: Parameters<typeof resolveAvatarIdentity>[3]) => resolveAvatarIdentity(session, [], {}, overrides);

test('desktop validation preserves absent traits so shape-only edits inherit the chosen colour', () => {
  const overrides = {
    'directory:local::/work': { color: '#d25b87', shapeName: 'cloud' },
    'session:local::chat': { shapeName: 'tree' },
  };
  const stored = parseAvatarOverrides(overrides);
  expect(Object.keys(stored['session:local::chat'])).toEqual(['shapeName']);
  expect(resolve(stored)).toEqual(resolve(overrides));
  expect(resolve(JSON.parse(JSON.stringify(stored)))).toEqual(resolve(overrides));
  expect(resolve(stored).color).toBe('#d25b87');
});

test('undefined fields from older desktops cannot erase inherited colours or shapes', () => {
  const overrides = {
    'directory:local::/work': { color: '#d25b87', shapeName: 'cloud' },
    'session:local::chat': { color: undefined, colorIndex: undefined, shapeName: 'tree' },
  };
  expect(resolve(overrides).color).toBe('#d25b87');
  expect(resolve({ ...overrides, 'session:local::chat': { shapeName: undefined } }).shapeName).toBe('cloud');
});

test('choosing a swatch replaces inherited custom colour without losing the shape, across save/reload', () => {
  const overrides = {
    'directory:local::/work': { color: '#d25b87', shapeName: 'cloud' },
    'session:local::chat': { colorIndex: 3, color: undefined },
  };
  const stored = parseAvatarOverrides(overrides);
  expect(resolve(stored)).toEqual(resolve(overrides));
  expect(resolve(stored).color).toBeUndefined();
  expect(resolve(stored).colorIndex).toBe(3);
  expect(resolve(stored).shapeName).toBe('cloud');
});


test('every colour offered in the picker survives desktop validation and persistence', () => {
  for (let colorIndex = 0; colorIndex < IDENTITY_COLORS.length; colorIndex++) {
    const chosen = { 'session:local::chat': { colorIndex } };
    const stored = parseAvatarOverrides(chosen);
    expect(stored['session:local::chat']?.colorIndex).toBe(colorIndex);
    const identity = resolve(JSON.parse(JSON.stringify(stored)));
    expect(identity.colorIndex).toBe(colorIndex);
    for (const style of ['buddy', 'crystal', 'mosaic', 'lava', 'scribble'] as const) {
      expect(blobColor(style, identity)).toBe(`var(--blob-${colorIndex})`);
    }
  }
  expect(parseAvatarOverrides({ bad: { colorIndex: IDENTITY_COLORS.length } })).toEqual({});
});
