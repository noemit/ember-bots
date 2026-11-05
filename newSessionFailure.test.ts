import { describe, expect, test } from 'bun:test';
import {
  newSessionFailureText,
  sessionCreateFailureOf,
  type SessionCreateFailure,
} from './src/lib/newSessionFailure';

/**
 * The draft pane is the only place these sentences appear, and it appears exactly when a session did
 * not start. So the tests are about qualities rather than wording: the actor is named, the reader is
 * told what they can conclude, and there is always something to do next that is already on screen.
 */

/** The shape `src/api.ts` throws: an Error with the HTTP status, 0 for a transport failure. */
class SessionCreateError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'SessionCreateError';
    this.status = status;
  }
}

const LABEL = 'Heliograph';
const DIRECTORY = '/work/ember';

const textOf = (
  failure: SessionCreateFailure,
  directory: string = DIRECTORY,
  instanceLabel: string = LABEL
): string => newSessionFailureText({ failure, instanceLabel, directory });

/** Every kind, with the details a real host sends, plus the awkward ones. */
const CASES: SessionCreateFailure[] = [
  { kind: 'refused', detail: 'the workspace is read-only' },
  { kind: 'refused' },
  { kind: 'refused', detail: 'folder does not exist: /work/gone' },
  { kind: 'host-error', detail: 'the session store is locked' },
  { kind: 'host-error' },
  { kind: 'unreachable' },
  { kind: 'ambiguous' },
  { kind: 'unknown' },
  { kind: 'unknown', detail: 'Error: fetch failed\n    at fetch (node:internal)' },
];

describe('classifying what a failed create tells us', () => {
  test('a 4xx is the host refusing something it understood', () => {
    const failure = sessionCreateFailureOf(new SessionCreateError('folder does not exist: /work/gone', 400));
    expect(failure).toEqual({ kind: 'refused', detail: 'folder does not exist: /work/gone' });
    expect(sessionCreateFailureOf(new SessionCreateError('no such model', 404)).kind).toBe('refused');
  });

  test('a 5xx is the host failing at its own job', () => {
    expect(sessionCreateFailureOf(new SessionCreateError('internal error', 500)).kind).toBe('host-error');
    expect(sessionCreateFailureOf(new SessionCreateError('unavailable', 503)).kind).toBe('host-error');
  });

  test('status 0 means the request never got an answer, and the reason says whether it got through', () => {
    // The create may or may not have happened: this is the case that duplicates sessions.
    expect(sessionCreateFailureOf(new SessionCreateError('Timed out after 20s', 0)).kind).toBe('ambiguous');
    expect(sessionCreateFailureOf(new SessionCreateError('the host stopped partway through', 0)).kind).toBe(
      'ambiguous'
    );
    expect(sessionCreateFailureOf(new SessionCreateError('Hearth lost its connection', 0)).kind).toBe(
      'ambiguous'
    );
    // Nothing got out at all, so there is nothing to check for.
    expect(sessionCreateFailureOf(new SessionCreateError('Failed to fetch', 0)).kind).toBe('unreachable');
    expect(sessionCreateFailureOf(new SessionCreateError('', 0)).kind).toBe('unreachable');
  });

  test('an error with no status is unclassified, and keeps its message for the log only', () => {
    expect(sessionCreateFailureOf(new Error('boom'))).toEqual({ kind: 'unknown', detail: 'boom' });
    expect(sessionCreateFailureOf(undefined)).toEqual({ kind: 'unknown', detail: undefined });
    expect(sessionCreateFailureOf({ message: '   ' })).toEqual({ kind: 'unknown', detail: undefined });
    // Anything that is not a number is not a status.
    expect(sessionCreateFailureOf({ status: '400', message: 'nope' }).kind).toBe('unknown');
  });
});

