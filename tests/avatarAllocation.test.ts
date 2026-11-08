import { describe, expect, test } from 'bun:test';
import { allocateAvatar, competesForIdentity, identityShape } from '../src/blob/allocateIdentity';
import { AVATAR_COLOR_COUNT, IDENTITY_COLORS, identityPaletteFor, perceptualDistance } from '../src/blob/contrast';
import { hashString, resolveAvatarIdentity } from '../src/blob/seed';
import { THEMES } from '../src/themes';
import type { AvatarAssignment, AvatarIdentity, BlobStyle, Session } from '../src/types';

const session = (id: string): Session => ({ id, instanceId: 'local', directory: '/work' });
const resolve = (id: string, assignment?: AvatarAssignment) => resolveAvatarIdentity(session(id), [], {}, {}, assignment);
const styles: BlobStyle[] = ['buddy', 'crystal', 'lava', 'mosaic', 'scribble'];

describe('distinct new bot identities', () => {
  test('repeated creations choose maximum perceptual separation rather than adjacent swatches', () => {
    for (const theme of THEMES) {
      const palette = identityPaletteFor([theme.palette.panel, theme.palette.elev, theme.palette.bg]);
      const active: AvatarIdentity[] = [];
      for (let i = 0; i < 10; i++) {
        const chosen = allocateAvatar('new-bot', active, 'buddy', palette);
        if (active.length) {
          const distances = palette.map(color => Math.min(...active.map(peer => perceptualDistance(color, palette[peer.colorIndex!]))));
          expect(distances[chosen.colorIndex]).toBeCloseTo(Math.max(...distances), 12);
          if (i < 5) expect(distances[chosen.colorIndex]).toBeGreaterThan(.10);
        }
        active.push(resolve(String(i), chosen));
      }
      expect(new Set(active.map(identity => identity.colorIndex)).size).toBe(10);
      expect(new Set(active.map(identity => identityShape('buddy', identity))).size).toBe(10);
    }
  });

  test('every style exhausts distinct silhouettes before repeating them', () => {
    for (const style of styles) {
      const active: AvatarIdentity[] = [];
      for (let i = 0; i < 6; i++) active.push(resolve(String(i), allocateAvatar('new-bot', active, style)));
      expect(new Set(active.map(identity => identityShape(style, identity))).size).toBe(6);
    }
  });

  test('deterministic input and ordering; existing identities do not change as newcomers arrive', () => {
    const existing = Array.from({ length: 8 }, (_, i) => resolve('old-' + i));
    const snapshot = JSON.stringify(existing);
    expect(allocateAvatar('next', existing, 'lava')).toEqual(allocateAvatar('next', [...existing].reverse(), 'lava'));
    const next = allocateAvatar('next', existing, 'lava');
    const saved = JSON.parse(JSON.stringify({ 'local::next': next }));
    expect(resolve('next', saved['local::next'])).toEqual(resolve('next', next));
    expect(resolve('next', next)).toEqual(resolveAvatarIdentity({ ...session('next'), archived: 123 }, [], {}, {}, next));
    expect(JSON.stringify(existing)).toBe(snapshot);
    for (const identity of existing) expect(identity.colorIndex).toBe(hashString('avatar-color:' + identity.sessionKey) % AVATAR_COLOR_COUNT);
  });

  test('explicit project, task and session overrides remain above automatic assignments', () => {
    const assignment = allocateAvatar('next', [resolve('old')], 'buddy');
    const projects = [{ id: 'project', name: 'Work', path: '/work' }];
    const overrides = { 'project:local::project': { color: '#551eb3', shapeName: 'cloud' } };
    for (const id of ['one', 'two', 'three']) {
      const identity = resolveAvatarIdentity(session(id), projects, {}, overrides, assignment);
      expect(identity.color).toBe('#551eb3');
      expect(identity.shapeName).toBe('cloud');
    }
    const identity = resolveAvatarIdentity(session('one'), projects, { 'local::one': 'task' }, {
      ...overrides, task: { colorIndex: 4 }, 'session:local::one': { color: '#ff0000', shapeName: 'cat' },
    }, assignment);
    expect(identity.color).toBe('#ff0000');
    expect(identity.shapeName).toBe('cat');
    const shapeOnly = resolveAvatarIdentity(session('one'), [], {}, { 'session:local::one': { shapeName: 'cat' } }, assignment);
    expect(shapeOnly.colorIndex).toBe(assignment.colorIndex);
  });

  test('scheduled runs retain their shared task silhouette, including a late binding', () => {
    const bindings = { 'local::first': 'nightly-task', 'local::next': 'nightly-task' };
    const first = resolveAvatarIdentity(session('first'), [], bindings, {});
    const assignment = allocateAvatar('next', [first], 'buddy');
    const next = resolveAvatarIdentity(session('next'), [], bindings, {}, assignment);
    expect(next.shapeSeed).toBe(first.shapeSeed);
    expect(next.colorIndex).toBe(assignment.colorIndex);
    const chosen = resolveAvatarIdentity(session('next'), [], bindings, { 'nightly-task': { shapeName: 'cat' } }, assignment);
    expect(chosen.shapeName).toBe('cat');
  });

  test('a fixed custom colour ranks silhouettes against the colour that will actually render', () => {
    const shapes = ['quartz', 'prism', 'flint', 'geode', 'shard', 'cluster'];
    const active = shapes.map((shapeName, index) => ({ ...resolve(String(index)), shapeName, color: index === 0 ? '#00cc00' : '#551eb3' }));
    // Quartz is already used twice, but neither is purple. Prefer it over an exact purple pair.
    active.push({ ...resolve('another-green'), shapeName: 'quartz', color: '#00cc00' });
    const assignment = allocateAvatar('purple-project', active, 'crystal', IDENTITY_COLORS, { color: '#551eb3' });
    expect(identityShape('crystal', resolve('next', assignment))).toBe('quartz');
  });

  test('custom purple is an occupied colour too, even without a palette index', () => {
    const purple = { ...resolve('purple'), color: '#551eb3', colorIndex: undefined };
    const chosen = allocateAvatar('new-bot', [purple], 'buddy');
    const best = Math.max(...IDENTITY_COLORS.map(color => perceptualDistance(color, purple.color)));
    expect(perceptualDistance(IDENTITY_COLORS[chosen.colorIndex], purple.color)).toBeCloseTo(best, 12);
  });

  test('exhausted colours balance reuse without reshuffling saved choices', () => {
    const active: AvatarIdentity[] = [];
    for (let i = 0; i < AVATAR_COLOR_COUNT * 3; i++) {
      const snapshot = JSON.stringify(active);
      const next = allocateAvatar('new-bot', active, 'mosaic');
      expect(JSON.stringify(active)).toBe(snapshot);
      active.push(resolve(String(i), next));
    }
    const counts = IDENTITY_COLORS.map((_, index) => active.filter(identity => identity.colorIndex === index).length);
    expect(new Set(counts)).toEqual(new Set([3]));
  });

  test('idle top-level bots and promoted peers compete; archived bots and unpromoted threads do not', () => {
    expect(competesForIdentity(session('idle'))).toBe(true);
    expect(competesForIdentity({ ...session('peer'), kind: 'peer', lead: { instanceId: 'local', sessionId: 'leader' } })).toBe(true);
    for (const attributes of [{ archived: 123 }, { kind: 'worker' as const }, { parentId: 'leader' }, { lead: { instanceId: 'local', sessionId: 'leader' } }]) {
      expect(competesForIdentity({ ...session('thread'), ...attributes })).toBe(false);
    }
  });
});
