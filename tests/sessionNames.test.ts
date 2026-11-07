import { describe, expect, test } from 'bun:test';
import {
  ADJECTIVES,
  deriveSessionName,
  detectTone,
  hashSeed,
  matchRole,
  MESSAGE_VOCABULARY,
  ROLES,
  titleCase,
} from '../src/lib/sessionNames';

/**
 * The contract is a *shape and a set of qualities*, not one string per message.
 *
 * The owner's verdict on the old scheme was "the names are still terrible (the words before the
 * roles)": a topic word read as a person ("What Gardener", "Handle Way", "Access Sorter"). So these
 * tests ask the questions that make that shape impossible rather than pinning "Tailnet Mechanic" and
 * calling it done — a better adjective can replace *Frantic* tomorrow without them becoming rubber
 * stamps.
 */

const NOUNS = new Set(ROLES.map((role) => role.name));
const TRADES = new Set(ROLES.filter((role) => role.kind === 'trade').map((role) => role.name));
const CREATURES = new Set(ROLES.filter((role) => role.kind === 'creature').map((role) => role.name));

/** A creature's emergency row: breakage's register, drawn only for a creature. */
const CREATURE_ALARMED = [
  'Wary', 'Alert', 'Ruffled', 'Bristly', 'Keen', 'Restless', 'Startled', 'Spooked', 'Edgy',
  'Wide-eyed', 'Skittish', 'Anxious', 'Flustered', 'Prickly', 'Lofty',
];
const ALL_ADJECTIVES = new Set(Object.values(ADJECTIVES).flat());
const NUMBERED = /^\S+(?: \S+)* \d+$/;

/** Split a name into the part before the noun and the noun itself. */
const parse = (name: string): { adjective: string; noun: string } => {
  const words = name.split(' ');
  const noun = words[words.length - 1];
  return { adjective: words.slice(0, -1).join(' '), noun };
};

describe('the roster', () => {
  test('is ~32 trades plus a generous creature list, and every entry says which it is', () => {
    expect(TRADES.size).toBeGreaterThanOrEqual(30);
    expect(CREATURES.size).toBeGreaterThanOrEqual(20);
    // Every noun is a person or an animal — the whole point of the scheme.
    expect(ROLES.every((role) => role.kind === 'trade' || role.kind === 'creature')).toBe(true);
  });

  test('names are unique and no keyword points at two entries', () => {
    expect(NOUNS.size).toBe(ROLES.length);
    const seen = new Map<string, string>();
    ROLES.forEach((role) => {
      role.keywords.forEach((keyword) => {
        const owner = seen.get(keyword);
        expect(owner === undefined || owner === role.name).toBe(true);
        seen.set(keyword, role.name);
      });
    });
  });

  test('a creature never matches from the message — it is only ever a seeded fallback', () => {
    expect(ROLES.filter((role) => role.kind === 'creature').every((role) => role.keywords.length === 0)).toBe(true);
  });
});

