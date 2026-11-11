import { describe, expect, test } from 'bun:test';
import { firstReplyText, isRenamable, renameFor, type RenameCandidate } from '../src/lib/sessionRenameQueue';
import { deriveSessionName } from '../src/lib/sessionNames';
import type { ChatMessage } from '../src/types';

const say = (role: 'user' | 'assistant', text: string): ChatMessage =>
  ({ id: `m-${Math.random().toString(36).slice(2, 8)}`, role, text, parts: [], completed: true }) as ChatMessage;

describe('finding the first reply in a transcript', () => {
  test('takes the first assistant message, skipping the human request', () => {
    const messages = [say('user', 'lets close the design gap'), say('assistant', 'I changed sessionNames.ts.')];
    expect(firstReplyText(messages)).toBe('I changed sessionNames.ts.');
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
      { id: 'a', role: 'assistant', text: 'First half. Second half.', parts: [], completed: true },
    ];
    expect(firstReplyText(messages)).toBe('First half. Second half.');
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
    expect(name).toBe(deriveSessionName({ text: REPLY }));
  });

  test('a request that named its own subject is left alone', () => {
    const specific = candidate({ request: 'fix the tray tint on the rail' });
    expect(renameFor(specific, REPLY, [])).toBeNull();
  });
});
