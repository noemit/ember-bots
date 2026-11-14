import { expect, test } from 'bun:test';
import { SessionTitleWrites, titleSaveFailure } from '../src/lib/sessionTitleWrites';

test('title save error names the host and points to the existing rename control', () => {
  const copy = titleSaveFailure('Tower');
  expect(copy).toContain('Tower');
  expect(copy).toMatch(/rename.*(?:title|name)/i);
  expect(copy).not.toMatch(/undefined|null|HTTP|exception|stack|!/);
});

const deferred = () => {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
};

for (const autoSucceeds of [false, true]) {
  test('human title wins while automatic PATCH is pending; auto success=' + autoSucceeds, async () => {
    const writes = new SessionTitleWrites();
    const automatic = deferred();
    const order: string[] = [];
    let title: string | undefined = 'Login Locksmith';
    const apply = (value: string | undefined) => { title = value; };
    const auto = writes.rename('chat', title, 'Login Redirect Locksmith', {
      apply, write: () => { order.push('auto'); return automatic.promise; }, failed: () => { throw new Error('old failure surfaced'); },
    });
    const human = writes.rename('chat', title, 'My release plan', {
      apply, write: async () => { order.push('human'); return true; }, failed: () => {},
    });
    expect(title).toBe('My release plan');
    automatic.resolve(autoSucceeds);
    await Promise.all([auto, human]);
    expect(order).toEqual(['auto', 'human']);
    expect(title).toBe('My release plan');
  });

  test('failed human PATCH rolls back only to a confirmed title; auto success=' + autoSucceeds, async () => {
    const writes = new SessionTitleWrites();
    const automatic = deferred();
    let title: string | undefined = 'Login Locksmith';
    const apply = (value: string | undefined) => { title = value; };
    let failures = 0;
    const auto = writes.rename('chat', title, 'Login Redirect Locksmith', {
      apply, write: () => automatic.promise, failed: () => { failures++; },
    });
    const human = writes.rename('chat', title, 'My release plan', {
      apply, write: async () => false, failed: () => { failures++; },
    });
    automatic.resolve(autoSucceeds);
    await Promise.all([auto, human]);
    expect(title).toBe(autoSucceeds ? 'Login Redirect Locksmith' : 'Login Locksmith');
    expect(failures).toBe(1);
  });
}

test('a rejected transport does not poison the next title write', async () => {
  const writes = new SessionTitleWrites();
  let title: string | undefined = 'Initial';
  const apply = (value: string | undefined) => { title = value; };
  let failures = 0;
  await writes.rename('chat', title, 'Automatic', { apply, write: async () => { throw new Error('offline'); }, failed: () => { failures++; } });
  expect(title).toBe('Initial');
  await writes.rename('chat', title, 'Human', { apply, write: async () => true, failed: () => {} });
  expect(title).toBe('Human');
  expect(failures).toBe(1);
});
