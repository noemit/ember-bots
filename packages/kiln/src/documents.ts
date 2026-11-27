import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  AgentDoc,
  defineDoc,
  type ConversationId,
  type Harness,
  type JsonObject,
  type Storage,
  type TaskId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { scratchDirFor } from "./scratch";

export type DocumentKind = "markdown" | "html";

export type FileToolProvenance = {
  absolutePath: string;
  cwd: string;
};

export type NestedFileToolProvenance = {
  callId: string;
  tool: string;
  absolutePath: string;
  cwd: string;
};

export type ResolvedConversationDocument = {
  candidate: string;
  resolvedPath: string;
  kind: DocumentKind;
  size: number;
  mtimeMs: number;
};

export type ReadConversationDocumentResult =
  | {
      ok: true;
      document: {
        path: string;
        kind: DocumentKind;
        content: string;
        size: number;
        mtimeMs: number;
      };
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 413;
      error: string;
    };

export const MAX_DOC_BYTES = 2 * 1024 * 1024;
export const MAX_RESOLVE_CANDIDATES = 64;
export const WALK_MAX_DEPTH = 4;
export const WALK_MAX_ENTRIES = 2_000;
const WALK_MAX_MS = 500;
const MAX_PROVENANCE_ENTRIES = 1_000;
const PROVENANCE_PAGE_SIZE = 100;
const MAX_CANDIDATE_CHARS = 512;
const MAX_PATH_CHARS = 4096;

const FILE_TOOL_NAMES = new Set(["read", "write", "edit", "view"]);
const WALK_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build"]);
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

/** Task-scoped provenance records collected from nested file tool calls inside `codemode`. */
export const NestedToolProvenanceDoc = defineDoc<{ items: NestedFileToolProvenance[] }>({
  kind: "hearth.nested-tool-provenance",
  version: 1,
  scope: "task",
  initial: () => ({ items: [] }),
  // Retires with the owning codemode task.
  checkpointWhen: () => false,
});

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeFileToolInputPath = (rawPath: string): string => {
  const normalized = rawPath.replace(UNICODE_SPACES, " ");
  return normalized.startsWith("@") ? normalized.slice(1) : normalized;
};

