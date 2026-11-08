import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CrewStrip, { BRICK_CLASS } from '../src/components/CrewStrip';
import type { AvatarIdentity, BallState, Session } from '../src/types';

/**
 * The crew strip renders to markup, no browser: these tests hold the *qualities* that a wrapped
 * brick strip introduced, not pixels. They exist because the strip is the only place a leader's
 * workers appear — a worker lost from it is a conversation the human cannot reach — and because
 * the same species of gap that `TODO.md` records for `GroupRow` ("no render test, and that gap has
 * now cost two bugs") applies here: every rule below was a bug once, or would be a bug the moment
 * someone re-ordered a class.
 */

/**
 * Server rendering has to happen without a DOM, and `api.test.ts` leaves `globalThis.window` set to a
 * transport stub for the rest of the process. The strip renders through `motion`, which takes the
 * browser path as soon as `window` exists and then throws on a stub that has no `addEventListener`
 * — so this file puts the DOM back the way SSR expects it and restores the stub afterwards.
 */
let stubbedWindow: unknown;
beforeAll(() => {
  const scope = globalThis as { window?: unknown };
  stubbedWindow = scope.window;
  delete scope.window;
});
afterAll(() => {
  if (stubbedWindow !== undefined) (globalThis as { window?: unknown }).window = stubbedWindow;
});

/** A direct worker of `hearth::lead`. */
const worker = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  instanceId: 'hearth',
  kind: 'worker',
  lead: { instanceId: 'hearth', sessionId: 'lead' },
  title: `Worker ${id}`,
  ...extra,
});

/**
 * A leader identity. `projectKey` matters: it puts `blobColor` on the `var(--blob-N)` branch, so the
 * tint has to survive being composed with a CSS variable rather than a hex.
 */
const leader: AvatarIdentity = {
  sessionKey: 'hearth::lead',
  colorSeed: 'lead-colour',
  shapeSeed: 'lead-shape',
  motionSeed: 'lead-motion',
  projectKey: 'ember',
};

/** An identity with no group and no override: `blobColor` hands back a raw hex here. */
const ungroupedLeader: AvatarIdentity = {
  sessionKey: 'hearth::lead',
  colorSeed: 'lead-colour',
  shapeSeed: 'lead-shape',
  motionSeed: 'lead-motion',
};

const render = (props: React.ComponentProps<typeof CrewStrip>) =>
  renderToStaticMarkup(<CrewStrip onOpenWorker={() => {}} blobStyle="buddy" {...props} />);

/** How many bricks the markup draws. One per worker, plus one per extra blocked worker. */
const bricks = (html: string) => html.split('data-crew-brick=""').length - 1;

