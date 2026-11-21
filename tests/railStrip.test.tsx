import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RAIL_STRIP_GAP,
  RAIL_STRIP_LABEL_WIDTH,
  WIDE_RAIL_CARD_PADDING,
  WIDE_RAIL_MAX_STRIP_WIDTH,
  wideRailStripWidth,
} from '../src/lib/railStrip';
import { blobStripLayout } from '../src/lib/projectGroups';
import LeftRail from '../src/components/LeftRail';
import ProjectCard from '../src/components/ProjectCard';
import { SessionBlob, SessionBlobStrip } from '../src/components/SessionBlobStrip';
import { TooltipProvider } from '../src/components/ui/tooltip';
import type { Instance, Project, RailMode, Session } from '../src/types';

const session = (overrides: Partial<Session> & Pick<Session, 'id'>): Session => ({
  instanceId: 'local',
  ...overrides,
});

/** SSR needs a TooltipProvider, as the real rail tree (App) supplies one. */
const render = (element: React.ReactElement) =>
  renderToStaticMarkup(<TooltipProvider>{element}</TooltipProvider>);

describe('the project session strip', () => {
  const markup = () =>
    render(
      <SessionBlobStrip>
        <SessionBlob
          session={session({ id: '1', title: 'Fix the start-up flicker' })}
          size={48}
          blobStyle="buddy"
          identity={undefined}
          mood="idle"
          active
          onOpen={() => {}}
        />
      </SessionBlobStrip>
    );

  test('draws a laid-out row with the height the project card always had', () => {
    expect(markup()).toContain('min-h-[30px]');
    expect(markup()).toContain('px-1');
    expect(markup()).toContain('gap:4px');
  });

  test('a title sits under its blob as a clipped two-line chip', () => {
    const html = markup();
    expect(html).toContain('data-blob-label');
    // Exactly two 13px lines plus their 1px padding. It was 35, which let a sliver of a third
    // line show through - a half-visible line reads as a broken chip. `e2e/renameTitle.pw.ts`
    // pins the same ceiling from the rendered side.
    expect(html).toContain('max-height:30px');
    expect(html).toContain(`width:${RAIL_STRIP_LABEL_WIDTH}px`);
    expect(html).toContain('Fix the start-up flicker');
    // The chip is a real label, not a bare tooltip on a dot.
    expect(html).toContain('bg-muted px-1 py-px text-[10px]');
  });

  test('an interactive blob is a labelled button with an active-column underline', () => {
    const html = markup();
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Fix the start-up flicker"');
    expect(html).toContain('data-column-underline');
    expect(html).toContain('data-visible-column="true"');
    expect(html).toContain('data-session-key="local::1"');
  });

  test('a blob carries no pin badge: messages cannot be pinned any more', () => {
    expect(markup()).not.toContain('pinned');
  });

  test('an untitled session falls back to its id, trimmed', () => {
    const html = render(
      <SessionBlobStrip>
        <SessionBlob
          session={session({ id: 'abc', title: '   ' })}
          size={48}
          blobStyle="buddy"
          identity={undefined}
          mood="idle"
          active={false}
          onOpen={() => {}}
        />
      </SessionBlobStrip>
    );
    expect(html).toContain('>abc<');
  });
});

/**
 * S4-10 / S4-11: a blank title is not a title.
 *
 * `titleOverride ?? session.title ?? session.id` let an empty or whitespace-only title win, and the
 * row rendered with no text at all — indistinguishable from a broken session. The strip's own
 * fallback is `session.title?.trim() || session.id`; this pins the same rule for a whitespace title
 * on an interactive blob (the row's, next to it, is the visible one). `SessionRow` and the command
 * palette apply the same rule to the title they print.
 */
/** Whitespace as a title: tab, newline and spaces, the shapes a host can actually store. */
const blankTitle = (): string => [9, 10, 32, 32].map((code) => String.fromCharCode(code)).join('');

describe('a blank title never wins the fallback', () => {
  test('whitespace in the title falls through to the id on the strip', () => {
    const html = render(
      <SessionBlobStrip>
        <SessionBlob
          session={session({ id: 'sess-42', title: blankTitle() })}
          size={48}
          blobStyle="buddy"
          identity={undefined}
          mood="idle"
          active={false}
          onOpen={() => {}}
        />
      </SessionBlobStrip>
    );
    expect(html).toContain('>sess-42<');
    expect(html).toContain('aria-label="sess-42"');
  });
});

/**
 * The rail is where an unanswered host used to look exactly like a quiet one: a grey blob and no
 * badge. `unknown` has to reach the DOM as its own mood, because that attribute is what carries the
 * neutral (desaturated, still) treatment in `blob.css` — a mood that got folded back to idle here
 * would be invisible no matter what the state model says.
 */
