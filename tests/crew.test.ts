import { describe, expect, test } from 'bun:test';
import {
  threadDescendants,
  workerKeySet,
  threadShelfStatus,
  blockedWorkersAmong,
  brickStatusSignal,
  blockedWorkersUnder,
  crewByLeader,
  crewDepth,
  crewIsResting,
  CREW_BRICK_TINT,
  isWorker,
  leaderBrickEdge,
  leaderBrickStyle,
  leaderBrickWash,
  leaderNeedsInput,
  parseCrewReport,
  promotionNameFor,
  splitCrew,
  workerStateLabel,
} from '../src/lib/crew';
import { BUDDY_COLORS } from '../src/blob/buddy';
import { contrastRatio, identityPaletteFor } from '../src/blob/contrast';
import { THEMES } from '../src/themes';
import { sessionKey, type Session } from '../src/types';

/** A session stub; `instanceId` is fixed so keys read `hearth::<id>`. */
const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  instanceId: 'hearth',
  ...extra,
});

/** A worker with `lead` pointing at another session id on the same instance. */
const worker = (id: string, leadId: string, extra: Partial<Session> = {}): Session =>
  session(id, {
    kind: 'worker',
    lead: { instanceId: 'hearth', sessionId: leadId },
    ...extra,
  });

describe('isWorker', () => {
  test('only kind "worker" is a crew worker; peers and plain sessions are not', () => {
    expect(isWorker(worker('2', '1'))).toBe(true);
    expect(isWorker(session('3', { kind: 'peer' }))).toBe(false);
    expect(isWorker(session('4'))).toBe(false);
  });
});

describe('crewByLeader', () => {
  test('groups workers under their leader key, skipping peers, plain sessions and leadless workers', () => {
    const leader = session('1');
    const a = worker('2', '1', { title: 'Parse config' });
    const b = worker('3', '1', { title: 'Migrate schema' });
    const peer = session('4', { kind: 'peer', lead: { instanceId: 'hearth', sessionId: '1' } });
    const plain = session('5');
    const leadless = session('6', { kind: 'worker' });

    const crews = crewByLeader([leader, a, b, peer, plain, leadless]);
    expect([...crews.keys()]).toEqual(['hearth::1']);
    expect(crews.get('hearth::1')).toEqual([a, b]);
  });

  test('keeps separate groups per leader and key on the leader instance', () => {
    const a = worker('2', '1');
    const b = session('3', { kind: 'worker', lead: { instanceId: 'other', sessionId: '1' } });
    const crews = crewByLeader([a, b]);
    expect(crews.get('hearth::1')).toEqual([a]);
    expect(crews.get('other::1')).toEqual([b]);
    expect(crews.size).toBe(2);
  });
});

describe('leaderNeedsInput', () => {
  test('is false when nothing needs input and true for the leader itself', () => {
    const leader = session('1');
    expect(leaderNeedsInput(leader, [leader, worker('2', '1')])).toBe(false);
    expect(leaderNeedsInput(session('1', { needsInput: true }), [])).toBe(true);
    expect(leaderNeedsInput(leader, [], true)).toBe(true);
  });

  test('rolls a direct worker need up to the leader', () => {
    const leader = session('1');
    const w = worker('2', '1', { needsInput: true });
    expect(leaderNeedsInput(leader, [leader, w])).toBe(true);
  });

  test('rolls a depth-3 need up through intermediate workers', () => {
    const leader = session('1');
    const w1 = worker('2', '1');
    const w2 = worker('3', '2');
    const w3 = worker('4', '3', { needsInput: true });
    expect(leaderNeedsInput(leader, [leader, w1, w2, w3])).toBe(true);
    // And the intermediate worker sees it too.
    expect(leaderNeedsInput(w1, [leader, w1, w2, w3])).toBe(true);
    // With the deepest need removed, nothing rolls up.
    const calm = worker('4', '3');
    expect(leaderNeedsInput(leader, [leader, w1, w2, calm])).toBe(false);
  });

  test('does not follow a peer that keeps its lead as history', () => {
    const leader = session('1');
    const peer = session('2', {
      kind: 'peer',
      lead: { instanceId: 'hearth', sessionId: '1' },
      needsInput: true,
    });
    expect(leaderNeedsInput(leader, [leader, peer])).toBe(false);
  });

  test('a lead cycle terminates', () => {
    const a = worker('a', 'b');
    const b = worker('b', 'c');
    const c = worker('c', 'a');
    expect(leaderNeedsInput(a, [a, b, c])).toBe(false);
    const needing = worker('c', 'a', { needsInput: true });
    expect(leaderNeedsInput(a, [a, b, needing])).toBe(true);
  });
});

