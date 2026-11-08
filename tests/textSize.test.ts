import { describe, expect, test } from 'bun:test';
import {
  CHAT_PX,
  COMPOSER_PX,
  INTERFACE_SCALE,
  TEXT_SIZES,
  composerSizeOf,
  isTextSize,
  nearestChatSize,
  textSizeLabel,
  textSizeVars,
} from '../src/lib/textSize';

describe('three text sizes, three homes', () => {
  test('each named size maps to a distinct, increasing value', () => {
    expect([...TEXT_SIZES]).toEqual(['small', 'medium', 'large']);
    expect(CHAT_PX.small).toBeLessThan(CHAT_PX.medium);
    expect(CHAT_PX.medium).toBeLessThan(CHAT_PX.large);
    expect(COMPOSER_PX.small).toBeLessThan(COMPOSER_PX.medium);
    expect(COMPOSER_PX.medium).toBeLessThan(COMPOSER_PX.large);
    expect(INTERFACE_SCALE.small).toBeLessThan(1);
    expect(INTERFACE_SCALE.large).toBeGreaterThan(1);
  });

  test('the shipped defaults are the sizes Ember already used', () => {
    expect(CHAT_PX.medium).toBe(14);
    // The composer has been fixed at 18px since 1.20.x; Medium must not silently shrink it.
    expect(COMPOSER_PX.medium).toBe(18);
    expect(composerSizeOf(undefined)).toBe('medium');
  });

  test('an old numeric chat size lands on the nearest preset, ties upward', () => {
    expect(nearestChatSize(12)).toBe('small');
    expect(nearestChatSize(13)).toBe('small');
    expect(nearestChatSize(14)).toBe('medium');
    expect(nearestChatSize(15)).toBe('large');
    expect(nearestChatSize(18)).toBe('large');
    expect(nearestChatSize(undefined)).toBe('medium');
    expect(nearestChatSize(Number.NaN)).toBe('medium');
  });

  test('the settings variables carry every size, including the interface scale', () => {
    expect(textSizeVars({ chatPx: 16, composer: 'large', interface: 'small' })).toEqual({
      '--conversation-text-size': '16px',
      '--composer-text-size': `${COMPOSER_PX.large}px`,
      '--interface-zoom': String(INTERFACE_SCALE.small),
    });
    expect(textSizeVars({})['--composer-text-size']).toBe('18px');
    expect(textSizeVars({})['--interface-zoom']).toBe('1');
  });

  test('unknown stored values are refused rather than trusted', () => {
    expect(isTextSize('small')).toBe(true);
    expect(isTextSize('huge')).toBe(false);
    expect(isTextSize(14)).toBe(false);
    expect(isTextSize(undefined)).toBe(false);
    expect(textSizeLabel('small')).toBe('Small');
  });
});