describe('the crew strip is a flat readable list', () => {
  const crew = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => worker(id));

  test('one row per worker, separated by fine rules', () => {
    const html = render({ workers: crew, stateFor: () => 'active' });
    expect(bricks(html)).toBe(7);
    expect(html).toContain('flex-col divide-y');
    expect(html).toContain('<ul');
    // One list item per worker and nothing else: the minimiser lives on the shelf's Crew tab now,
    // so the strip cannot grow a chip of its own chrome.
    expect(html.split('<li').length - 1).toBe(7);
    expect(html).not.toContain('aria-label="Minimize crew"');
  });

  test('chips, not chips inside a card: the strip draws no surface of its own', () => {
    // Reported from use: the bricks read as chips *in a card*, because that is what they were — a
    // bordered, filled, shadowed Card wrapped around a list of already-bordered chips, adding a
    // second surface between the composer band and the work.
    const html = render({ workers: crew, stateFor: () => 'active' });
    expect(html).not.toContain('bg-background/80');
    expect(html).not.toContain('shadow-sm');
    expect(html).not.toContain('data-slot="card"');
    // It is still one named group, so the strip keeps a boundary a screen reader can announce.
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Crew"');
  });

  test('a large crew is bounded without losing nested questions, Previous or keyboard controls', () => {
    const many = Array.from({ length: 20 }, (_, index) => worker('live-' + index));
    const html = render({
      workers: [...many, worker('finished')],
      stateFor: (session) => session.id === 'finished' ? 'idle' : 'active',
      onToggleYolo: () => {},
      nestedBlocked: [{ worker: worker('deep', { needsInput: true, title: 'Deep question' }), depth: 3, title: 'Deep question' }],
    });
    expect(bricks(html)).toBe(21);
    expect(html).toContain('max-h-48');
    expect(html).toContain('overflow-y-auto');
    expect(html).toMatch(/<ul[^>]+tabindex="0"[^>]+aria-label="Thread conversations"/);
    expect(html).toContain('focus-visible:ring-inset');
    for (const session of many) {
      expect(html).toContain('aria-label="' + session.title + '"');
      expect(html).toContain('aria-label="Turn on YOLO mode for ' + session.title + '"');
    }
    expect(html).toContain('+1 previous');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Deep question needs input — open the conversation to answer"');
    expect(html).not.toContain('overflow-hidden');
  });

  test('the worker chip stays compact without allocating an avatar', () => {
    const html = render({ workers: [worker('a')], stateFor: () => 'active' });
    expect(html).toContain('line-clamp-2');
    expect(html).toContain('data-tray-preview');
    expect(html).not.toMatch(/class="blob(?: |")/);
    expect(html).not.toContain('width:16px;height:16px');
  });

  test('each brick is a real button that opens its worker', () => {
    const html = render({ workers: [worker('a')], stateFor: () => 'active' });
    expect(html).toContain('aria-label="Worker a"');
    expect(html).toContain('title="Open Worker a — working"');
  });

  test('the name stays the worker title; the status is its description', () => {
    // Two reasons to keep them apart: a worker is looked up by its title (agents, e2e, the human),
    // and a screen reader should still hear the status. `aria-label` overrides the brick's contents,
    // so the word has to reach AT some other way — a described-by word does, without growing names.
    const html = render({ workers: [worker('a')], stateFor: () => 'active' });
    expect(html).toContain('aria-label="Worker a"');
    const described = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(described).toBeTruthy();
    expect(html).toContain(`id="${described}"`);
    expect(html).toContain('data-tray-meta');
    expect(html).toMatch(/>working<\/span>/);
  });
});

describe('only promoted bot links retain an avatar', () => {
  for (const state of ['active', 'needs-input', 'error', 'unknown'] as const) {
    test(`an unpromoted ${state} worker has no avatar DOM`, () => {
      const html = render({ workers: [worker('a')], stateFor: () => state });
      expect(html).not.toMatch(/class="blob(?: |")/);
      expect(bricks(html)).toBe(1);
    });
  }

  test('crew membership is enough when the host omits kind', () => {
    const html = render({ workers: [worker('a', { kind: undefined })], stateFor: () => 'active' });
    expect(html).not.toMatch(/class="blob(?: |")/);
    expect(html).toContain('aria-label="Worker a"');
  });

  test('a promoted bot link keeps its blob and bot badge', () => {
    const html = render({ workers: [worker('a', { promotedTo: 'peer-1' })], stateFor: () => 'idle' });
    expect(html).toMatch(/class="blob(?: |")/);
    expect(html).toContain('>bot<');
  });
});

