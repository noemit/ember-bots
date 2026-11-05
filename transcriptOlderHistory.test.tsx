/**
 * The missing-history line is *outside* the scrolling pane, so it cannot be scrolled away.
 *
 * It used to be the first child of the scroller. When a session's kept tail happened to fit on
 * screen — a short session, or a tall window — the line sat above the viewport and the reader was
 * told nothing that history was missing; when the tail was taller than the window it was visible.
 * The same state, two different surfaces, decided by content height. Measured at 1366×768 with a
 * full read the breaker had given up on: window 832px, history 1085px, nothing in the visible area.
 *
 * So the fact lives above the scroller now, and this pins the shape it has to keep: the strip is a
 * sibling of `[aria-label="Conversation history"]`, never a descendant of it.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const source = fs.readFileSync(path.join(import.meta.dir, 'src/components/Transcript.tsx'), 'utf8');

/** Everything between the scroll container's opening tag and the end of the component. */
const scrollerBody = (): string => {
  const start = source.indexOf('ref={scrollRef}');
  if (start < 0) throw new Error('scroll container not found');
  return source.slice(start);
};

describe('where the missing-history line lives', () => {
  test('is a sibling of the scroller, not a child of it', () => {
    // The strip is rendered before the scroll container opens, so it cannot be inside it.
    const stripAt = source.indexOf('Earlier messages aren\'t loaded yet.');
    const scrollerAt = source.indexOf('ref={scrollRef}');
    expect(stripAt).toBeGreaterThan(0);
    expect(scrollerAt).toBeGreaterThan(stripAt);
  });

  test('does not appear inside the scroller’s body at all', () => {
    // The regression this guards: a later edit moving the block back to "first child" because it
    // looked like a header row for the transcript.
    expect(scrollerBody()).not.toContain("Earlier messages aren't loaded yet.");
    expect(scrollerBody()).not.toContain("Earlier messages can't be loaded");
  });

  test('is a flex-none strip with its own surface, so it never scrolls or collapses', () => {
    const at = source.indexOf('Earlier messages aren\'t loaded yet.');
    const blockStart = source.lastIndexOf('<div', at);
    const className = source.slice(blockStart, source.indexOf('role="status"', blockStart));
    expect(className).toContain('flex-none');
    // A boundary against the transcript: it reads as a strip above the conversation, not a message.
    expect(className).toContain('border-b');
  });

  test('keeps the one-action rule: Compact when repairs are halted, Load them when not', () => {
    // Same words in both places — the line was moved wholesale rather than duplicated.
    expect(source).toContain("repairHalt ?");
    expect(source).toContain('Compact');
    expect(source).toContain('Load them');
  });
});