const resolveProvenancePath = async (
  toolName: string,
  args: unknown,
  env: NonNullable<ToolExecutionApi["env"]>,
  context: Context
): Promise<FileToolProvenance | undefined> => {
  if (!FILE_TOOL_NAMES.has(toolName)) return undefined;
  if (typeof args !== "object" || args === null) return undefined;
  const rawPath = (args as { path?: unknown }).path;
  if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;
  const cwd = typeof env.cwd === "string" && env.cwd.trim() ? env.cwd : process.cwd();
  if (toolName === "view") {
    const absolutePath = getOrThrow(await env.absolutePath(rawPath, context));
    return { absolutePath, cwd };
  }
  const normalized = normalizeFileToolInputPath(rawPath);
  const resolved = getOrThrow(await env.absolutePath(normalized, context));
  if (toolName !== "read") {
    return { absolutePath: resolved, cwd };
  }
  // Mirror pi-durable's read path fallback ordering so macOS screenshot/Unicode names match.
  const variants = [
    resolved,
    resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
    resolved.normalize("NFD"),
    resolved.replace(/'/g, "\u2019"),
    resolved.normalize("NFD").replace(/'/g, "\u2019"),
  ];
  for (const variant of new Set(variants)) {
    if (getOrThrow(await env.exists(variant, context))) {
      return { absolutePath: variant, cwd };
    }
  }
  return { absolutePath: resolved, cwd };
};

/**
 * Wrap `read`, `write`, `edit`, and `view` so successful non-error results attach structured
 * `details.provenance = { absolutePath, cwd }` without disturbing existing `details` fields,
 * and record nested calls on the owning `codemode` task when executed inside `codemode`.
 */
export const withFileToolProvenance = (tool: ToolRegistration): ToolRegistration => {
  if (!FILE_TOOL_NAMES.has(tool.name)) return tool;
  return {
    ...tool,
    execute: async (args, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> => {
      let lastReportedDetails: unknown;
      const trackedApi: ToolExecutionApi = {
        ...api,
        details: async (value, detailsContext) => {
          lastReportedDetails = value;
          return api.details(value, detailsContext);
        },
      };
      const result = await tool.execute(args, trackedApi, context);
      if (result.isError === true || !api.env) {
        return result;
      }
      let provenance: FileToolProvenance | undefined;
      try {
        provenance = await resolveProvenancePath(tool.name, args, api.env, context);
      } catch {
        provenance = undefined;
      }
      if (!provenance) {
        return result;
      }
      if (typeof api.getTask === "function" && typeof api.commit === "function") {
        try {
          const selfTask = await api.getTask(api.taskId, context);
          const ownerTaskId: TaskId | undefined = selfTask?.owner;
          if (ownerTaskId !== undefined) {
            const callId = String(api.callId);
            await api.commit(async (tx) => {
              const doc = await tx.doc(NestedToolProvenanceDoc, ownerTaskId);
              if (!doc.items.some((item) => item.callId === callId && item.absolutePath === provenance.absolutePath)) {
                doc.items.push({
                  callId,
                  tool: tool.name,
                  absolutePath: provenance.absolutePath,
                  cwd: provenance.cwd,
                });
              }
            }, context);
          }
        } catch {
          // Best-effort nested provenance propagation; never break the file operation itself.
        }
      }
      const existingDetails = isJsonObject(result.details)
        ? result.details
        : isJsonObject(lastReportedDetails)
          ? lastReportedDetails
          : {};
      return {
        ...result,
        details: {
          ...existingDetails,
          provenance,
        },
      };
    },
  };
};

/**
 * Wrap `codemode` (non-gating) so completed runs surface nested file tool provenance recorded by
 * child `read`/`write`/`edit`/`view` calls in `details.nestedProvenance`.
 */
export const withCodemodeProvenance = (tool: ToolRegistration): ToolRegistration => ({
  ...tool,
  execute: async (args, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> => {
    const result = await tool.execute(args, api, context);
    if (result.isError === true || typeof api.snapshot !== "function") {
      return result;
    }
    try {
      const nested = await api.snapshot(NestedToolProvenanceDoc, api.taskId, context);
      if (!nested || nested.items.length === 0) {
        return result;
      }
      const existingDetails = isJsonObject(result.details) ? result.details : {};
      return {
        ...result,
        details: {
          ...existingDetails,
          nestedProvenance: nested.items.map((item) => ({ ...item })),
        },
      };
    } catch {
      return result;
    }
  },
});

export const docKindForPath = (filePath: string): DocumentKind | undefined => {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".markdown" || ext === ".mdx") return "markdown";
  if (ext === ".html" || ext === ".htm") return "html";
  return undefined;
};

const safeRealpath = (targetPath: string): string | undefined => {
  try {
    return realpathSync(targetPath);
  } catch {
    return undefined;
  }
};

const normalizedSegments = (targetPath: string): string[] =>
  resolve(targetPath)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);

const isPathInsideOrEqual = (candidatePath: string, rootPath: string): boolean => {
  const rel = relative(rootPath, candidatePath);
  if (rel === "") return true;
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  return true;
};

const isPathInside = (candidatePath: string, rootPath: string): boolean => {
  const rel = relative(rootPath, candidatePath);
  if (!rel || rel === ".") return false;
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  return true;
};

/**
 * Wide-root guard (`D1`): `/`, `$HOME`, `/home`, `/Users`, `/tmp`, `/var`, `/private/tmp`, and
 * `config.home` itself are never walked blindly and never grant ambient folder containment.
 */
export const isWideRoot = (dirPath: string, configHome: string): boolean => {
  const canonical = safeRealpath(dirPath);
  if (!canonical) return true;
  if (dirname(canonical) === canonical) return true;

  const home = homedir();
  const homeParent = dirname(home);
  const wideCandidates = new Set<string>([
    "/",
    "/home",
    "/Users",
    "/tmp",
    "/var",
    "/private/tmp",
    home,
    ...(homeParent && homeParent !== home ? [homeParent] : []),
    configHome,
  ]);
  const canonWide = new Set<string>();
  for (const entry of wideCandidates) {
    if (!entry) continue;
    canonWide.add(resolve(entry));
    const real = safeRealpath(entry);
    if (real) canonWide.add(real);
  }
  return canonWide.has(canonical);
};

const SECRET_EXACT_SEGMENTS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".git",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".env",
  ".ember",
  ".hearth",
]);

const CONFIG_MARKER_SEGMENTS = new Set([".config", ".ember", ".hearth", ".openchamber", ".opencode"]);

const envCanonicalDir = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  return safeRealpath(value) ?? resolve(value);
};

const SCRATCH_EXEMPT_HOME_SEGMENTS = new Set([".ember", ".hearth"]);

/**
 * Secret-segment and secret-root denylist (`D1`). Runs case-insensitively on canonical segments
 * and configured state/credential directories. Only the active conversation's own scratch dir
 * inside `$HEARTH_HOME` is exempted (and its relative path is still checked against all secret
 * filenames/segments).
 */
