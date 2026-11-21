/**
 * C2 (audit): an outage renders as itself, not as deletion.
 *
 * The pure halves are covered in `instanceHealth.test.ts`; this renders the rail and window notices so the *shape* is
 * pinned too: the silent host gets one honest toast of its own (not a session row, not a survivor
 * session), its last-known sessions are still listed, and the empty state names the real case
 * instead of the old "No instances connected. Add a Hearth endpoint in Settings, then refresh."
 */
import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InstanceOutageToasts } from '../src/components/InstanceOutageToasts';
import LeftRail from '../src/components/LeftRail';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { silentInstances } from '../src/lib/instanceHealth';
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
    scheduledTasks?: import('../src/types').ScheduledTask[];
    dismissed?: string[];
  } = {}
) => {
  ensureRenderableGlobals();
  const everySession = extra.everySession ?? list;
  return renderToStaticMarkup(
    <TooltipProvider>
      <InstanceOutageToasts entries={silentInstances(instances, list, undefined, new Set(extra.dismissed ?? []))} onRetry={() => undefined} onDismiss={() => undefined} onSettings={() => undefined} retrying={false} />
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
    expect(countOf(html, 'data-testid="instance-outage-toast"')).toBe(1);
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
    expect(text).not.toMatch(/Add a Kiln connection/i);
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
    expect(html).toContain('Connection settings for Keep');
    expect(textOf(html)).not.toMatch(/undefined|null|HTTP|!/);
  });

  test('a dismissed host draws no row, and its sessions are still listed', () => {
    const text = textOf(render([host], sessions, { dismissed: ['pi:keep'] }));
    expect(text).not.toMatch(/not answering/i);
    expect(text).toContain('Habit onboarding QA');
    expect(text).toContain('Memory budget');
    // Silencing the warning is not a claim that the host is back: the empty state still names the
    // real reason rather than pretending everything is fine.
    const empty = textOf(render([host], [], { dismissed: ['pi:keep'] }));
    expect(empty).toMatch(/none of your 1 Kiln connection is answering/i);
    expect(empty).toMatch(/reprobe/i);
  });

  test('an empty rail names the case instead of asserting absence', () => {
    const silent = textOf(render([host], []));
    expect(silent).toMatch(/none of your 1 Kiln connection is answering/i);
    // The way back is named by its label, not by where it sits: every outage row can be dismissed,
    // so this list can be empty with no Retry button anywhere above it.
    expect(silent).toMatch(/reprobe instances in the instances menu/i);

    const noEndpoints = textOf(render([], []));
    expect(noEndpoints).toMatch(/No Kiln connections yet/i);
    expect(noEndpoints).toMatch(/settings/i);

    const connectedEmpty = textOf(
      render([{ ...host, status: 'ready', attachable: true }], [])
    );
    expect(connectedEmpty).toMatch(/no sessions yet/i);
    expect(connectedEmpty).not.toMatch(/not answering/i);
  });
});
