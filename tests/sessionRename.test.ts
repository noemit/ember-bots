import { describe, expect, test } from 'bun:test';
import {
  MIN_REPLY_LENGTH,
  replyIsSubstantive,
  upgradedName,
  waitingName,
} from '../src/lib/sessionRename';

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
    expect(name).toBe('Test Cartographer');
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

describe('completed exchange refinements', () => {
  test('a known topic can earn a concrete, grounded qualifier', () => {
    const name = upgradedName({ request: 'fix the login flow', reply: 'I fixed the login redirect so returning users reach their original page after signing in.' });
    expect(name).toBe('Login Redirect Locksmith');
  });
  test('keeps a specific human subject against a generic test report', () => {
    expect(upgradedName({ request: 'fix sourdough hydration', reply: 'I added tests and verified everything works correctly with the existing suite.' })).toBeNull();
  });
  test('long acknowledgement is not substantive evidence', () => {
    expect(replyIsSubstantive('Sure, I will look into the login redirect and investigate what needs to change.')).toBe(false);
  });
});

describe('measurable specificity without subject drift', () => {
  test.each([
    ['fix the rail tint', 'I fixed the sidebar tint so the active conversation uses its own colour.', 'Rail Tint Cartographer'],
    ['fix the login flow', 'I fixed the login redirect and verified returning users reach the original page.', 'Login Redirect Locksmith'],
    ['fix queue ordering', 'I fixed queue ordering so parked messages remain in the requested sequence.', 'Queue Ordering Sorter'],
    ['fix sourdough hydration', 'I fixed sourdough storage so dough hydration survives overnight refrigeration.', 'Sourdough Persistence Mechanic'],
  ])('%s gains one anchored concrete facet', (request, reply, expected) => {
    expect(upgradedName({ request, reply })).toBe(expected);
  });
  test('human facet wins over an incidental reply facet', () => {
    expect(upgradedName({ request: 'fix the rail tint', reply: 'I fixed the sidebar overflow and tint so the selected chat stays recognizable.' })).toBe('Rail Tint Cartographer');
  });
  test('generic reports and unrelated concrete work leave the title alone', () => {
    for (const reply of [
      'I added tests and verified everything works correctly with the existing suite.',
      'I fixed the database migration so all rows survive the schema upgrade successfully.',
      'The login flow works correctly and all the existing tests pass successfully now.',
    ]) expect(upgradedName({ request: 'fix login', reply })).toBeNull();
  });
  test('code, paths and credentials cannot contribute a new facet', () => {
    expect(upgradedName({ request: 'fix login', reply: 'The login flow works correctly now. https://example.com/redirect token=refresh ```redirect storage```' })).toBeNull();
  });
  test('refined collisions retain the same subject, facet and character', () => {
    const input = { request: 'fix login', reply: 'I fixed the login redirect so users return to their original page after signing in.' };
    expect(upgradedName({ ...input, taken: ['Login Redirect Locksmith', 'Login Redirect Locksmith 2'] })).toBe('Login Redirect Locksmith 3');
  });
});

test('an unrelated initial title cannot replace the human subject', () => {
  expect(upgradedName({ request: 'fix login', initialTitle: 'Queue Porter', reply: 'I fixed the login redirect so returning users reach their original page after signing in.' }))
    .toBe('Login Redirect Locksmith');
});
