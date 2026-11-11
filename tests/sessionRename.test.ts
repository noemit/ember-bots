import { describe, expect, test } from 'bun:test';
import {
  MIN_REPLY_LENGTH,
  replyIsSubstantive,
  upgradedName,
  waitingName,
} from '../src/lib/sessionRename';
import { deriveSessionName } from '../src/lib/sessionNames';

describe('a reply worth renaming from', () => {
  test('needs a sentence, not an acknowledgement', () => {
    expect(replyIsSubstantive('Sure — looking now.')).toBe(false);
    expect(replyIsSubstantive('')).toBe(false);
    expect(replyIsSubstantive(undefined)).toBe(false);
    const long = 'I found the cause: sessionNames.ts builds the subject, and the reply carries it.';
    expect(long.length).toBeGreaterThanOrEqual(MIN_REPLY_LENGTH);
    expect(replyIsSubstantive(long)).toBe(true);
  });
});

describe('the upgrade', () => {
  test('does nothing at all without a substantive reply', () => {
    expect(upgradedName({ request: 'lets close the design gap', reply: 'On it.' })).toBeNull();
    expect(upgradedName({ request: 'lets close the design gap' })).toBeNull();
  });

  test('never displaces a request that already named its subject', () => {
    const name = upgradedName({
      request: 'the login flow needs the token stored somewhere',
      reply: 'I looked at the download queue instead, which turned out to be unrelated to any of it, honestly.',
    });
    expect(name).toBeNull();
  });

  test('uses the reply when the request named no subject at all', () => {
    const request = 'lets close the design gap';
    const reply =
      'I changed src/lib/sessionNames.ts so the subject comes from the reply, and added tests for the provisional title.';
    const name = upgradedName({ request, reply });
    expect(name).not.toBeNull();
    expect(name).toBe(deriveSessionName({ text: reply }));
  });

  test('refuses a reply that names no subject either', () => {
    // A reply made only of acknowledgements: no topic word, no noun a person would recognise.
    const filler = 'Sure. Yes. Okay. Done.';
    expect(upgradedName({ request: 'lets close the design gap', reply: filler })).toBeNull();
  });

  test('a reply of pure acknowledgement is too short to matter anyway', () => {
    expect(upgradedName({ request: 'lets close the design gap', reply: 'Done.' })).toBeNull();
  });

  test('is stable: the same conversation and reply always upgrade to the same name', () => {
    const input = {
      request: 'lets close the design gap',
      reply: 'I changed src/lib/sessionNames.ts so the subject comes from the reply, and added tests.',
    };
    expect(upgradedName(input)).toBe(upgradedName(input));
  });

  test('respects taken names so an upgrade cannot duplicate a neighbour', () => {
    const request = 'lets close the design gap';
    const reply = 'I changed src/lib/sessionNames.ts so the subject comes from the reply.';
    const first = upgradedName({ request, reply });
    expect(first).not.toBeNull();
    const second = upgradedName({ request, reply, taken: [first!] });
    expect(second).not.toBe(first);
  });
});

describe('the waiting placeholder', () => {
  test('is a roster name, never a bare id', () => {
    const name = waitingName('instance|/folder|hello');
    expect(name).not.toMatch(/^\d+$/);
    expect(name.trim().split(/\s+/).length).toBeGreaterThanOrEqual(2);
  });

  test('is deterministic for one conversation', () => {
    expect(waitingName('a|b|c')).toBe(waitingName('a|b|c'));
  });

  test('differs between conversations', () => {
    expect(waitingName('instance|/one|hello')).not.toBe(waitingName('instance|/two|hello'));
  });
});
