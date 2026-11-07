import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ComposerShelf, { nextShelfState, type ShelfSection } from '../src/components/ComposerShelf';

/**
 * The shelf above the composer: one line of tabs, one section open under it.
 *
 * It replaced three separate trays — a queue card, a notes card and a crew strip — that stacked a
 * border, a heading and often a second line for everything in the tallest part of the window. These
 * tests pin the qualities that make the replacement cheaper: one header line, no empty tab for a
 * tray with nothing in it, and folding that keeps the tabs (so nothing becomes unreachable).
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

const sections = (
  over: Partial<Record<'queue' | 'notes' | 'crew' | 'processes', number>> = {}
): ShelfSection[] => [
  { id: 'queue', label: 'Queue', count: over.queue ?? 2, content: <p>queue rows</p> },
  { id: 'notes', label: 'For later', count: over.notes ?? 1, content: <p>note rows</p> },
  { id: 'crew', label: 'Crew', count: over.crew ?? 3, alert: true, content: <p>crew chips</p> },
  // Zero by default: an agent that left nothing running has no Processes tab at all.
  ...((over.processes ?? 0) > 0
    ? [
        {
          id: 'processes' as const,
          label: 'Processes',
          count: over.processes ?? 0,
          content: <p>process rows</p>,
        },
      ]
    : []),
];

const render = (props: Partial<React.ComponentProps<typeof ComposerShelf>> = {}) =>
  renderToStaticMarkup(
    <ComposerShelf
      sections={sections()}
      active="queue"
      onActiveChange={() => {}}
      open
      onOpenChange={() => {}}
      {...props}
    />
  );

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('the composer shelf', () => {
  test('one tab per tray, each with its count', () => {
    const html = render();
    expect(html.split('role="tab"').length - 1).toBe(3);
    expect(text(html)).toContain('Queue 2');
    expect(text(html)).toContain('For later 1');
    expect(text(html)).toContain('Crew 3');
  });

  test('only the open section draws rows — the shelf cannot be a stack', () => {
    const html = render({ active: 'notes' });
    expect(html).toContain('note rows');
    expect(html).not.toContain('queue rows');
    expect(html).not.toContain('crew chips');
  });

  test('a tray with nothing in it has no tab: an empty heading only says "nothing here"', () => {
    const html = render({ sections: sections({ queue: 0 }) });
    expect(html.split('role="tab"').length - 1).toBe(2);
    expect(text(html)).not.toContain('Queue 0');
    // With the empty tray selected, the shelf opens the first tray that has something.
    expect(text(html)).toContain('note rows');
  });

  test('the open tray can be folded away, and its tab stays to bring it back', () => {
    const folded = render({ open: false });
    expect(folded).not.toContain('queue rows');
    expect(folded.split('role="tab"').length - 1).toBe(3);
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).toContain('aria-label="Show the composer trays"');
    // The open state says what the control will do, not what it currently is.
    expect(render()).toContain('aria-label="Fold the composer trays"');
  });

  test('a tray that wants the human carries a dot, named for a screen reader', () => {
    const html = render();
    expect(html).toContain('needs your attention');
    expect(html).toContain('bg-highlight');
  });

  test('nothing to show is nothing at all, not an empty header', () => {
    expect(
      render({ sections: sections({ queue: 0, notes: 0, crew: 0, processes: 0 }) })
    ).toBe('');
  });
});

describe('the Processes tray', () => {
  test('is a tab beside the others, not a row above the composer', () => {
    const html = render({ sections: sections({ processes: 2 }) });
    expect(html.split('role="tab"').length - 1).toBe(4);
    expect(text(html)).toContain('Processes 2');
  });

  test('has no tab when nothing is running', () => {
    const html = render({ sections: sections({ processes: 0 }) });
    expect(text(html)).not.toContain('Processes');
    expect(html.split('role="tab"').length - 1).toBe(3);
  });

  test('opens like any other tray, and only one is open at a time', () => {
    const html = render({ sections: sections({ processes: 2 }), active: 'processes' });
    expect(html).toContain('process rows');
    expect(html).not.toContain('queue rows');
  });
});

/**
 * A tab is both "show me this tray" and "put it away".
 *
 * Clicking the tray that is already open used to do nothing: it re-selected itself, so the only way
 * to fold the shelf was the small chevron on the right — a second control for a gesture the tab
 * already implies. The tab now folds, and clicking it again brings the same tray back.
 */
describe('clicking a tab', () => {
  test('the open tray folds', () => {
    expect(nextShelfState({ open: true, selected: true, id: 'queue' })).toEqual({
      open: false,
      active: null,
    });
  });

  test('the folded tray reopens, still selected', () => {
    expect(nextShelfState({ open: false, selected: true, id: 'queue' })).toEqual({
      open: true,
      active: 'queue',
    });
  });

  test('another tray opens on that tray', () => {
    expect(nextShelfState({ open: true, selected: false, id: 'crew' })).toEqual({
      open: true,
      active: 'crew',
    });
    // Including from a folded shelf: the click shows the tray it names, not the one left over.
    expect(nextShelfState({ open: false, selected: false, id: 'crew' })).toEqual({
      open: true,
      active: 'crew',
    });
  });
});