describe('a session whose status is unknown', () => {
  const strip = (mood: 'idle' | 'unknown') =>
    render(
      <SessionBlobStrip>
        <SessionBlob
          session={session({ id: '1', title: 'Unanswered host' })}
          size={48}
          blobStyle="buddy"
          identity={undefined}
          mood={mood}
          active={false}
          onOpen={() => {}}
        />
      </SessionBlobStrip>
    );

  test('reaches the blob as its own mood, not as idle', () => {
    expect(strip('unknown')).toContain('data-mood="unknown"');
    expect(strip('idle')).toContain('data-mood="idle"');
  });

  test('keeps the title chip and the row shape, so the row is still readable', () => {
    const html = strip('unknown');
    expect(html).toContain('Unanswered host');
    expect(html).toContain('min-h-[30px]');
  });
});

/**
 * U1 (audit): Wide Session Rail `stripWidth` must adapt dynamically below `1392px` instead of
 * assuming `660px`, so neither the `56px` blob columns nor the trailing `+N` overflow chip clip.
 */
describe('wide rail dynamic strip width (U1)', () => {
  const localHost: Instance = {
    id: 'local',
    label: 'Local',
    kind: 'local',
    status: 'ready',
    attachable: true,
  };
  const project: Project = { id: 'p-ember', name: 'ember', path: '/work/ember' };
  const makeProjectSessions = (count: number): Session[] =>
    Array.from({ length: count }, (_, index) =>
      session({
        id: `w-${index + 1}`,
        title: `Task ${index + 1}`,
        directory: '/work/ember',
        updated: 10_000 - index,
      })
    );

  const countRenderedBlobs = (html: string): number => html.split('data-session-key="').length - 1;

  /**
   * Real horizontal chrome inside `scroller.clientWidth`:
   * `px-1.5` scroller padding (12px) + `ProjectCard` border & `px-2` (18px) + `SessionBlobStrip` `px-1` (8px) = 38px.
   */
  const stripContentBoxWidth = (scrollerClientWidth: number): number => scrollerClientWidth - 38;
  const requiredStripWidth = (count: number, stripWidth: number): number => {
    const layout = blobStripLayout(
      count,
      stripWidth,
      48,
      30,
      RAIL_STRIP_GAP,
      RAIL_STRIP_LABEL_WIDTH
    );
    const item = Math.max(layout.size, RAIL_STRIP_LABEL_WIDTH);
    const chip = layout.overflow > 0 ? Math.max(layout.size, 22) : 0;
    return (
      layout.visible * item +
      (layout.visible - 1) * RAIL_STRIP_GAP +
      (layout.overflow > 0 ? RAIL_STRIP_GAP + chip : 0)
    );
  };

  test('subtracts ProjectCard padding (~44px) from measured scroll container width so +N never clips', () => {
    expect(WIDE_RAIL_CARD_PADDING).toBe(44);
    for (const viewport of [768, 900, 1024, 1200, 1320, 1391]) {
      for (const scrollbar of [0, 15]) {
        const scrollerClientWidth = Math.floor(viewport * 0.5) - 1 - scrollbar;
        const measured = wideRailStripWidth(scrollerClientWidth, viewport);
        const fallback = wideRailStripWidth(null, viewport);
        expect(measured).toBe(scrollerClientWidth - 44);
        expect(measured).toBeLessThan(WIDE_RAIL_MAX_STRIP_WIDTH);
        expect(fallback).toBeLessThan(WIDE_RAIL_MAX_STRIP_WIDTH);

        for (const count of [2, 6, 9, 11, 12, 20]) {
          expect(requiredStripWidth(count, measured)).toBeLessThanOrEqual(
            stripContentBoxWidth(scrollerClientWidth)
          );
          if (scrollbar === 0) {
            expect(requiredStripWidth(count, fallback)).toBeLessThanOrEqual(
              stripContentBoxWidth(scrollerClientWidth)
            );
          }
        }
      }
    }
  });

  test('caps unmeasured fallback at 660 on wide monitors and handles missing globals safely', () => {
    expect(wideRailStripWidth(null, 1600)).toBe(660);
    expect(wideRailStripWidth(null, undefined)).toBe(660);
    expect(wideRailStripWidth(0, Number.NaN)).toBe(660);
    expect(wideRailStripWidth(80, 768)).toBe(RAIL_STRIP_LABEL_WIDTH);
  });

  test('ProjectCard with measured ResizeObserver width adapts visible blobs and keeps +N intact', () => {
    const twelve = makeProjectSessions(12);
    // At 768px (`scroller.clientWidth = 383`, stripWidth = 339), 5 slots + `+7` fit (`332px <= 345px`),
    // whereas hardcoded 660px tried to render 10 slots + `+2` (`632px`) and clipped half the strip.
    const narrowHtml = render(
      <ProjectCard
        project={project}
        instanceId="local"
        instanceLabel="Local"
        markerColor={undefined}
        sessions={twelve}
        moods={{}}
        visibleKeys={new Set()}
        avatarIdentities={{}}
        blobStyle="buddy"
        reloadingKeys={new Set()}
        archivingKeys={new Set()}
        onOpenProject={() => undefined}
        onOpenSession={() => undefined}
        onNewAgent={() => undefined}
        onReload={() => undefined}
        onArchive={() => undefined}
        onArchiveMany={() => undefined}
        onCustomizeAppearance={() => undefined}
        stripWidth={wideRailStripWidth(383, 768)}
      />
    );
    expect(countRenderedBlobs(narrowHtml)).toBe(5);
    expect(narrowHtml).toContain('aria-label="7 more sessions"');
    expect(narrowHtml).toContain('>+7<');

    // At 1320px (`scroller.clientWidth = 659`, stripWidth = 615), 9 slots + `+3` (`572px <= 621px`)
    // fit cleanly instead of hardcoded 660px squeezing 10 slots + `+2` (`632px > 621px`) and clipping `+2`.
    const midHtml = render(
      <ProjectCard
        project={project}
        instanceId="local"
        instanceLabel="Local"
        markerColor={undefined}
        sessions={twelve}
        moods={{}}
        visibleKeys={new Set()}
        avatarIdentities={{}}
        blobStyle="buddy"
        reloadingKeys={new Set()}
        archivingKeys={new Set()}
        onOpenProject={() => undefined}
        onOpenSession={() => undefined}
        onNewAgent={() => undefined}
        onReload={() => undefined}
        onArchive={() => undefined}
        onArchiveMany={() => undefined}
        onCustomizeAppearance={() => undefined}
        stripWidth={wideRailStripWidth(659, 1320)}
      />
    );
    expect(countRenderedBlobs(midHtml)).toBe(9);
    expect(midHtml).toContain('aria-label="3 more sessions"');
    expect(midHtml).toContain('>+3<');
  });

  test('LeftRail in wide mode adapts ProjectCard strip width below 1392px before measurement', () => {
    const scope = globalThis as { window?: unknown };
    const previousWindow = scope.window;
    const renderRailAt = (viewportWidth: number, mode: RailMode, list: Session[]) => {
      const existing =
        typeof previousWindow === 'object' && previousWindow !== null
          ? (previousWindow as Record<string, unknown>)
          : {};
      scope.window = {
        ...existing,
        innerWidth: viewportWidth,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      };
      try {
        return render(
          <LeftRail
            instances={[localHost]}
            projectsByInstance={{ local: [project] }}
            instanceDefaults={{}}
            sessions={list}
            snoozedSessions={[]}
            onSnooze={() => undefined}
            everySession={list}
            moods={{}}
            previews={{}}
            selectedKey={null}
            avatarIdentities={{}}
            blobStyle="buddy"
            mode={mode}
            compact={false}
            loading={false}
            startupMessage={null}
            mobileOpen={false}
            reloadingKeys={new Set()}
            archivingKeys={new Set()}
            visibleColumnKeys={new Set()}
            selectedSession={null}
            windowLabel={null}
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
            onRenameSession={() => undefined}
          />
        );
      } finally {
        if (previousWindow === undefined) delete scope.window;
        else scope.window = previousWindow;
      }
    };

    const twelve = makeProjectSessions(12);
    const eleven = makeProjectSessions(11);

    const wide768 = renderRailAt(768, 'wide', twelve);
    expect(countRenderedBlobs(wide768)).toBe(5);
    expect(wide768).toContain('aria-label="7 more sessions"');

    const wide1024 = renderRailAt(1024, 'wide', twelve);
    expect(countRenderedBlobs(wide1024)).toBe(7);
    expect(wide1024).toContain('aria-label="5 more sessions"');

    // At 1391px, 11 sessions (`656px` raw width) no longer pretend to fit in 660px: the 11th folds
    // into `+1` (`634px`) so the strip never clips at the right border.
    const wide1391 = renderRailAt(1391, 'wide', eleven);
    expect(countRenderedBlobs(wide1391)).toBe(10);
    expect(wide1391).toContain('aria-label="1 more sessions"');

    const wide1600 = renderRailAt(1600, 'wide', twelve);
    expect(countRenderedBlobs(wide1600)).toBe(10);
    expect(wide1600).toContain('aria-label="2 more sessions"');

    const normal1600 = renderRailAt(1600, 'normal', twelve);
    expect(countRenderedBlobs(normal1600)).toBe(4);
    expect(normal1600).toContain('aria-label="8 more sessions"');
  });
});
