import { expect, test } from 'bun:test';
import { freezeDraftAppearance, previewDraftAppearance, withSessionAppearance } from '../src/lib/draftAppearance';
import { hashString, mulberry32, resolveAvatarIdentity } from '../src/blob/seed';
import { crystalGeometry, CRYSTAL_SHAPES } from '../src/blob/crystal';
import { lavaGeometry, LAVA_SHAPES } from '../src/blob/lava';
import type { AvatarIdentity } from '../src/types';
import { createPendingCreate, failPendingCreate, restartPendingCreate } from '../src/lib/pendingCreate';

const draft = { id: 'draft:local', instanceId: 'local', directory: '/work' };
const created = { ...draft, id: 'created' };
const projectOverrides = { 'directory:local::/work': { color: '#118844', shapeName: 'cloud' } };

test('draft appearance freezes the selected style, colour, shape and geometry seed', () => {
  const base = resolveAvatarIdentity(draft, [], {}, projectOverrides, { colorIndex: 3, shapeSeed: 'reserved-seed' });
  const preview = previewDraftAppearance(base, { style: 'crystal', color: '#6633aa', shapeName: 'quartz' });
  const choice = freezeDraftAppearance(preview, 'buddy');
  const stored = withSessionAppearance(created, projectOverrides, choice.override);
  expect(Object.keys(stored).sort()).toEqual(['directory:local::/work', 'session:local::created']);
  expect(projectOverrides).toEqual({ 'directory:local::/work': { color: '#118844', shapeName: 'cloud' } });
  // Another client may win the automatic-assignment race; the explicit draft choice still wins.
  const after = resolveAvatarIdentity(created, [], {}, stored, { colorIndex: 18, shapeSeed: 'other-client-seed' });
  for (const field of ['style', 'color', 'colorIndex', 'shapeName', 'shapeSeed'] as const) expect(after[field]).toEqual(preview[field]);
  expect(after.style).toBe('crystal');
  expect(after.shapeSeed).toBe('reserved-seed');
});

test('the custom colour input keeps the assignment used for Buddy pupil colour', () => {
  const base = resolveAvatarIdentity(draft, [], {}, {}, { colorIndex: 9, shapeSeed: 'same-body' });
  const preview = previewDraftAppearance(base, { color: '#158cba', colorIndex: undefined });
  const choice = freezeDraftAppearance(preview, 'buddy');
  expect(preview.colorIndex).toBe(9);
  expect(choice.assignment.colorIndex).toBe(9);
});

test('choosing a swatch replaces an inherited custom colour in the preview and frozen choice', () => {
  const base = resolveAvatarIdentity(draft, [], {}, projectOverrides);
  const preview = previewDraftAppearance(base, { colorIndex: 7 });
  expect(preview.color).toBeUndefined();
  const choice = freezeDraftAppearance(preview, 'buddy');
  expect(choice.override.color).toBeUndefined();
  expect(choice.override.colorIndex).toBe(7);
  expect(choice.assignment.shapeSeed).toBe(base.shapeSeed);
});

test('an automatic shape keeps its exact geometry and masks a folder shape after a style switch', () => {
  for (const style of ['crystal', 'lava'] as const) {
    const shapes = style === 'crystal' ? CRYSTAL_SHAPES : LAVA_SHAPES;
    const inherited = { 'directory:local::/work': { shapeName: shapes[0].name } };
    const preview = previewDraftAppearance(resolveAvatarIdentity(draft, [], {}, inherited), { style, shapeName: undefined });
    const choice = freezeDraftAppearance(preview, 'buddy');
    const after = resolveAvatarIdentity(created, [], {}, withSessionAppearance(created, inherited, choice.override), choice.assignment);
    const geometry = (identity: AvatarIdentity) => style === 'crystal'
      ? crystalGeometry(mulberry32(hashString(`crystal:${identity.shapeSeed}`)), mulberry32(123), CRYSTAL_SHAPES.find(shape => shape.name === identity.shapeName))
      : lavaGeometry(mulberry32(hashString(`lava:${identity.shapeSeed}`)), LAVA_SHAPES.find(shape => shape.name === identity.shapeName));
    expect(geometry(after)).toEqual(geometry(preview));
    expect(shapes.some(shape => shape.name === choice.override.shapeName)).toBe(false);
  }
});

test('failure and retry keep the complete draft appearance without touching project settings', () => {
  const choice = freezeDraftAppearance(resolveAvatarIdentity(draft, [], {}, projectOverrides), 'buddy');
  const options = { instanceId: 'local', directory: '/work', bypass: false, appearance: choice };
  const pending = createPendingCreate({ id: 'attempt', options, title: 'New bot', createdAt: 1,
    message: { id: 'message', input: { text: 'Start here' }, text: 'Start here', attachments: [], createdAt: 1, held: false } });
  const failed = failPendingCreate(pending, 'Host refused this folder');
  const retried = restartPendingCreate(failed, { ...options, directory: '/fixed' });
  expect(retried.options.appearance).toEqual(choice);
  expect(retried.options.directory).toBe('/fixed');
  expect(withSessionAppearance(created, projectOverrides)).toBe(projectOverrides);
});
