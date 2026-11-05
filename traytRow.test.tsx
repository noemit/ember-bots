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
import TrayRow from './src/components/TrayRow';

const render = (over: Partial<React.ComponentProps<typeof TrayRow>> = {}) =>
  renderToStaticMarkup(<TrayRow text="a queued line" openLabel="Read queued message" onOpen={() => {}} {...over} />);

describe('a tray row', () => {
  test('is one line of text and nothing else when it is idle', () => {
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
