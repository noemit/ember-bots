import { describe, expect, test } from 'bun:test';
import { instanceMenuState } from '../src/lib/instanceMenu';
import type { Instance } from '../src/types';

/**
 * The Instances menu had one control, and it was disabled for exactly the rows that needed one.
 *
 * "Hide" and "forget" are different wishes: hiding is for now, forgetting is for an instance that
 * no longer exists. A container that is gone forever reports "not connected", so the tick box was
 * disabled and the menu offered no way to be rid of it — the entry stayed for good. These pin the
 * split: a host that cannot answer cannot be hidden, and can always be forgotten.
 */
const instance = (over: Partial<Instance>): Instance => ({
  id: 'host-0',
  label: 'Old container',
  kind: 'remote',
  status: 'down',
  ...over,
});

describe('what the Instances menu offers for one row', () => {
  test('a host that cannot answer can still be forgotten — that is the whole point', () => {
    const state = instanceMenuState(instance({ status: 'down' }), new Set());
    expect(state.canToggle).toBe(false);
    expect(state.canForget).toBe(true);
    expect(state.checked).toBe(false);
  });

  test('a ready host is toggled, not left checked when it is hidden', () => {
    const ready = instance({ status: 'ready', url: 'http://127.0.0.1:3002' });
    expect(instanceMenuState(ready, new Set())).toEqual({ checked: true, canToggle: true, canForget: true });
    expect(instanceMenuState(ready, new Set(['host-0']))).toEqual({
      checked: false,
      canToggle: true,
      canForget: false,
    });
  });

  test('a forgotten row is not offered a second forget, so the only move left is undoing it', () => {
    const gone = instance({ status: 'down' });
    expect(instanceMenuState(gone, new Set(['host-0'])).canForget).toBe(false);
  });
});
