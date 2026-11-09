import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import QueuedMessageList, { canMergeQueuedUp } from '../src/components/QueuedMessageList';
import SessionNotes from '../src/components/SessionNotes';
import type { QueuedMessage } from '../src/types';

let previousWindow: unknown;
beforeAll(() => {
  previousWindow = (globalThis as { window?: unknown }).window;
  delete (globalThis as { window?: unknown }).window;
});
afterAll(() => {
  if (previousWindow !== undefined) (globalThis as { window?: unknown }).window = previousWindow;
});
const item = (id: string, extra: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id, text: `Message ${id}`, content: `Message ${id}`, createdAt: 0,
  attachments: [], context: [], sendConfig: { providerID: 'test', modelID: 'test' }, ...extra,
});
const success = async () => true;
const render = (items: QueuedMessage[], sendingId: string | null = null) => renderToStaticMarkup(
  <QueuedMessageList queue={{ sessionId: 's', directory: '/work', items, sendingId }} models={[]}
    onSendQueued={success} onMoveQueued={success} onRemoveQueued={success} onParkQueued={success}
    onReplaceQueued={success} onRetryQueued={success} onDiscardQueued={() => true} />
);
const action = (html: string, name: string) => [...html.matchAll(/<button\b[^>]*>/g)]
  .map(match => match[0]).find(button => button.includes(`aria-label="${name}`));

describe('readable queue actions retain their contract', () => {
  test('normal items keep reading, editing, sending, cancelling and movement as separate controls', () => {
    const html = render([item('a'), item('b')]);
    for (const name of ['Read queued message', 'Edit queued message', 'Send queued message now', 'Cancel queued message', 'Move queued message up', 'Move queued message down', 'More actions']) {
      expect(action(html, name)).toBeDefined();
    }
    expect(html).toContain('list-none flex-col divide-y');
    expect(html).toContain('data-tray-preview');
  });

  test('steers only retain reading, withdrawal and movement, never unsafe edit/send/overflow', () => {
    const html = render([item('steer', { mode: 'steer' })]);
    expect(action(html, 'Withdraw')).toBeDefined();
    expect(action(html, 'Move queued message')).toBeDefined();
    for (const name of ['Edit queued message', 'Send queued message now', 'More actions']) expect(action(html, name)).toBeUndefined();
    expect(html).toContain('aria-label="Waiting for the turn to pause"');
  });

  test('pending items allow text editing but have no overflow or send action', () => {
    const html = render([item('pending', { pending: true })]);
    expect(action(html, 'Edit queued message')).not.toContain(' disabled=');
    expect(action(html, 'More actions')).toBeUndefined();
    expect(action(html, 'Send queued message now')).toBeUndefined();
  });

  test('sending locks are visibly disabled rather than silently ignoring another mutation', () => {
    const html = render([item('a'), item('b')], 'a');
    for (const name of ['Edit queued message', 'Send queued message now', 'Cancel queued message', 'Move queued message up', 'More actions']) {
      expect(action(html, name)).toContain(' disabled=');
    }
  });

  test('failed messages retain diagnostics with retry and discard controls', () => {
    const html = render([item('failed', { error: 'Tower refused the message. Retry or cancel it.' })]);
    expect(html).toContain('data-tray-error');
    expect(action(html, 'Retry queueing')).toBeDefined();
    expect(action(html, 'Discard this message')).toBeDefined();
  });

  test('merge-up excludes steers, pending and failed items on either side', () => {
    expect(canMergeQueuedUp([item('a'), item('b')], 1)).toBe(true);
    expect(canMergeQueuedUp([item('a')], 0)).toBe(false);
    for (const extra of [{ mode: 'steer' as const }, { pending: true }, { error: 'failed' }]) {
      expect(canMergeQueuedUp([item('a', extra), item('b')], 1)).toBe(false);
      expect(canMergeQueuedUp([item('a'), item('b', extra)], 1)).toBe(false);
    }
  });

  test('merge all appears only beyond three follow-ups, outside the bounded list', () => {
    expect(render([item('a'), item('b'), item('c'), item('steer', { mode: 'steer' })])).not.toContain('Merge all queued messages');
    const html = render(['a', 'b', 'c', 'd'].map(id => item(id)));
    expect(html.indexOf('</ol>')).toBeLessThan(html.indexOf('Merge all queued messages'));
  });

  test('notes use the same fine separated list and keep their real handlers reachable', () => {
    const html = renderToStaticMarkup(<SessionNotes notes={[{ id: 'n', text: 'A saved thought', createdAt: 0 }]} onSend={success} onBringBack={() => {}} onDelete={() => {}} onUpdate={() => {}} models={[]} modelValue="default" modelVariant="" recentModels={[]} />);
    expect(html).toContain('list-none flex-col divide-y');
    for (const name of ['Read note', 'Send note', 'Edit note in composer', 'Delete note']) expect(action(html, name)).toBeDefined();
  });
});
