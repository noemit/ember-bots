import { describe, expect, test } from 'bun:test';
import { INSTRUCTION_PRESETS, presetFor, delegatorInstructions, delegatorChoices } from '../src/lib/instructionPresets';
import retired from './fixtures/retiredInstructionTexts.json';

const text = INSTRUCTION_PRESETS[1].instructions;
describe('standing instruction presets', () => {
  test('only classic and delegator are shipped prompts, with stable ids', () => {
    expect(INSTRUCTION_PRESETS.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'classic', name: 'Pi Classic' },
      { id: 'delegator', name: 'Ultra Delegator' },
    ]);
    expect(INSTRUCTION_PRESETS[0].instructions).toBe('');
    expect(presetFor('')).toBe(INSTRUCTION_PRESETS[0]);
    expect(presetFor(text)).toBe(INSTRUCTION_PRESETS[1]);
    expect(presetFor(undefined)).toBeUndefined();
  });

  test('arbitrary and retired saved texts remain custom, not reinterpreted as new presets', () => {
    for (const instructions of [...retired.map(p => p.instructions), '  My own instructions\n']) {
      expect(presetFor(instructions)).toBeUndefined();
    }
  });

  test('generated prompts route exact configured identities without asking for approval', () => {
    const choices = { harder: { providerID: 'provider-a', modelID: 'family/hard' }, easier: { providerID: 'provider-b', modelID: 'small' } };
    const generated = delegatorInstructions(choices);
    expect(delegatorChoices(generated)).toEqual(choices);
    expect(presetFor(generated)?.id).toBe('delegator');
    expect(generated).toContain('Harder tasks: provider-a/family/hard');
    expect(generated).toContain('Easier tasks: provider-b/small');
    expect(generated).toMatch(/route easier tasks.*harder tasks/);
    expect(generated).not.toMatch(/ask.*confirm|wait for.*approval|silence|session models/i);
    expect(generated).toMatch(/unavailable.*replace it in Standing instructions.*never silently substitute/);
    expect(presetFor(generated + ' My changes')).toBeUndefined();
    expect(delegatorChoices(delegatorInstructions({}))).toEqual({});
    text.split('\n').forEach((line, i) => expect(line.startsWith(`${i + 1}. `)).toBe(true));
    expect(text.length).toBeLessThan(3500);
  });

  test('coordination keeps durable continuation, explicit completion and evidence rules', () => {
    expect(text).toMatch(/session wait.*durable continuation/);
    expect(text).toMatch(/Do not poll/);
    expect(text).toMatch(/self-contained brief, acceptance criteria and evidence/);
    expect(text).toMatch(/assignment token.*final reply is not Done/);
    expect(text).toMatch(/claim, not your verification/);
    expect(text).toMatch(/Retrieved is not verified or incorporated.*check evidence/);
    expect(text).toContain('/threads/<conversationId>');
    expect(text).toMatch(/Coordinate silently/);
    expect(text).toMatch(/without subagents.*yourself/);
    expect(text).toMatch(/report.*incomplete.*not Done/);
    expect(text).toMatch(/stalled attempt.*reopening/);
    expect(text).toMatch(/corrections.*spawn a new task for unrelated work/);
    expect(text).toMatch(/Resume until the agreed outcome is delivered/);
  });
});