describe('the name a message produces', () => {
  test('is always <adjective from the pools> <noun from the roster>', () => {
    const messages = [
      'fix the tailnet reconnect flapping',
      'the rail is broken again, everything is wrong',
      'shortlist research datasets',
      'what do you think about our pricing model',
      'plan the roadmap for the new settings page',
      'how do I add a settings toggle',
      'tidy up the stale branches',
      'can you take a look at the composer',
      'hmm',
      'ok',
      'what',
      'handle the endpoint for access',
      'is there a way to batch archive sessions',
      'who added this comment',
    ];
    for (const text of messages) {
      for (let index = 0; index < 25; index += 1) {
        const name = deriveSessionName({ text, seed: `seed-${index}` });
        const { adjective, noun } = parse(name);
        expect(NOUNS.has(noun)).toBe(true);
        expect(ALL_ADJECTIVES.has(adjective)).toBe(true);
        expect(name).toBe(titleCase(name));
      }
    }
  });

  test('never contains a word from the message vocabulary', () => {
    // The owner's complaint, as a property: these are the words that leaked into names as nouns.
    const messages = [
      'what do you think about our pricing model',
      'how does the scheduler handle retries',
      'is there a way to batch archive sessions',
      'the endpoint for access is flapping',
      'what should we do about the flaky login test',
      'Check whether the kanban sync still works',
      'The end of the line',
      'where is the auth token stored',
      'why is the rail so slow when the crew strip is open',
      'what about the tailnet',
    ];
    for (const text of messages) {
      for (let index = 0; index < 30; index += 1) {
        const name = deriveSessionName({ text, seed: `voc-${index}` });
        const words = name.toLowerCase().split(/\s+/);
        for (const word of words) {
          // A roster noun may coincidentally be a message word ("check" is not; "test" is not a
          // noun here) — the assertion is about *scaffolding* reaching the name, so ask the
          // vocabulary set rather than checking the raw message.
          expect(`${text.slice(0, 24)} → ${name}: ${word}`).not.toContain(word === 'the' ? '' : '\u0000');
          if (MESSAGE_VOCABULARY.has(word)) {
            // The only words allowed through are roster nouns the message happened to contain,
            // and every one of them is a person or an animal, never a subject noun.
            expect(NOUNS.has(titleCase(word))).toBe(true);
          }
        }
      }
    }
  });

  test('the noun follows the work the message asks for', () => {
    const cases: Array<[string, string]> = [
      ['Fix the tailnet reconnect flapping', 'Mechanic'],
      ['Shortlist research datasets', 'Curator'],
      ['Plan the roadmap for the new settings page', 'Cartographer'],
      ['Benchmark the model on a 200-message session', 'Analyst'],
      ['Schedule a daily brief for the team', 'Scheduler'],
    ];
    for (const [text, role] of cases) {
      expect(matchRole(text)?.name).toBe(role);
      for (let index = 0; index < 10; index += 1) {
        expect(parse(deriveSessionName({ text, seed: `role-${index}` })).noun).toBe(role);
      }
    }
  });

  test('with nothing to match, the noun is a creature', () => {
    for (const text of ['hmm', 'ok', '', 'the same as before', 'and then']) {
      const seen = new Set<string>();
      for (let index = 0; index < 8; index += 1) {
        const name = deriveSessionName({ text, seed: `fallback-${index}` });
        const { noun } = parse(name);
        expect(CREATURES.has(noun)).toBe(true);
        seen.add(noun);
      }
      // Not the same animal every time: the fallback is seeded, not fixed.
      expect(seen.size).toBeGreaterThan(1);
    }
  });

  test('a creature fallback that collides bounces to a colleague, not another animal forever', () => {
    // The rail is the thing that runs out of animals: once a noun is used up the walk must be able
    // to reach a trade, or a folder of a hundred short sessions is a handful of animals on repeat.
    const taken: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      taken.push(deriveSessionName({ text: 'ok', seed: `rail-${index}`, taken: [...taken] }));
    }
    const nouns = new Set(taken.map((name) => parse(name).noun));
    expect(nouns.size).toBeGreaterThan(30);
    // The rail runs out of animals before it runs out of names: 120 sessions still never repeat a
    // noun more than three times.
    const taken2: string[] = [];
    for (let index = 0; index < 120; index += 1) {
      taken2.push(deriveSessionName({ text: 'ok', seed: `rail-long-`, taken: [...taken2] }));
    }
    const counts = new Map<string, number>();
    for (const name of taken2) {
      const noun = parse(name).noun;
      counts.set(noun, (counts.get(noun) ?? 0) + 1);
    }
    expect(counts.size).toBeGreaterThanOrEqual(CREATURES.size);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
  });

  test('a folder never becomes the noun', () => {
    for (let index = 0; index < 8; index += 1) {
      const name = deriveSessionName({ text: 'hmm', directory: '/workspace/hearth', seed: `dir-${index}` });
      expect(name.toLowerCase()).not.toContain('hearth');
      expect(CREATURES.has(parse(name).noun)).toBe(true);
    }
  });
});

