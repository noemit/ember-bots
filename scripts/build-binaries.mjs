import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

const kind = process.argv[2];
if (kind !== 'kiln' && kind !== 'tinder') throw new Error('Choose kiln or tinder to build.');
const directory = kind === 'kiln' ? 'build/harness' : 'release';
const entry = kind === 'kiln' ? 'packages/kiln/src/index.ts' : 'packages/kiln/src/tinder.ts';
const name = kind === 'kiln' ? 'kiln' : 'tinder-cli';
mkdirSync(directory, { recursive: true });
const result = spawnSync('bun', ['build', '--compile', entry, '--outfile', join(directory, `${name}${process.platform === 'win32' ? '.exe' : ''}`)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
