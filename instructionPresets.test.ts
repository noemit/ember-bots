import { describe, expect, test } from 'bun:test';
import { INSTRUCTION_PRESETS, presetFor } from './src/lib/instructionPresets';

/**
 * The shipped prompt library. These are the only prompts Ember puts in front of a model without the
 * user writing them, so the qualities that matter are: they are distinct jobs, each says what it must
 * not do, and none is so long it crowds out the session's own context.
 */
describe('standing instruction presets', () => {
  test('the library has a classic (nothing added) plus distinct jobs', () => {
    expect(INSTRUCTION_PRESETS.length).toBeGreaterThanOrEqual(4);
    expect(INSTRUCTION_PRESETS.map((preset) => preset.id)).toContain('delegator');
    expect(new Set(INSTRUCTION_PRESETS.map((preset) => preset.id)).size).toBe(INSTRUCTION_PRESETS.length);
    // Pi classic is the empty one on purpose: a list of roles with no way to choose none would change
    // every session by default, and "the harness prompt as it is" is a legitimate answer.
    const classic = INSTRUCTION_PRESETS.find((preset) => preset.id === 'classic');
    expect(classic?.instructions).toBe('');
    expect(classic?.note?.length ?? 0).toBeGreaterThan(40);
    expect(presetFor('')).toBe(classic!);
    for (const preset of INSTRUCTION_PRESETS) {
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.blurb.length).toBeGreaterThan(0);
      if (preset.instructions === '') continue; // classic adds nothing, so there is nothing to size
      expect(preset.instructions.trim().length).toBeGreaterThan(80);
      // Long enough to say something, short enough to leave room for the session's own context.
      expect(preset.instructions.length).toBeLessThan(2_000);
      expect(preset.instructions).not.toMatch(/undefined|\bprompt\b.*\bprompt\b/);
    }
  });

  test('each names a scope rather than asking for good behaviour', () => {
    for (const preset of INSTRUCTION_PRESETS) {
      if (preset.instructions === '') continue;
      // A prompt that only says "be careful" changes nothing: each of these says what not to do.
      expect(preset.instructions.toLowerCase()).toMatch(/do not|not to|never|only when/);
    }
  });

  test('a session reads its preset back from the text it stored', () => {
    const delegator = INSTRUCTION_PRESETS.find((preset) => preset.id === 'delegator');
    expect(presetFor(delegator?.instructions)).toBe(delegator!);
    expect(presetFor(undefined)).toBeUndefined();
    expect(presetFor('something the person wrote themselves')).toBeUndefined();
  });
});