export const isSecretPath = (
  targetPath: string,
  configHome: string,
  conversationNumber: number
): boolean => {
  const canonical = resolve(targetPath);
  const homeDir = homedir();
  const ownScratchResolved = resolve(scratchDirFor(configHome, conversationNumber));
  const ownScratchReal = safeRealpath(ownScratchResolved);
  const ownScratchRoot =
    ownScratchReal !== undefined && isPathInside(canonical, ownScratchReal)
      ? ownScratchReal
      : isPathInside(canonical, ownScratchResolved)
        ? ownScratchResolved
        : undefined;
  const inOwnScratch = ownScratchRoot !== undefined;

  const hearthHomes = [
    resolve(configHome),
    safeRealpath(configHome),
    envCanonicalDir("HEARTH_HOME"),
    envCanonicalDir("EMBER_HOME"),
    resolve(join(homeDir, ".hearth")),
    safeRealpath(join(homeDir, ".hearth")),
  ].filter((value): value is string => value !== undefined);

  if (!inOwnScratch) {
    for (const root of hearthHomes) {
      if (isPathInsideOrEqual(canonical, root)) return true;
    }
  }

  const forbiddenDataDirs = [
    resolve(join(homeDir, ".ember")),
    safeRealpath(join(homeDir, ".ember")),
    envCanonicalDir("EMBER_DATA_DIR"),
    resolve(join(homeDir, ".config", "ember")),
    safeRealpath(join(homeDir, ".config", "ember")),
    resolve(join(homeDir, ".config", "openchamber")),
    safeRealpath(join(homeDir, ".config", "openchamber")),
    envCanonicalDir("OPENCHAMBER_DATA_DIR"),
    resolve(join(homeDir, ".local", "share", "opencode")),
    safeRealpath(join(homeDir, ".local", "share", "opencode")),
  ].filter((value): value is string => value !== undefined);

  for (const dir of forbiddenDataDirs) {
    if (!inOwnScratch) {
      if (isPathInsideOrEqual(canonical, dir)) return true;
    } else if (isPathInside(dir, ownScratchRoot) && isPathInsideOrEqual(canonical, dir)) {
      return true;
    }
  }

  if (inOwnScratch) {
    // Allow `.ember` / `.hearth` (or `.config/ember`) only as ancestors of the verified scratch
    // root itself; still reject other secret ancestor directories like `.ssh` or `.aws`.
    const prefixSegments = normalizedSegments(ownScratchRoot).map((seg) => seg.toLowerCase());
    for (const seg of prefixSegments) {
      if (SECRET_EXACT_SEGMENTS.has(seg) && !SCRATCH_EXEMPT_HOME_SEGMENTS.has(seg)) return true;
    }
  }

  const segments = normalizedSegments(
    inOwnScratch ? relative(ownScratchRoot, canonical) : canonical
  ).map((seg) => seg.toLowerCase());
  const hasConfigAncestor = segments.slice(0, -1).some((seg) => CONFIG_MARKER_SEGMENTS.has(seg));

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!;
    if (SECRET_EXACT_SEGMENTS.has(seg)) return true;
    if (seg.startsWith(".env.")) return true;
    if (seg.startsWith("id_rsa") || seg.startsWith("id_ed25519")) return true;
    if (seg.startsWith("hearth.sqlite")) return true;
    if (/\.(?:pem|key|p12|pfx)(?:\.|$)/.test(seg)) return true;
    if (seg === ".config" && i + 1 < segments.length) {
      const next = segments[i + 1]!;
      if (next === "gh" || next === "gcloud" || next === "ember" || next === "openchamber") {
        return true;
      }
    }
    if (hasConfigAncestor) {
      if (
        seg === "auth.json" ||
        seg === "peers.json" ||
        seg === "settings.json" ||
        seg.startsWith("auth.json.") ||
        seg.startsWith("peers.json.") ||
        seg.startsWith("settings.json.")
      ) {
        return true;
      }
    }
  }
  return false;
};

type ParsedCandidate =
  | { ok: true; raw: string; pathPart: string; kind: DocumentKind; isExplicit: boolean }
  | { ok: false };

const hasControlOrNonSpaceWhitespace = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || (/\s/.test(value[i]!) && code !== 0x20)) {
      return true;
    }
  }
  return false;
};

const isExplicitAbsolutePath = (targetPath: string): boolean =>
  isAbsolute(targetPath) || targetPath.startsWith("~/") || /^[A-Za-z]:[/\\]/.test(targetPath);

/**
 * Strictly parse local `file:///...` and `file://localhost/...` URLs into local filesystem paths.
 * Rejects foreign/UNC hosts, userinfo credentials, query strings, backslashes, encoded separators,
 * control characters, and `.` / `..` traversal segments before normalization.
 */
const parseLocalFileUrl = (rawUrl: string): string | null => {
  if (!/^file:\/\//i.test(rawUrl)) return null;
  const afterScheme = rawUrl.slice(7);
  const hashIdx = afterScheme.indexOf("#");
  const beforeHash = hashIdx >= 0 ? afterScheme.slice(0, hashIdx) : afterScheme;
  const fragment = hashIdx >= 0 ? afterScheme.slice(hashIdx + 1) : "";
  if (fragment && hasControlOrNonSpaceWhitespace(fragment)) return null;
  if (beforeHash.includes("?") || beforeHash.includes("\\")) return null;

  const slashIdx = beforeHash.indexOf("/");
  if (slashIdx === -1) return null;
  const authority = beforeHash.slice(0, slashIdx);
  if (authority.includes("@")) return null;
  if (authority !== "" && authority.toLowerCase() !== "localhost") return null;

  const rawPath = beforeHash.slice(slashIdx);
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) return null;

  const rawSegments = rawPath.slice(1).split("/");
  if (rawSegments.length === 0) return null;
  const decodedSegments: string[] = [];
  for (const segment of rawSegments) {
    if (!segment) return null;
    if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(segment)) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (!decoded || decoded === "." || decoded === "..") return null;
    if (decoded.includes("/") || decoded.includes("\\") || hasControlOrNonSpaceWhitespace(decoded)) {
      return null;
    }
    decodedSegments.push(decoded);
  }

  if (decodedSegments.length >= 2 && /^[A-Za-z]:$/.test(decodedSegments[0]!)) {
    return `${decodedSegments[0]}/${decodedSegments.slice(1).join("/")}`;
  }
  return `/${decodedSegments.join("/")}`;
};

