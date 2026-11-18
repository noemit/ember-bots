import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAllowedDocPopoutUrl } from '../electron/docPopout';

describe('isAllowedDocPopoutUrl', () => {
  const renderer = path.resolve('/app/dist/index.html');
  const baseFileUrl = pathToFileURL(renderer).toString();

  test('allows only same-file renderer URLs with docPopout=1 and bounded popoutId', () => {
    expect(isAllowedDocPopoutUrl(`${baseFileUrl}?docPopout=1&popoutId=popout_1234abcd`, renderer)).toBe(true);
    expect(isAllowedDocPopoutUrl(`${baseFileUrl}?docPopout=1&popoutId=abc-123_XYZ#section`, renderer)).toBe(true);
  });

  test('rejects arbitrary URLs, file traversal, missing flags, credentials, and bad popoutId', () => {
    expect(isAllowedDocPopoutUrl('https://evil.example/?docPopout=1&popoutId=popout_1234', renderer)).toBe(false);
    expect(isAllowedDocPopoutUrl('file:///etc/passwd?docPopout=1&popoutId=popout_1234', renderer)).toBe(false);
    expect(isAllowedDocPopoutUrl('file:///tmp/evil.html?docPopout=1&popoutId=popout_1234', renderer)).toBe(false);
    expect(isAllowedDocPopoutUrl(baseFileUrl, renderer)).toBe(false);
    expect(isAllowedDocPopoutUrl(`${baseFileUrl}?docPopout=1`, renderer)).toBe(false);
    expect(isAllowedDocPopoutUrl(`${baseFileUrl}?docPopout=1&popoutId=short`, renderer)).toBe(false);
    expect(isAllowedDocPopoutUrl(`${baseFileUrl}?docPopout=1&popoutId=../escape`, renderer)).toBe(false);
    expect(isAllowedDocPopoutUrl('file://user:pass@/app/dist/index.html?docPopout=1&popoutId=popout_1234', renderer)).toBe(false);
  });
});
