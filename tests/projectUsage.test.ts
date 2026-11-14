import { expect, test } from 'bun:test';
import { projectUsageForHost, PROJECT_USAGE_WINDOW_MS } from '../src/lib/projectUsage';
import type { Session } from '../src/types';

const now = 100 * PROJECT_USAGE_WINDOW_MS;
const chat = (id: string, directory: string, createdAt = now - 100): Session => ({ id, instanceId: 'a', directory, createdAt });

test('frequency counts distinct started chats, not latest output or repeated snapshots', () => {
  const a = chat('1', '/work/frequent', now - 500);
  const b = chat('2', '/work/frequent', now - 400);
  const recent = chat('3', '/else/recent', now - 10);
  expect(projectUsageForHost([a, a, b, recent], 'a', now)).toEqual([
    { path: '/work/frequent', count: 2, lastUsed: now - 400 },
    { path: '/else/recent', count: 1, lastUsed: now - 10 },
  ]);
  expect(projectUsageForHost([{ ...a, updated: now }, b, recent], 'a', now)[0]?.lastUsed).toBe(now - 400);
});

test('host boundary and human-facing active chats exclude workers, subagents, hidden and scheduled runs', () => {
  const sessions = [chat('1', '/real'), { ...chat('1', '/other'), instanceId: 'b' },
    { ...chat('2', '/worker'), kind: 'worker' as const }, { ...chat('3', '/subagent'), parentId: '1' },
    { ...chat('4', '/hidden'), archived: now }, chat('5', '/scheduled')];
  expect(projectUsageForHost(sessions, 'a', now, new Set(['5']))).toEqual([{ path: '/real', count: 1, lastUsed: now - 100 }]);
});

test('known old and unknown-start paths stay searchable across roots; exact paths break ties', () => {
  expect(projectUsageForHost([
    chat('1', '/z/atlas'), chat('2', '/a/atlas'), chat('3', '/old', now - PROJECT_USAGE_WINDOW_MS - 1),
    { ...chat('4', '/unknown'), createdAt: undefined, updated: now },
  ], 'a', now)).toEqual([
    { path: '/a/atlas', count: 1, lastUsed: now - 100 },
    { path: '/z/atlas', count: 1, lastUsed: now - 100 },
    { path: '/old', count: 0, lastUsed: now - PROJECT_USAGE_WINDOW_MS - 1 },
    { path: '/unknown', count: 0, lastUsed: 0 },
  ]);
});

test('30-day boundary is inclusive and invalid or future timestamps do not invent usage', () => {
  const sessions = [chat('1', '/edge', now - PROJECT_USAGE_WINDOW_MS), chat('2', '/future', now + 1), chat('3', '/invalid', NaN)];
  expect(projectUsageForHost(sessions, 'a', now).map((row) => row.count)).toEqual([1, 0, 0]);
});