const parseCandidateInput = (raw: unknown, maxLength: number): ParsedCandidate => {
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > maxLength) return { ok: false };
  if (hasControlOrNonSpaceWhitespace(trimmed)) return { ok: false };
  // Reject UNC network paths (`//host/share` or `\\host\share`).
  if (trimmed.startsWith("//") || trimmed.startsWith("\\\\")) return { ok: false };

  if (/^file:/i.test(trimmed)) {
    const decodedPath = parseLocalFileUrl(trimmed);
    if (!decodedPath) return { ok: false };
    const kind = docKindForPath(decodedPath);
    if (!kind) return { ok: false };
    return { ok: true, raw, pathPart: decodedPath, kind, isExplicit: true };
  }

  // Reject all other URI schemes (allow Windows drive letters like `C:\...` or `C:/...`).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !/^[A-Za-z]:[/\\]/.test(trimmed)) {
    return { ok: false };
  }

  let pathPart = trimmed;
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx > 0) {
    const beforeHash = trimmed.slice(0, hashIdx);
    if (docKindForPath(beforeHash) !== undefined) {
      pathPart = beforeHash;
    }
  }
  const kind = docKindForPath(pathPart);
  if (!kind) return { ok: false };

  const isExplicit =
    isExplicitAbsolutePath(pathPart) ||
    pathPart.startsWith("./") ||
    pathPart.startsWith("../") ||
    pathPart.includes("/") ||
    pathPart.includes("\\");

  return { ok: true, raw, pathPart, kind, isExplicit };
};

type ConversationDocContext = {
  conversationId: ConversationId;
  conversationNumber: number;
  configHome: string;
  nonWideCwd?: string;
  ownScratch?: string;
  provenanceList: FileToolProvenance[];
  provenanceByCanonical: Map<string, FileToolProvenance[]>;
  provenanceByBasename: Map<string, string[]>;
};

const collectProvenance = async (
  storage: Storage,
  conversationId: ConversationId,
  configHome: string,
  conversationNumber: number,
  context: Context
): Promise<{
  list: FileToolProvenance[];
  byCanonical: Map<string, FileToolProvenance[]>;
  byBasename: Map<string, string[]>;
}> => {
  const list: FileToolProvenance[] = [];
  const byCanonical = new Map<string, FileToolProvenance[]>();
  const byBasenameMap = new Map<string, Set<string>>();

  const addRecord = (record: FileToolProvenance) => {
    const canonical = safeRealpath(record.absolutePath);
    const resolvedKey = canonical ?? resolve(record.absolutePath);
    if (isSecretPath(resolvedKey, configHome, conversationNumber)) return;
    if (isSecretPath(record.absolutePath, configHome, conversationNumber)) return;
    if (!docKindForPath(resolvedKey)) return;
    list.push({ absolutePath: resolvedKey, cwd: record.cwd });
    const existingList = byCanonical.get(resolvedKey);
    if (existingList) existingList.push(record);
    else byCanonical.set(resolvedKey, [record]);

    const base = basename(resolvedKey);
    let set = byBasenameMap.get(base);
    if (!set) {
      set = new Set();
      byBasenameMap.set(base, set);
    }
    set.add(resolvedKey);
  };

  let cursor: Awaited<ReturnType<Storage["scanEntries"]>>["next"] | undefined;
  let scanned = 0;
  while (scanned < MAX_PROVENANCE_ENTRIES) {
    const page = await storage.scanEntries(
      { conversationId, order: "descending" },
      Math.min(PROVENANCE_PAGE_SIZE, MAX_PROVENANCE_ENTRIES - scanned),
      cursor,
      context
    );
    if (page.items.length === 0) break;
    scanned += page.items.length;

    for (const entry of page.items) {
      if (entry.kind !== "pi.tool-result" || !Array.isArray(entry.model)) continue;
      for (const message of entry.model) {
        if (typeof message !== "object" || message === null) continue;
        const toolMessage = message as {
          role?: unknown;
          toolName?: unknown;
          isError?: unknown;
          details?: unknown;
        };
        if (toolMessage.role !== "toolResult" || toolMessage.isError === true) continue;
        const details = toolMessage.details;
        if (!isJsonObject(details)) continue;

        if (typeof toolMessage.toolName === "string" && FILE_TOOL_NAMES.has(toolMessage.toolName)) {
          const prov = details.provenance;
          if (
            isJsonObject(prov) &&
            typeof prov.absolutePath === "string" &&
            typeof prov.cwd === "string" &&
            prov.absolutePath.trim() &&
            prov.cwd.trim()
          ) {
            addRecord({ absolutePath: prov.absolutePath, cwd: prov.cwd });
          }
        } else if (toolMessage.toolName === "codemode" && Array.isArray(details.nestedProvenance)) {
          for (const item of details.nestedProvenance) {
            if (!isJsonObject(item)) continue;
            if (
              typeof item.tool === "string" &&
              FILE_TOOL_NAMES.has(item.tool) &&
              typeof item.absolutePath === "string" &&
              typeof item.cwd === "string" &&
              item.absolutePath.trim() &&
              item.cwd.trim()
            ) {
              addRecord({ absolutePath: item.absolutePath, cwd: item.cwd });
            }
          }
        }
      }
    }
    if (!page.next) break;
    cursor = page.next;
  }

  const byBasename = new Map<string, string[]>();
  for (const [base, set] of byBasenameMap) {
    byBasename.set(base, [...set]);
  }
  return { list, byCanonical, byBasename };
};

