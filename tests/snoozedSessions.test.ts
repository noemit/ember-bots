import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSnoozedSessions } from '../electron/transport';
import { DEFAULT_SETTINGS } from '../src/hooks/useEmberSettings';
import { pruneSnoozedSessions, setSessionSnoozed } from '../src/lib/snoozedSessions';

describe('snooze settings validation and migration', () => {
  test('old settings have no snoozes; hide, mute and read state are not a migration source', () => {
    expect(DEFAULT_SETTINGS.snoozedSessions).toEqual([]);
    const old = { mutedSessions: ['host::id'], hiddenInstances: ['host'], readMarks: { 'host::id': { quiet: true } } };
    expect(parseSnoozedSessions((old as Record<string, unknown>).snoozedSessions)).toEqual([]);
    for (const value of [undefined, null, true, 12, 'host::id', {}, { 'host::id': true }]) {
      expect(parseSnoozedSessions(value)).toEqual([]);
    }
  });

  test('keeps distinct host keys and drops duplicates, bare ids, empty parts, controls and oversized keys', () => {
    expect(parseSnoozedSessions([
      'local::same', 'pi:tower::same', 'local::same', 7, null, {}, [], '', 'same',
      '::same', 'local::', 'a::b::c', 'local::id\n', 'local::id\u0000', 'local::id\u007f',
      ' local::same', 'local::has space', 'x'.repeat(501) + '::id',
    ])).toEqual(['local::same', 'pi:tower::same']);
  });

  test('does not inherit the workspace list limit of forty sessions', () => {
    const keys = Array.from({ length: 80 }, (_, i) => `host::${i}`);
    expect(parseSnoozedSessions(keys)).toEqual(keys);
  });

  test('validated snoozes survive a disk reload without altering drafts, read marks or mute', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ember-snoozes-'));
    try {
      const file = join(directory, 'settings.json');
      const original = {
        snoozedSessions: parseSnoozedSessions(['a::same', 'b::same', 'a::same']),
        mutedSessions: ['a::same'], readMarks: { 'b::same': { through: 12 } },
        composerDrafts: { 'a::same': { text: 'Keep my thought' } },
        openSessions: ['a::same'], minimizedSessions: [], sessionNotes: { 'a::same': [{ text: 'later' }] },
      };
      await writeFile(file, JSON.stringify(original));
      const stored = JSON.parse(await readFile(file, 'utf8'));
      const restarted = { ...stored, snoozedSessions: parseSnoozedSessions(stored.snoozedSessions) };
      expect(restarted).toEqual(original);
      expect(restarted.snoozedSessions).toEqual(['a::same', 'b::same']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('manual snooze transitions and conservative pruning', () => {
  test('snooze and wake target the full key, never the same id on another host', () => {
    const current = ['a::same', 'b::same'];
    expect(setSessionSnoozed(current, 'a::same', true)).toEqual(current);
    expect(setSessionSnoozed(current, 'a::same', false)).toEqual(['b::same']);
    expect(setSessionSnoozed(current, 'a::new', true)).toEqual([...current, 'a::new']);
    expect(current).toEqual(['a::same', 'b::same']);
  });

  test('without positive deletion evidence retains every snooze, including hidden and absent sessions', () => {
    const current = ['a::archived', 'a::outside-current-page', 'offline::same'];
    expect(pruneSnoozedSessions(current)).toEqual(current);
    expect(pruneSnoozedSessions(current, { deletedSessionKeys: new Set(), removedInstanceIds: new Set() })).toEqual(current);
  });

  test('prunes only exact deleted keys or explicitly removed hosts', () => {
    const current = ['a::same', 'b::same', 'pi:removed::same', 'pi:removed-too::same', 'a::archived'];
    expect(pruneSnoozedSessions(current, {
      deletedSessionKeys: new Set(['a::same']), removedInstanceIds: new Set(['pi:removed']),
    })).toEqual(['b::same', 'pi:removed-too::same', 'a::archived']);
    expect(current).toHaveLength(5);
  });
});
