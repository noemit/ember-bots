/**
 * GitHub release update checker.
 *
 * Pure semver comparison, release payload parsing, and a bounded fetch helper against GitHub's
 * latest release API (`https://api.github.com/repos/noemit/ember-bots/releases/latest`), with a
 * fallback to `/tags` when no formal Release object has been published yet.
 */

export const GITHUB_REPO_SLUG = 'noemit/ember-bots';
export const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_REPO_SLUG}/releases`;
export const GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases/latest`;
export const GITHUB_TAGS_API = `https://api.github.com/repos/${GITHUB_REPO_SLUG}/tags?per_page=10`;

export type UpdateCheckResult = {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string;
};

/**
 * Parse a version string like `"v0.95.1"`, `"0.95.1"`, or `"0.95.1-beta.1"` into `[major, minor, patch]`
 * plus an optional pre-release suffix. Returns `null` when the string does not start with `X.Y.Z`.
 */
export const parseSemver = (
  raw: string | undefined | null
): { major: number; minor: number; patch: number; prerelease?: string } | null => {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^v/i, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(cleaned);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return {
    major,
    minor,
    patch,
    ...(match[4] ? { prerelease: match[4] } : {}),
  };
};

/** Normalize a tag or version string (`"v1.2.0"` → `"1.2.0"`). */
export const normalizeVersion = (raw: string | undefined | null): string | null => {
  const parsed = parseSemver(raw);
  if (!parsed) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease ? `-${parsed.prerelease}` : ''}`;
};

/**
 * True when `candidate` is strictly newer than `current`.
 *
 * Pre-release builds (`0.95.0-dev`) are never offered as an upgrade over a stable release unless
 * `candidate` is a stable release of the same `X.Y.Z` or a higher `X.Y.Z`.
 */
export const isNewerVersion = (current: string, candidate: string): boolean => {
  const cur = parseSemver(current);
  const next = parseSemver(candidate);
  if (!cur || !next) return false;
  // Never prompt a user to "upgrade" to a prerelease tag.
  if (next.prerelease) return false;
  if (next.major !== cur.major) return next.major > cur.major;
  if (next.minor !== cur.minor) return next.minor > cur.minor;
  if (next.patch !== cur.patch) return next.patch > cur.patch;
  // Same X.Y.Z, where current is a prerelease (e.g. `0.95.0-dev`) and candidate is stable `0.95.0`.
  return Boolean(cur.prerelease && !next.prerelease);
};

/**
 * Extract the version and URL from GitHub's `/releases/latest` JSON response.
 */
export const parseGithubReleasePayload = (
  payload: unknown
): { version: string; url: string } | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const rec = payload as Record<string, unknown>;
  if (rec.draft === true || rec.prerelease === true) return null;
  const tag = typeof rec.tag_name === 'string' ? rec.tag_name : typeof rec.name === 'string' ? rec.name : null;
  const version = normalizeVersion(tag);
  if (!version) return null;
  const htmlUrl =
    typeof rec.html_url === 'string' && /^https:\/\/github\.com\//i.test(rec.html_url)
      ? rec.html_url
      : `${GITHUB_RELEASES_URL}/tag/v${version}`;
  return { version, url: htmlUrl };
};

/**
 * Extract the newest stable semver tag from GitHub's `/tags` array response.
 */
export const parseGithubTagsPayload = (
  payload: unknown
): { version: string; url: string } | null => {
  if (!Array.isArray(payload)) return null;
  let best: { version: string; url: string } | null = null;
  for (const item of payload) {
    if (!item || typeof item !== 'object') continue;
    const name = (item as { name?: unknown }).name;
    if (typeof name !== 'string') continue;
    const parsed = parseSemver(name);
    if (!parsed || parsed.prerelease) continue;
    const version = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    if (!best || isNewerVersion(best.version, version)) {
      best = {
        version,
        url: `${GITHUB_RELEASES_URL}/tag/${encodeURIComponent(name.trim())}`,
      };
    }
  }
  return best;
};

/**
 * Check GitHub for a newer release of Ember. Never throws: network errors or rate limits simply
 * return `updateAvailable: false`.
 */
export const checkGithubForUpdate = async (
  currentVersion: string,
  fetchImpl: typeof fetch = fetch
): Promise<UpdateCheckResult> => {
  const cleanCurrent = normalizeVersion(currentVersion) ?? currentVersion.trim();
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': `Ember/${cleanCurrent || '0.0.0'}`,
  };

  try {
    const releaseRes = await fetchImpl(GITHUB_LATEST_RELEASE_API, {
      headers,
      signal: AbortSignal.timeout(6_000),
    });
    if (releaseRes.ok) {
      const parsed = parseGithubReleasePayload(await releaseRes.json().catch(() => null));
      if (parsed) {
        return {
          updateAvailable: isNewerVersion(cleanCurrent, parsed.version),
          currentVersion: cleanCurrent,
          latestVersion: parsed.version,
          releaseUrl: parsed.url,
        };
      }
    }

    // Fallback to tags if the repo uses tags or has no published release object yet (404).
    const tagsRes = await fetchImpl(GITHUB_TAGS_API, {
      headers,
      signal: AbortSignal.timeout(6_000),
    });
    if (tagsRes.ok) {
      const parsed = parseGithubTagsPayload(await tagsRes.json().catch(() => null));
      if (parsed) {
        return {
          updateAvailable: isNewerVersion(cleanCurrent, parsed.version),
          currentVersion: cleanCurrent,
          latestVersion: parsed.version,
          releaseUrl: parsed.url,
        };
      }
    }
  } catch {
    // Offline or blocked; fail silently.
  }

  return {
    updateAvailable: false,
    currentVersion: cleanCurrent,
    latestVersion: null,
    releaseUrl: GITHUB_RELEASES_URL,
  };
};

/** User-facing notice copy when an update is available. */
export const formatUpdateNotice = (latestVersion: string): string =>
  `Update available: Ember ${latestVersion} is out on GitHub.`;
