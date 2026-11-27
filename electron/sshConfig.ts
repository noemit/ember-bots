import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type SshHostCandidate = {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  proxyJump?: string;
  source: 'ssh-config';
};

const MAX_INCLUDE_DEPTH = 5;
const MAX_HOSTS = 200;

/**
 * Validate an SSH target (host alias or `user@host`).
 * Rejects leading dashes (SSH option injection), whitespace, control chars, and shell metacharacters.
 */
export const isValidSshTarget = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 255) return false;
  if (trimmed.startsWith('-')) return false;
  if (/[\s\r\n\0'"`$|;&<>()\\]/.test(trimmed)) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9._:@[\]-]{0,254}$/.test(trimmed);
};

const stripComment = (line: string): string => {
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === '#' && !inQuotes) return line.slice(0, i);
  }
  return line;
};

/** Split an OpenSSH config directive into `[keyword, rest]`, handling whitespace or `=`. */
const parseDirective = (raw: string): [string, string] | null => {
  const cleaned = stripComment(raw).trim();
  if (!cleaned) return null;
  const match = /^([A-Za-z][A-Za-z0-9-]*)(?:\s*=\s*|\s+)(.*)$/.exec(cleaned);
  if (!match) return null;
  return [match[1]!.toLowerCase(), match[2]!.trim()];
};

const unquote = (value: string): string =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;

const tokenizeValues = (value: string): string[] => {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && /\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
};

const isConcreteAlias = (pattern: string): boolean =>
  pattern.length > 0 &&
  !pattern.startsWith('!') &&
  !pattern.includes('*') &&
  !pattern.includes('?') &&
  isValidSshTarget(pattern);

const matchGlob = (pattern: string, name: string): boolean => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(name);
};

const expandIncludePaths = (pattern: string, sshDir: string, homeDir: string): string[] => {
  const cleaned = unquote(pattern);
  const resolved = cleaned.startsWith('~/')
    ? path.join(homeDir, cleaned.slice(2))
    : path.isAbsolute(cleaned)
      ? cleaned
      : path.join(sshDir, cleaned);
  if (!resolved.includes('*') && !resolved.includes('?')) {
    return fs.existsSync(resolved) ? [resolved] : [];
  }
  const dir = path.dirname(resolved);
  const basePattern = path.basename(resolved);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((entry) => matchGlob(basePattern, entry))
      .sort()
      .map((entry) => path.join(dir, entry))
      .filter((full) => {
        try {
          return fs.statSync(full).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
};

type MutableHost = {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  proxyJump?: string;
};

const parseFileInto = (
  filePath: string,
  sshDir: string,
  homeDir: string,
  visited: Set<string>,
  depth: number,
  hosts: Map<string, MutableHost>
): void => {
  if (depth > MAX_INCLUDE_DEPTH || hosts.size >= MAX_HOSTS) return;
  let real: string;
  try {
    real = fs.realpathSync(filePath);
  } catch {
    return;
  }
  if (visited.has(real)) return;
  visited.add(real);

  let content: string;
  try {
    content = fs.readFileSync(real, 'utf8');
  } catch {
    return;
  }

  let activeAliases: string[] = [];
  let inMatchBlock = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const parsed = parseDirective(rawLine);
    if (!parsed) continue;
    const [key, rawValue] = parsed;

    if (key === 'include') {
      for (const token of tokenizeValues(rawValue)) {
        for (const included of expandIncludePaths(token, sshDir, homeDir)) {
          parseFileInto(included, sshDir, homeDir, visited, depth + 1, hosts);
        }
      }
      continue;
    }

    if (key === 'match') {
      inMatchBlock = true;
      activeAliases = [];
      continue;
    }

    if (key === 'host') {
      inMatchBlock = false;
      const patterns = tokenizeValues(rawValue);
      activeAliases = patterns.filter(isConcreteAlias);
      for (const alias of activeAliases) {
        if (!hosts.has(alias) && hosts.size < MAX_HOSTS) {
          hosts.set(alias, { alias });
        }
      }
      continue;
    }

    if (inMatchBlock || activeAliases.length === 0) continue;

    // OpenSSH uses first-match-wins for host directives.
    const val = unquote(rawValue);
    for (const alias of activeAliases) {
      const entry = hosts.get(alias);
      if (!entry) continue;
      if (key === 'hostname' && !entry.hostName && val) {
        entry.hostName = val;
      } else if (key === 'user' && !entry.user && val) {
        entry.user = val;
      } else if (key === 'port' && entry.port === undefined) {
        const parsedPort = Number(val);
        if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
          entry.port = parsedPort;
        }
      } else if (key === 'proxyjump' && !entry.proxyJump && val && val.toLowerCase() !== 'none') {
        entry.proxyJump = val;
      }
    }
  }
};

/**
 * Passively discover concrete SSH host aliases from `~/.ssh/config` and any `Include`d files.
 * Performs local filesystem reads only — never opens a network connection or spawns `ssh`.
 */
export const discoverSshConfigHosts = (options?: {
  configPath?: string;
  homeDir?: string;
}): SshHostCandidate[] => {
  const homeDir = options?.homeDir ?? os.homedir();
  const sshDir = path.join(homeDir, '.ssh');
  const configPath = options?.configPath ?? path.join(sshDir, 'config');
  if (!fs.existsSync(configPath)) return [];
  const hosts = new Map<string, MutableHost>();
  parseFileInto(configPath, sshDir, homeDir, new Set<string>(), 0, hosts);
  return [...hosts.values()].map((entry) => ({
    ...entry,
    source: 'ssh-config' as const,
  }));
};
