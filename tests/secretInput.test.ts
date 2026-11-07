import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A guard, not a unit test: `<input type="password">` on macOS switches on Secure Keyboard Entry, a
 * machine-wide OS flag that disables every third-party hotkey on the machine (skhd, Karabiner,
 * Hammerspoon). If such a field is unmounted or hidden while focused, Chromium never clears it and
 * the flag sticks with no visible cause. Secret fields go through `ui/secret-input.tsx` instead.
 */
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.tsx') ? [path] : [];
  });

describe('secret fields', () => {
  test('no renderer input uses type="password"', () => {
    const offenders = walk('src').filter((file) => readFileSync(file, 'utf8').includes('type="password"'));
    expect(offenders).toEqual([]);
  });

  test('the shared secret input masks with text-security instead', () => {
    const source = readFileSync('src/components/ui/secret-input.tsx', 'utf8');
    expect(source).toContain('WebkitTextSecurity');
    expect(source).toContain('type="text"');
  });
});