describe('readable status beneath each preview', () => {
  /**
   * One live brick of `a` in the requested state, with a busy worker beside it: a crew whose every
   * worker is idle starts collapsed, and these assertions are about the brick, not the pill.
   */
  const one = (state: BallState, extra: Partial<Session> = {}) =>
    render({
      workers: [worker('busy', { title: 'Busy' }), worker('a', extra)],
      stateFor: (session) => (session.id === 'a' ? state : 'active'),
    });

  test('a quiet bot keeps its status beneath the title', () => {
    // A quiet worker only reaches the brick list as a standing relationship: `splitCrew` files an
    // idle one-shot worker under "+N previous". This is the one brick that shows the quiet tone.
    const html = one('idle', { promotedTo: 'peer-1' });
    expect(html).toContain('aria-label="Worker a"');
    expect(html).toContain('title="Open the persistent bot for Worker a — idle"');
    // A 6px dot carries it on the brick; the word is only in the tooltip and the description.
    expect(html).toContain('size-1.5 flex-none rounded-full bg-muted-foreground/40');
    expect(html).not.toContain('bg-highlight px-1');
  });

  test('"needs input" still says it out loud', () => {
    // The exception that matters: this is the whole reason the strip is on screen.
    const html = one('needs-input');
    expect(html).toContain('>needs input<');
    // The word and the surface, not an outline: chips carry no borders at all now.
    expect(html).toContain('font-medium text-highlight');
    expect(html).toContain('data-tray-meta');
    expect(html).not.toContain('border-highlight');
  });

  test('"failed" keeps a destructive status, not a neutral word', () => {
    const failed = one('error');
    expect(failed).toContain('text-destructive');
    expect(failed).toContain('size-1.5 flex-none rounded-full bg-destructive');
    expect(failed).toContain('title="Open Worker a — failed"');
    expect(failed).toContain('>failed</span>');
    // Nothing quiet wears it: a failed worker must not read as an idle one with a different dot.
    const working = one('active');
    expect(working).not.toContain('bg-destructive');
  });

  test('an unanswered host keeps its dashed edge and says "status unknown"', () => {
    // No answer is not a verdict — the reasoning the old status badge carried.
    const html = one('unknown');
    expect(html).toContain('border-dashed');
    expect(html).toContain('title="Open Worker a — status unknown"');
    expect(html).toContain('>status unknown</span>');
    expect(html).not.toContain('bg-highlight px-1');
  });

  test('a working brick is the one that carries the accent dot', () => {
    const html = one('active');
    expect(html).toContain('size-1.5 flex-none rounded-full bg-highlight');
    expect(html).toContain('title="Open Worker a — working"');
  });
});

describe('neutral rows preserve the leader relationship without tinted cards', () => {
  test('a leader identity never adds a surface or outline to a thread', () => {
    for (const identity of [leader, ungroupedLeader]) {
      const html = render({ workers: [worker('a')], leaderIdentity: identity, stateFor: () => 'active' });
      expect(html).not.toContain('color-mix');
      expect(html).not.toMatch(/class="blob(?: |")/);
      expect(html).toContain('data-tray-meta');
    }
  });

  test('the group still names its leader', () => {
    expect(render({ workers: [worker('a')], leaderTitle: 'Lead agent', stateFor: () => 'active' }))
      .toContain('aria-label="Crew of Lead agent"');
  });
});

describe('previous worker chats are a chip in the same wrap', () => {
  const crew = [
    worker('busy', { title: 'Busy' }),
    worker('done1', { title: 'Done one' }),
    worker('done2', { title: 'Done two' }),
  ];
  const stateFor = (session: Session): BallState => (session.id === 'busy' ? 'active' : 'idle');

  test('finished workers collapse behind +N previous, not into the brick list', () => {
    const html = render({ workers: crew, stateFor });
    expect(html).toContain('+2 previous');
    expect(bricks(html)).toBe(1);
    expect(html).toContain('aria-expanded="false"');
    // A chip, not a full-width text link: the visible count *is* its name.
    expect(html).toContain('title="2 finished worker chats"');
    expect(html).not.toContain('border-dashed px-1.5');
  });

  test('the chip is exactly the count of finished workers, and absent when there are none', () => {
    expect(render({ workers: crew.slice(0, 2), stateFor })).toContain('+1 previous');
    expect(render({ workers: crew.slice(0, 1), stateFor })).not.toContain('previous');
    // A promoted worker is a standing relationship: it stays a brick however quiet it is.
    const promoted = render({
      workers: [worker('busy', { title: 'Busy' }), worker('done1', { title: 'Done one', promotedTo: 'peer-1' })],
      stateFor,
    });
    expect(promoted).not.toContain('previous');
    expect(promoted).toContain('>bot<');
  });
});

