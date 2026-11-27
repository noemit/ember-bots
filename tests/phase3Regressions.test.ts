import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hearthBuild } from '../packages/kiln/src/config';
import { reconcileTranscriptTail } from '../src/lib/transcriptReconciliation';
import type { ChatMessage } from '../src/types';
import { binaryName } from '../scripts/artifact-names.mjs';

const msg = (id: string, text: string): ChatMessage => ({
  id,
  role: 'assistant',
  text,
  parts: [{ type: 'text', text }],
  completed: true,
});

describe('Phase 3 regressions (R1, R2, U8)', () => {
  test('R1: hearthBuild walks upward from packages/kiln and resolves worktree .git files', () => {
    // Live monorepo subdir packages/kiln resolves the owning repo commit SHA.
    const sha = hearthBuild(resolve('packages/kiln'));
    expect(sha).toMatch(/^[0-9a-f]{7}$/i);

    // Synthetic worktree layout with `.git` pointer file.
    const root = mkdtempSync(join(tmpdir(), 'ember-r1-git-'));
    try {
      const realGit = join(root, 'repo.git', 'worktrees', 'wt1');
      const commonGit = join(root, 'repo.git');
      mkdirSync(join(commonGit, 'refs', 'heads'), { recursive: true });
      mkdirSync(realGit, { recursive: true });
      const fakeSha = 'abcdef1234567890abcdef1234567890abcdef12';
      writeFileSync(join(commonGit, 'refs', 'heads', 'main'), `${fakeSha}\n`);
      writeFileSync(join(realGit, 'HEAD'), 'ref: refs/heads/main\n');
      writeFileSync(join(realGit, 'commondir'), '../..\n');

      const wtSubdir = join(root, 'wt1', 'packages', 'kiln');
      mkdirSync(wtSubdir, { recursive: true });
      writeFileSync(join(root, 'wt1', '.git'), `gitdir: ${realGit}\n`);

      expect(hearthBuild(wtSubdir)).toBe('abcdef1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    // hearth.sh defines a real `restart()` function called by both `update()` and the case arm.
    const script = readFileSync(resolve('packages/kiln/scripts/hearth.sh'), 'utf8');
    expect(script).toMatch(/^restart\(\)\s*\{/m);
  });

  test('R2: artifact-names produces a single .exe extension for Windows binaries', () => {
    expect(binaryName('kiln', 'bun-windows-x64')).toBe('kiln.exe');
    expect(binaryName('tinder', 'bun-windows-x64')).toBe('tinder-windows-x64.exe');
    expect(binaryName('tinder', 'bun-windows-x64').endsWith('.exe.exe')).toBe(false);
  });

  test('U8: reconcileTranscriptTail marks hasGap when a newer non-overlapping tail is glued past held history', () => {
    const held = [msg('e1', 'first'), msg('e2', 'second')];
    const overlapping = [msg('e2', 'second'), msg('e3', 'third')];
    const overlapped = reconcileTranscriptTail(held, overlapping, new Set());
    expect(overlapped.hasGap).toBeUndefined();
    expect(overlapped.messages.map((m) => m.id)).toEqual(['e1', 'e2', 'e3']);

    const jumped = [msg('e50', 'much later'), msg('e51', 'newest')];
    const gapped = reconcileTranscriptTail(held, jumped, new Set());
    expect(gapped.needsFullFetch).toBe(false);
    expect(gapped.hasGap).toBe(true);
    expect(gapped.messages.map((m) => m.id)).toEqual(['e1', 'e2', 'e50', 'e51']);
  });
});