const buildConversationDocContext = async (
  deps: { storage: Storage; harness: Harness; configHome: string },
  conversationId: ConversationId,
  context: Context
): Promise<ConversationDocContext> => {
  const conversationNumber = Number(conversationId);
  const [agent, provenance] = await Promise.all([
    deps.harness.snapshot(AgentDoc, conversationId, context),
    collectProvenance(deps.storage, conversationId, deps.configHome, conversationNumber, context),
  ]);

  let nonWideCwd: string | undefined;
  if (agent?.cwd && !isWideRoot(agent.cwd, deps.configHome)) {
    const canonCwd = safeRealpath(agent.cwd);
    if (canonCwd && !isSecretPath(canonCwd, deps.configHome, conversationNumber)) {
      nonWideCwd = canonCwd;
    }
  }

  const rawScratch = scratchDirFor(deps.configHome, conversationNumber);
  const canonScratch = existsSync(rawScratch) ? safeRealpath(rawScratch) : resolve(rawScratch);

  return {
    conversationId,
    conversationNumber,
    configHome: deps.configHome,
    ...(nonWideCwd ? { nonWideCwd } : {}),
    ...(canonScratch ? { ownScratch: canonScratch } : {}),
    provenanceList: provenance.list,
    provenanceByCanonical: provenance.byCanonical,
    provenanceByBasename: provenance.byBasename,
  };
};

type WalkIndex = Map<string, string[]>;

const buildBoundedProjectIndex = (rootDir: string, configHome: string, conversationNumber: number): WalkIndex => {
  const byBasename = new Map<string, Set<string>>();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];
  let visited = 0;
  const startedAt = Date.now();

  while (queue.length > 0 && visited < WALK_MAX_ENTRIES) {
    if (Date.now() - startedAt > WALK_MAX_MS) break;
    const current = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= WALK_MAX_ENTRIES) break;
      visited += 1;
      const name = entry.name;
      if (name.startsWith(".") || WALK_SKIP_DIRS.has(name)) continue;
      const fullPath = join(current.dir, name);
      if (entry.isDirectory()) {
        if (current.depth < WALK_MAX_DEPTH) {
          const canonDir = safeRealpath(fullPath);
          if (canonDir && isPathInsideOrEqual(canonDir, rootDir) && !isSecretPath(canonDir, configHome, conversationNumber)) {
            queue.push({ dir: canonDir, depth: current.depth + 1 });
          }
        }
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!docKindForPath(name)) continue;
      const canon = safeRealpath(fullPath);
      if (!canon) continue;
      if (!isPathInsideOrEqual(canon, rootDir)) continue;
      if (isSecretPath(fullPath, configHome, conversationNumber) || isSecretPath(canon, configHome, conversationNumber)) {
        continue;
      }
      let set = byBasename.get(name);
      if (!set) {
        set = new Set<string>();
        byBasename.set(name, set);
      }
      set.add(canon);
    }
  }

  const index: WalkIndex = new Map();
  for (const [name, set] of byBasename) {
    index.set(name, [...set]);
  }
  return index;
};

const isCanonicalPathAuthorized = (
  canonicalPath: string,
  ctx: ConversationDocContext,
  logicalPath?: string
): boolean => {
  if (!docKindForPath(canonicalPath)) return false;
  if (isSecretPath(canonicalPath, ctx.configHome, ctx.conversationNumber)) return false;
  if (logicalPath && isSecretPath(logicalPath, ctx.configHome, ctx.conversationNumber)) return false;

  if (ctx.nonWideCwd && isPathInsideOrEqual(canonicalPath, ctx.nonWideCwd)) return true;
  if (ctx.ownScratch && isPathInside(canonicalPath, ctx.ownScratch)) return true;
  if (ctx.provenanceByCanonical.has(canonicalPath)) return true;
  return false;
};

type ResolveOutcome =
  | { status: "ok"; canonicalPath: string }
  | { status: "denied" }
  | { status: "not_found" }
  | { status: "ambiguous" };

