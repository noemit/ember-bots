/**
 * C2 (audit): an outage renders as itself, not as deletion.
 *
 * The pure halves are covered in `instanceHealth.test.ts`; this renders the rail so the *shape* is
 * pinned too: the silent host gets one honest row of its own (not a session row, not a survivor
 * session), its last-known sessions are still listed, and the empty state names the real case
 * instead of the old "No instances connected. Add a Hearth endpoint in Settings, then refresh."
 */
import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LeftRail from '../src/components/LeftRail';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { silentInstances } from '../src/lib/instanceHealth';
import { buildRailEntries } from '../src/lib/projectGroups';
import type { Instance, Session } from '../src/types';

const host: Instance = { id: 'pi:keep', label: 'Keep', kind: 'pi', status: 'unreachable', attachable: false };

const sessions: Session[] = [
  { id: '11', instanceId: 'pi:keep', title: 'Habit onboarding QA', updated: Date.now() },
  { id: '12', instanceId: 'pi:keep', title: 'Memory budget', updated: Date.now() - 60_000 },
];

/**
 * Rendering here must not depend on file order. Bun runs every test file in one process, and the
 * api tests install a bare `{ ember: … }` as `window` — after which react-dom's server renderer
 * (the browser build) asks that object for `addEventListener` and throws. Give it the listener
 * methods it wants; nothing else about the stub changes.
 */
