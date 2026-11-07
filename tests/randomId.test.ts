import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomId, uuidFromBytes } from '../src/lib/randomId';
import { copyText } from '../src/lib/clipboard';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const walkTsFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkTsFiles(full)));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(full);
  }
  return files;
};

describe('randomId works in insecure contexts (plain HTTP over Tailscale)', () => {
  test('uuidFromBytes sets RFC 4122 version 4 and variant 10 bits', () => {
    const zeros = new Uint8Array(16);
    expect(uuidFromBytes(zeros)).toBe('00000000-0000-4000-8000-000000000000');
    expect(uuidFromBytes(zeros)).toMatch(UUID_V4);

    const ones = new Uint8Array(16).fill(0xff);
    expect(uuidFromBytes(ones)).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(uuidFromBytes(ones)).toMatch(UUID_V4);
  });

  test('uses crypto.randomUUID when present', () => {
    const id = randomId();
    expect(id).toMatch(UUID_V4);
  });

  test('falls back to crypto.getRandomValues when crypto.randomUUID is undefined (insecure HTTP context)', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const realCrypto = globalThis.crypto;
    let getRandomValuesCalls = 0;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: {
          // Simulates an HTTP origin like http://100.x.y.z:57821 where randomUUID is absent.
          randomUUID: undefined,
          getRandomValues: <T extends ArrayBufferView>(array: T): T => {
            getRandomValuesCalls += 1;
            return realCrypto.getRandomValues(array);
          },
        },
      });
      const a = randomId();
      const b = randomId();
      expect(getRandomValuesCalls).toBe(2);
      expect(a).toMatch(UUID_V4);
      expect(b).toMatch(UUID_V4);
      expect(a).not.toBe(b);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    }
  });

  test('falls back to Math.random when crypto is completely unavailable or throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: {
          randomUUID: () => {
            throw new Error('Not supported in insecure context');
          },
          getRandomValues: () => {
            throw new Error('Blocked');
          },
        },
      });
      const id = randomId();
      expect(id).toMatch(UUID_V4);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    }
  });

  test('renderer code never calls crypto.randomUUID() or navigator.clipboard.writeText() outside their helpers', async () => {
    const files = await walkTsFiles(join(import.meta.dir, '../src'));
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (!file.endsWith('randomId.ts')) {
        expect(text).not.toMatch(/\bcrypto\.randomUUID\b/);
      }
      if (!file.endsWith('clipboard.ts')) {
        expect(text).not.toMatch(/\bnavigator\.clipboard\.writeText\b/);
      }
    }
  });
});

describe('copyText in insecure contexts', () => {
  test('falls back to document.execCommand when navigator.clipboard is undefined', async () => {
    const scope = globalThis as { navigator?: unknown; document?: unknown };
    const prevNavigator = scope.navigator;
    const prevDocument = scope.document;
    let execCommandArg: string | null = null;
    let appendedText: string | null = null;
    let removed = false;
    let restoredFocus = false;
    const previousActive = {
      focus: () => {
        restoredFocus = true;
      },
    };
    try {
      // Set HTMLElement stub so instanceof check passes if HTMLElement exists.
      scope.navigator = {};
      const fakeTextarea = {
        value: '',
        style: {} as Record<string, string>,
        setAttribute: () => {},
        focus: () => {},
        select: () => {},
        setSelectionRange: () => {},
        remove: () => {
          removed = true;
        },
      };
      scope.document = {
        activeElement: previousActive,
        body: {
          appendChild: (node: { value: string }) => {
            appendedText = node.value;
          },
        },
        createElement: () => fakeTextarea,
        execCommand: (cmd: string) => {
          execCommandArg = cmd;
          return true;
        },
      };
      const ok = await copyText('ABCD-1234');
      expect(ok).toBe(true);
      expect(appendedText).toBe('ABCD-1234');
      expect(execCommandArg).toBe('copy');
      expect(removed).toBe(true);
    } finally {
      scope.navigator = prevNavigator;
      scope.document = prevDocument;
      void restoredFocus;
    }
  });
});