describe('workerStateLabel', () => {
  test('maps needsInput, coarse state and reported to a label', () => {
    expect(workerStateLabel(worker('2', '1', { needsInput: true }))).toBe('needs input');
    expect(workerStateLabel(worker('2', '1'), { state: 'active' })).toBe('working');
    expect(workerStateLabel(worker('2', '1'), { state: 'error' })).toBe('failed');
    expect(workerStateLabel(worker('2', '1'), { state: 'idle', reported: true })).toBe('reported');
    expect(workerStateLabel(worker('2', '1'), { state: 'idle' })).toBe('idle');
  });

  test('no answer is unknown, not idle — and a report is still a fact', () => {
    // A caller with no state source, and a host that answered `unknown`, both land here.
    expect(workerStateLabel(worker('2', '1'))).toBe('unknown');
    expect(workerStateLabel(worker('2', '1'), { state: 'unknown' })).toBe('unknown');
    // A report is knowledge from the transcript, so it outranks a missing status.
    expect(workerStateLabel(worker('2', '1'), { state: 'unknown', reported: true })).toBe('reported');
    // A worker that is explicitly asking is known regardless.
    expect(workerStateLabel(worker('2', '1', { needsInput: true }), { state: 'unknown' })).toBe('needs input');
  });

  test('needsInput wins over a coarse state', () => {
    expect(workerStateLabel(worker('2', '1', { needsInput: true }), { state: 'active' })).toBe('needs input');
    expect(workerStateLabel(worker('2', '1'), { state: 'needs-input' })).toBe('needs input');
  });
});

describe('promotionNameFor', () => {
  test('seeds the promote dialog with the worker title, trimmed, else Worker <id>', () => {
    expect(promotionNameFor(worker('7', '1', { title: 'Parse config' }))).toBe('Parse config');
    expect(promotionNameFor(worker('7', '1', { title: '  padded  ' }))).toBe('padded');
    expect(promotionNameFor(worker('7', '1'))).toBe('Worker 7');
    expect(promotionNameFor(worker('7', '1', { title: '   ' }))).toBe('Worker 7');
  });
});

describe('parseCrewReport', () => {
  test('recognizes the [crew] wake prefix and returns its body', () => {
    expect(parseCrewReport('[crew] Crew report (generation 2): Parse config finished.')).toEqual({
      summary: 'Crew report (generation 2): Parse config finished.',
      kind: 'crew',
    });
    expect(parseCrewReport('  [crew]   spaced body  ')).toEqual({ summary: 'spaced body', kind: 'crew' });
  });

  test('recognizes a side-question report and distinguishes it from a crew report', () => {
    expect(
      parseCrewReport('[crew] Side question:\nYou asked: "what port?"\nAside #1 (reported): 3002')
    ).toEqual({
      summary: 'You asked: "what port?"\nAside #1 (reported): 3002',
      kind: 'side-question',
    });
  });

  test('leaves normal user messages alone', () => {
    expect(parseCrewReport('hello there')).toBeNull();
    expect(parseCrewReport('[crew]')).toBeNull();
    expect(parseCrewReport('[crew]    ')).toBeNull();
    expect(parseCrewReport('crew report')).toBeNull();
  });
});

describe('crewIsResting', () => {
  const worker = (id: string, overrides: Partial<Session> = {}): Session =>
    ({ id, instanceId: 'pi:hearth', kind: 'worker', ...overrides }) as Session;

  test('is resting when every worker is known to be idle', () => {
    expect(crewIsResting([worker('a'), worker('b')], () => 'idle')).toBe(true);
    expect(crewIsResting([])).toBe(true);
  });

  test('is not resting when a worker needs input or is working', () => {
    expect(crewIsResting([worker('a'), worker('b', { needsInput: true })])).toBe(false);
    expect(crewIsResting([worker('a'), worker('b')], (s) => (s.id === 'b' ? 'active' : 'idle'))).toBe(false);
  });

  test('is not resting when a worker has no status answer', () => {
    // "Resting" is a claim that nothing more is coming. Without an answer, say nothing.
    expect(crewIsResting([worker('a'), worker('b')])).toBe(false);
    expect(crewIsResting([worker('a'), worker('b')], (s) => (s.id === 'b' ? 'unknown' : 'idle'))).toBe(false);
  });
});

