import { describe, expect, test } from 'bun:test';
import { modelLabel } from './src/lib/modelLabel';

const ref = (variant?: string) => ({ providerID: 'opencode-go', modelID: 'glm-5.3-flash', variant });

describe('the model-and-level label', () => {
  test('a known level follows the model name, in the picker’s own vocabulary', () => {
    // The footer, the queue row and the edit dialog all read this, so the level never drifts in
    // spelling between them — and it names the level the turn ran at, not the composer's selection.
    expect(modelLabel(ref('high'))).toBe('opencode-go / glm-5.3-flash · high');
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(modelLabel(ref(level))).toBe(`opencode-go / glm-5.3-flash · ${level}`);
    }
  });

  test('a turn with no level shows only the model', () => {
    // A legacy entry (written before the host recorded a level) must not grow a guessed label.
    expect(modelLabel(ref())).toBe('opencode-go / glm-5.3-flash');
    expect(modelLabel(ref(''))).toBe('opencode-go / glm-5.3-flash');
    // "default" is "the model's own default", which is not a level; it is never synthesized or echoed.
    expect(modelLabel(ref('default'))).toBe('opencode-go / glm-5.3-flash');
    expect(modelLabel(ref('Default'))).toBe('opencode-go / glm-5.3-flash');
  });

  test('the level is trimmed rather than spelled with stray whitespace', () => {
    expect(modelLabel(ref(' high '))).toBe('opencode-go / glm-5.3-flash · high');
    expect(modelLabel(ref('   '))).toBe('opencode-go / glm-5.3-flash');
  });

  test('a missing model falls back, and the fallback can be the caller’s', () => {
    expect(modelLabel(undefined)).toBe('Model unavailable');
    expect(modelLabel(undefined, 'Unknown model')).toBe('Unknown model');
  });
});
