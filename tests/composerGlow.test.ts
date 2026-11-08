import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { applyTheme, THEMES } from '../src/themes';

test('applying a theme selects pigment for light surfaces and emitted colour for dark ones', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const vars = new Map<string, string>();
  const root = { style: { setProperty: (key: string, value: string) => vars.set(key, value), colorScheme: '' }, classList: { toggle: () => {} } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: root } });
  try {
    // Return to light too: switching themes must replace, not retain, the old mode.
    for (const theme of [...THEMES, THEMES[0]!]) {
      applyTheme(theme.id);
      expect(vars.get('--composer-glow-blend')).toBe(theme.dark ? 'color-dodge' : 'multiply');
      expect(vars.get('--background')).toBe(theme.palette.bg);
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('focus is a quiet colour cue, absent when unfocused', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const base = css.match(/\[data-composer-surface\]::before\s*\{([^}]+)\}/)?.[1];
  const focused = css.match(/\[data-composer-surface\]:has\(:focus-visible\)::before\s*\{([^}]+)\}/)?.[1];
  expect(base).toMatch(/opacity:\s*0\s*;/);
  const strength = Number(focused?.match(/opacity:\s*([\d.]+)\s*;/)?.[1]);
  expect(strength).toBeGreaterThan(0);
  expect(strength).toBeLessThanOrEqual(0.2);
  expect(base).toContain('pointer-events: none');
});

test('identity colour remains conditional and the focus halo has a theme-accent fallback', () => {
  const source = readFileSync(new URL('../src/components/ChatView.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  expect(source).toMatch(/style=\{session && showSessionAvatar \? \{\s*'--composer-glow-color': blobColor\(blobStyle, identity\)/);
  expect(css).toContain('var(--composer-glow-color, var(--ring))');
  expect(css).toContain('background-blend-mode: var(--composer-glow-blend)');
  expect(css).toContain('mix-blend-mode: var(--composer-glow-blend)');
});
