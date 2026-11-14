import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ShareOwner } from './kilnSharing';
import { isIP } from 'node:net';
export type SyncShareOwnerStore = { read: () => ShareOwner | undefined; write: (owner: ShareOwner | undefined) => void };
export function parseShareOwner(text: string): ShareOwner | undefined {
  try {
    if (text.length > 4096) return undefined;
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value.nodeId !== 'string' || !value.nodeId || value.nodeId.length > 200 || typeof value.target !== 'string'
      || typeof value.etag !== 'string' || !/^[a-f0-9]{64}$/.test(value.etag)
      || (value.port !== undefined && (!Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535))) return undefined;
    const url = new URL('http://' + value.target);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.host !== value.target || url.pathname !== '/' || url.username || url.password || url.search || url.hash
      || !(host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127'))) return undefined;
    return { nodeId: value.nodeId, target: value.target, etag: value.etag, ...(value.port !== undefined ? { port: Number(value.port) } : {}) };
  } catch { return undefined; }
}

/** No credentials: daemon identity, exact target and created Serve ETag. Atomic, desktop-local. */
export function fileShareOwnerStore(file: string): SyncShareOwnerStore {
  return {
    read() {
      try { return parseShareOwner(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
    },
    write(owner) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
      try {
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(owner ?? {})); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(temporary, file);
        // Persist receipt invalidation before a daemon mutation can be submitted.
        const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      } finally {
        try { fs.unlinkSync(temporary); }
        catch { /* Best-effort scratch cleanup must not hide the commit's outcome. */ }
      }
    },
  };
}
