import { describe, expect, test } from 'bun:test';
import { firstReplyText, firstNamingExchange, isRenamable, renameFor, type RenameCandidate } from '../src/lib/sessionRenameQueue';
import type { ChatMessage } from '../src/types';

const say = (role: 'user' | 'assistant', text: string): ChatMessage =>
  ({ id: `m-${Math.random().toString(36).slice(2, 8)}`, role, text, parts: [], completed: true }) as ChatMessage;

describe('finding the first reply in a transcript', () => {
  test('takes the first assistant message, skipping the human request', () => {
    const messages = [say('user', 'lets close the design gap'), say('assistant', 'I changed sessionNames.ts to derive the provisional title from the completed reply.')];
    expect(firstReplyText(messages)).toBe('I changed sessionNames.ts to derive the provisional title from the completed reply.');
  });

  test('ignores a turn that was only tool calls', () => {
    const messages = [
      say('user', 'lets close the design gap'),
      say('assistant', ''),
      say('assistant', 'I changed sessionNames.ts and added tests for the provisional title.'),
    ];
    expect(firstReplyText(messages)).toBe('I changed sessionNames.ts and added tests for the provisional title.');
  });

  test('reads a reply split across parts as one answer', () => {
    const messages: ChatMessage[] = [
      say('user', 'go'),
      { id: 'a', role: 'assistant', text: 'I fixed the login redirect. Returning users now reach their original page.', parts: [
        { type: 'text', id: 'p1', text: 'I fixed the login redirect.' },
        { type: 'text', id: 'p2', text: 'Returning users now reach their original page.' },
      ], completed: true },
    ];
    expect(firstReplyText(messages)).toBe('I fixed the login redirect. Returning users now reach their original page.');
  });

  test('is null when the agent has not spoken yet', () => {
    expect(firstReplyText([say('user', 'hello')])).toBeNull();
    expect(firstReplyText([])).toBeNull();
  });
});

describe('which sessions are worth upgrading', () => {
  const candidate = (over: Partial<RenameCandidate>): RenameCandidate => ({
    key: 'k',
    provisional: true,
    currentTitle: 'Login Locksmith',
    expectedTitle: 'Login Locksmith',
    request: '',
    ...over,
  });

  const REPLY = 'I changed src/lib/sessionNames.ts so the subject comes from the reply, and added tests.';

  test('only sessions still marked provisional are eligible', () => {
    expect(isRenamable(candidate({ provisional: true }))).toBe(true);
    expect(isRenamable(candidate({ provisional: false }))).toBe(false);
  });

  test('a human rename is never overwritten', () => {
    // A person renaming a session clears the mark, so the upgrade never sees it.
    expect(renameFor(candidate({ provisional: false, request: 'lets close the design gap' }), REPLY, [])).toBeNull();
  });

  test('a provisional name with no reply stays put', () => {
    const fresh = candidate({ request: 'lets close the design gap' });
    expect(renameFor(fresh, null, [])).toBeNull();
    expect(renameFor(fresh, 'On it.', [])).toBeNull();
  });

  test('a provisional name from an intent-only request upgrades once a reply lands', () => {
    const name = renameFor(candidate({ request: 'lets close the design gap' }), REPLY, []);
    expect(name).not.toBeNull();
    expect(name).toBe('Test Cartographer');
  });

  test('a request that named its own subject is left alone', () => {
    const specific = candidate({ request: 'fix the tray tint on the rail' });
    expect(renameFor(specific, REPLY, [])).toBeNull();
  });
});

describe('first completed substantive exchange only', () => {
  const answer = 'I fixed the login redirect so returning users reach their original page after signing in.';
  test('skips acknowledgement and live output', () => {
    expect(firstReplyText([say('user', 'fix login'), say('assistant', 'Sure — looking now.'), { ...say('assistant', answer), live: true }, say('assistant', answer)])).toBe(answer);
  });
  test('rejects errors and incomplete replies', () => {
    expect(firstReplyText([{ ...say('assistant', answer), error: 'Failed' }, { ...say('assistant', answer), completed: false }])).toBeNull();
  });
  test('never borrows a later human exchange', () => {
    expect(firstReplyText([say('user', 'fix login'), say('assistant', 'On it.'), say('user', 'now fix the queue'), say('assistant', answer)])).toBeNull();
  });
  test('internal reports are not replies', () => {
    expect(firstReplyText([say('assistant', '[crew] Login redirect tests completed successfully; all workers have finished their tasks.')])).toBeNull();
  });
});

