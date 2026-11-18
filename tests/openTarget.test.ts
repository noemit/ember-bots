import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ALLOWED_EXTERNAL_PROTOCOLS,
  fileUrlToLocalPath,
  openTarget,
  type OpenTargetShell,
} from '../electron/openTarget';

const tempDirs: string[] = [];
const makeTempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ember-open-target-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const createMockShell = (overrides: Partial<OpenTargetShell> = {}) => {
  const calls = {
    openExternal: [] as string[],
    openPath: [] as string[],
    showItemInFolder: [] as string[],
  };
  const shell: OpenTargetShell = {
    openExternal: async (url: string) => {
      calls.openExternal.push(url);
    },
    openPath: async (targetPath: string) => {
      calls.openPath.push(targetPath);
      return '';
    },
    showItemInFolder: (fullPath: string) => {
      calls.showItemInFolder.push(fullPath);
    },
    ...overrides,
  };
  return { shell, calls };
};

describe('openTarget URL and local/file:// handling', () => {
  test('converts file: URLs via fileURLToPath before statSync, opens directories with openPath, and only reveals files with showItemInFolder', async () => {
    const root = makeTempDir();
    const folder = path.join(root, 'project-folder');
    const scriptFile = path.join(root, 'payload.sh');
    const spacedFile = path.join(root, 'report final.pdf');
    mkdirSync(folder);
    writeFileSync(scriptFile, '#!/bin/sh\necho pwned\n', { mode: 0o755 });
    writeFileSync(spacedFile, 'pdf');

    const statPaths: string[] = [];
    const { shell, calls } = createMockShell();
    const trackingFs = {
      statSync: (targetPath: string) => {
        statPaths.push(targetPath);
        return {
          isDirectory: () => targetPath === folder,
          isFile: () => targetPath === scriptFile || targetPath === spacedFile,
        };
      },
    };

    // File via file:// URL -> converted before statSync, revealed ONLY via showItemInFolder.
    expect(await openTarget(pathToFileURL(scriptFile).toString(), shell, { fs: trackingFs })).toBe(true);
    // Uppercase FILE:// and percent-encoded spaces also convert cleanly to path before statSync.
    const upperUrl = pathToFileURL(spacedFile).toString().replace(/^file:/, 'FILE:');
    expect(await openTarget(upperUrl, shell, { fs: trackingFs })).toBe(true);
    // file://localhost/... -> converted and revealed ONLY via showItemInFolder.
    expect(await openTarget(`file://localhost${scriptFile}`, shell, { fs: trackingFs })).toBe(true);
    // Directory via file:// URL -> converted before statSync and opened with openPath.
    expect(await openTarget(pathToFileURL(folder).toString(), shell, { fs: trackingFs })).toBe(true);

    expect(statPaths).toEqual([scriptFile, spacedFile, scriptFile, folder]);
    expect(calls.showItemInFolder).toEqual([scriptFile, spacedFile, scriptFile]);
    expect(calls.openPath).toEqual([folder]);
    expect(calls.openExternal).toEqual([]);
  });

  test('never falls back to shell.openPath on files even if showItemInFolder throws or path is executable', async () => {
    const root = makeTempDir();
    const exeFile = path.join(root, 'autorun.desktop');
    writeFileSync(exeFile, '[Desktop Entry]\nExec=id\n', { mode: 0o755 });

    const { shell, calls } = createMockShell({
      showItemInFolder: () => {
        throw new Error('Finder unavailable');
      },
    });

    expect(await openTarget(exeFile, shell)).toBe(false);
    expect(await openTarget(pathToFileURL(exeFile).toString(), shell)).toBe(false);
    expect(calls.openPath).toEqual([]);
    expect(calls.openExternal).toEqual([]);
  });

  test('expands ~ paths, resolves symlinks properly, and reports false when openPath fails or path is missing', async () => {
    const home = makeTempDir();
    const subDir = path.join(home, 'workspace');
    const noteFile = path.join(subDir, 'notes.md');
    const linkToFile = path.join(home, 'notes-link.md');
    mkdirSync(subDir);
    writeFileSync(noteFile, 'hello');
    symlinkSync(noteFile, linkToFile);

    const { shell, calls } = createMockShell();
    expect(await openTarget('~', shell, { homedir: home })).toBe(true);
    expect(await openTarget('~/workspace', shell, { homedir: home })).toBe(true);
    expect(await openTarget('~/workspace/notes.md', shell, { homedir: home })).toBe(true);
    expect(await openTarget(linkToFile, shell, { homedir: home })).toBe(true);
    expect(await openTarget(path.join(home, 'missing.txt'), shell, { homedir: home })).toBe(false);
    expect(await openTarget('./relative-script.sh', shell, { homedir: home })).toBe(false);

    expect(calls.openPath).toEqual([home, subDir]);
    expect(calls.showItemInFolder).toEqual([noteFile, linkToFile]);
    expect(calls.openExternal).toEqual([]);

    const failingDirShell = createMockShell({
      openPath: async () => 'Failed to open directory',
    });
    expect(await openTarget(subDir, failingDirShell.shell)).toBe(false);
  });

  test('handles Windows drive-letter paths as local paths rather than URL schemes and rejects remote file:// / UNC paths', async () => {
    const statCalls: string[] = [];
    const { shell, calls } = createMockShell();
    const winFs = {
      statSync: (targetPath: string) => {
        statCalls.push(targetPath);
        if (targetPath === 'C:\\Users\\em\\folder') return { isDirectory: () => true, isFile: () => false };
        if (targetPath === 'C:\\Users\\em\\run.bat') return { isDirectory: () => false, isFile: () => true };
        throw new Error('ENOENT');
      },
    };

    expect(
      await openTarget('C:\\Users\\em\\run.bat', shell, {
        fs: winFs,
        path: path.win32,
        homedir: 'C:\\Users\\em',
        toFilePath: () => '\\\\evil.example.com\\share\\payload.exe',
      }),
    ).toBe(true);
    expect(
      await openTarget('C:\\Users\\em\\folder', shell, {
        fs: winFs,
        path: path.win32,
        homedir: 'C:\\Users\\em',
      }),
    ).toBe(true);

    expect(calls.showItemInFolder).toEqual(['C:\\Users\\em\\run.bat']);
    expect(calls.openPath).toEqual(['C:\\Users\\em\\folder']);
    expect(calls.openExternal).toEqual([]);

    // Remote file:// hosts and UNC paths must never hit statSync, openPath, showItemInFolder, or openExternal.
    const beforeBlockedStats = statCalls.length;
    for (const remoteOrMalformed of [
      'file://evil.example.com/share/payload.exe',
      'file://192.168.1.20/c$/Windows/System32/calc.exe',
      'file://user:pass@localhost/tmp/secret',
      'file:relative/file.txt',
      'file:///tmp/null%00byte.txt',
      '\\\\evil.example.com\\share\\payload.exe',
      '//evil.example.com/share/payload.exe',
    ]) {
      expect(fileUrlToLocalPath(remoteOrMalformed)).toBeNull();
      expect(
        await openTarget(remoteOrMalformed, shell, {
          fs: winFs,
          path: path.win32,
          toFilePath: () => '\\\\evil.example.com\\share\\payload.exe',
        }),
      ).toBe(false);
    }
    expect(statCalls).toHaveLength(beforeBlockedStats);
  });

  test('strictly restricts external URLs to https:, http:, and mailto:, rejecting dangerous or arbitrary protocols', async () => {
    expect(ALLOWED_EXTERNAL_PROTOCOLS).toEqual(['https:', 'http:', 'mailto:']);
    const { shell, calls } = createMockShell();

    expect(await openTarget('https://github.com/noemit/ember-bots', shell)).toBe(true);
    expect(await openTarget('http://127.0.0.1:5179/blob-gallery.html', shell)).toBe(true);
    expect(await openTarget('mailto:em-bot@mail.grokbot.com', shell)).toBe(true);
    expect(await openTarget('localhost:3000/api/health', shell)).toBe(true);
    expect(await openTarget('www.ember.dev/docs', shell)).toBe(true);

    expect(calls.openExternal).toEqual([
      'https://github.com/noemit/ember-bots',
      'http://127.0.0.1:5179/blob-gallery.html',
      'mailto:em-bot@mail.grokbot.com',
      'http://localhost:3000/api/health',
      'http://www.ember.dev/docs',
    ]);

    const allowedCount = calls.openExternal.length;
    const blockedUrls = [
      'javascript:alert(1)',
      'JAVASCRIPT:fetch("https://evil.invalid")',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox("xss")',
      'smb://fileserver/share/payload',
      'ssh://git@github.com/org/repo',
      'vscode://file/etc/passwd',
      'vscode-insiders://file/etc/passwd',
      'ftp://ftp.example.com/pub/file',
      'tel:+15551234567',
      'custom-scheme://launch',
      'about:blank',
      'blob:https://example.com/550e8400-e29b-41d4-a716-446655440000',
      'https://user:secret@example.com/private',
      'http://admin:admin@127.0.0.1:8080/',
      'localhost@evil.example.com',
      'mailto:',
      '',
      '   ',
      'https://example.com/\x00evil',
    ];

    for (const blocked of blockedUrls) {
      expect(await openTarget(blocked, shell)).toBe(false);
    }
    expect(calls.openExternal).toHaveLength(allowedCount);
    expect(calls.openPath).toEqual([]);
    expect(calls.showItemInFolder).toEqual([]);
  });
});
