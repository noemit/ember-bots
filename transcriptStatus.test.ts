import { describe, expect, test } from 'bun:test';
import {
  RETRY_HINT,
  type TranscriptState,
  isSettledFailure,
  startupNotice,
  transcriptNotice,
} from './src/lib/transcriptStatus';

const error = (failure?: TranscriptState['failure']): TranscriptState =>
  failure === undefined ? { status: 'error' } : { status: 'error', failure };

// The bug this module exists for: a fetch that lost a race with Hearth's cold start used to paint
// "Couldn't reach this session — retrying…" in destructive red.
test('a transient failure is a waiting state, never a destructive failure', () => {
  for (const failure of ['poll', 'tail', 'initial'] as const) {
    expect(transcriptNotice({ state: error(failure), messagesEmpty: true }).kind).toBe('waiting');
  }
});

test('an unreachable host is named, and the empty pane is not blamed on the session', () => {
  const notice = transcriptNotice({
    state: error('initial'),
    messagesEmpty: true,
    instanceStatus: 'unreachable',
    instanceLabel: 'Tower',
  });
  // Waiting, not destructive: nothing is broken and Ember is still trying.
  expect(notice.kind).toBe('waiting');
  const text = notice.kind === 'waiting' ? notice.text : '';
  expect(text).toContain('Tower');
  // Names the host's state and what the reader can conclude, rather than describing it as a
  // session that would not load.
  expect(text).toMatch(/isn.t answering|not answering/i);
  expect(text).toMatch(/asleep|network/i);
  expect(text).not.toMatch(/this session wouldn.t load/i);
  expect(text).not.toContain('!');
  // Without a label it still names the party that is not answering.
  const unlabelled = transcriptNotice({ state: error('poll'), messagesEmpty: true, instanceStatus: 'unreachable' });
  expect(unlabelled.kind === 'waiting' ? unlabelled.text : '').toContain('ember-harness');
  // A probe still out is the cold-boot sentence, which is a different fact from an outage.
  expect(
    transcriptNotice({ state: error('poll'), messagesEmpty: true, instanceStatus: 'checking', instanceLabel: 'Tower' })
  ).toEqual({ kind: 'waiting', text: 'Tower is still starting up — waiting for it to answer…' });
  // A connected instance that refused one read is a different sentence from an absent one.
  expect(
    transcriptNotice({ state: error('poll'), messagesEmpty: true, instanceStatus: 'ready' })
  ).toEqual({ kind: 'waiting', text: `Haven't loaded this session yet. ${RETRY_HINT}` });
});

test('a settled failure keeps the destructive treatment', () => {
  const notice = transcriptNotice({ state: error('reload'), messagesEmpty: true });
  expect(notice.kind).toBe('failed');
  // An untagged `error` is the historical reload shape, so it must not be swallowed.
  expect(transcriptNotice({ state: error(), messagesEmpty: true }).kind).toBe('failed');
  expect(isSettledFailure(error())).toBe(true);
  expect(isSettledFailure(error('reload'))).toBe(true);
  expect(isSettledFailure(error('poll'))).toBe(false);
  expect(isSettledFailure(error('tail'))).toBe(false);
  expect(isSettledFailure(error('initial'))).toBe(false);
});

/**
 * Copy is the product, and an error is the moment a reader most needs a sentence that helps. These
 * pin the qualities rather than the exact wording, so the message can be rewritten for the better
 * without the test becoming a rubber stamp for a dead end.
 */
describe('error copy', () => {
  const failed = (instanceStatus?: 'ready' | 'unreachable', instanceLabel?: string) => {
    const notice = transcriptNotice({
      state: error('reload'),
      messagesEmpty: true,
      instanceStatus,
      instanceLabel,
    });
    return notice.kind === 'failed' ? notice.text : '';
  };

  test('never a dead end: it says what happened and what to try', () => {
    const text = failed('ready');
    expect(text.length).toBeGreaterThan(20);
    // Points at the recovery that is already on screen.
    expect(text.toLowerCase()).toMatch(/refresh|try again/);
  });

  test('blames the right party, and names it when it can', () => {
    const reachable = failed('ready');
    const unreachable = failed('unreachable', 'Tower');
    expect(reachable).not.toMatch(/Tower/);
    expect(unreachable).toMatch(/Tower/);
    // A host that did not answer is a different fact from a session that would not load.
    expect(unreachable).not.toBe(reachable);
  });

  test('says what the reader can conclude about the host', () => {
    expect(failed('unreachable', 'Tower')).toMatch(/asleep|network|back/i);
  });

  test('no shouting and no jargon: no exclamation, no HTTP status, no stack words', () => {
    for (const text of [failed('ready'), failed('unreachable', 'Tower')]) {
      expect(text).not.toContain('!');
      expect(text).not.toMatch(/\b(4\d\d|5\d\d|undefined|null|error:)\b/i);
    }
  });
});

test('ready and loading have nothing to announce', () => {
  expect(transcriptNotice({ state: { status: 'ready' }, messagesEmpty: true })).toEqual({ kind: 'none' });
  expect(transcriptNotice({ state: { status: 'loading' }, messagesEmpty: true })).toEqual({ kind: 'none' });
});

// The regression that mattered most: a readable transcript must never be covered by an error bar.
test('a transcript that already has messages never shows a fetch notice', () => {
  for (const state of [error('initial'), error('poll'), error('reload'), error()]) {
    expect(transcriptNotice({ state, messagesEmpty: false })).toEqual({ kind: 'none' });
  }
});

test('startup says what it is doing instead of looking empty', () => {
  const base = { bootstrapping: false, waitingForSessions: 0, unreachable: 0, sessionCount: 0 };
  expect(startupNotice(base)).toBeNull();
  expect(startupNotice({ ...base, waitingForSessions: 1 })).toBe(
    'Connecting to ember-harness and loading your sessions…'
  );
  // Counting as it fills makes it legible that work is progressing rather than stalled.
  expect(startupNotice({ ...base, waitingForSessions: 2, sessionCount: 7 })).toBe(
    'Loading your sessions — 7 so far…'
  );
  expect(startupNotice({ ...base, bootstrapping: true })).toBe('Starting up…');
  // Once sessions are listed, a mid-boot bootstrap is no longer the interesting fact.
  expect(startupNotice({ ...base, bootstrapping: true, sessionCount: 7 })).toBeNull();
  expect(startupNotice({ ...base, unreachable: 1 })).toBe('ember-harness is not answering yet — still trying.');
  expect(startupNotice({ ...base, unreachable: 2 })).toBe(
    '2 ember-harness instances are not answering yet — still trying.'
  );
  // Waiting for a list outranks the reachability verdict: the list is the thing in progress.
  expect(startupNotice({ ...base, waitingForSessions: 1, unreachable: 2 })).toBe(
    'Connecting to ember-harness and loading your sessions…'
  );
});