describe('provenance and restart safety', () => {
  const seed = 'Login Locksmith';
  const eligible: RenameCandidate = { key: 'host::chat', provisional: true, request: 'fix login', currentTitle: seed, expectedTitle: seed };
  test('missing seed never enrolls existing history', () => {
    expect(isRenamable({ ...eligible, expectedTitle: undefined })).toBe(false);
    expect(isRenamable({ ...eligible, expectedTitle: '' })).toBe(false);
    expect(isRenamable({ ...eligible, currentTitle: undefined })).toBe(false);
  });
  test('a serialized creation seed survives restart without trusting the transcript', () => {
    const stored = JSON.parse(JSON.stringify({ [eligible.key]: seed })) as Record<string, string>;
    expect(isRenamable({ ...eligible, expectedTitle: stored[eligible.key] })).toBe(true);
    expect(isRenamable({ ...eligible, key: 'old-chat', expectedTitle: stored['old-chat'] })).toBe(false);
  });
  test('manual edits and workers are blocked', () => {
    expect(isRenamable({ ...eligible, currentTitle: 'My login investigation' })).toBe(false);
    expect(isRenamable({ ...eligible, currentTitle: seed.toLowerCase() })).toBe(false);
    expect(isRenamable({ ...eligible, kind: 'worker' })).toBe(false);
  });
});

describe('evidence boundaries', () => {
  const request = 'fix the login redirect';
  const reply = 'I fixed the login redirect so returning users reach their original page after signing in.';
  test('returns both human intent and completed answer after acknowledgement', () => {
    expect(firstNamingExchange([say('user', request), say('assistant', 'On it.'), say('assistant', reply)])).toEqual({ request, reply });
  });
  test('requires a real human opening and never treats internal notices as that opening', () => {
    expect(firstNamingExchange([say('assistant', reply)])).toBeNull();
    expect(firstNamingExchange([say('user', '[crew] investigate login redirect completion'), say('assistant', reply)])).toBeNull();
    expect(firstNamingExchange([say('user', '[crew] workers finished'), say('user', request), say('assistant', reply)])).toEqual({ request, reply });
  });
  test('skips tool-bearing prose, errors, aborts and non-assistant roles', () => {
    const toolStep = { ...say('assistant', reply), parts: [{ type: 'tool', id: 'tool', call: {} }] } as ChatMessage;
    const invalidRole = { ...say('assistant', reply), role: 'system' } as unknown as ChatMessage;
    for (const invalid of [toolStep, invalidRole, { ...say('assistant', reply), error: 'Failed' }, { ...say('assistant', reply), aborted: true }, { ...say('assistant', reply), completed: false }, { ...say('assistant', reply), live: true }]) {
      expect(firstNamingExchange([say('user', request), invalid])).toBeNull();
    }
  });
  test('the final assistant answer wins within the first human exchange only', () => {
    const finalReply = 'I fixed the login redirect and confirmed that returning users reach their original page.';
    expect(firstNamingExchange([say('user', request), say('assistant', reply), say('assistant', finalReply), say('user', 'now fix the database'), say('assistant', 'I changed the database migration and all tests pass successfully now.')])).toEqual({ request, reply: finalReply });
  });
  test('interim substantive prose cannot survive an invalid final assistant entry', () => {
    const toolOnly = { ...say('assistant', ''), parts: [{ type: 'tool', id: 'tool', call: {} }] } as ChatMessage;
    const toolProse = { ...toolOnly, text: reply };
    for (const final of [
      { ...say('assistant', reply), error: 'Failed' },
      { ...say('assistant', reply), aborted: true },
      { ...say('assistant', reply), live: true },
      { ...say('assistant', reply), completed: false },
      toolOnly, toolProse, say('assistant', 'Done.'),
    ]) {
      expect(firstNamingExchange([say('user', request), say('assistant', reply), final])).toBeNull();
    }
  });
  test('a trailing internal notice is not the final assistant answer', () => {
    expect(firstNamingExchange([say('user', request), say('assistant', reply), say('assistant', '[crew] All workers finished their assigned tasks successfully.')])).toEqual({ request, reply });
  });
});

test('refinement preserves the creation character and collision suffix from the exact seed', () => {
  const title = 'Login Gatekeeper 2';
  expect(renameFor({ key: 'chat', provisional: true, request: 'fix login', currentTitle: title, expectedTitle: title },
    'I fixed the login redirect so returning users reach their original page after signing in.', []))
    .toBe('Login Redirect Gatekeeper 2');
});
