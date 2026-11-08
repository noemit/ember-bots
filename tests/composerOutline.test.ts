import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The composer's focus state is a **soft outer glow** plus the send button taking the accent —
 * the border keeps its own colour and width at every state.
 *
 * This is the fourth pass at the composer outline, so the history and the rule are pinned here
 * rather than left to whoever next reaches for `ring`, `outline`, or a recoloured border:
 *
 *  1. A wide ring keyed on `:focus-visible`. Chromium sets `:focus-visible` for a *clicked* text
 *     field too (it takes keyboard input), so a second, offset outline painted for the whole of
 *     normal writing.
 *  2. A 1px **inset** ring, to read as the border thickening. Subtler, still wrong: the border and
 *     the inset ring are two concentric arcs 1px apart, and at a 14px radius they round to
 *     different pixel columns — measured on the rendered box, the hairline carried a gap across the
 *     top (`#+#` in rows 17-18 of the corner), which is the "weird pixeliness" it looked like.
 *  3. A thicker recoloured border (`has-focus-visible:!border-2 has-focus-visible:border-ring`).
 *     Rejected by the owner: the border must keep its own colour when focused; the focus state is
 *     carried by a soft outer glow alone, plus the send button turning accent.
 */
const css = fs.readFileSync(path.join(import.meta.dir, '../src/styles.css'), 'utf8');
const source = fs.readFileSync(path.join(import.meta.dir, '../src/components/ChatView.tsx'), 'utf8');

/** The composer's own class list — the only element in the file with this marker. */
const composerClassName = (): string => {
  const match = source.match(/className="(group\/composer flex flex-col rounded-xl border bg-background[^"]*)"/);
  if (!match) throw new Error('composer class not found in ChatView.tsx');
  return match[1]!;
};

/** The send button's class list inside the composer row. */
const sendButtonClassName = (): string => {
  const match = source.match(/className="(size-7 flex-none rounded-full[^"]*group-has-focus-visible\/composer[^"]*)"/);
  if (!match) throw new Error('send button class not found in ChatView.tsx');
  return match[1]!;
};

describe('the composer outline and send button accent', () => {
  test('the border keeps its own colour and width on focus', () => {
    const cls = composerClassName();
    expect(cls).not.toContain('border-ring');
    expect(cls).not.toContain('!border-2');
    expect(cls).not.toMatch(/\b(focus-within|has-focus-visible):border-/);
  });

  test('focus is a blurred outer box-shadow glow on has-focus-visible, never a ring or inset-ring', () => {
    const cls = composerClassName();
    expect(css).toContain('[data-composer-surface]:has(:focus-visible)::before');
    expect(css).toContain('box-shadow: 0 0 12px');
    expect(css).toContain('mix-blend-mode: var(--composer-glow-blend)');
    expect(css).toContain('pointer-events: none');
    expect(css).toContain('isolation: isolate');
    expect(css).not.toContain('[data-composer-surface]:focus-within');
    expect(cls).not.toContain('inset-ring');
    expect(cls).not.toMatch(/\bhas-focus-visible:ring-/);
    expect(cls).not.toMatch(/\bhas-focus-visible:outline\b/);
    // Clicking a row control (`focus-within` without `:focus-visible`) must not trigger the glow.
    expect(cls).not.toMatch(/\bfocus-within:shadow-/);
  });

  test('the send button takes the accent under the same has-focus-visible condition and stays muted when disabled', () => {
    const cls = sendButtonClassName();
    expect(cls).toContain('group-has-focus-visible/composer:not-aria-disabled:bg-highlight');
    expect(cls).toContain('group-has-focus-visible/composer:not-aria-disabled:text-highlight-foreground');
    expect(cls).toContain('aria-disabled:bg-muted');
    expect(cls).toContain('aria-disabled:opacity-50');
  });
});