describe('splitCrew', () => {
  const worker = (id: string, extra: Partial<Session> = {}): Session =>
    ({ id, instanceId: 'pi:hearth', kind: 'worker', ...extra }) as Session;

  test('keeps working and asking workers live, and finished ones in previous', () => {
    const busy = worker('busy');
    const asking = worker('asking', { needsInput: true });
    const done = worker('done');
    const { live, previous } = splitCrew([busy, asking, done], (s) => (s.id === 'busy' ? 'active' : 'idle'));
    expect(live.map((s) => s.id)).toEqual(['busy', 'asking']);
    expect(previous.map((s) => s.id)).toEqual(['done']);
  });

  test('an unknown worker stays live: it is not finished, and it is not resting', () => {
    const unknown = worker('unknown');
    const done = worker('done');
    const { live, previous } = splitCrew([unknown, done], (s) =>
      s.id === 'unknown' ? 'unknown' : 'idle'
    );
    expect(live.map((s) => s.id)).toEqual(['unknown']);
    expect(previous.map((s) => s.id)).toEqual(['done']);
    // With no state source at all, nothing is known, so nobody is filed as finished either.
    expect(splitCrew([worker('a'), worker('b')]).previous).toEqual([]);
  });

  test('loses nobody and keeps the incoming order', () => {
    const all = ['a', 'b', 'c', 'd'].map((id) => worker(id));
    const { live, previous } = splitCrew(all, () => 'idle');
    expect([...live, ...previous].map((s) => s.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(previous.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
    // Without a state source nothing is finished either — it is all still open, in order.
    expect(splitCrew(all).live.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('an error state stays live', () => {
    const { live } = splitCrew([worker('x')], () => 'error');
    expect(live.map((s) => s.id)).toEqual(['x']);
  });
});

describe('crewDepth', () => {
  test('counts the lead chain: 1 for a direct worker, 2+ for a sub-crew', () => {
    const leader = session('1');
    const w1 = worker('2', '1');
    const w2 = worker('3', '2');
    const w3 = worker('4', '3');
    const all = [leader, w1, w2, w3];
    expect(crewDepth(leader, all)).toBe(0);
    expect(crewDepth(w1, all)).toBe(1);
    expect(crewDepth(w2, all)).toBe(2);
    expect(crewDepth(w3, all)).toBe(3);
  });

  test('counts from the lead edge, so a peer that keeps its lead as history reads 1', () => {
    // `crewDepth` measures the chain, not crew membership: `isWorker` is what decides membership,
    // and a peer's `lead` is history only — which is why `blockedWorkersAmong` filters on `isWorker`
    // before asking for a depth.
    const peer = session('2', { kind: 'peer', lead: { instanceId: 'hearth', sessionId: '1' } });
    expect(crewDepth(peer, [peer])).toBe(1);
    // Without a `lead` at all (a plain session) there is no chain to walk.
    expect(crewDepth(session('3'), [])).toBe(0);
    // The leader is not loaded: the edge still counts once, and the walk then stops.
    expect(crewDepth(worker('5', 'gone'), [])).toBe(1);
  });

  test('a lead cycle terminates', () => {
    const a = worker('a', 'b');
    const b = worker('b', 'a');
    expect(Number.isFinite(crewDepth(a, [a, b]))).toBe(true);
    expect(crewDepth(a, [a, b])).toBeLessThanOrEqual(2);
  });
});

describe('blockedWorkersUnder', () => {
  test('nothing blocked is an empty list', () => {
    const leader = session('1');
    expect(blockedWorkersUnder(leader, [leader, worker('2', '1')])).toEqual([]);
  });

  test('a depth-1 worker needing input is named, with its depth', () => {
    const leader = session('1');
    const w = worker('2', '1', { needsInput: true, title: 'Parse config' });
    const blocked = blockedWorkersUnder(leader, [leader, w]);
    expect(blocked.map((entry) => entry.title)).toEqual(['Parse config']);
    expect(blocked[0].worker.id).toBe('2');
    expect(blocked[0].depth).toBe(1);
  });

  test('a depth-2 (sub-sub) worker needing input surfaces, not just the rollup', () => {
    const leader = session('1');
    const w1 = worker('2', '1');
    const w2 = worker('3', '2', { needsInput: true, title: 'Migrate schema' });
    const blocked = blockedWorkersUnder(leader, [leader, w1, w2]);
    expect(blocked.map((entry) => [entry.worker.id, entry.depth, entry.title])).toEqual([
      ['3', 2, 'Migrate schema'],
    ]);
    // Shallowest first: a direct worker outranks the sub-crew behind it.
    const direct = worker('4', '1', { needsInput: true, title: 'Lint' });
    const both = blockedWorkersUnder(leader, [leader, w1, w2, direct]);
    expect(both.map((entry) => entry.depth)).toEqual([1, 2]);
  });

  test('a worker needing input whose leader is itself a worker is reachable from the top', () => {
    const top = session('1');
    const midWorker = worker('2', '1');
    const deepWorker = worker('3', '2', { needsInput: true, title: 'Deep ask' });
    // From the top leader, and from the intermediate worker's own point of view.
    expect(blockedWorkersUnder(top, [top, midWorker, deepWorker]).map((e) => e.worker.id)).toEqual(['3']);
    expect(blockedWorkersUnder(midWorker, [top, midWorker, deepWorker]).map((e) => e.depth)).toEqual([1]);
  });

  test('a worker that stops needing input disappears; one that starts appears', () => {
    const leader = session('1');
    const asking = worker('2', '1', { needsInput: true });
    const calm = worker('2', '1');
    expect(blockedWorkersUnder(leader, [leader, asking])).toHaveLength(1);
    expect(blockedWorkersUnder(leader, [leader, calm])).toHaveLength(0);
  });

  test('only the worker actually blocked is listed, not its ancestors', () => {
    const leader = session('1');
    const w1 = worker('2', '1');
    const w2 = worker('3', '2', { needsInput: true });
    const blocked = blockedWorkersUnder(leader, [leader, w1, w2]);
    expect(blocked.map((entry) => entry.worker.id)).toEqual(['3']);
  });

  test('a lead cycle terminates', () => {
    const a = worker('a', 'b', { needsInput: true });
    const b = worker('b', 'a');
    expect(blockedWorkersUnder(b, [a, b]).map((entry) => entry.worker.id)).toEqual(['a']);
  });

  test('falls back to "Worker <id>" without a title', () => {
    const leader = session('1');
    const w = worker('9', '1', { needsInput: true });
    expect(blockedWorkersUnder(leader, [leader, w])[0].title).toBe('Worker 9');
  });
});

describe('blockedWorkersAmong', () => {
  test('picks blocked workers out of a mixed rail payload, shallowest first', () => {
    const leader = session('1');
    const w1 = worker('2', '1');
    const deep = worker('3', '2', { needsInput: true, title: 'Deep' });
    const direct = worker('4', '1', { needsInput: true, title: 'Direct' });
    const busyNoAsk = worker('5', '1');
    const peerAsking = session('6', { kind: 'peer', needsInput: true });
    const plainAsking = session('7', { needsInput: true });
    const blocked = blockedWorkersAmong([leader, w1, deep, direct, busyNoAsk, peerAsking, plainAsking]);
    expect(blocked.map((entry) => entry.title)).toEqual(['Direct', 'Deep']);
    expect(blocked.map((entry) => entry.depth)).toEqual([1, 2]);
  });
});


/**
 * The crew strip used to print a text badge per worker. Six of them stacked over the composer were
 * the reason the strip had to scroll; a brick carries a dot instead and keeps the word in
 * `title`/`aria-label`. These are the rules that decide which state is allowed to shout.
 */
describe('brickStatusSignal', () => {
  test('every status keeps a word for its label, so nothing is only a colour', () => {
    const statuses = ['working', 'needs input', 'failed', 'idle', 'reported', 'unknown'] as const;
    for (const status of statuses) {
      const signal = brickStatusSignal(status);
      expect(signal.word.length).toBeGreaterThan(0);
      expect(signal.tone.length).toBeGreaterThan(0);
    }
  });

  test('only "needs input" prints its word', () => {
    // The two loud states exist for a reason, and only one of them needs a word: `failed` says it
    // with a destructive surface, which no quiet brick can imitate.
    const shouting = (['working', 'needs input', 'failed', 'idle', 'reported', 'unknown'] as const).filter(
      (status) => brickStatusSignal(status).showWord
    );
    expect(shouting).toEqual(['needs input']);
    expect(brickStatusSignal('needs input')).toEqual({ word: 'needs input', showWord: true, tone: 'attention' });
    expect(brickStatusSignal('failed')).toEqual({ word: 'failed', showWord: false, tone: 'failed' });
  });

  test('a missing answer is unknown, and speaks for itself', () => {
    // A host that is not answering may be mid-turn: the brick keeps a dashed, wordless reading
    // rather than borrowing "idle".
    expect(brickStatusSignal('unknown')).toEqual({ word: 'status unknown', showWord: false, tone: 'unknown' });
    expect(brickStatusSignal('idle').tone).toBe('quiet');
    expect(brickStatusSignal('idle').tone).not.toBe(brickStatusSignal('unknown').tone);
  });
});

/**
 * The bricks take the *leader's* colour so a crew reads as one family, and the blobs inside them are
 * left alone so they still match the column each worker opens into. Both halves of that rule have
 * their own test above (`the leader colour changes the surface and nothing else` in
 * `crewStrip.test.tsx`); this is the arithmetic behind the tint.
 */
describe('the leader tint on a crew brick', () => {
  test('composes a wash and an edge with color-mix, for a var(--blob-N) and a raw hex alike', () => {
    // `blobColor` returns one or the other depending on the identity, so the tint has to be a
    // composition rather than a channel split.
    for (const color of ['var(--blob-7)', '#3d7bff']) {
      const style = leaderBrickStyle(color);
      expect(style.backgroundColor).toBe(`color-mix(in oklab, ${color} 10%, transparent)`);
      expect(style.borderColor).toBe(`color-mix(in oklab, ${color} 45%, var(--border))`);
      expect(style).toEqual({ backgroundColor: leaderBrickWash(color), borderColor: leaderBrickEdge(color) });
    }
    expect(CREW_BRICK_TINT).toEqual({ wash: 10, edge: 45 });
  });

  test('the wash stays strong enough to read and weak enough to keep the 11px title legible', () => {
    // The edge is mixed with `--border` so it is never invisible; the wash is mixed with transparent
    // so it never turns the brick into a colour block. What must hold is the title: a wash that
    // dropped foreground text below WCAG AA would trade one unreadable strip for another.
    const mix = (color: string, surface: string, amount: number): string => {
      const parse = (value: string): number[] => {
        const hex = value.replace('#', '');
        const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
        const n = parseInt(full, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      };
      const [a, b] = [parse(color), parse(surface)];
      const channels = a.map((channel, index) => Math.round(channel * amount + b[index] * (1 - amount)));
      return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    };

    for (const theme of THEMES) {
      const surfaces = [theme.palette.bg, theme.palette.panel, theme.palette.elev];
      // Every colour the tint can be handed: the theme-adjusted palette a `var(--blob-N)` resolves
      // to, plus the buddy fills `blobColor` returns raw.
      const colors = [...identityPaletteFor([theme.palette.panel, theme.palette.elev, theme.palette.bg]),
        ...BUDDY_COLORS.map((entry) => entry.fill)];
      for (const surface of surfaces) {
        for (const color of colors) {
          const brick = mix(color, surface, CREW_BRICK_TINT.wash / 100);
          expect(
            contrastRatio(theme.palette.text, brick),
            `${theme.id}: title on a ${color} wash over ${surface}`
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

test('thread source links include unblocked descendants, avoid cycles and isolate hosts', () => {
  const root = session('1');
  const child = worker('2', '1');
  const nested = worker('3', '2');
  const cycle = worker('1', '3');
  const unrelated = worker('4', '1', { instanceId: 'elsewhere', lead: { instanceId: 'hearth', sessionId: '1' } });
  expect(threadDescendants(root, crewByLeader([root, child, nested, cycle, unrelated])).map((entry) => entry.id)).toEqual(['2', '3']);
});

test('thread shelf counts direct and nested blockers once and keeps running status distinct', () => {
  const busy = worker('2', '1');
  const blocked = worker('3', '1', { needsInput: true });
  const nested = worker('4', '3', { needsInput: true });
  const status = threadShelfStatus([busy, blocked], [
    { worker: blocked, title: 'Blocked', depth: 1 },
    { worker: nested, title: 'Nested', depth: 2 },
  ], () => 'active');
  expect(status).toEqual({
    total: 3,
    running: 1,
    needsHuman: 2,
    summary: '1 / 3',
    detail: '1 of 3 threads running · 2 needs you',
  });
  // A quiet crew says "0 / n" rather than omitting the tab's numbers.
  const idle = threadShelfStatus([busy], [], () => 'idle');
  expect(idle.summary).toBe('0 / 1');
  expect(idle.detail).toBe('0 of 1 threads running');
});

test('worker keys cover the crew and leave leaders and plain chats alone', () => {
  const leader = worker('1', undefined, { kind: 'leader' });
  const direct = worker('2', '1');
  const plain = worker('3', undefined, { kind: 'peer' });
  const sessions = [leader, direct, plain];
  const keys = workerKeySet(sessions, crewByLeader(sessions));
  expect(keys.has(sessionKey(direct))).toBe(true);
  expect(keys.has(sessionKey(leader))).toBe(false);
  expect(keys.has(sessionKey(plain))).toBe(false);
  // A crew roster alone is enough: the same key is found when only the roster knows it.
  expect(workerKeySet([], crewByLeader(sessions)).has(sessionKey(direct))).toBe(true);
});
