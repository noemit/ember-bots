import { expect, test } from 'bun:test';
import { ReadCoordinator } from '../src/lib/readCoordinator';

test('deduplicates reads and serializes a full repair after a tail', async () => {
  const coordinator = new ReadCoordinator();
  const calls: string[] = [];
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const tail = coordinator.run('a', 'tail', async () => { calls.push('tail'); await blocked; });
  const duplicate = coordinator.run('a', 'tail', async () => { calls.push('duplicate'); });
  const full = coordinator.run('a', 'full', async () => { calls.push('full'); });
  const duplicateFull = coordinator.run('a', 'full', async () => { calls.push('duplicate full'); });
  await Promise.resolve();
  expect(calls).toEqual(['tail']);
  expect(duplicate).toBe(tail);
  expect(duplicateFull).toBe(full);
  release();
  await full;
  expect(calls).toEqual(['tail', 'full']);
});

test('an authoritative repair waits for a pre-mutation full read then fetches again', async () => {
  const coordinator = new ReadCoordinator();
  const calls: string[] = [];
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const old = coordinator.run('a', 'full', async () => { calls.push('before mutation'); await blocked; });
  const fresh = coordinator.run('a', 'full', async () => { calls.push('after mutation'); }, true);
  await Promise.resolve();
  expect(calls).toEqual(['before mutation']);
  release();
  await Promise.all([old, fresh]);
  expect(calls).toEqual(['before mutation', 'after mutation']);
});

test('independent sessions proceed and failures release a key', async () => {
  const coordinator = new ReadCoordinator();
  await expect(coordinator.run('a', 'full', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
  let finished = false;
  await coordinator.run('a', 'full', async () => { finished = true; });
  expect(finished).toBe(true);
});

test('an afterCurrent full is not swallowed by an in-flight tail', async () => {
  const coordinator = new ReadCoordinator();
  const calls: string[] = [];
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const tail = coordinator.run('a', 'tail', async () => { calls.push('tail'); await blocked; });
  // The post-mutation refresh must start after the read in flight: joining it would report a value
  // read before the mutation as the state after it.
  const repair = coordinator.run('a', 'full', async () => { calls.push('full'); }, true);
  expect(repair).not.toBe(tail);
  release();
  await repair;
  expect(calls).toEqual(['tail', 'full']);
});

test('a tail that asked to wait is not turned into a second full walk', async () => {
  const coordinator = new ReadCoordinator();
  const calls: string[] = [];
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  coordinator.run('a', 'tail', async () => { calls.push('tail'); await blocked; });
  const queuedFull = coordinator.run('a', 'full', async () => { calls.push('full'); });
  // A post-mutation tail keeps its own mode: it waits for the read in flight, and it does not become
  // a second full-history walk.
  const queuedTail = coordinator.run('a', 'tail', async () => { calls.push('queued tail'); }, true);
  release();
  await queuedFull;
  await queuedTail;
  expect(calls).toEqual(['tail', 'full']);
});

test('a full queued behind a tail is never lost to a later tail', async () => {
  const coordinator = new ReadCoordinator();
  const calls: string[] = [];
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  coordinator.run('a', 'tail', async () => { calls.push('tail'); await blocked; });
  const full = coordinator.run('a', 'full', async () => { calls.push('full'); });
  const laterTail = coordinator.run('a', 'tail', async () => { calls.push('later tail'); });
  release();
  await full;
  await laterTail;
  expect(calls).toEqual(['tail', 'full']);
});

test('a queued run takes the key over, so nothing reads in parallel beside it', async () => {
  const coordinator = new ReadCoordinator();
  const calls: string[] = [];
  let releaseTail = () => {};
  const tailBlock = new Promise<void>((resolve) => { releaseTail = resolve; });
  let releaseFull = () => {};
  const fullBlock = new Promise<void>((resolve) => { releaseFull = resolve; });
  coordinator.run('a', 'tail', async () => { calls.push('tail'); await tailBlock; });
  const full = coordinator.run('a', 'full', async () => { calls.push('full'); await fullBlock; });
  releaseTail();
  await Promise.resolve();
  // While the follow-up runs, a third tail joins it instead of starting a second read.
  const joined = coordinator.run('a', 'tail', async () => { calls.push('second tail'); });
  releaseFull();
  await full;
  await joined;
  expect(calls).toEqual(['tail', 'full']);
});

test('a failure is the caller’s to see, and the key is free afterwards', async () => {
  const coordinator = new ReadCoordinator();
  await expect(coordinator.run('a', 'tail', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  let ran = false;
  await coordinator.run('a', 'tail', async () => { ran = true; });
  expect(ran).toBe(true);
});

test('a queued full that already started keeps a later tail from reading beside it', async () => {
  const coordinator = new ReadCoordinator();
  const calls: string[] = [];
  let releaseTail = () => {};
  const tailBlock = new Promise<void>((resolve) => { releaseTail = resolve; });
  let releaseFull = () => {};
  const fullBlock = new Promise<void>((resolve) => { releaseFull = resolve; });
  coordinator.run('a', 'tail', async () => { calls.push('tail'); await tailBlock; });
  const full = coordinator.run('a', 'full', async () => { calls.push('full'); await fullBlock; });
  releaseTail();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // The follow-up owns the key now: this tail joins it rather than starting a second read.
  const late = coordinator.run('a', 'tail', async () => { calls.push('late'); });
  releaseFull();
  await full;
  await late;
  expect(calls).toEqual(['tail', 'full']);
});