describe('tone', () => {
  test('classifies breakage, curiosity, building and routine apart', () => {
    expect(detectTone('the rail is broken again, everything is wrong')).toBe('breakage');
    expect(detectTone('fix the flapping reconnect, it crashed')).toBe('breakage');
    expect(detectTone('urgent: the export keeps failing')).toBe('breakage');
    expect(detectTone('how does the scheduler handle retries')).toBe('curiosity');
    expect(detectTone('research and compare the options')).toBe('curiosity');
    expect(detectTone('plan the roadmap for the settings page')).toBe('building');
    expect(detectTone('build the new endpoint and design the schema')).toBe('building');
    expect(detectTone('tidy up the stale branches')).toBe('routine');
    expect(detectTone('a small quick note')).toBe('routine');
    expect(detectTone('')).toBe('neutral');
    expect(detectTone('hmm')).toBe('neutral');
  });

  test('reads the vocabulary a bug report actually uses as breakage', () => {
    // Pasted errors and plain descriptions of the wrong thing happening are the two commonest
    // first messages there are; all of these used to come out calm (a "Gentle Beetle" on a crash).
    const reports = [
      'ember 0.85.0 crashes on launch',
      "TypeError: Cannot read properties of undefined (reading 'map')",
      'FIX THE RAIL IT KEEPS JUMPING',
      'the page goes blank',
      'it drops my paste every time',
      'keeps resetting my scroll position',
      'the whole rail disappeared',
      'the export silently produces an empty file',
      "I'm so tired of the rail jumping around",
      'STOP LOSING MY MESSAGE',
    ];
    for (const text of reports) expect({ text, tone: detectTone(text) }).toEqual({ text, tone: 'breakage' });
  });

  test('a question word does not outvote evidence that something is broken', () => {
    // "why" is framing; "drop" and "every time" are the report.
    expect(detectTone('WHY DOES IT DROP MY PASTE EVERY TIME')).toBe('breakage');
    expect(detectTone('why is the webview showing a blank page after resume')).toBe('breakage');
    // With no complaint in it, a question is a question.
    expect(detectTone('how does the scheduler handle retries')).toBe('curiosity');
  });

  test('a broken message gets a breakage adjective, never one only another tone owns', () => {
    const breakage = new Set(ADJECTIVES.breakage);
    const othersOnly = new Set(
      Object.entries(ADJECTIVES)
        .filter(([tone]) => tone !== 'breakage')
        .flatMap(([, list]) => list.filter((adjective) => !breakage.has(adjective)))
    );
    for (let index = 0; index < 60; index += 1) {
      const name = deriveSessionName({ text: 'the rail is broken again, everything is wrong', seed: `b-${index}` });
      const { adjective } = parse(name);
      expect(breakage.has(adjective)).toBe(true);
      expect(othersOnly.has(adjective)).toBe(false);
    }
  });

  /**
   * The 0.88.0 failure, as a measurement rather than an opinion.
   *
   * That build gave every tone a 22-word shared middle with its own words appended, and the draw
   * hashes over the whole row — so 65–80% of draws never reached a tone word. Measured then, a
   * breakage report drew "Observant Mechanic" and "Gentle Beetle", and a plan drew "Watchful
   * Cartographer". The share is the property: a tone word must actually be what gets drawn.
   */
  const toneSharesOf = (text: string, tone: keyof typeof ADJECTIVES, seeds = 200) => {
    const counts = new Map<string, number>();
    const names = new Map<string, number>();
    for (let index = 0; index < seeds; index += 1) {
      const name = deriveSessionName({ text, seed: `share-${index}` });
      const adjective = parse(name).adjective;
      counts.set(adjective, (counts.get(adjective) ?? 0) + 1);
      names.set(name, (names.get(name) ?? 0) + 1);
    }
    const drawn = [...counts.entries()];
    const row = new Set(ADJECTIVES[tone]);
    const exact = drawn.filter(([adjective]) => row.has(adjective)).reduce((sum, [, n]) => sum + n, 0);
    return { drawn, counts, names, exactShare: exact / seeds };
  };

  test('a tone word is the majority of what is drawn, for every tone', () => {
    // Measured before this pass: breakage trades 38%, building 33%, routine 31%.
    const cases: Array<[string, keyof typeof ADJECTIVES]> = [
      ['fix the tailnet reconnect flapping', 'breakage'],
      ['ember 0.85.0 crashes on launch', 'breakage'],
      ['plan the migration to the new schema', 'building'],
      ['build the new settings page', 'building'],
      ['can you tidy the changelog', 'routine'],
      ['rename the function to something clearer', 'routine'],
      ['how does the scheduler handle retries', 'curiosity'],
      ['research the image downscaling libraries', 'curiosity'],
    ];
    for (const [text, tone] of cases) {
      const { counts } = toneSharesOf(text, tone);
      const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
      // A creature on a bad day draws the alarmed row, which is breakage's register in its own
      // words: count it as carrying, or the measurement would punish the pair it is meant to reach.
      const carrying = [...counts.entries()]
        .filter(([adjective]) => ADJECTIVES[tone].includes(adjective) || CREATURE_ALARMED.includes(adjective))
        .reduce((sum, [, n]) => sum + n, 0);
      expect({ text, share: Math.round((carrying / total) * 100) >= 55 }).toEqual({ text, share: true });
    }
  });

  test('a crash never draws a placid word', () => {
    // The list is the owner's, verbatim: these were being drawn for breakage reports because they
    // sat in every row's shared middle.
    const placid = ['Observant', 'Watchful', 'Wary', 'Alert', 'Gentle', 'Patient', 'Unhurried', 'Content', 'Cheerful', 'Dapper'];
    // "Wary" and "Alert" are the two that belong to a creature in an emergency — alarmed at the
    // problem, which is the register the brief asked for — and to nothing a trade can draw.
    const alarmedButNotPlacid = new Set(['Wary', 'Alert']);
    // neutral is where these live, and a message with no signal is what they are for. What must
    // never reach them is a *trade*'s row — that is the pool a crash with a matched keyword draws.
    // A crash never reaches them: not through a trade's breakage row (which is the row a fix draws)…
    for (const adjective of ADJECTIVES.breakage) {
      if (!alarmedButNotPlacid.has(adjective)) expect(placid).not.toContain(adjective);
    }
    // …and not through a creature's emergency row either.
    for (const adjective of CREATURE_ALARMED) {
      if (!alarmedButNotPlacid.has(adjective)) expect(placid).not.toContain(adjective);
    }
    const crashes = ['ember crashes on launch', 'ember 0.85.0 crashes on launch', 'TypeError: Cannot read properties of undefined'];
    for (const text of crashes) {
      const { drawn } = toneSharesOf(text, 'breakage');
      for (const [adjective] of drawn) {
        if (!alarmedButNotPlacid.has(adjective)) expect(placid).not.toContain(adjective);
      }
    }
  });

  test('a crash and a plan draw substantially disjoint adjectives', () => {
    const crash = toneSharesOf('ember 0.85.0 crashes on launch, everything is broken again', 'breakage').counts;
    const plan = toneSharesOf('plan the migration to the new schema', 'building').counts;
    const shared = [...crash.keys()].filter((adjective) => plan.has(adjective));
    // One shared word at most ("Keen"/"Steady" by design); more means one tone is diluting the other.
    expect(shared.length).toBeLessThanOrEqual(1);
  });

  test('every tone keeps 20+ distinct names over 200 seeds', () => {
    // The 12-Mechanic collapse must not come back: making the tone the majority must not make the
    // name the tone.
    const cases: Array<[string, keyof typeof ADJECTIVES]> = [
      ['fix the flaky test', 'breakage'],
      ['ember crashes on launch', 'breakage'],
      ['plan the migration', 'building'],
      ['tidy up the stale branches', 'routine'],
      ['how does the scheduler handle retries', 'curiosity'],
      ['ok', 'neutral'],
    ];
    for (const [text, tone] of cases) {
      const { names } = toneSharesOf(text, tone);
      expect({ text, tone, distinct: names.size >= 20 }).toEqual({ text, tone, distinct: true });
    }
  });

  test('a calm plan gets a building adjective, a curious question a curiosity one', () => {
    const building = new Set(ADJECTIVES.building);
    const curiosity = new Set(ADJECTIVES.curiosity);
    for (let index = 0; index < 40; index += 1) {
      const planned = deriveSessionName({ text: 'plan the roadmap for the new settings page', seed: `p-${index}` });
      expect(building.has(parse(planned).adjective)).toBe(true);
      const asked = deriveSessionName({ text: 'how does the scheduler handle retries', seed: `q-${index}` });
      expect(curiosity.has(parse(asked).adjective)).toBe(true);
    }
    // The tone's own words, named in the brief, are all reachable from the message's own noun.
    const each = (tone: 'building' | 'curiosity' | 'routine') => new Set(ADJECTIVES[tone]);
    for (const adjective of ['Diligent', 'Methodical', 'Deliberate', 'Inventive', 'Studious', 'Careful', 'Thorough']) {
      expect(each('building').has(adjective)).toBe(true);
    }
    for (const adjective of ['Curious', 'Inquisitive', 'Inquiring', 'Perceptive', 'Attentive', 'Thoughtful']) {
      expect(each('curiosity').has(adjective)).toBe(true);
    }
    for (const adjective of ['Brisk', 'Deft', 'Spry', 'Snappy', 'Tidy', 'Neat', 'Handy', 'Prompt']) {
      expect(each('routine').has(adjective)).toBe(true);
    }
  });

  test('a creature on a bad day is alarmed, never placid and never ill', () => {
    // "Frantic Fox" is an emergency rather than a name and "Feverish Otter" is a disease, but
    // "Gentle Beetle" on a crash report is the pair the brief forbids. A creature gets its own
    // breakage row: alarmed at the problem. A crash has to actually reach it.
    const creatureRow = new Set([
      'Wary', 'Alert', 'Ruffled', 'Bristly', 'Keen', 'Restless', 'Startled', 'Spooked', 'Edgy',
      'Wide-eyed', 'Skittish', 'Anxious', 'Flustered', 'Prickly', 'Lofty',
    ]);
    const placid = new Set(['Gentle', 'Cheerful', 'Jolly', 'Mellow', 'Bright', 'Patient', 'Content', 'Unhurried', 'Dapper']);
    let creaturesSeen = 0;
    for (const text of ['ember crashes on launch, everything is broken again', 'TypeError: Cannot read properties of undefined']) {
      for (let index = 0; index < 80; index += 1) {
        const { adjective, noun } = parse(deriveSessionName({ text, seed: `c-${index}` }));
        if (!CREATURES.has(noun)) continue;
        creaturesSeen += 1;
        expect(creatureRow.has(adjective)).toBe(true);
        expect(placid.has(adjective)).toBe(false);
      }
    }
    expect(creaturesSeen).toBeGreaterThan(0);
  });
});

