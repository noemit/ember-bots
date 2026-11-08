/**
 * A tray row's two spinners, and when neither is there.
 *
 * A steer message is held by the host until the running turn pauses. It used to say so in its
 * metadata — "waits for the turn to pause" — which took the one line of the row away from the
 * message itself to describe something a spinner says faster. The spinner sits at the *trailing*
 * edge; the leading one is for a row that is being created, which is a different fact.
 */
import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TrayRow from '../src/components/TrayRow';

const render = (over: Partial<React.ComponentProps<typeof TrayRow>> = {}) =>
  renderToStaticMarkup(<TrayRow text="a queued line" openLabel="Read queued message" onOpen={() => {}} {...over} />);

describe('a tray row', () => {
  test('keeps preview and metadata readable when idle', () => {
    const html = render({ meta: <span>faux-hearth / glm</span> });
    expect(html).toContain('a queued line');
    expect(html).toContain('faux-hearth / glm');
    expect(html).not.toContain('animate-spin');
  });

  test('a waiting row puts the spinner at its trailing edge, with no sentence', () => {
    const html = render({ waiting: true, waitingLabel: 'Waiting for the turn to pause' });
    expect(html).toContain('animate-spin');
    // Spoken, not written: the visible line belongs to the message.
    expect(html).toContain('aria-label="Waiting for the turn to pause"');
    expect(html).not.toContain('>Waiting for the turn to pause<');
  });

  test('the leading spinner is for a row still being created', () => {
    // `busy` (place-holder) and `waiting` (held) are different facts and never both show.
    const busy = render({ busy: true });
    expect(busy).toContain('animate-spin');
    expect(busy).not.toContain('role="status"');
  });
});


describe('fine-list readable previews', () => {
  test('long previews clamp at two lines and wrap unbroken text rather than widening the shelf', () => {
    const html = render({ text: 'A long message ' + 'word'.repeat(100) });
    expect(html).toContain('data-tray-preview');
    expect(html).toContain('line-clamp-2');
    expect(html).toContain('overflow-wrap:anywhere');
    expect(html).not.toContain('truncate');
  });

  test('actions are sibling buttons in their own reserved lane, reachable on touch and focus', () => {
    const html = render({ meta: 'Model · effort', actions: <button>Send</button> });
    expect(html.match(/<button/g)?.length).toBe(2);
    expect(html.indexOf('</button>')).toBeLessThan(html.indexOf('data-tray-actions'));
    expect(html).toContain('flex-wrap');
    expect(html).toContain('max-sm:opacity-100');
    expect(html).toContain('[@media(min-width:640px)_and_(hover:hover)_and_(pointer:fine)]:opacity-0');
    expect(html).not.toContain('[@media(hover:hover)_and_(pointer:fine)]:opacity-0');
    expect(html).toContain('group-focus-within/row:opacity-100');
    expect(html).not.toContain('group-hover/row:hidden');
    expect(html).not.toContain('absolute');
  });

  test('errors remain outside the text clamp, wrap, and are never hover-hidden', () => {
    const html = render({ detail: 'Tower refused this message. Retry or cancel it.' });
    const error = html.slice(html.indexOf('data-tray-error'));
    expect(error).toContain('Tower');
    expect(error).toContain('overflow-wrap:anywhere');
    expect(error).not.toContain('line-clamp');
    expect(error).not.toContain('hidden');
  });
});