describe('the sentence in the draft pane', () => {
  test('each kind names the instance that failed', () => {
    for (const failure of CASES) {
      expect(textOf(failure)).toContain(LABEL);
    }
    // Same failure, different host: the sentence follows the label.
    expect(textOf({ kind: 'unreachable' }, DIRECTORY, 'Tower')).toContain('Tower');
    expect(textOf({ kind: 'unreachable' }, DIRECTORY, 'Tower')).not.toContain(LABEL);
  });

  test('never a dead end: every sentence offers a next step that is on screen', () => {
    for (const failure of CASES) {
      expect(textOf(failure)).toMatch(/Try again|Check the rail|Pick another folder/);
    }
  });

  test('no shouting and no jargon: no exclamation, no HTTP code, no undefined, no stack words', () => {
    for (const failure of CASES) {
      const text = textOf(failure);
      expect(text).not.toContain('!');
      expect(text).not.toMatch(/undefined|null|Error:|status|\b(4\d\d|5\d\d)\b/);
    }
  });

  test('the folder case names the folder the attempt was sent with', () => {
    const failure: SessionCreateFailure = { kind: 'refused', detail: 'folder does not exist: /work/gone' };
    expect(textOf(failure, '/work/gone')).toContain('/work/gone');
    expect(textOf(failure, '/work/gone')).toContain("doesn't exist");
    // No folder to name: it still says which thing is wrong.
    expect(textOf(failure, '   ')).toContain("that folder doesn't exist");
    expect(textOf(failure, '')).toContain('Pick another folder');
    // A refusal that is not about the folder is quoted instead, so the picker is not blamed.
    const refusal = textOf({ kind: 'refused', detail: 'the model was withdrawn' });
    expect(refusal).toContain('the model was withdrawn');
    expect(refusal).not.toContain('folder');
  });

  test('a long reason is quoted, not reprinted', () => {
    const detail = `${'x'.repeat(200)}`;
    const text = textOf({ kind: 'refused', detail });
    expect(text).toContain('x'.repeat(160));
    expect(text).not.toContain('x'.repeat(161));
    expect(text.endsWith('Try again.')).toBe(true);
  });

  test('a reason that already ends in a full stop does not produce two', () => {
    const text = textOf({ kind: 'host-error', detail: 'the session store is locked.' });
    expect(text).toBe("Heliograph couldn't start this session: the session store is locked. Try again.");
    expect(text).not.toContain('..');
    expect(textOf({ kind: 'refused', detail: 'nope!' })).not.toContain('!');
  });

  test('a reason that came with a stack is quoted as one line, without its `Error:`', () => {
    const text = textOf({
      kind: 'refused',
      detail: 'Error: the folder is read-only\n    at handler (/srv/hearth/server.js:12:9)',
    });
    expect(text).toBe("Heliograph didn't start this session: the folder is read-only. Try again.");
    expect(text).not.toContain('at handler');
  });

  test('an unclassified failure says the plain thing instead of quoting the wire', () => {
    // `sessionCreateFailureOf` keeps the message for the log; the sentence must not spend it.
    const failure = sessionCreateFailureOf(new Error('TypeError: x is not a function'));
    expect(textOf(failure)).toBe("Heliograph didn't start this session. Try again.");
  });

  test('the ambiguous case asks the reader to look before they retry, and the plain cases do not', () => {
    expect(textOf({ kind: 'ambiguous' })).toContain('may have started this session anyway');
    expect(textOf({ kind: 'ambiguous' })).toContain('Check the rail');
    // Different facts, different sentences: a host that refused is not a host that went quiet.
    expect(textOf({ kind: 'unreachable' })).toContain("isn't answering");
    expect(textOf({ kind: 'refused' })).not.toBe(textOf({ kind: 'host-error' }));
    expect(textOf({ kind: 'host-error' })).toContain("couldn't start");
  });

  test('a missing label still leaves the sentence whole', () => {
    const text = textOf({ kind: 'unreachable' }, DIRECTORY, '  ');
    expect(text).toContain("isn't answering");
    expect(text.startsWith(' ')).toBe(false);
  });
});
