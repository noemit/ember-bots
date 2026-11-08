import { describe, expect, test } from 'bun:test';
import { COMPOSER_PX, INTERFACE_SCALE, applyTextSizes, type TextSize } from '../src/lib/textSize';

/** A stand-in for `document.documentElement` — only `style.setProperty` is read. */
const fakeRoot = () => {
  const props = new Map<string, string>();
  return {
    element: { style: { setProperty: (name: string, value: string) => { props.set(name, value); } } } as unknown as HTMLElement,
    props,
  };
};

describe('interface zoom writes the window it must fit inside', () => {
  test('each preset records its real window size, not the zoomed substitute', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      const root = fakeRoot();
      applyTextSizes(root.element, { interface: size, composer: 'medium', chatPx: 14, viewport: { width: 1600, height: 1000 } });
      expect(root.props.get('--interface-zoom')).toBe(String(INTERFACE_SCALE[size]));
      expect(root.props.get('--viewport-width')).toBe('1600px');
      expect(root.props.get('--viewport-height')).toBe('1000px');
    }
  });

  test('a window resize rewrites the compensation without touching the presets', () => {
    const root = fakeRoot();
    const apply = (size: { width: number; height: number }) =>
      applyTextSizes(root.element, { interface: 'large', composer: 'small' as TextSize, chatPx: 16, viewport: size });
    apply({ width: 390, height: 844 });
    expect(root.props.get('--viewport-height')).toBe('844px');
    // The App effect re-runs this call on resize — same presets, new window.
    apply({ width: 1280, height: 800 });
    expect(root.props.get('--viewport-height')).toBe('800px');
    expect(root.props.get('--viewport-width')).toBe('1280px');
    expect(root.props.get('--interface-zoom')).toBe('1.08');
    expect(root.props.get('--composer-text-size')).toBe(COMPOSER_PX.small + 'px');
  });

  test('the sizes themselves are unchanged px, never zoomed', () => {
    const root = fakeRoot();
    applyTextSizes(root.element, { interface: 'large', composer: 'large', chatPx: 13, viewport: { width: 1600, height: 1000 } });
    expect(root.props.get('--conversation-text-size')).toBe('13px');
    expect(root.props.get('--composer-text-size')).toBe(COMPOSER_PX.large + 'px');
  });
});
