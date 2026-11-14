import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LocalApiError } from './tailscaleLocalApiError';

export type MacDaemonProof = { port: number; token: string };
const validProof = (port: string, token: string): MacDaemonProof => {
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535 || !/^[a-f0-9]{10,256}$/i.test(token)) throw new LocalApiError('unsupported');
  return { port: Number(port), token };
};
export const macLsofArgs = (uid: number): string[] => ['-n', '-a', `-u${uid}`, '-c', 'IPNExtension', '-F'];
/** Official same-user IPNExtension lookup only. No all-process scan, shell, env directory or logging. */
export function runMacProofLookup(uid: number): Promise<string> {
  if (!Number.isSafeInteger(uid) || uid < 0) return Promise.reject(new LocalApiError('unsupported'));
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/lsof', macLsofArgs(uid), { timeout: 8_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) reject(new LocalApiError('unavailable')); else resolve(stdout);
    });
  });
}
export function parseMacProofLookup(output: string): MacDaemonProof | undefined {
  if (Buffer.byteLength(output) > 256 * 1024) throw new LocalApiError('invalid');
  const matches = new Map<string, MacDaemonProof>();
  for (const line of output.split('\n')) {
    // lsof's name field only, and only the official App Store sameuserproof filename.
    if (!line.startsWith('n')) continue;
    const candidate = line.includes('.tailscale.ipn.macos/sameuserproof-');
    const match = /\.tailscale\.ipn\.macos\/sameuserproof-([1-9]\d{0,4})-([a-f0-9]{10,256})$/i.exec(line);
    if (candidate && !match) throw new LocalApiError('unsupported');
    if (match) { const proof = validProof(match[1], match[2]); matches.set(proof.port + ':' + proof.token, proof); }
  }
  // Ambiguous daemons are not guessed at. Nothing from the output is included in errors.
  if (matches.size > 1) throw new LocalApiError('unsupported');
  return matches.values().next().value;
}

/** Official system-extension proof layout. Parameters are test seams, never renderer inputs. */
export function readMacsysProof(directory = '/Library/Tailscale', expectedOwner = 0): MacDaemonProof | undefined {
  let fd: number | undefined;
  try {
    const parent = fs.statSync(directory);
    if (!parent.isDirectory() || parent.uid !== expectedOwner || (parent.mode & 0o022) !== 0) throw new LocalApiError('unsupported');
    const port = fs.readlinkSync(path.join(directory, 'ipnport'));
    // Only a literal port, never a path taken from a symlink target.
    if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) throw new LocalApiError('unsupported');
    fd = fs.openSync(path.join(directory, 'sameuserproof-' + port), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const file = fs.fstatSync(fd);
    if (!file.isFile() || file.uid !== expectedOwner || (file.mode & 0o022) !== 0 || file.size > 512) throw new LocalApiError('unsupported');
    const bytes = Buffer.alloc(513);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 512) throw new LocalApiError('invalid');
    return validProof(port, bytes.subarray(0, length).toString('utf8').trim());
  } catch (error) {
    if (error instanceof LocalApiError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw new LocalApiError(code === 'EACCES' || code === 'EPERM' ? 'permission' : 'unsupported');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export async function discoverMacDaemonProof(dependencies: { lsof: () => Promise<string>; macsys: () => MacDaemonProof | undefined } = {
  lsof: () => runMacProofLookup(process.getuid!()), macsys: () => readMacsysProof(),
}): Promise<MacDaemonProof | undefined> {
  let output: string | undefined;
  try { output = await dependencies.lsof(); } catch { /* Official next choice is the macsys proof, not general credentials. */ }
  if (output !== undefined) {
    const appStore = parseMacProofLookup(output);
    if (appStore) return appStore;
  }
  return dependencies.macsys();
}