describe('the parts that must survive the layout change', () => {
  test('a resting crew still draws its chips, because folding belongs to the shelf', () => {
    // The strip used to collapse itself to a "Crew 2 · resting" pill whenever every worker was idle,
    // which made a settled crew look like something you had put away. Folding is now an explicit
    // action on the shelf, and the chips are always the chips.
    const html = render({
      workers: [worker('a'), worker('b')],
      stateFor: (session) => (session.id === 'a' ? 'active' : 'idle'),
    });
    // The working one is a chip; the finished one is behind "+1 previous", which is not folding.
    expect(bricks(html)).toBe(1);
    expect(html).toContain('+1 previous');
    expect(html).not.toContain('resting');
  });

  test('YOLO stays visible and clickable when it is on', () => {
    // The same shield and the same word the composer uses: "auto" named the mechanism rather than
    // the mode, so one feature looked like two.
    const on = render({
      workers: [worker('a')],
      stateFor: () => 'active',
      autoAcceptByKey: { 'hearth::a': true },
      onToggleYolo: () => {},
    });
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('aria-label="Turn off YOLO mode for Worker a"');
    expect(on).toContain('lucide-shield-check');
    expect(on).toContain('Yolo');
    // Off is a hover/focus control, so seven bricks do not carry seven YOLO words.
    const off = render({
      workers: [worker('a')],
      stateFor: () => 'active',
      autoAcceptByKey: { 'hearth::a': false },
      onToggleYolo: () => {},
    });
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('aria-label="Turn on YOLO mode for Worker a"');
  });

  test('without a toggle the YOLO state is still shown, read-only', () => {
    const html = render({ workers: [worker('a')], stateFor: () => 'active', autoAcceptByKey: { 'hearth::a': true } });
    expect(html).toContain('Yolo');
    expect(html).toContain('lucide-shield-check');
    expect(html).not.toContain('aria-pressed');
  });

  test('the word collapses to the shield on a narrow strip, and @container never sits on the brick itself', () => {
    // `@container` (`container-type: inline-size`) on a shrink-to-fit `inline-flex` brick applies
    // inline-size containment, collapsing every brick to its 12px padding while its contents paint
    // over its neighbours. The strip wrapper (`group/strip`) owns `@container`; `BRICK_CLASS` must
    // never carry it.
    expect(BRICK_CLASS).not.toContain('@container');
    const html = render({
      workers: [worker('a')],
      stateFor: () => 'active',
      autoAcceptByKey: { 'hearth::a': true },
      onToggleYolo: () => {},
    });
    expect(html).toContain('group/strip @container');
    expect(html).not.toMatch(/data-crew-brick=""[^>]*@container/);
    expect(html).toContain('hidden @[420px]:inline">Yolo<');
  });

  test('a blocked worker below the crew gets its own brick, with its depth', () => {
    const html = render({
      workers: [worker('a')],
      nestedBlocked: [
        { worker: worker('deep', { needsInput: true, title: 'Deep ask' }), depth: 2, title: 'Deep ask' },
        // Already a brick of its own: it must not be listed twice.
        { worker: worker('a', { title: 'Worker a' }), depth: 1, title: 'Worker a' },
      ],
      stateFor: () => 'active',
    });
    expect(bricks(html)).toBe(2);
    expect(html).toContain('Deep ask');
    expect(html).toContain('Nested · depth 2');
    expect(html).toContain('title="2 levels below this bot"');
    expect(html).toContain('aria-label="Deep ask needs input — open the conversation to answer"');
    expect(html).not.toMatch(/class="blob(?: |")/);
    expect(html).toContain('>needs input<');
  });

  test('a crew with nobody in it renders nothing at all', () => {
    expect(render({ workers: [] })).toBe('');
  });
});
