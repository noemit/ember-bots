/**
 * Shared canonical relative-path validation and base-URL confinement for Kiln / Hearth (`pi`)
 * requests across both `/remote/pi` (`remoteServer.ts`) and `PiClient.request` (`piClient.ts`).
 */

export type CanonicalPiPath = {
  /** Normalized relative path (`pathname + search`) safe to send upstream. */
  path: string;
  /** Slash-normalized pathname preserving percent-encoded characters within segments (e.g. `%2F`). */
  pathname: string;
  /** Percent-decoded, slash-normalized pathname for route policy checks. */
  decodedPathname: string;
  /** Query string (`''` or `'?' + ...`). */
  search: string;
};

const ALIGNMENT_DESKTOP_ERROR = 'Align instances from the desktop app, where connection credentials stay private.';
const PEERS_DESKTOP_ERROR = 'Manage peer connections from the desktop app, where connection credentials stay private.';

const hasControlCharacters = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const trimTrailingSlash = (pathname: string): string =>
  pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : '/';

/**
 * Canonicalize a relative Pi API path, rejecting empty paths, paths not starting with `'/'`,
 * protocol-relative `'//'`, backslashes, control characters, `'#'` fragments, malformed `%`
 * encodings, and any raw or percent-decoded `'.'` or `'..'` path segment.
 */
export const canonicalizePiPath = (rawPath: unknown): CanonicalPiPath | null => {
  if (
    typeof rawPath !== 'string' ||
    rawPath.length === 0 ||
    !rawPath.startsWith('/') ||
    rawPath.startsWith('//') ||
    rawPath.includes('\\') ||
    rawPath.includes('#') ||
    hasControlCharacters(rawPath)
  ) {
    return null;
  }

  const queryIndex = rawPath.indexOf('?');
  const rawPathname = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath;
  const rawSearch = queryIndex >= 0 ? rawPath.slice(queryIndex) : '';

  if (rawSearch) {
    try {
      if (hasControlCharacters(decodeURIComponent(rawSearch))) return null;
    } catch {
      return null;
    }
  }

  const rawSegments: string[] = [];
  const decodedSegments: string[] = [];
  for (const segment of rawPathname.split('/').slice(1)) {
    if (segment === '') continue;
    if (segment === '.' || segment === '..') return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('\\') ||
      hasControlCharacters(decoded) ||
      decoded.split('/').some((part) => part === '.' || part === '..')
    ) {
      return null;
    }
    rawSegments.push(segment);
    decodedSegments.push(decoded);
  }

  let parsed: URL;
  try {
    parsed = new URL(`/${rawSegments.join('/')}${rawSearch}`, 'http://localhost');
  } catch {
    return null;
  }
  if (parsed.origin !== 'http://localhost' || parsed.username || parsed.password || parsed.hash) {
    return null;
  }

  const pathname = trimTrailingSlash(parsed.pathname.replace(/\/+/g, '/'));
  const decodedPathname = trimTrailingSlash(`/${decodedSegments.join('/')}`.replace(/\/+/g, '/'));
  const search = parsed.search;
  return {
    path: `${pathname}${search}`,
    pathname,
    decodedPathname,
    search,
  };
};

const matchDesktopOnlyPathname = (pathname: string): string | null => {
  const normalized = trimTrailingSlash(pathname.replace(/\/+/g, '/'));
  if (normalized === '/alignment' || normalized.startsWith('/alignment/')) {
    return ALIGNMENT_DESKTOP_ERROR;
  }
  if (normalized === '/directory/peers' || normalized.startsWith('/directory/peers/')) {
    return PEERS_DESKTOP_ERROR;
  }
  return null;
};

/**
 * Enforce the desktop-only `/remote/pi` blocklist (`/alignment`, `/directory/peers`).
 *
 * Checks both the strict canonical pathname and the dot/slash/backslash-resolved pathname so
 * bypass attempts like `//alignment/share`, `/\alignment/connections`, `/%2e%2e/alignment/share`,
 * and `/alignment/../alignment/share` receive `403` before strict validation rejects other
 * non-canonical paths with `400`.
 */
export const desktopOnlyPiRouteError = (rawPath: unknown): string | null => {
  const canonical = canonicalizePiPath(rawPath);
  if (canonical) {
    return matchDesktopOnlyPathname(canonical.pathname) ?? matchDesktopOnlyPathname(canonical.decodedPathname);
  }

  if (
    typeof rawPath !== 'string' ||
    rawPath.length === 0 ||
    !rawPath.startsWith('/') ||
    rawPath.includes('#') ||
    hasControlCharacters(rawPath)
  ) {
    return null;
  }

  const queryIndex = rawPath.indexOf('?');
  const rawPathname = queryIndex >= 0 ? rawPath.slice(0, queryIndex) : rawPath;
  const rawSearch = queryIndex >= 0 ? rawPath.slice(queryIndex) : '';
  if (rawSearch) {
    try {
      if (hasControlCharacters(decodeURIComponent(rawSearch))) return null;
    } catch {
      return null;
    }
  }

  const stack: string[] = [];
  for (const rawSegment of rawPathname.replace(/\\/g, '/').split('/')) {
    if (!rawSegment) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (hasControlCharacters(decoded)) return null;
    for (const part of decoded.replace(/\\/g, '/').split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        stack.pop();
        continue;
      }
      stack.push(part);
    }
  }

  return matchDesktopOnlyPathname(`/${stack.join('/')}`);
};

/**
 * Safely resolve a canonical Pi relative path against a configured `endpoint.url`, verifying the
 * target stays on `base.origin` and beneath `base.pathname` so credentials never escape a subpath.
 */
export const resolvePiUrl = (baseUrl: string, rawPath: unknown): URL | null => {
  const canonical = canonicalizePiPath(rawPath);
  if (!canonical) return null;

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    return null;
  }

  const basePrefix = base.pathname.replace(/\/+$/, '');
  const baseDir = new URL(`${base.origin}${basePrefix}/`);
  let url: URL;
  try {
    url = new URL(`.${canonical.path}`, baseDir);
  } catch {
    return null;
  }

  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== `${basePrefix}${canonical.pathname}` ||
    (basePrefix !== '' && url.pathname !== basePrefix && !url.pathname.startsWith(`${basePrefix}/`))
  ) {
    return null;
  }

  return url;
};
