import { describe, expect, test } from 'bun:test';
import {
  checkGithubForUpdate,
  formatUpdateNotice,
  isNewerVersion,
  normalizeVersion,
  parseGithubReleasePayload,
  parseSemver,
} from './src/lib/updateCheck';

describe('semver parsing and comparison', () => {
  test('parses v-prefixed and plain semver strings', () => {
    expect(parseSemver('v0.94.2')).toEqual({ major: 0, minor: 94, patch: 2 });
    expect(parseSemver('1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: 'beta.1' });
    expect(normalizeVersion('v0.95.0')).toBe('0.95.0');
    expect(parseSemver('not-a-version')).toBeNull();
  });

  test('detects strictly newer stable versions and ignores older, equal, or prerelease targets', () => {
    expect(isNewerVersion('0.94.2', '0.94.3')).toBe(true);
    expect(isNewerVersion('0.94.2', '0.95.0')).toBe(true);
    expect(isNewerVersion('0.94.2', '1.0.0')).toBe(true);
    expect(isNewerVersion('0.94.2', '0.94.2')).toBe(false);
    expect(isNewerVersion('0.94.2', '0.94.1')).toBe(false);
    // Prerelease candidate is never offered as an upgrade.
    expect(isNewerVersion('0.94.2', '0.95.0-rc.1')).toBe(false);
    // A dev build is upgraded by the matching stable release.
    expect(isNewerVersion('0.94.2-dev', '0.94.2')).toBe(true);
  });
});

describe('GitHub payload parsing and checkGithubForUpdate', () => {
  test('parses latest release payload and skips drafts/prereleases', () => {
    expect(
      parseGithubReleasePayload({
        tag_name: 'v0.95.0',
        html_url: 'https://github.com/noemit/ember-bots/releases/tag/v0.95.0',
        draft: false,
        prerelease: false,
      })
    ).toEqual({
      version: '0.95.0',
      url: 'https://github.com/noemit/ember-bots/releases/tag/v0.95.0',
    });

    expect(parseGithubReleasePayload({ tag_name: 'v0.96.0', draft: true })).toBeNull();
    expect(parseGithubReleasePayload({ tag_name: 'v0.96.0', prerelease: true })).toBeNull();
  });

  test('falls back to /tags when /releases/latest returns 404 and picks the highest stable tag', async () => {
    const res = await checkGithubForUpdate('0.94.2', (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith('/releases/latest')) {
        return new Response('not found', { status: 404 });
      }
      return Response.json([
        { name: 'v0.94.2' },
        { name: 'v0.96.0-beta.1' },
        { name: 'v0.95.1' },
      ]);
    }) as typeof fetch);

    expect(res.updateAvailable).toBe(true);
    expect(res.latestVersion).toBe('0.95.1');
    expect(res.releaseUrl).toBe('https://github.com/noemit/ember-bots/releases/tag/v0.95.1');
    expect(formatUpdateNotice(res.latestVersion!)).toBe('Update available: Ember 0.95.1 is out on GitHub.');
  });

  test('returns updateAvailable: false on network failure without throwing', async () => {
    const res = await checkGithubForUpdate('0.94.2', (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);
    expect(res.updateAvailable).toBe(false);
    expect(res.latestVersion).toBeNull();
  });
});
