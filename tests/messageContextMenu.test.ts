/**
 * The reply's right-click menu, and where "Mark as unread" may appear in it.
 *
 * The menu is the second home for Copy and Reply (the hover gutter keeps the first), and the only
 * home for the inverse of the read receipt. What matters here is *when* it is offered, which is a
 * question about the render tree rather than about pixels:
 *
 *   - only assistant replies — a user message is not something the agent's read state describes;
 *   - only where unread state exists at all, which the app withholds from worker threads;
 *   - never while text is selected: a right-click inside a selection means "work with these words",
 *     and the native menu is the one that does that;
 *   - never on a draft or an optimistic message, which has no host-side entry to mark.
 *
 * Pure structure, so it reads the component source rather than mounting a virtualised transcript.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isMessageRead, markUnreadFrom } from '../src/lib/readState';

const transcript = fs.readFileSync(path.join(import.meta.dir, '../src/components/Transcript.tsx'), 'utf8');
const chatView = fs.readFileSync(path.join(import.meta.dir, '../src/components/ChatView.tsx'), 'utf8');

describe('the reply context menu', () => {
  test('is offered only for assistant replies with unread state to move', () => {
    expect(transcript).toContain('const menuEnabled = message.role === \'assistant\' && Boolean(onMarkUnread);');
    expect(transcript).toContain('if (!menuEnabled) return rowBody;');
  });

  test('"Mark as unread" is withheld while text is selected', () => {
    // Read at *pointerdown*, because the browser collapses the selection when the right button goes
    // down — by the time `contextmenu` fires the drag has already been forgotten. The remembered
    // answer wins; a `contextmenu` with no preceding press falls back to the live selection.
    expect(transcript).toContain('selectionAtPress.current = Boolean(window.getSelection()?.isCollapsed);');
    expect(transcript).toContain('setMenuAllowed(remembered ?? Boolean(window.getSelection()?.isCollapsed));');
    expect(transcript).toContain('{menuAllowed.current && onMarkUnread ? (');
  });

  test('keeps Copy and Reply in the menu as well as in the hover gutter', () => {
    const menu = transcript.slice(transcript.indexOf('const menuContent = ('), transcript.indexOf('const rowBody = ('));
    expect(menu).toContain('Copy as Markdown');
    expect(menu).toContain('onSelect={() => onReply(message)}');
    // ...and the gutter Copy is still its own control, not replaced by the menu.
    expect(transcript).toContain('const CopyAsMarkdown = ({ message }: { message: ChatMessage }) => (');
  });

  test('a worker thread never sees the control', () => {
    // ChatView derives it from the callbacks the app hands it, which are absent on a worker.
    expect(chatView).toContain('canManageUnread={Boolean(session && onMarkMessageUnread && onMarkMessageRead)}');
  });
});

describe('what the menu item does', () => {
  test('unreads that reply and everything after it, and nothing before', () => {
    const read = { through: 40, readAt: 900 };
    const next = markUnreadFrom(read, 20);
    expect(next.through).toBe(19);
    expect(isMessageRead(next, 19, 0)).toBe(true);
    expect(isMessageRead(next, 20, 0)).toBe(false);
    expect(isMessageRead(next, 33, 0)).toBe(false);
  });

  test('is safe to press twice', () => {
    const once = markUnreadFrom({ through: 40 }, 20);
    const twice = markUnreadFrom(once, 20);
    expect(twice.through).toBe(once.through);
  });
});
