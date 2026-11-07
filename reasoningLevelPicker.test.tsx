/**
 * The reasoning level, as a brain and the word the model uses for it.
 *
 * It used to be signal bars, and the bars were the defect: they mapped the level *list position*
 * onto four fixed shapes, so a two-level model and a five-level one drew the same icons, two middles
 * collapsed onto one, and a single bar meant "off", "minimal" or "default" indifferently. The word is
 * the model's own, so there is no second vocabulary to learn and nothing to mis-map.
 */
import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReasoningLevelPicker, { reasoningLevelWord } from './src/components/ReasoningLevelPicker';
import { TooltipProvider } from './src/components/ui/tooltip';

describe('the word', () => {
  test('is the model’s own level, capitalised', () => {
    expect(reasoningLevelWord(['off', 'low', 'high'], 'low')).toBe('Low');
    expect(reasoningLevelWord(['off', 'high'], 'high')).toBe('High');
    // A model whose levels are already cased is not double-capitalised or mangled.
    expect(reasoningLevelWord(['Off', 'High'], 'High')).toBe('High');
  });

  test('says Default when no level is chosen', () => {
    // The old control drew this as the lowest bar, which claimed a level the model never had.
    expect(reasoningLevelWord(['off', 'low', 'high'], '')).toBe('Default');
  });

  test('a level the model no longer lists still names itself', () => {
    // Settings outlive model catalogues; reading "Default" over a stored `max` would be a lie.
    expect(reasoningLevelWord(['off', 'low'], 'max')).toBe('Max');
  });

  test('matches the stored value case-insensitively and shows the model’s spelling', () => {
    expect(reasoningLevelWord(['off', 'MINIMAL'], 'minimal')).toBe('MINIMAL');
  });
});

describe('the control', () => {
  test('an unchanged host setting names the effective level instead of claiming Default', () => {
    for (const level of ['off', 'high']) {
      const html = renderToStaticMarkup(
        <ReasoningLevelPicker levels={['off', 'low', 'high']} value="" currentLevel={level} onChange={() => {}} />
      );
      expect(html).toContain(`aria-label="Reasoning level: ${level === 'off' ? 'Off' : 'High'}"`);
      expect(html).not.toContain('Reasoning level: Default');
    }
  });
  const render = (value: string) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <ReasoningLevelPicker levels={['off', 'low', 'high']} value={value} onChange={() => {}} />
      </TooltipProvider>
    );

  test('draws a brain and the word, not bars', () => {
    const html = render('low');
    expect(html).toContain('lucide-brain');
    expect(html).toContain('>Low<');
    // The four signal glyphs are gone; that was the icon family being complained about.
    expect(html).not.toMatch(/lucide-signal/);
  });

  test('collapses to the brain alone on a narrow column, and keeps the words for a screen reader', () => {
    // `@[460px]` is a container query on the composer row: the word goes, the brain stays.
    const html = render('low');
    expect(html).toContain('hidden @[460px]:inline');
    expect(html).toContain('aria-label="Reasoning level: Low"');
    expect(html).toContain('title="Reasoning level: Low"');
  });

  test('an unset level reads as Default and looks quieter', () => {
    const html = render('');
    expect(html).toContain('>Default<');
    expect(html).toContain('text-muted-foreground');
  });
});
