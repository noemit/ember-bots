import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseAvatarOverrides } from '../electron/transport';
import Blob from '../src/blob/Blob';
import BuddyBlob from '../src/blob/BuddyBlob';
import CrystalBlob from '../src/blob/CrystalBlob';
import { blobColor } from '../src/blob/color';
import { loadBlobComponent } from '../src/blob/dockIcon';
import { allocateAvatar, identityShape } from '../src/blob/allocateIdentity';
import { avatarAppearanceOverride, resolveAvatarIdentity, seedIdentity } from '../src/blob/seed';
import { effectiveBlobStyle } from '../src/blob/styles';
import type { AvatarOverride } from '../src/types';

test('stored styles validate sparsely and retain retired preferences without rewriting', () => {
  for (const style of ['buddy', 'crystal', 'mosaic', 'lava', 'scribble']) {
    const saved = JSON.parse(JSON.stringify({ bot: { style } }));
    expect(parseAvatarOverrides(saved)).toEqual(saved);
  }
  for (const style of ['pip', 'gem', '', null, 3, {}, 'toString']) {
    expect(parseAvatarOverrides({ bot: { style } })).toEqual({});
    expect(parseAvatarOverrides({ bot: { style, color: '#ABCDEF' } })).toEqual({ bot: { color: '#abcdef' } });
  }
  expect(parseAvatarOverrides(JSON.parse('{"__proto__":{"style":"lava"}}'))).toEqual({});
});

test('scope styles merge independently with session over task over project', () => {
  const session = { id: 'bot', instanceId: 'local', directory: '/work' };
  const bindings = { 'local::bot': 'task' };
  const overrides: Record<string, AvatarOverride> = {
    'directory:local::/work': { style: 'lava', color: '#551eb3', shapeName: 'cloud' },
    task: { style: 'crystal' },
    'session:local::bot': { style: 'scribble', colorIndex: 3 },
  };
  const identity = resolveAvatarIdentity(session, [], bindings, overrides);
  expect(identity.style).toBe('scribble');
  expect(effectiveBlobStyle('mosaic', identity)).toBe('buddy');
  expect(identity.colorIndex).toBe(3);
  expect(identity.color).toBeUndefined();
  expect(identity.shapeName).toBe('cloud');
  overrides['session:local::bot'] = { style: undefined };
  expect(avatarAppearanceOverride(session, [], bindings, overrides)).toEqual({ style: 'crystal', color: '#551eb3', shapeName: 'cloud' });
  delete overrides.task;
  expect(resolveAvatarIdentity(session, [], bindings, overrides).style).toBe('lava');
});

test('renderer, dock and colour use the identity style before the global default', async () => {
  for (const style of ['buddy', 'crystal', 'mosaic', 'lava', 'scribble'] as const) {
    const identity = { ...seedIdentity('bot'), style };
    const effective = effectiveBlobStyle('lava', identity);
    const actual = renderToStaticMarkup(<Blob style="lava" seed="bot" identity={identity} />);
    expect(actual).toContain(`blob-${effective}`);
    expect(blobColor('lava', identity)).toBe(blobColor(effective, seedIdentity('bot')));
    expect(await loadBlobComponent('lava', identity)).toBe(await loadBlobComponent(effective));
    expect(blobColor('lava', { ...identity, color: '#123456' })).toBe('#123456');
    expect(blobColor('lava', { ...identity, colorIndex: 4 })).toBe('var(--blob-4)');
    expect(identity.style).toBe(style);
  }
  expect(await loadBlobComponent('lava', { style: 'scribble' })).toBe(BuddyBlob);
  expect(await loadBlobComponent('lava', { style: 'crystal' })).toBe(CrystalBlob);
});

test('allocator targets the override style and compares peers in their actual style', () => {
  const peers = Array.from({ length: 8 }, (_, i) => ({ ...seedIdentity(`peer-${i}`), style: 'crystal' as const, colorIndex: i }));
  const override = { style: 'crystal' as const, color: '#551eb3' };
  expect(allocateAvatar('new', peers, 'buddy', undefined, override)).toEqual(allocateAvatar('new', peers, 'crystal', undefined, override));
  expect(allocateAvatar('new', peers, 'lava', undefined, { style: 'scribble' })).toEqual(allocateAvatar('new', peers, 'buddy'));
  // Foreign shapes must not be interpreted as target shapes, even with identical names/seeds.
  for (let i = 0; i < 20; i++) {
    const foreign = [{ ...seedIdentity('foreign'), style: 'mosaic' as const, colorIndex: 2, shapeName: 'cloud' }];
    const changedForeignShape = [{ ...foreign[0], shapeSeed: `changed-${i}`, shapeName: 'other' }];
    expect(allocateAvatar(`new-${i}`, foreign, 'buddy')).toEqual(allocateAvatar(`new-${i}`, changedForeignShape, 'buddy'));
  }
  expect(identityShape('buddy', peers[0])).toBe(identityShape('crystal', peers[0]));
});


test('explicit frozen geometry survives validation and outranks task and first-writer assignment', () => {
  for (const shapeSeed of ['frozen:preview', 'x'.repeat(200)]) {
    expect(parseAvatarOverrides({ bot: { shapeSeed } })).toEqual({ bot: { shapeSeed } });
  }
  for (const shapeSeed of ['', '   ', 'x'.repeat(201), null, 42, {}]) {
    expect(parseAvatarOverrides({ bot: { shapeSeed } })).toEqual({});
    expect(parseAvatarOverrides({ bot: { shapeSeed, style: 'buddy' } })).toEqual({ bot: { style: 'buddy' } });
  }
  const session = { id: 'bot', instanceId: 'local', directory: '/work' };
  const overrides = parseAvatarOverrides({
    'directory:local::/work': { shapeSeed: 'project-seed' },
    task: { shapeSeed: 'task-seed' },
    'session:local::bot': { shapeSeed: 'frozen-preview', colorIndex: 7 },
  });
  const assignment = { shapeSeed: 'another-client-first-writer', colorIndex: 1 };
  const bindings = { 'local::bot': 'task' };
  const identity = resolveAvatarIdentity(session, [], bindings, overrides, assignment);
  expect(identity.shapeSeed).toBe('frozen-preview');
  expect(identity.colorIndex).toBe(7);
  overrides['session:local::bot'] = { shapeSeed: undefined };
  expect(resolveAvatarIdentity(session, [], bindings, overrides, assignment).shapeSeed).toBe('task-seed');
  delete overrides.task;
  expect(resolveAvatarIdentity(session, [], bindings, overrides, assignment).shapeSeed).toBe('project-seed');
  expect(assignment).toEqual({ shapeSeed: 'another-client-first-writer', colorIndex: 1 });
});
