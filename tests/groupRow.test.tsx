/**
 * The group card: a member's name must be readable, and the header must not repeat it.
 *
 * Owner-reported, and the second half was two separate causes: a group made from one session's
 * "Group with…" was seeded with `name: ''`, and `defaultGroupName` returned *that member's own
 * title* for a single-member group — so the header either drew nothing or drew the first name again
 * under a list that already said it.
 *
 * What this pins is the reading that follows from it:
 *
 *  - a member's **whole** title is in the DOM, untruncated by a fixed chip — the point of grouping
 *    these agents was that their names matter;
 *  - the header draws **the count**, never a name it would then repeat;
 *  - the group still announces itself (`aria-label`, and an `sr-only` name), because removing the
 *    visible name must not remove the accessible one.
 *
 * Rendered with `renderToStaticMarkup`: what matters is what ends up in the markup, and the rest of
 * the card (menus, clicks) is Radix and Motion, which need a DOM the test runner does not have.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GroupRow from '../src/components/GroupRow';
import { TooltipProvider } from '../src/components/ui/tooltip';
import type { GroupEntry } from '../src/lib/projectGroups';
import type { Session } from '../src/types';

/**
 * Radix's Tooltip reaches for `window` while rendering, and another suite in the same process
 * deletes it (`composerShelf.test.tsx` does the same for the same reason). Stubbing it here keeps
 * this file order-independent: it passes alone and in the full run.
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

const member = (id: string, title: string): Session =>
  ({
    id,
    instanceId: 'pi:hearth',
    title,
    updated: Date.now(),
  }) as Session;

const entryOf = (over: Partial<GroupEntry> = {}): GroupEntry => ({
  kind: 'group',
  id: 'g1',
  name: 'Group',
  keys: [],
  members: [member('a', 'Habit onboarding QA · copy pass'), member('b', 'Habit onboarding QA · icons')],
  instanceIds: ['pi:hearth'],
  primaryKey: 'pi:hearth::a',
  updated: Date.now(),
  ...over,
});

const render = (entry: GroupEntry) =>
  renderToStaticMarkup(
    <TooltipProvider>
    <GroupRow
      entry={entry}
      instanceLabels={{ 'pi:hearth': 'hearth' }}
      avatarIdentities={{}}
      moods={{}}
      visibleKeys={new Set()}
      blobStyle="buddy"
      onNewAgent={() => {}}
      onOpen={() => {}}
      onOpenSession={() => {}}
      onArchiveMany={() => {}}
      onManage={() => {}}
      onUngroup={() => {}}
    />
    </TooltipProvider>
  );

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('a group card', () => {
  test('writes each member’s full title, not a clipped chip', () => {
    const html = render(entryOf());
    // The distinguishing tail is what the old 30px chip cut, and what made two members look alike.
    expect(html).toContain('Habit onboarding QA · copy pass');
    expect(html).toContain('Habit onboarding QA · icons');
  });

  test('draws no title chip of its own beside them', () => {
    // The blob is the bare face now; a chip would repeat the name the row already writes.
    expect(render(entryOf())).not.toContain('data-blob-label');
  });

  test('the header carries the count, not a name', () => {
    const shown = text(render(entryOf()));
    expect(shown).toContain('2 agents');
    // "Group" is this entry's name; it must not be drawn in the header. It survives as the row's
    // accessible name, which is not visible text and so does not appear here.
    expect(shown.startsWith('2 agents')).toBe(true);
  });

  test('a group named after a member does not repeat that name in the header', () => {
    // The exact shape `defaultGroupName` used to produce for one member: the member's own title.
    const html = render(
      entryOf({
        name: 'Habit onboarding QA · copy pass',
        members: [member('a', 'Habit onboarding QA · copy pass')],
      })
    );
    const shown = text(html);
    // Once, in the list — not twice.
    expect(shown.split('Habit onboarding QA · copy pass').length - 1).toBe(1);
    expect(shown).toContain('1 agent');
  });

  test('the row still says what it is, for a screen reader and for a tooltip', () => {
    const html = render(entryOf({ name: 'Release train' }));
    // Removing the visible name must not remove the accessible one.
    expect(html).toContain('aria-label="Open group Release train"');
    expect(html).toContain('Release train');
  });

  test('a member waiting on you is marked, by name not colour alone', () => {
    const html = render(
      entryOf({ members: [{ ...member('a', 'Waiting one'), needsInput: true } as Session] })
    );
    expect(html).toContain('waiting on you');
  });
});