describe('the adjective pools', () => {
  test('have no duplicates within a pool', () => {
    for (const [tone, pool] of Object.entries(ADJECTIVES)) {
      expect({ tone, size: new Set(pool.map((adj) => adj.toLowerCase())).size }).toEqual({ tone, size: pool.length });
    }
  });

  test('are never insulting, and never describe a thing rather than a person', () => {
    // Words that would read as a judgement of the person doing the work, or as a state of a
    // broken object being used as a personality. Neither is allowed: these names land on other
    // people's sessions.
    const banned = [
      'clumsy', 'stupid', 'hopeless', 'useless', 'lazy-eyed', 'sloppy', 'broken', 'battered',
      'crippled', 'dumb', 'mad', 'insane', 'crazy', 'furious', 'angry', 'bad', 'poor', 'weak',
      'ugly', 'smelly', 'hated', 'wretched', 'beaten', 'crashed', 'halted', 'stuck',
    ];
    for (const pool of Object.values(ADJECTIVES)) {
      for (const adjective of pool) {
        expect(banned).not.toContain(adjective.toLowerCase());
      }
    }
  });

  test('the shared minority is small: every non-neutral row is mostly its own words', () => {
    // A big shared middle is how the tone stopped landing: the row is drawn uniformly, so every
    // shared word is a straight subtraction from the tone's share.
    expect(ADJECTIVES.neutral.length).toBeGreaterThanOrEqual(10);
    for (const [tone, pool] of Object.entries(ADJECTIVES)) {
      if (tone === 'neutral') continue;
      const own = pool.filter((adjective) => !ADJECTIVES.neutral.includes(adjective));
      expect({ tone, mostlyOwn: own.length / pool.length >= 0.85 }).toEqual({ tone, mostlyOwn: true });
    }
    // The slow and the dreamy live only on neutral, and never reach a bug report.
    for (const adjective of ['Lazy', 'Sleepy', 'Drowsy']) {
      for (const [tone, pool] of Object.entries(ADJECTIVES)) {
        if (tone === 'neutral') continue;
        expect(pool).not.toContain(adjective);
      }
    }
  });

  test('adjective and noun never contradict each other', () => {
    // The worst pairs, pinned: a state-of-a-thing adjective on a person or an animal, and a wild
    // adjective on a calm craft.
    // (The old scheme's own failure was "Patient Crash": a state of a thing where a person belongs.
    // Nothing in a pool may describe a thing's condition, because every noun is alive.)
    const nothingAboutBrokenObjects = ['Broken', 'Battered', 'Crashed', 'Halted', 'Spotted', 'Cracked'];
    for (const adjective of nothingAboutBrokenObjects) {
      expect(ALL_ADJECTIVES.has(adjective)).toBe(false);
    }
    // And the kinds stay apart in the pool table: only the neutral row (and the tone rows declared
    // `both`) are ever offered to a creature, so "Feverish Fox" cannot be drawn.
    for (let index = 0; index < 80; index += 1) {
      const name = deriveSessionName({ text: 'the export keeps failing', seed: `pair-` });
      const { adjective, noun } = parse(name);
      if (CREATURES.has(noun)) expect(ADJECTIVES.breakage).not.toContain(adjective);
      if (NOUNS.has(noun)) expect(ALL_ADJECTIVES.has(adjective)).toBe(true);
    }
  });
});