const ensureRenderableGlobals = () => {
  const scope = globalThis as { window?: Record<string, unknown> };
  const current = scope.window ?? {};
  if (typeof current.addEventListener === 'function') return;
  scope.window = {
    ...current,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
};

const render = (
  instances: Instance[],
  list: Session[],
  extra: {
    everySession?: Session[];
    groups?: import('../src/types').SessionGroup[];
    scheduledTasks?: import('../src/types').ScheduledTask[];
    dismissed?: string[];
  } = {}
) => {
  ensureRenderableGlobals();
  const everySession = extra.everySession ?? list;
  return renderToStaticMarkup(
    <TooltipProvider>
      <LeftRail
        instances={instances}
        projectsByInstance={{}}
        instanceDefaults={{}}
        sessions={list}
        everySession={everySession}
        moods={{}}
        previews={{}}
        selectedKey={null}
        avatarIdentities={{}}
        blobStyle="buddy"
        compact={false}
        loading={false}
        startupMessage={null}
        silentInstances={silentInstances(instances, list, undefined, new Set(extra.dismissed ?? []))}
        onRetryInstances={() => undefined}
        onDismissOutage={() => undefined}
        retryingInstances={false}
        mobileOpen={false}
        reloadingKeys={new Set()}
        archivingKeys={new Set()}
        visibleColumnKeys={new Set()}
        pinnedCounts={{}}
        selectedSession={null}
        windowLabel={null}
        scheduledTasks={extra.scheduledTasks ?? []}
        scheduledTaskBySession={{}}
        runningScheduledKeys={new Set()}
        onRunScheduledTask={() => undefined}
        onChangeScheduledTaskModel={() => undefined}
        onOpenArchive={() => undefined}
        onSelectSession={() => undefined}
        onOpenProject={() => undefined}
        onOpenSession={() => undefined}
        onReload={() => undefined}
        onArchive={() => undefined}
        onArchiveMany={() => undefined}
        onCustomizeAppearance={() => undefined}
        onNewAgent={() => undefined}
        groups={extra.groups ?? []}
        onOpenGroup={() => undefined}
        onUngroup={() => undefined}
        onManageGroup={() => undefined}
      />
    </TooltipProvider>
  );
};

/** Text content only, so assertions are about what a reader sees. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const countOf = (html: string, needle: string): number => html.split(needle).length - 1;

describe('the rail during an outage', () => {
  test('names the silent host, counts what is still listed, and offers Retry', () => {
    const html = render([host], sessions);
    const text = textOf(html);
    expect(countOf(html, 'data-testid="rail-silent-instance"')).toBe(1);
    expect(text).toContain('Keep');
    expect(text).toMatch(/not answering/i);
    expect(text).toContain('2 sessions');
    expect(text).toMatch(/retry/i);
  });

  test('keeps the last-known list: the sessions are still rows, so an outage is not a deletion', () => {
    const text = textOf(render([host], sessions));
    expect(text).toContain('Habit onboarding QA');
    expect(text).toContain('Memory budget');
  });

  test('never says the endpoint is missing while an endpoint exists', () => {
    const text = textOf(render([host], sessions));
    expect(text).not.toMatch(/No instances connected/i);
    expect(text).not.toMatch(/Add an ember-harness endpoint/i);
  });

  test('offers a way to stop the warning, named after the host it belongs to', () => {
    const html = render([host], sessions);
    // The row is the only surface that says a host is down, and a sleeping laptop should not
    // leave it above every session for good — so dismissing has to be possible, and reachable by
    // name rather than as an unlabelled glyph.
    expect(html).toContain('aria-label="Stop warning about Keep"');
    // Retry stays: dismissing is "stop telling me", never "hide this so I can't ask again".
    expect(html).toContain('aria-label="Retry Keep"');
  });

  test('a settings problem is not dismissable, because silence cannot fix it', () => {
    const html = render([{ ...host, status: 'unsupported' }], sessions);
    expect(textOf(html)).toMatch(/Sessions unavailable/i);
    expect(html).not.toContain('Stop warning about');
  });

  test('a dismissed host draws no row, and its sessions are still listed', () => {
    const text = textOf(render([host], sessions, { dismissed: ['pi:keep'] }));
    expect(text).not.toMatch(/not answering/i);
    expect(text).toContain('Habit onboarding QA');
    expect(text).toContain('Memory budget');
    // Silencing the warning is not a claim that the host is back: the empty state still names the
    // real reason rather than pretending everything is fine.
    const empty = textOf(render([host], [], { dismissed: ['pi:keep'] }));
    expect(empty).toMatch(/none of your 1 ember-harness endpoint is answering/i);
    expect(empty).toMatch(/reprobe/i);
  });

  test('an empty rail names the case instead of asserting absence', () => {
    const silent = textOf(render([host], []));
    expect(silent).toMatch(/none of your 1 ember-harness endpoint is answering/i);
    // The way back is named by its label, not by where it sits: every outage row can be dismissed,
    // so this list can be empty with no Retry button anywhere above it.
    expect(silent).toMatch(/reprobe instances in the instances menu/i);

    const noEndpoints = textOf(render([], []));
    expect(noEndpoints).toMatch(/No ember-harness endpoints yet/i);
    expect(noEndpoints).toMatch(/settings/i);

    const connectedEmpty = textOf(
      render([{ ...host, status: 'ready', attachable: true }], [])
    );
    expect(connectedEmpty).toMatch(/no sessions yet/i);
    expect(connectedEmpty).not.toMatch(/not answering/i);
  });
});

/**
 * S4-5: searching a group's name must find the group's sessions, and keep them inside the group.
 *
 * The rail builds its search entries with `buildRailEntries(activeMatches, projectsByInstance,
 * groups)`. Without `groups` the members of a group fell through to standalone session rows (found
 * only when their own title matched) and the group card disappeared, so searching by the name the
 * reader gave the group returned nothing. The contract is pinned against the builder the rail calls
 * — there is no DOM here to type into the search box — plus the rail's own render of a group.
 */
describe('searching a group by name', () => {
  const member = (id: string, title: string, updated: number): Session => ({
    id,
    instanceId: 'local',
    title,
    updated,
  });
  const group = {
    id: 'g-release',
    name: 'Release train',
    keys: ['local::g1', 'local::g2'],
    primaryKey: 'local::g1',
  };
  const members = [member('g1', 'Wire the retry budget', 3), member('g2', 'Land the migration', 2)];

  test('with `groups`, matching members stay in one group entry instead of splitting into rows', () => {
    const withGroups = buildRailEntries(members, {}, [group]);
    expect(withGroups).toHaveLength(1);
    expect(withGroups[0].kind).toBe('group');
    expect(withGroups[0].kind === 'group' ? withGroups[0].members.map((m) => m.id) : []).toEqual(['g1', 'g2']);
    // The old call — no `groups` — is the bug: two bare rows and no group card.
    const withoutGroups = buildRailEntries(members, {});
    expect(withoutGroups.map((entry) => entry.kind)).toEqual(['session', 'session']);
  });

  test('the rail draws the group card for those entries', () => {
    const html = render(
      [{ id: 'local', label: 'Local', kind: 'local', status: 'ready', attachable: true }],
      members,
      { groups: [group] }
    );
    // The header draws the count, not the name: a group's name was either empty (seeded by
    // "Group with…") or a member's own title, so the header repeated the list under it. The name
    // still reaches a screen reader through the row's accessible name.
    expect(textOf(html)).toContain('2 bots');
    expect(html).toContain('aria-label="Open group Release train"');
  });
});
