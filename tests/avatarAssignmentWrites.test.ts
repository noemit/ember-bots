import { expect, test } from 'bun:test';
import { AvatarAssignmentWrites } from '../src/hooks/avatarAssignmentWrites';
import { mergeAvatarAssignments } from '../electron/transport';

const original = { colorIndex: 2, shapeSeed: 'original' };
const competing = { colorIndex: 4, shapeSeed: 'other-client' };

test('failed allocation survives a reread and is included in an unrelated settings save', () => {
  const writes = new AvatarAssignmentWrites();
  writes.acknowledge({});
  writes.stage({ chat: original });
  // setSettings rejects; the hook's recovery getSettings still has no assignment.
  writes.acknowledge({});
  expect(writes.visible()).toEqual({ chat: original });
  expect(writes.additions()).toEqual({ chat: original });
  const unrelatedPatch = { theme: 'clay', avatarAssignments: writes.additions() };
  const stored = mergeAvatarAssignments({}, unrelatedPatch.avatarAssignments);
  writes.acknowledge(stored);
  expect(writes.visible()).toEqual({ chat: original });
  expect(writes.additions()).toEqual({});
});

test('repeated allocation and retries cannot overwrite the first optimistic choice', () => {
  const writes = new AvatarAssignmentWrites();
  writes.stage({ chat: original });
  writes.stage({ chat: competing });
  writes.acknowledge({});
  writes.stage(writes.additions());
  expect(writes.visible()).toEqual({ chat: original });
  expect(writes.additions()).toEqual({ chat: original });
});

test('main first-write winner replaces a competing optimistic choice after a lost response', () => {
  const writes = new AvatarAssignmentWrites();
  writes.stage({ chat: original });
  writes.acknowledge({ chat: competing });
  expect(writes.visible()).toEqual({ chat: competing });
  expect(writes.additions()).toEqual({});
  // A saved retry closure can still carry the old patch; staging it must not restore that choice.
  writes.stage({ chat: original });
  expect(writes.visible()).toEqual({ chat: competing });
  expect(writes.additions()).toEqual({});
});

test('older responses acknowledge only their own keys and cannot erase newer additions', () => {
  const writes = new AvatarAssignmentWrites();
  writes.stage({ first: original });
  writes.stage({ second: competing });
  writes.acknowledge({ first: original });
  expect(writes.additions()).toEqual({ second: competing });
  expect(writes.visible()).toEqual({ first: original, second: competing });
  writes.acknowledge({});
  expect(writes.visible()).toEqual({ first: original, second: competing });
});