const resolveExplicitPath = (
  parsed: Extract<ParsedCandidate, { ok: true }>,
  ctx: ConversationDocContext
): ResolveOutcome => {
  const rawPath = parsed.pathPart;

  if (isExplicitAbsolutePath(rawPath)) {
    const expanded = rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : resolve(rawPath);
    if (isSecretPath(expanded, ctx.configHome, ctx.conversationNumber)) return { status: "denied" };
    const canonical = safeRealpath(expanded);
    if (!canonical) {
      // Never leak file existence outside allowed roots for nonexistent targets.
      const logicalAllowed =
        (ctx.nonWideCwd !== undefined && isPathInsideOrEqual(expanded, ctx.nonWideCwd)) ||
        (ctx.ownScratch !== undefined && isPathInside(expanded, ctx.ownScratch));
      return { status: logicalAllowed ? "not_found" : "denied" };
    }
    if (isSecretPath(canonical, ctx.configHome, ctx.conversationNumber)) return { status: "denied" };
    if (!isCanonicalPathAuthorized(canonical, ctx, expanded)) return { status: "denied" };
    return { status: "ok", canonicalPath: canonical };
  }

  // Relative path with separators / leading `./` or `../`: check `nonWideCwd` and provenance `cwd`s.
  const matched = new Set<string>();
  let sawDenied = false;

  if (ctx.nonWideCwd) {
    const joined = resolve(ctx.nonWideCwd, rawPath);
    if (!isPathInsideOrEqual(joined, ctx.nonWideCwd) || isSecretPath(joined, ctx.configHome, ctx.conversationNumber)) {
      sawDenied = true;
    } else {
      const canonical = safeRealpath(joined);
      if (canonical) {
        if (!isPathInsideOrEqual(canonical, ctx.nonWideCwd) || isSecretPath(canonical, ctx.configHome, ctx.conversationNumber)) {
          sawDenied = true;
        } else {
          matched.add(canonical);
        }
      }
    }
  }

  for (const [canonProv, records] of ctx.provenanceByCanonical) {
    if (isSecretPath(canonProv, ctx.configHome, ctx.conversationNumber)) continue;
    for (const record of records) {
      const joinedFromProv = resolve(record.cwd, rawPath);
      if (isSecretPath(joinedFromProv, ctx.configHome, ctx.conversationNumber)) continue;
      const canonJoined = safeRealpath(joinedFromProv);
      if (canonJoined === canonProv) {
        matched.add(canonProv);
        break;
      }
    }
  }

  if (matched.size > 1) return { status: "ambiguous" };
  if (matched.size === 1) {
    const [only] = matched;
    return { status: "ok", canonicalPath: only! };
  }
  return sawDenied ? { status: "denied" } : { status: "not_found" };
};

const resolveRelativeToBase = (
  parsed: Extract<ParsedCandidate, { ok: true }>,
  baseCanonicalPath: string,
  ctx: ConversationDocContext
): ResolveOutcome => {
  const rawPath = parsed.pathPart;
  if (isExplicitAbsolutePath(rawPath)) {
    return resolveExplicitPath(parsed, ctx);
  }
  const baseDir = dirname(baseCanonicalPath);
  const logicalTarget = resolve(baseDir, rawPath);
  if (isSecretPath(logicalTarget, ctx.configHome, ctx.conversationNumber)) return { status: "denied" };

  // Enforce containment logically before touching disk so probing nonexistent outside paths returns 403, not 404.
  const baseInCwd = ctx.nonWideCwd !== undefined && isPathInsideOrEqual(baseCanonicalPath, ctx.nonWideCwd);
  const baseInScratch = ctx.ownScratch !== undefined && isPathInside(baseCanonicalPath, ctx.ownScratch);
  const logicalAllowed =
    (baseInCwd && ctx.nonWideCwd !== undefined && isPathInsideOrEqual(logicalTarget, ctx.nonWideCwd)) ||
    (baseInScratch && ctx.ownScratch !== undefined && isPathInside(logicalTarget, ctx.ownScratch)) ||
    ctx.provenanceByCanonical.has(logicalTarget);
  if (!logicalAllowed) return { status: "denied" };

  const canonical = safeRealpath(logicalTarget);
  if (!canonical) return { status: "not_found" };
  if (isSecretPath(canonical, ctx.configHome, ctx.conversationNumber)) return { status: "denied" };

  // Re-verify containment after resolving any symlinks on disk.
  if (baseInCwd && ctx.nonWideCwd && isPathInsideOrEqual(canonical, ctx.nonWideCwd)) {
    return { status: "ok", canonicalPath: canonical };
  }
  if (baseInScratch && ctx.ownScratch && isPathInside(canonical, ctx.ownScratch)) {
    return { status: "ok", canonicalPath: canonical };
  }
  if (ctx.provenanceByCanonical.has(canonical)) {
    return { status: "ok", canonicalPath: canonical };
  }
  return { status: "denied" };
};

