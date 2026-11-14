import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('desktop updater packaging boundaries', () => {
  test('only release distribution scripts opt packaged apps into stable updates', () => {
    for (const name of ['dist:mac', 'dist:win', 'dist:linux']) {
      expect(manifest.scripts[name]).toContain('--config.extraMetadata.emberUpdateChannel=stable');
      expect(manifest.scripts[name]).toContain('--publish never');
    }
    for (const name of ['dist', 'dist:mac:local']) {
      expect(manifest.scripts[name]).not.toContain('emberUpdateChannel');
      expect(manifest.scripts[name]).toContain('--publish never');
    }
    // A shared marker would also enable unsigned CI and direct development packaging.
    expect(manifest.emberUpdateChannel).toBeUndefined();
    expect(manifest.build.extraMetadata?.emberUpdateChannel).toBeUndefined();
  });

  test('release packages retain signing gates and the reviewed stable GitHub destination', () => {
    for (const name of ['dist:mac', 'dist:win']) {
      expect(manifest.scripts[name]).toContain('--config.forceCodeSigning=true');
    }
    expect(manifest.scripts['dist:mac']).toContain('EMBER_RELEASE=1');
    expect(manifest.build.win.verifyUpdateCodeSignature).toBe(true);
    expect(manifest.build.publish).toEqual([
      { provider: 'github', owner: 'noemit', repo: 'ember-bots', channel: 'latest', releaseType: 'release' },
    ]);
    expect(manifest.build.mac.target).toEqual(['dmg', 'zip']);
    expect(manifest.build.win.target).toContain('nsis');
    expect(manifest.build.linux.target).toContain('AppImage');
  });
});