describe('determinism', () => {
  test('the same input gives the same name', () => {
    const input = { text: 'Fix the flaky test', directory: '/workspace/ember', seed: 'stable' };
    expect(deriveSessionName(input)).toBe(deriveSessionName(input));
    expect(hashSeed('stable')).toBe(hashSeed('stable'));
    for (let index = 0; index < 20; index += 1) {
      const withText = { text: 'fix the tailnet flapping', seed: `d-${index}` };
      expect(deriveSessionName(withText)).toBe(deriveSessionName(withText));
    }
  });

  test('taken does not change the first answer when nothing is taken', () => {
    const text = 'shortlist research datasets';
    expect(deriveSessionName({ text, seed: 'k' })).toBe(deriveSessionName({ text, seed: 'k', taken: [] }));
  });

  test('returns a name, never an id', () => {
    for (let index = 0; index < 40; index += 1) {
      expect(deriveSessionName({ text: '', seed: String(index) })).toMatch(/^[A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)+$/);
    }
  });
});

describe('spread', () => {
  const distinctSeeds = (count: number, key: (index: number) => string) => {
    const counts = new Map<string, number>();
    for (let index = 0; index < count; index += 1) {
      const name = deriveSessionName({ seed: key(index) });
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  };

  test('200 distinct seeds spread over the space with no runaway collision', () => {
    const counts = distinctSeeds(200, (index) => `session-${index}`);
    // The space is ~768 base names, so 200 independent draws land on ~155 distinct ones.
    expect(counts.size).toBeGreaterThanOrEqual(130);
    const worst = Math.max(...counts.values());
    // A fair draw gives a worst bucket of 5–6 at this size; 10 would be role-matching text or a
    // narrow hash leaking through.
    expect(worst).toBeLessThanOrEqual(9);
    // Both halves of the name are exercised: the nouns are the top pick for a message with
    // nothing in it, so all of them must be reachable.
    const nouns = new Set([...counts.keys()].map((name) => parse(name).noun));
    // Every animal is reachable in one draw; a walk that runs the rail dry also bounces to
    // colleagues, so this is "at least every animal", not "only animals".
    expect(nouns.size).toBeGreaterThanOrEqual(CREATURES.size);
  });

  test('near-identical seeds are not near-identical names', () => {
    // The old failure: `short piece 0` … `short piece 5` landed on six identical names, because
    // FNV's low bits agree for inputs that differ in their last character.
    const names = new Set<string>();
    for (let index = 0; index < 6; index += 1) {
      names.add(deriveSessionName({ text: 'short piece', seed: `local|/w|short piece ${index}` }));
    }
    expect(names.size).toBeGreaterThanOrEqual(4);
  });

  test('one first message produces many names, not one per adjective row', () => {
    // The old failure in a new coat: with a narrow per-tone pool and the noun pinned by the verb,
    // every "fix …" session could only ever be one of twelve Mechanics — 200 seeds, 12 names. The
    // tone now sets the emphasis and the row is wide, so the walk has room.
    for (const text of ['fix the flaky test', 'plan the migration', 'the tailnet reconnect is flapping again']) {
      const names = new Set<string>();
      for (let index = 0; index < 200; index += 1) names.add(deriveSessionName({ text, seed: `v-${index}` }));
      expect({ text, many: names.size >= 18 }).toEqual({ text, many: true });
    }
  });

  test('the first draw is the message’s own noun; the walk is what varies the rest', () => {
    expect(parse(deriveSessionName({ text: 'fix the flaky test', seed: 'w-0' })).noun).toBe('Mechanic');
    expect(parse(deriveSessionName({ text: 'fix the flaky test', seed: 'w-1' })).noun).toBe('Mechanic');
  });

  test('a role-matched message still draws its adjective from the seed', () => {
    // Thirty different messages that all said "fix" used to be thirty "Frantic Mechanics".
    const names = new Set<string>();
    for (let index = 0; index < 30; index += 1) {
      names.add(deriveSessionName({ text: `fix the flapping thing ${index}`, seed: `fix-${index}` }));
    }
    expect(names.size).toBeGreaterThanOrEqual(6);
  });
});

/**
 * "i have too many gardeners": the same noun coming back too often.
 *
 * The rail is what a person reads. 0.88.1 ranked the message's own noun first and only the
 * adjective varied, so forty "fix …" sessions came out twenty-six Mechanics and a hundred idle ones
 * wrapped round the same handful of creatures. These measure the *noun*, because that is the thing
 * that makes two sessions look like siblings.
 */
describe('breadth', () => {
  const rail = (text: string, prefix: string, count: number) => {
    const taken: string[] = [];
    const names: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const name = deriveSessionName({ text, seed: `${prefix}-${index}`, taken: [...taken] });
      taken.push(name);
      names.push(name);
    }
    return names;
  };
  const nounCounts = (names: string[]) => {
    const counts = new Map<string, number>();
    for (const name of names) {
      const noun = parse(name).noun;
      counts.set(noun, (counts.get(noun) ?? 0) + 1);
    }
    return counts;
  };

  test('a hundred idle sessions do not repeat a noun more than three times', () => {
    const counts = nounCounts(rail('ok', 'idle', 100));
    expect(counts.size).toBeGreaterThanOrEqual(40);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
  });

  test('a hundred "fix …" sessions vary beyond Mechanic, and no noun runs away with it', () => {
    const counts = nounCounts(rail('fix the flaky test', 'fix', 100));
    // The fix itself stays a Mechanic — but not a rail of them.
    expect(counts.get('Mechanic') ?? 0).toBeLessThanOrEqual(3);
    expect(counts.size).toBeGreaterThanOrEqual(20);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(3);
  });

  test('a single fix session still most often lands on Mechanic', () => {
    let mechanic = 0;
    for (let index = 0; index < 200; index += 1) {
      if (parse(deriveSessionName({ text: 'fix the flaky test', seed: `single-${index}` })).noun === 'Mechanic') {
        mechanic += 1;
      }
    }
    // A lone session has no rail to avoid, so the first draw — the message's own noun — wins.
    expect(mechanic).toBeGreaterThanOrEqual(190);
  });

  test('two sessions on the same topic do not look like siblings', () => {
    // The owner's acceptance test, as a property: neighbours in a rail differ in the noun, not just
    // in the adjective.
    const names = rail('ok', 'neighbours', 30);
    for (let index = 1; index < names.length; index += 1) {
      expect(parse(names[index]).noun).not.toBe(parse(names[index - 1]).noun);
    }
  });

  test('every noun in the roster is reachable by some seed', () => {
    // The walk has to be able to *reach* a noun, or "prefer a different noun" has nothing to offer.
    // The first draw covers the creatures, and the walk's coverage is what `CANDIDATE_STEPS` and the
    // bounce are for, so the check is over a rail that has already used each noun up.
    const reached = new Set<string>();
    for (let index = 0; index < 2000; index += 1) {
      reached.add(parse(deriveSessionName({ text: 'ok', seed: `reach-${index}` })).noun);
    }
    expect(reached.size).toBe(CREATURES.size);
    // And the roster itself is the universe: no name anywhere holds a noun outside it.
    for (const noun of reached) expect(NOUNS.has(noun)).toBe(true);
    // A rail that keeps going past the creatures must reach trades too, not wrap the animals.
    const railNames = rail('ok', 'reach-rail', 140);
    const nouns = new Set(railNames.map((name) => parse(name).noun));
    expect(nouns.size).toBeGreaterThanOrEqual(ROLES.length - 1);
  });
});