const resolveCandidateToCanonical = (
  parsed: Extract<ParsedCandidate, { ok: true }>,
  ctx: ConversationDocContext,
  baseCanonicalPath: string | undefined,
  getWalkIndex: () => WalkIndex | undefined
): ResolveOutcome => {
  // (a) Relative to an already-verified open document.
  if (baseCanonicalPath !== undefined) {
    return resolveRelativeToBase(parsed, baseCanonicalPath, ctx);
  }

  // (b) Explicit path (absolute, `~/`, `./`, `../`, or containing path separators).
  if (parsed.isExplicit) {
    return resolveExplicitPath(parsed, ctx);
  }

  // (c) Structured tool provenance from successful `read`/`write`/`edit`/`view` (and nested `codemode`) calls.
  const base = basename(parsed.pathPart);
  const provMatches = ctx.provenanceByBasename.get(base);
  if (provMatches && provMatches.length > 0) {
    if (provMatches.length > 1) return { status: "ambiguous" };
    return { status: "ok", canonicalPath: provMatches[0]! };
  }

  // (d) Bounded project-scope lookup inside non-wide `AgentDoc.cwd`.
  const walkIndex = getWalkIndex();
  if (!walkIndex) return { status: "not_found" };
  const walkMatches = walkIndex.get(base);
  if (!walkMatches || walkMatches.length === 0) return { status: "not_found" };
  if (walkMatches.length > 1) return { status: "ambiguous" };
  return { status: "ok", canonicalPath: walkMatches[0]! };
};

type DescriptorReadResult =
  | {
      ok: true;
      path: string;
      kind: DocumentKind;
      content: string;
      size: number;
      mtimeMs: number;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 413;
      error: string;
    };

/**
 * Descriptor-safe TOCTOU-free read (`D1`): `O_NOFOLLOW | O_NONBLOCK`, `fstatSync().isFile()`,
 * post-open `realpath` + `dev:ino` re-verification, bounded read `<= MAX_DOC_BYTES + 1`,
 * zero NUL bytes, and strict fatal UTF-8 decoding.
 */
const openAndReadVerifiedDocument = (
  canonicalTarget: string,
  ctx: ConversationDocContext
): DescriptorReadResult => {
  const kind = docKindForPath(canonicalTarget);
  if (!kind) {
    return { ok: false, status: 403, error: "Kiln only opens Markdown (.md, .markdown, .mdx) and HTML (.html, .htm) documents." };
  }
  if (!isCanonicalPathAuthorized(canonicalTarget, ctx)) {
    return { ok: false, status: 403, error: "Kiln refused access outside this conversation's allowed folders." };
  }

  const flags =
    fsConstants.O_RDONLY |
    fsConstants.O_NOFOLLOW |
    (typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0);

  let fd: number;
  try {
    fd = openSync(canonicalTarget, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      return { ok: false, status: 403, error: "Kiln refused to follow an unsafe symbolic link." };
    }
    return { ok: false, status: 404, error: "Kiln could not find or open this document." };
  }

  try {
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile()) {
      return { ok: false, status: 403, error: "Kiln only reads regular files for document previews." };
    }
    if (fdStat.size > MAX_DOC_BYTES) {
      return { ok: false, status: 413, error: "This document exceeds the 2 MB preview limit." };
    }

    const postReal = safeRealpath(canonicalTarget);
    if (!postReal) {
      return { ok: false, status: 404, error: "Kiln could not verify this document on disk." };
    }
    const postStat = statSync(postReal);
    if (postStat.dev !== fdStat.dev || postStat.ino !== fdStat.ino) {
      return { ok: false, status: 403, error: "The document changed while Kiln opened it. Try again." };
    }
    if (!isCanonicalPathAuthorized(postReal, ctx)) {
      return { ok: false, status: 403, error: "Kiln refused access outside this conversation's allowed folders." };
    }

    const buf = Buffer.allocUnsafe(MAX_DOC_BYTES + 1);
    let total = 0;
    while (total < MAX_DOC_BYTES + 1) {
      const readBytes = readSync(fd, buf, total, MAX_DOC_BYTES + 1 - total, null);
      if (readBytes === 0) break;
      total += readBytes;
    }
    if (total > MAX_DOC_BYTES) {
      return { ok: false, status: 413, error: "This document exceeds the 2 MB preview limit." };
    }

    const slice = buf.subarray(0, total);
    if (slice.includes(0)) {
      return { ok: false, status: 400, error: "This file appears to be binary and cannot be previewed as text." };
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(slice);
    } catch {
      return { ok: false, status: 400, error: "This file is not valid UTF-8 text." };
    }

    return {
      ok: true,
      path: postReal,
      kind,
      content,
      size: fdStat.size,
      mtimeMs: fdStat.mtimeMs,
    };
  } finally {
    closeSync(fd);
  }
};

const createWalkIndexGetter = (ctx: ConversationDocContext): (() => WalkIndex | undefined) => {
  let cachedWalkIndex: WalkIndex | undefined | null = null;
  return () => {
    if (cachedWalkIndex !== null) return cachedWalkIndex;
    cachedWalkIndex = ctx.nonWideCwd
      ? buildBoundedProjectIndex(ctx.nonWideCwd, ctx.configHome, ctx.conversationNumber)
      : undefined;
    return cachedWalkIndex;
  };
};

