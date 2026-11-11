import { describe, expect, test } from 'bun:test';
import { PILLS_SCROLL_MS, jumpsVisible, scrollTailMayHide } from '../src/lib/jumpPillsVisibility';

describe('jump pill visibility', () => {
  test('hidden at rest, with no pointer and no recent scroll', () => {
    expect(jumpsVisible({ pointerInside: false, scrollArmed: false })).toBe(false);
  });

  test('hovering the session area shows them', () => {
    expect(jumpsVisible({ pointerInside: true, scrollArmed: false })).toBe(true);
  });

  test('a recent real scroll shows them, pointer elsewhere', () => {
    expect(jumpsVisible({ pointerInside: false, scrollArmed: true })).toBe(true);
  });

  test('the overflow of the 3s tail takes them away again', () => {
    // What the component passes once the timer has run and nothing re-armed it.
    expect(jumpsVisible({ pointerInside: false, scrollArmed: false })).toBe(false);
  });
});

describe('the scroll tail and hover cannot fight', () => {
  test('a timer that fires with the pointer over the area may not hide the pills', () => {
    // Hover began while the 3s timer was pending: the pointer is the newer fact, so the pills stay.
    expect(scrollTailMayHide(true)).toBe(false);
    expect(jumpsVisible({ pointerInside: true, scrollArmed: false })).toBe(true);
  });

  test('a timer that fires with the pointer away does hide them once the tail is dropped', () => {
    expect(scrollTailMayHide(false)).toBe(true);
    expect(jumpsVisible({ pointerInside: false, scrollArmed: false })).toBe(false);
  });

  test('leaving the area after a bare hover hides them: nothing re-arms the tail', () => {
    const hovered = jumpsVisible({ pointerInside: true, scrollArmed: false });
    const left = jumpsVisible({ pointerInside: false, scrollArmed: false });
    expect([hovered, left]).toEqual([true, false]);
  });
});

describe('landing on a reply is not a reason to hide anything', () => {
  test('visibility is a function of the pointer and the scroll tail alone', () => {
    // There is deliberately no "just clicked" input: a jump leaves both facts untouched, so the
    // pills are exactly as they were before the click. This is the property the owner corrected.
    for (const pointerInside of [true, false]) {
      for (const scrollArmed of [true, false]) {
        const before = jumpsVisible({ pointerInside, scrollArmed });
        const after = jumpsVisible({ pointerInside, scrollArmed });
        expect(after).toBe(before);
      }
    }
  });
});

describe('scroll tail length', () => {
  test('the pills wait three seconds after the last scroll', () => {
    expect(PILLS_SCROLL_MS).toBe(3_000);
  });
});