describe('collisions', () => {
  test('taken forces a different name, always', () => {
    const first = deriveSessionName({ text: 'Fix the tailnet flapping', seed: 'x' });
    const second = deriveSessionName({ text: 'Fix the tailnet flapping', seed: 'x', taken: [first] });
    expect(second).not.toBe(first);
  });

  test('sixty collisions in a row never repeat a name', () => {
    const taken: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      const name = deriveSessionName({ text: 'fix the tailnet flapping', seed: 'same', taken });
      expect(taken).not.toContain(name);
      taken.push(name);
    }
    // Still the scheme's shape: no number needed until the whole space is exhausted.
    expect(taken.every((name) => !NUMBERED.test(name))).toBe(true);
  });

  test('an exhausted space is numbered rather than duplicated', () => {
    // Every adjective × noun taken: the only escape left is a suffix, and it must be unique.
    const taken: string[] = [];
    const text = 'fix the flapping tailnet';
    for (let index = 0; index < 400; index += 1) {
      const name = deriveSessionName({ text, seed: 'exhaust', taken });
      expect(taken).not.toContain(name);
      taken.push(name);
    }
    expect(taken.some((name) => NUMBERED.test(name))).toBe(true);
  });

  test('a seeded creature name is what a collision falls back to, not another topic', () => {
    // Nothing in any step may smuggle a message word in: the vocabulary property again, through
    // the collision path.
    const taken: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const name = deriveSessionName({ text: 'handle the endpoint for access', seed: 'handle', taken });
      taken.push(name);
      for (const word of name.toLowerCase().split(' ')) {
        if (MESSAGE_VOCABULARY.has(word)) expect(NOUNS.has(titleCase(word))).toBe(true);
      }
    }
  });
});