const resolveVerifiedBasePath = (
  basePath: string | undefined,
  ctx: ConversationDocContext,
  getWalkIndex: () => WalkIndex | undefined
):
  | { ok: true; baseCanonicalPath: string | undefined }
  | { ok: false; status: 400 | 403 | 404; error: string } => {
  if (basePath === undefined) {
    return { ok: true, baseCanonicalPath: undefined };
  }
  const parsedBase = parseCandidateInput(basePath, MAX_PATH_CHARS);
  if (!parsedBase.ok || !parsedBase.isExplicit) {
    return { ok: false, status: 403, error: "Kiln requires a verified document path as basePath." };
  }
  const baseResolution = resolveCandidateToCanonical(parsedBase, ctx, undefined, getWalkIndex);
  if (baseResolution.status !== "ok") {
    return {
      ok: false,
      status: baseResolution.status === "denied" ? 403 : 404,
      error: "Kiln could not verify the referring document inside this conversation.",
    };
  }
  const baseRead = openAndReadVerifiedDocument(baseResolution.canonicalPath, ctx);
  if (!baseRead.ok) {
    return { ok: false, status: baseRead.status === 413 ? 403 : baseRead.status, error: baseRead.error };
  }
  return { ok: true, baseCanonicalPath: baseRead.path };
};

export const resolveConversationDocuments = async (
  deps: { storage: Storage; harness: Harness; configHome: string },
  conversationId: ConversationId,
  input: { candidates: readonly unknown[]; basePath?: string },
  context: Context
): Promise<
  | { ok: true; resolved: ResolvedConversationDocument[] }
  | { ok: false; status: 400 | 403 | 404; error: string }
> => {
  const ctx = await buildConversationDocContext(deps, conversationId, context);
  const getWalkIndex = createWalkIndexGetter(ctx);
  const baseResult = resolveVerifiedBasePath(input.basePath, ctx, getWalkIndex);
  if (!baseResult.ok) return baseResult;
  const baseCanonicalPath = baseResult.baseCanonicalPath;

  const resolved: ResolvedConversationDocument[] = [];
  const seen = new Set<string>();
  const verifiedByPath = new Map<string, DescriptorReadResult>();

  for (const rawCandidate of input.candidates) {
    const parsed = parseCandidateInput(rawCandidate, MAX_CANDIDATE_CHARS);
    if (!parsed.ok) continue;
    if (seen.has(parsed.raw)) continue;
    seen.add(parsed.raw);

    const outcome = resolveCandidateToCanonical(parsed, ctx, baseCanonicalPath, getWalkIndex);
    if (outcome.status !== "ok") continue;

    let readResult = verifiedByPath.get(outcome.canonicalPath);
    if (!readResult) {
      readResult = openAndReadVerifiedDocument(outcome.canonicalPath, ctx);
      verifiedByPath.set(outcome.canonicalPath, readResult);
    }
    if (!readResult.ok) continue;

    resolved.push({
      candidate: parsed.raw,
      resolvedPath: readResult.path,
      kind: readResult.kind,
      size: readResult.size,
      mtimeMs: readResult.mtimeMs,
    });
  }

  return { ok: true, resolved };
};

export const readConversationDocument = async (
  deps: { storage: Storage; harness: Harness; configHome: string },
  conversationId: ConversationId,
  input: { path: string; basePath?: string },
  context: Context
): Promise<ReadConversationDocumentResult> => {
  const parsedTarget = parseCandidateInput(input.path, MAX_PATH_CHARS);
  if (!parsedTarget.ok) {
    return {
      ok: false,
      status: 403,
      error: "Kiln only opens valid local Markdown or HTML document paths.",
    };
  }

  const ctx = await buildConversationDocContext(deps, conversationId, context);
  const getWalkIndex = createWalkIndexGetter(ctx);
  const baseResult = resolveVerifiedBasePath(input.basePath, ctx, getWalkIndex);
  if (!baseResult.ok) return baseResult;
  const baseCanonicalPath = baseResult.baseCanonicalPath;

  const outcome = resolveCandidateToCanonical(parsedTarget, ctx, baseCanonicalPath, getWalkIndex);
  if (outcome.status === "denied") {
    return {
      ok: false,
      status: 403,
      error: "Kiln refused access outside this conversation's allowed folders or to a protected file.",
    };
  }
  if (outcome.status === "ambiguous") {
    return {
      ok: false,
      status: 403,
      error: "More than one file in this conversation matches that name. Open a more specific path.",
    };
  }
  if (outcome.status === "not_found") {
    return {
      ok: false,
      status: 404,
      error: "Kiln could not find that document inside this conversation.",
    };
  }

  const readResult = openAndReadVerifiedDocument(outcome.canonicalPath, ctx);
  if (!readResult.ok) {
    return { ok: false, status: readResult.status, error: readResult.error };
  }

  return {
    ok: true,
    document: {
      path: readResult.path,
      kind: readResult.kind,
      content: readResult.content,
      size: readResult.size,
      mtimeMs: readResult.mtimeMs,
    },
  };
};
