import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Open a link from a chat or context menu: allowlisted external URLs (`https:`, `http:`,
 * `mailto:`) go to the default handler, existing local directories open with `shell.openPath`,
 * and existing local files (including `file://` URLs) are strictly revealed in their folder
 * via `shell.showItemInFolder` — never executed via `shell.openPath` or `shell.openExternal`.
 */

export const ALLOWED_EXTERNAL_PROTOCOLS = ['https:', 'http:', 'mailto:'] as const;

// `localhost:3000` parses as the odd scheme `localhost:` and `www.example.com` isn't a URL
// at all, so agents' bare web addresses need an explicit http:// prefix before anything else.
const NEEDS_SCHEME = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|www\.)[^\s]*$/i;

export type OpenTargetShell = {
  openExternal(url: string): Promise<void>;
  openPath(targetPath: string): Promise<string>;
  showItemInFolder(fullPath: string): void;
};

export type OpenTargetStat = {
  isDirectory(): boolean;
  isFile?(): boolean;
};

export type OpenTargetOptions = {
  fs?: { statSync(targetPath: string): OpenTargetStat };
  homedir?: string;
  path?: Pick<typeof path, 'isAbsolute' | 'join' | 'resolve'>;
  toFilePath?: (url: URL) => string;
};

const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const isUncOrProtocolRelativePath = (value: string): boolean =>
  value.startsWith('//') || value.startsWith('\\\\');

const isLocalFilesystemSyntax = (value: string): boolean =>
  (value.startsWith('/') && !value.startsWith('//')) || /^[A-Za-z]:[\\/]/.test(value);

/**
 * Convert a local `file:` URL into a filesystem path, rejecting remote hosts (which would
 * become SMB UNC paths on Windows), credentials, relative `file:` forms without a leading
 * slash, malformed encodings, and decoded control characters.
 */
export const fileUrlToLocalPath = (
  rawUrl: string,
  toFilePath: (url: URL) => string = fileURLToPath,
): string | null => {
  if (typeof rawUrl !== 'string' || !/^file:\//i.test(rawUrl) || hasControlCharacters(rawUrl)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:' || parsed.username || parsed.password) return null;
  if (parsed.hostname && parsed.hostname.toLowerCase() !== 'localhost') return null;
  try {
    const converted = toFilePath(parsed);
    if (!converted || hasControlCharacters(converted) || isUncOrProtocolRelativePath(converted)) {
      return null;
    }
    return converted;
  } catch {
    return null;
  }
};

const openLocalPath = async (
  localPath: string,
  shell: OpenTargetShell,
  fsImpl: { statSync(targetPath: string): OpenTargetStat },
  pathImpl: Pick<typeof path, 'isAbsolute' | 'join' | 'resolve'>,
): Promise<boolean> => {
  if (!localPath || hasControlCharacters(localPath) || isUncOrProtocolRelativePath(localPath)) {
    return false;
  }
  if (!pathImpl.isAbsolute(localPath)) return false;
  const resolved = pathImpl.resolve(localPath);
  if (isUncOrProtocolRelativePath(resolved)) return false;
  let stat: OpenTargetStat;
  try {
    stat = fsImpl.statSync(resolved);
  } catch {
    return false;
  }
  try {
    if (stat.isDirectory()) {
      const error = await shell.openPath(resolved);
      return typeof error === 'string' ? error.length === 0 : true;
    }
    if (typeof stat.isFile === 'function' && !stat.isFile()) return false;
    shell.showItemInFolder(resolved);
    return true;
  } catch {
    return false;
  }
};

export const openTarget = async (
  target: string,
  shell: OpenTargetShell,
  options: OpenTargetOptions = {},
): Promise<boolean> => {
  const trimmed = typeof target === 'string' ? target.trim() : '';
  if (!trimmed || hasControlCharacters(trimmed)) return false;

  const fsImpl = options.fs ?? fs;
  const pathImpl = options.path ?? path;
  const homedir = options.homedir ?? os.homedir();
  const toFilePath = options.toFilePath ?? fileURLToPath;

  if (NEEDS_SCHEME.test(trimmed)) {
    try {
      const bareUrl = new URL(`http://${trimmed}`);
      if (bareUrl.protocol !== 'http:' || bareUrl.username || bareUrl.password) return false;
      await shell.openExternal(bareUrl.toString());
      return true;
    } catch {
      return false;
    }
  }

  const expanded =
    trimmed === '~' || /^~[\\/]/.test(trimmed)
      ? pathImpl.join(homedir, trimmed.slice(1))
      : trimmed;

  if (/^file:/i.test(expanded)) {
    const localPath = fileUrlToLocalPath(expanded, toFilePath);
    if (!localPath) return false;
    return openLocalPath(localPath, shell, fsImpl, pathImpl);
  }

  if (isLocalFilesystemSyntax(expanded)) {
    return openLocalPath(expanded, shell, fsImpl, pathImpl);
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(expanded)) {
    let parsed: URL;
    try {
      parsed = new URL(expanded);
    } catch {
      return false;
    }
    if (!ALLOWED_EXTERNAL_PROTOCOLS.includes(parsed.protocol as (typeof ALLOWED_EXTERNAL_PROTOCOLS)[number])) {
      return false;
    }
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === 'mailto:' && !parsed.pathname.trim() && !parsed.search) return false;
    try {
      await shell.openExternal(parsed.toString());
      return true;
    } catch {
      return false;
    }
  }

  return false;
};
