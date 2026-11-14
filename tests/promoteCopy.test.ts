import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Promotion copy, judged by what a reader can conclude rather than by one wording: the phrase the
 * owner chose appears where it can be read in full, the wire still says `peer`, and no line leaves
 * the person without an outcome or a next step.
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('promote-to-a-persistent-bot copy', () => {
  const header = read('src/components/ChatView.tsx');
  const dialog = read('src/components/PromoteWorkerDialog.tsx');
  const strip = read('src/components/CrewStrip.tsx');
  const app = read('src/App.tsx');

  test('the header button is short, and its accessible name and tooltip carry the full phrase', () => {
    expect(header).toContain('aria-label="Promote to a persistent bot"');
    expect(header).toMatch(/title="Promote to a persistent bot:/);
    // The visible word stays one line in a narrow column; the phrase above is what it means.
    expect(header).toMatch(/<UserPlus aria-hidden="true" \/>\s*\n\s*Promote\s*\n/);
    expect(header).not.toContain('Promote to peer');
    expect(header).not.toMatch(/title="Fork this worker into a named peer/);
  });

  test('the dialog names the phrase, the outcome, and the busy next step', () => {
    expect(dialog).toContain('<DialogTitle>Promote to a persistent bot</DialogTitle>');
    expect(dialog).toContain('becomes its own bot');
    expect(dialog).toContain('keeps');
    expect(dialog).toContain('running whether or not its parent does');
    expect(dialog).toContain('message by name');
    expect(dialog).toContain('Make persistent');
    expect(dialog).toMatch(/still working — wait for it to finish, or stop it first/);
    // The block sits beside the disabled action, not buried in introductory copy.
    expect(dialog).toContain('role="status"');
    expect(dialog).toMatch(/Kiln[^;]*; it cannot transfer a running turn/);
    expect(dialog).toMatch(/Back to thread.*Stop button/);
    expect(dialog).toContain('aria-describedby=');
    expect(dialog).toMatch(/Enter a name above/);
    expect(dialog).not.toContain('Promote worker to peer');
  });

  test('every promoted surface says bot; only identifiers and the wire still say peer', () => {
    for (const source of [header, dialog, strip]) {
      const copy = source
        .replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
        .replaceAll(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}/g, '')
        .replaceAll(/\bpeerFor\b|\bpeer\b(?=\s*[:,?}])/g, 'IDENTIFIER');
      expect(copy).not.toMatch(/\(named peers?\)|\bpeer (link|badge|fork)\b/i);
    }
    expect(strip).toContain('<span');
    expect(strip).toContain('\n          bot\n');
    expect(strip).toContain('Open the persistent bot for');
    // The notice states the outcome, and the failure names the model that refused and offers a retry.
    expect(app).toContain('is persistent now — others can message it by name.');
    expect(app).toContain('Couldn’t make this bot persistent.');
    // Only the protocol keeps the old word.
    expect(app).toContain('promoteSession');
    expect(app).toContain('promotedTo');
  });
});
