import { describe, expect, test } from 'bun:test';
import {
  commentDelivery,
  commentSubmitDescription,
  commentSubmitHint,
  commentSubmitLabel,
} from '../src/lib/commentDelivery';

describe('which delivery a comment gets', () => {
  test('an idle agent is sent to', () => {
    expect(commentDelivery({ busy: false, yeet: false })).toBe('send');
  });

  test('a busy agent queues behind the turn', () => {
    expect(commentDelivery({ busy: true, yeet: false })).toBe('queue');
  });

  test('YEET steers, busy or not', () => {
    expect(commentDelivery({ busy: true, yeet: true })).toBe('steer');
    expect(commentDelivery({ busy: false, yeet: true })).toBe('steer');
  });
});

describe('the button copy', () => {
  test('names the delivery, never "Add"', () => {
    expect(commentSubmitLabel('send')).toBe('Send');
    expect(commentSubmitLabel('queue')).toBe('Queue');
    expect(commentSubmitLabel('steer')).toBe('Steer');
    for (const mode of ['send', 'queue', 'steer'] as const) {
      expect(commentSubmitLabel(mode)).not.toBe('Add');
    }
  });

  test('the label and the behaviour come from the same answer', () => {
    // The thing that would be a bug: button says Send, message actually queues.
    const cases = [
      { busy: false, yeet: false, label: 'Send' },
      { busy: true, yeet: false, label: 'Queue' },
      { busy: true, yeet: true, label: 'Steer' },
    ];
    for (const { busy, yeet, label } of cases) {
      expect(commentSubmitLabel(commentDelivery({ busy, yeet }))).toBe(label);
    }
  });

  test('the aria-label names the object and the count', () => {
    expect(commentSubmitDescription('send', 1)).toBe('Send 1 annotation');
    expect(commentSubmitDescription('send', 3)).toBe('Send 3 annotations');
    expect(commentSubmitDescription('queue', 2)).toBe('Queue 2 annotations behind the running turn');
    expect(commentSubmitDescription('steer', 1)).toBe('Steer the running turn with 1 annotation');
  });

  test('the hint explains the promise the single word cannot', () => {
    expect(commentSubmitHint('send')).toContain('starts a turn');
    expect(commentSubmitHint('queue')).toContain('not interrupted');
    expect(commentSubmitHint('steer')).toContain('YEET');
  });

  test('no copy says "comment" where it should say "annotation"', () => {
    for (const mode of ['send', 'queue', 'steer'] as const) {
      expect(commentSubmitDescription(mode, 1).toLowerCase()).not.toContain('comment');
      expect(commentSubmitDescription(mode, 2).toLowerCase()).not.toContain('comment');
    }
  });
});
