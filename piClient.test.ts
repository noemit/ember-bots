import { describe, expect, test } from 'bun:test';
import {
  framesToHints,
  PiClient,
  RECENT_WATCHED_CONVERSATIONS,
  selectWatchedConversationIds,
  type PiHint,
} from './electron/piClient';

/**
 * Hearth's stream frames → the hints the renderer already understands.
 *
 * Since Hearth 0.41.0 (pi-durable 1.5.0) the stream carries **state**, not events: a `view` on
 * attach, then `text` / `appended` / `changed`. The transport's whole job is this mapping, and the
 * two ways to get it wrong are visible in the UI: a missing entry means a column that stops
 * updating, an over-eager one means a REST read per token.
 */
const frames = (...list: unknown[]): string => JSON.stringify(list);

describe('what each frame becomes', () => {
  test('the attach view asks for one repair read, not for the transcript', () => {
    const hints = framesToHints('pi:test', '7', frames({ type: 'view', docs: { 'pi.live': {} }, conversation: { id: 7 } }));
    expect(hints.map((hint) => hint.type)).toEqual(['pi:view']);
    // The view carries no entries: history is the paged REST read.
    expect(hints[0]?.deltas).toBeUndefined();
  });

  test('streamed text becomes deltas the renderer applies without a read', () => {
    const hints = framesToHints(
      'pi:test',
      '7',
      frames({
        type: 'text',
        deltas: [
          { index: 0, kind: 'text', text: 'Hel' },
          { index: 1, kind: 'thinking', text: 'pondering' },
        ],
      })
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]?.type).toBe('pi:message_update');
    expect(hints[0]?.deltas).toEqual([
      { index: 0, kind: 'text', text: 'Hel' },
      { index: 1, kind: 'thinking', text: 'pondering' },
    ]);
  });

  test('a malformed or oversized delta batch still takes the REST path', () => {
    const bad = framesToHints('pi:test', '7', frames({ type: 'text', deltas: [{ index: 'x', text: 5 }] }));
    expect(bad[0]?.type).toBe('pi:message_update');
    expect(bad[0]?.deltas).toBeUndefined();
    const huge = framesToHints(
      'pi:test',
      '7',
      frames({ type: 'text', deltas: [{ index: 0, kind: 'text', text: 'x'.repeat(9_000) }] })
    );
    expect(huge[0]?.deltas).toBeUndefined();
  });

  test('an appended entry is the same hint a settled message used to be', () => {
    const hints = framesToHints('pi:test', '7', frames({ type: 'appended', entries: [{ id: 11 }] }));
    expect(hints.map((hint) => [hint.type, hint.sessionId])).toEqual([['pi:message_end', '7']]);
  });

  test('each changed kind keeps the weight the old event had', () => {
    const hints = framesToHints(
      'pi:test',
      '7',
      frames({ type: 'changed', kinds: ['inbox', 'run_start', 'compaction', 'conversation'] })
    );
    expect(hints.map((hint) => hint.type)).toEqual([
      'pi:inbox_update',
      'pi:run_start',
      'pi:compaction_end',
      'pi:submission',
    ]);
    // Duplicates collapse: one read per kind, not one per op behind it.
    const deduped = framesToHints('pi:test', '7', frames({ type: 'changed', kinds: ['live', 'live', 'usage'] }));
    expect(deduped.map((hint) => hint.type)).toEqual(['pi:tool_execution_update', 'pi:usage_changed']);
  });

  test('a frame this build does not know is ignored rather than guessed at', () => {
    expect(framesToHints('pi:test', '7', frames({ type: 'invented' }))).toEqual([]);
    expect(framesToHints('pi:test', '7', 'not json')).toEqual([]);
    expect(framesToHints('pi:test', '7', frames({ type: 'changed', kinds: ['something-new'] }))[0]?.type).toBe(
      'pi:tool_execution_update'
    );
  });

  test('milestone kinds still reach the activity log', () => {
    const hints = framesToHints('pi:test', '7', frames({ type: 'changed', kinds: ['run_start'] }));
    expect(hints[0]?.summary).toBe('started working');
  });
});

describe('the transport', () => {
  test('it forwards a frame batch as one hint per frame, in order', () => {
    const emitted: PiHint[] = [];
    const client = new PiClient((event) => emitted.push(event as PiHint));
    const internal = client as unknown as {
      forwardEvents: (endpointId: string, conversationId: string, message: string) => void;
    };
    internal.forwardEvents(
      'pi:test',
      '123',
      frames({ type: 'changed', kinds: ['run_start'] }, { type: 'text', deltas: [{ index: 0, kind: 'text', text: 'hi' }] })
    );
    expect(emitted.map((hint) => hint.type)).toEqual(['pi:run_start', 'pi:message_update']);
  });

  test('selectWatchedConversationIds watches on-screen ∪ busy ∪ the N most recent active conversations', () => {
    const all = Array.from({ length: 168 }, (_, index) => ({
      id: 1000 - index,
      busy: index === 50,
      needsInput: index === 90,
      archived: index === 2 ? 12345 : undefined,
    }));
    const watched = selectWatchedConversationIds(all, {
      openIds: new Set([1000 - 120]),
      recentLimit: RECENT_WATCHED_CONVERSATIONS,
    });
    // 16 recent non-archived + 1 busy (idx 50) + 1 needsInput (idx 90) + 1 open (idx 120) = 19
    expect(watched).toHaveLength(RECENT_WATCHED_CONVERSATIONS + 3);
    expect(watched).toContain(1000 - 50);
    expect(watched).toContain(1000 - 90);
    expect(watched).toContain(1000 - 120);
    // Archived conversation (idx 2) is excluded unless open or busy.
    expect(watched).not.toContain(1000 - 2);
  });
});
