import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RAIL_STRIP_LABEL_WIDTH,
  RAIL_STRIP_MAX_SIZE,
  RAIL_STRIP_MIN_SIZE,
  RAIL_STRIP_WIDTH,
  groupNewAgentTarget,
  railStripLayout,
  splitStrip,
} from './src/lib/railStrip';
import { blobStripLayout } from './src/lib/projectGroups';
import { SessionBlob, SessionBlobStrip } from './src/components/SessionBlobStrip';
import { TooltipProvider } from './src/components/ui/tooltip';
import type { Session } from './src/types';

const session = (overrides: Partial<Session> & Pick<Session, 'id'>): Session => ({
  instanceId: 'local',
  ...overrides,
});

describe('railStripLayout', () => {
  test('is the shared project-card math at the rail width', () => {
    // The project card passes exactly these numbers; if either drifts, the two cards' blobs stop
    // matching size for size and the whole point of sharing the strip is gone.
    for (const count of [0, 1, 3, 4, 5, 9, 20, 40]) {
      expect(railStripLayout(count)).toEqual(
        blobStripLayout(count, RAIL_STRIP_WIDTH, 48, 30, 4, RAIL_STRIP_LABEL_WIDTH)
      );
    }
    expect(RAIL_STRIP_MAX_SIZE).toBe(48);
    expect(RAIL_STRIP_MIN_SIZE).toBe(30);
  });

  test('a handful of sessions keeps full-size blobs, with room for the labels', () => {
    expect(railStripLayout(0)).toEqual({ size: 48, visible: 0, overflow: 0 });
    expect(railStripLayout(3)).toEqual({ size: 48, visible: 3, overflow: 0 });
    expect(railStripLayout(4)).toEqual({ size: 48, visible: 4, overflow: 0 });
  });

  test('as members grow the strip shrinks, then overflows instead of reflowing', () => {
    expect(railStripLayout(5).size).toBe(46);
    expect(railStripLayout(10).size).toBe(36);
    expect(railStripLayout(40).size).toBe(30);
    // 280px fits four 56px items plus gaps; anything past that collapses into the +N chip.
    const many = railStripLayout(12);
    expect(many.visible).toBe(4);
    expect(many.overflow).toBe(8);
    expect(many.visible + many.overflow).toBe(12);
  });
});

describe('splitStrip', () => {
  const members = Array.from({ length: 7 }, (_, index) => session({ id: `s${index}` }));

  test('divides members in card order without dropping or repeating one', () => {
    const layout = railStripLayout(members.length);
    const { shown, hidden } = splitStrip(members, layout);
    expect(shown).toHaveLength(layout.visible);
    expect(hidden).toHaveLength(layout.overflow);
    expect([...shown, ...hidden].map((member) => member.id)).toEqual(members.map((member) => member.id));
  });

  test('everything fits when the strip has no overflow', () => {
    const three = members.slice(0, 3);
    expect(splitStrip(three, railStripLayout(3))).toEqual({ shown: three, hidden: [] });
    expect(splitStrip([], railStripLayout(0))).toEqual({ shown: [], hidden: [] });
  });
});

describe('groupNewAgentTarget', () => {
  test('uses the group primary member instance and folder', () => {
    const members = [
      session({ id: 'a', instanceId: 'local', directory: '/work/ember' }),
      session({ id: 'b', instanceId: 'pi:hearth', directory: '/work/other' }),
    ];
    expect(groupNewAgentTarget(members, 'pi:hearth::b')).toEqual({
      instanceId: 'pi:hearth',
      directory: '/work/other',
    });
  });

  test('falls back to the first member when the primary no longer resolves', () => {
    const members = [session({ id: 'a', instanceId: 'local', directory: '/work/ember' })];
    expect(groupNewAgentTarget(members, 'pi:hearth::gone')).toEqual({
      instanceId: 'local',
      directory: '/work/ember',
    });
    expect(groupNewAgentTarget(members, undefined)?.instanceId).toBe('local');
  });

  test('an empty group has no target rather than a guessed instance', () => {
    expect(groupNewAgentTarget([], 'local::a')).toBeUndefined();
  });
});

/** SSR needs a TooltipProvider, as the real rail tree (App) supplies one. */
const render = (element: React.ReactElement) =>
  renderToStaticMarkup(<TooltipProvider>{element}</TooltipProvider>);

/**
 * The two cards must draw the same blob: same wrapper classes, same label chip, same underline.
 * This pins the shared strip's output, because it is now both cards' body.
 */
describe('the shared session strip', () => {
  const markup = (onOpen?: () => void) =>
    render(
      <SessionBlobStrip>
        <SessionBlob
          session={session({ id: '1', title: 'Fix the start-up flicker' })}
          size={48}
          blobStyle="buddy"
          identity={undefined}
          mood="idle"
          active
          onOpen={onOpen}
        />
      </SessionBlobStrip>
    );

  test('draws a laid-out row with the height the project card always had', () => {
    expect(markup(() => {})).toContain('min-h-[30px]');
    expect(markup(() => {})).toContain('px-1');
    expect(markup(() => {})).toContain('gap:4px');
  });

  test('a title sits under its blob as a clipped two-line chip', () => {
    const html = markup(() => {});
    expect(html).toContain('data-blob-label');
    // Exactly two 13px lines plus their 1px padding. It was 35, which let a sliver of a third
    // line show through - a half-visible line reads as a broken chip. `e2e/renameTitle.pw.ts`
    // pins the same ceiling from the rendered side.
    expect(html).toContain('max-height:30px');
    expect(html).toContain('Fix the start-up flicker');
    // The chip is a real label, not a bare tooltip on a dot.
    expect(html).toContain('bg-muted px-1 py-px text-[10px]');
  });

  test('an interactive blob is a labelled button with an active-column underline', () => {
    const html = markup(() => {});
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Fix the start-up flicker"');
    expect(html).toContain('data-column-underline');
    expect(html).toContain('data-visible-column="true"');
    expect(html).toContain('data-session-key="local::1"');
  });

  test('a display-only blob keeps its chip and title but stops being a control', () => {
    const html = markup(undefined);
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('tabindex="0"');
    expect(html).toContain('Fix the start-up flicker');
    expect(html).toContain('data-blob-label');
    // Title chips share one width floor, so a shrunken blob's label still fits.
    expect(html).toContain(`width:${RAIL_STRIP_LABEL_WIDTH}px`);
  });

  test('a blob carries no pin badge: messages cannot be pinned any more', () => {
    expect(markup(() => {})).not.toContain('pinned');
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
