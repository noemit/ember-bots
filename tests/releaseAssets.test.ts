import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// @ts-expect-error -- shared Node release CLI is deliberately JavaScript.
import { required, checksums, audit, promote, validateVersion } from '../scripts/release-assets.mjs';
// @ts-expect-error -- shared Node build helper is deliberately JavaScript.
import { binaryName } from '../scripts/artifact-names.mjs';
// @ts-expect-error -- builder hook is JavaScript.
import beforePack from '../scripts/before-pack.mjs';
import { Arch } from 'builder-util';
import pkg from '../package.json';
import { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper';

const digest = (bytes: Buffer) => createHash('sha512').update(bytes).digest('base64');
function fixture(version = '1.23.1', windows = 'manual') {
  const dir = mkdtempSync(join(tmpdir(), 'ember-release-test-'));
  for (const [platform, names] of Object.entries(required) as [string, string[]][]) {
    for (const name of names) writeFileSync(join(dir, name), version + name);
    if (platform !== 'linux') writeFileSync(join(dir, names[0] + '.blockmap'), 'map');
    if (platform === 'macos') writeFileSync(join(dir, names[1] + '.blockmap'), 'zip-map');
    if (platform !== 'windows' || windows === 'signed') {
      const files = (platform === 'macos' ? [names[1], names[0]] : [names[0]]).map(url => {
        const bytes = readFileSync(join(dir, url));
        return { url, size: bytes.length, sha512: digest(bytes), ...(platform === 'linux' ? { blockMapSize: 10 } : {}) };
      });
      writeFileSync(join(dir, platform === 'macos' ? 'latest-mac.yml' : platform === 'linux' ? 'latest-linux.yml' : 'latest.yml'), JSON.stringify({ version, files, path: files[0].url, sha512: files[0].sha512 }));
    }
    checksums(dir, platform, version, windows);
  }
  return dir;
}

test('builder chooses final platform/target names and preserves trust gates', () => {
  expect(pkg.build.mac.artifactName).toBe('Ember-macos-${arch}.${ext}');
  expect(pkg.build.win.artifactName).toBe('Ember-windows-${arch}.${ext}');
  expect(pkg.build.nsis.artifactName).toBe('Ember-windows-${arch}-setup.${ext}');
  expect(pkg.build.linux.artifactName).toBe('Ember-linux-${arch}.${ext}');
  expect(pkg.build.win.verifyUpdateCodeSignature).toBe(true);
  expect(pkg.scripts['dist:win']).toContain('forceCodeSigning=true');
  expect(pkg.scripts['dist:mac']).toContain('forceCodeSigning=true');
  for (const target of ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-x64', 'bun-darwin-arm64', 'bun-windows-x64']) {
    const [, platform, arch] = target.split('-');
    expect(binaryName('tinder', target, 'linux', 'x64')).toBe(`tinder-${platform === 'darwin' ? 'macos' : platform}-${arch}${platform === 'windows' ? '.exe' : ''}`);
    expect(binaryName('kiln', target)).toBe(platform === 'windows' ? 'kiln.exe' : 'kiln');
  }
  expect(() => binaryName('tinder', undefined, 'linux', 'mips')).toThrow();
});

test('complete manual and signed sets pass; missing assets, altered bytes, unsafe URLs and false updates fail', () => {
  for (const windows of ['manual', 'signed']) {
    const dir = fixture('1.23.1', windows);
    try {
      expect(() => audit(dir, '1.23.1', windows)).not.toThrow();
      expect(() => audit(dir, '1.23.2', windows)).toThrow();
      const path = join(dir, 'Ember-linux-x64.AppImage');
      const original = readFileSync(path);
      writeFileSync(path, 'tampered');
      expect(() => audit(dir, '1.23.1', windows)).toThrow();
      writeFileSync(path, original);
      const metadataPath = join(dir, 'latest-linux.yml');
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      metadata.files[0].url = '../Ember-linux-x64.AppImage';
      writeFileSync(metadataPath, JSON.stringify(metadata));
      expect(() => checksums(dir, 'linux', '1.23.1', windows)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const dir = fixture();
  try {
    writeFileSync(join(dir, 'latest.yml'), '{}');
    expect(() => audit(dir, '1.23.1', 'manual')).toThrow('must not advertise');
    rmSync(join(dir, 'latest.yml'));
    rmSync(join(dir, 'tinder-windows-x64.exe'));
    expect(() => audit(dir, '1.23.1', 'manual')).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('published releases and pre-contract versions cannot be promoted', () => {
  for (const version of ['1.23.0', 'v1.23.1', '1.23.1-beta.1']) expect(() => validateVersion(version)).toThrow();
  const calls: string[][] = [];
  expect(() => promote('1.23.1', 'manual', (...args: string[]) => {
    calls.push(args);
    const release = { id: 123, tag_name: 'v1.23.1', draft: false, prerelease: false, name: 'Ember 1.23.1' };
    return JSON.stringify(args[1].endsWith('/releases') ? [[release]] : release);
  })).toThrow('immutable');
  expect(calls).toHaveLength(2);
});

test('fixed filenames are allowed across versions, and updater rejects cached old bytes', async () => {
  const a = fixture('1.23.1');
  const b = fixture('1.23.2');
  try {
    audit(a, '1.23.1', 'manual'); audit(b, '1.23.2', 'manual');
    const filename = 'Ember-linux-x64.AppImage';
    const old = readFileSync(join(a, filename));
    const next = readFileSync(join(b, filename));
    expect(digest(old)).not.toBe(digest(next));
    const helper = new DownloadedUpdateHelper(a);
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const oldInfo = { url: new URL(`https://example.invalid/v1.23.1/${filename}`), info: { url: filename, sha512: digest(old), size: old.length } };
    const update = { version: '1.23.1', files: [oldInfo.info], path: filename, sha512: digest(old), releaseDate: '' };
    await helper.setDownloadedFile(join(a, filename), null, update, oldInfo, filename, true);
    const nextInfo = { url: new URL(`https://example.invalid/v1.23.2/${filename}`), info: { url: filename, sha512: digest(next), size: next.length } };
    expect(await helper.validateDownloadedPath(join(a, filename), { ...update, version: '1.23.2', files: [nextInfo.info], sha512: digest(next) }, nextInfo, logger)).toBeNull();
    const restarted = new DownloadedUpdateHelper(a);
    expect(await restarted.validateDownloadedPath(join(a, filename), { ...update, version: '1.23.2' }, nextInfo, logger)).toBeNull();
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

test('AppImage hook resolves actual target arch before hashing, not builder x86_64 alias', () => {
  for (const arch of [Arch.x64, Arch.arm64]) {
    const target = { name: 'appImage', options: { artifactName: pkg.build.linux.artifactName } };
    beforePack({ electronPlatformName: 'linux', arch, targets: [target] });
    expect(target.options.artifactName).toBe(`Ember-linux-${Arch[arch]}.AppImage`);
  }
  expect(() => beforePack({ electronPlatformName: 'linux', arch: Arch.ia32, targets: [{ name: 'appImage', options: {} }] })).toThrow();
  const shared = { name: 'appImage', options: {} };
  const tar = { name: 'tar.gz', options: { artifactName: pkg.build.linux.artifactName } };
  beforePack({ electronPlatformName: 'linux', arch: Arch.x64, targets: [shared, tar] });
  expect(tar.options.artifactName).toBe(pkg.build.linux.artifactName);
  expect(() => beforePack({ electronPlatformName: 'linux', arch: Arch.arm64, targets: [shared] })).toThrow('separately');
});

test('promotion audits assets before setting Latest, tolerates read counters/order, never uploads', () => {
  const dir = fixture();
  const calls: string[][] = [];
  const release = { id: 123, tag_name: 'v1.23.1', draft: true, prerelease: false, name: 'Ember 1.23.1', assets: [{ id: 456 }, { id: 457 }] };
  let snapshots = 0;
  try {
    const gh = (...args: string[]) => {
      calls.push(args);
      if (args[0] === 'api' && args[1].endsWith('/releases')) return JSON.stringify([[{ id: 1, tag_name: 'v1.23.0' }], [release]]);
      if (args[0] === 'api' && args[1] !== '--method') {
        expect(args[1]).toBe('repos/noemit/ember-bots/releases/123');
        snapshots++;
        const assets = release.assets.map(asset => ({ ...asset, download_count: snapshots }));
        if (snapshots % 2 === 0) assets.reverse();
        return JSON.stringify({ ...release, assets });
      }
      if (args[0] === 'release') cpSync(dir, args[args.indexOf('--dir') + 1], { recursive: true });
      return '{}';
    };
    promote('1.23.1', 'manual', gh);
    expect(calls.at(-1)).toEqual(['api', '--method', 'PATCH', 'repos/noemit/ember-bots/releases/123', '-F', 'draft=false', '-F', 'prerelease=false', '-f', 'make_latest=true']);
    expect(calls.some(args => args.includes('upload'))).toBe(false);
    expect(calls[0]).toEqual(['api', 'repos/noemit/ember-bots/releases', '--paginate', '--slurp']);
    expect(calls.some(args => args.some(value => value.includes('/releases/tags/')))).toBe(false);
    rmSync(join(dir, 'Ember-macos-arm64.zip.blockmap'));
    calls.length = 0;
    expect(() => promote('1.23.1', 'manual', gh)).toThrow('blockmap');
    expect(calls.some(args => args.includes('PATCH'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('draft lookup refuses ambiguous or unsafe release identities with recovery guidance', () => {
  for (const pages of [null, {}, [], [[]], [[{ id: 1, tag_name: 'v1.23.0' }]],
    [[{ id: 1, tag_name: 'v1.23.1' }, { id: 2, tag_name: 'v1.23.1' }]],
    [[{ id: '../other', tag_name: 'v1.23.1' }]]]) {
    const calls: string[][] = [];
    let failure: unknown;
    try {
      promote('1.23.1', 'manual', (...args: string[]) => {
        calls.push(args);
        return JSON.stringify(pages);
      });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/GitHub/);
    expect((failure as Error).message).toMatch(/check|review|refresh/i);
    expect(calls).toHaveLength(1);
    expect(calls.some(args => args.includes('PATCH'))).toBe(false);
  }
});

test('promotion refuses a changed release identity or asset set after downloading', () => {
  const dir = fixture();
  const release = { id: 123, tag_name: 'v1.23.1', draft: true, prerelease: false, name: 'Ember 1.23.1', assets: [{ id: 456 }] };
  try {
    for (const change of [{ id: 124 }, { tag_name: 'v1.23.2' }, { assets: [{ id: 789 }] }, { assets: [{ id: 456, digest: 'different-bytes' }] }, { body: 'unreviewed notes' }, { draft: false }, { prerelease: true }]) {
      const calls: string[][] = [];
      let snapshots = 0;
      expect(() => promote('1.23.1', 'manual', (...args: string[]) => {
        calls.push(args);
        if (args[0] === 'api' && args[1].endsWith('/releases')) return JSON.stringify([[release]]);
        if (args[0] === 'api' && args[1] !== '--method') return JSON.stringify(++snapshots === 1 ? release : { ...release, ...change });
        if (args[0] === 'release') cpSync(dir, args[args.indexOf('--dir') + 1], { recursive: true });
        return '{}';
      })).toThrow('changed');
      expect(calls.some(args => args.includes('PATCH'))).toBe(false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
