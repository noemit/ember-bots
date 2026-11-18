import * as React from 'react';
import { isRemoteExpired } from './remoteLifecycle';
import { randomId } from './randomId';
import type { ChatMessage, Instance, Session } from '../types';

export type DocumentKind = 'markdown' | 'html';

export type ResolvedDocumentRef = {
  candidate: string;
  resolvedPath: string;
  kind: DocumentKind;
  size: number;
  mtimeMs: number;
};

export type LoadedConversationDocument = {
  path: string;
  kind: DocumentKind;
  content: string;
  size: number;
  mtimeMs: number;
};

export type ParsedDocCandidate = {
  /** Normalized lookup path without `#fragment` or leading `./`. */
  lookupKey: string;
  /** Exact raw path string (without `#fragment`) sent to Kiln. */
  requestPath: string;
  fragment?: string;
  kind: DocumentKind;
};

const DOC_EXTENSION_REGEX = /\.(md|markdown|mdx|html|htm)$/i;
const DOC_EXTENSION_ANYWHERE_REGEX = /\.(md|markdown|mdx|html|htm)(?![A-Za-z0-9_])/i;
const DOC_TOKEN_ALLOWED = /^(?:~\/|\.{1,2}\/|\/|[A-Za-z0-9_@.-])(?:[^\s"'`<>()[\]{}|*?$]*?)\.(?:md|markdown|mdx|html|htm)$/i;
const DOC_PROSE_PATTERN =
  /(?<![A-Za-z0-9_:/\\@])(?:~\/|\.{1,2}\/|\/)?[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*\.(?:md|markdown|mdx|html|htm)(?:#[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)?/gi;

const EXTERNAL_SCHEME_REGEX = /^(?:https?:|mailto:|tel:|data:|blob:|javascript:|vbscript:|file:|thread:)/i;
const BARE_WEB_HOST_REGEX = /^(?:www\.|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+)/i;

export const MAX_RESOLVE_BATCH = 64;
const MAX_SCOPES = 24;
const MAX_ENTRIES_PER_SCOPE = 400;
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 15_000;
const POPOUT_TTL_MS = 60_000;
const POPOUT_CHANNEL_NAME = 'ember-doc-popout-v1';

export const docKindFromFilename = (filePath: string): DocumentKind | undefined => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  return undefined;
};

export const isExternalWebHref = (href: string | undefined): boolean => {
  if (!href) return false;
  const trimmed = href.trim();
  return /^(?:https?:|mailto:|tel:)/i.test(trimmed) || BARE_WEB_HOST_REGEX.test(trimmed);
};

const hasWhitespaceOrControlChars = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || /\s/.test(value[i]!)) return true;
  }
  return false;
};

export const parseDocCandidate = (rawInput: string): ParsedDocCandidate | null => {
  if (typeof rawInput !== 'string') return null;
  const trimmed = rawInput.trim();
  if (!trimmed || trimmed.length > 512) return null;
  if (hasWhitespaceOrControlChars(trimmed)) return null;
  if (EXTERNAL_SCHEME_REGEX.test(trimmed) || BARE_WEB_HOST_REGEX.test(trimmed)) return null;
  if (trimmed.startsWith('#')) return null;

  let pathPart = trimmed;
  let fragment: string | undefined;
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx > 0) {
    const before = trimmed.slice(0, hashIdx);
    const after = trimmed.slice(hashIdx + 1);
    if (DOC_EXTENSION_REGEX.test(before)) {
      pathPart = before;
      fragment = after || undefined;
    }
  }

  if (!DOC_TOKEN_ALLOWED.test(pathPart)) return null;
  const kind = docKindFromFilename(pathPart);
  if (!kind) return null;

  const lookupKey = pathPart.startsWith('./') && pathPart.length > 2 ? pathPart.slice(2) : pathPart;
  return {
    lookupKey,
    requestPath: pathPart,
    ...(fragment ? { fragment } : {}),
    kind,
  };
};

export type DocTextToken =
  | { type: 'text'; value: string }
  | { type: 'doc'; value: string; candidate: ParsedDocCandidate };

export const tokenizeProseDocCandidates = (text: string): DocTextToken[] => {
  if (!DOC_EXTENSION_ANYWHERE_REGEX.test(text)) return [{ type: 'text', value: text }];
  const tokens: DocTextToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(DOC_PROSE_PATTERN)) {
    const start = match.index ?? 0;
    const raw = match[0];
    // Avoid catching URLs like `https://example.com/foo.html` or `www.example.com/a.html`.
    const prefix = text.slice(Math.max(0, start - 128), start);
    if (/https?:\/\/\S*$|www\.\S*$/i.test(prefix)) continue;
    const parsed = parseDocCandidate(raw);
    if (!parsed) continue;
    if (start > cursor) {
      tokens.push({ type: 'text', value: text.slice(cursor, start) });
    }
    tokens.push({ type: 'doc', value: raw, candidate: parsed });
    cursor = start + raw.length;
  }
  if (cursor === 0) return [{ type: 'text', value: text }];
  if (cursor < text.length) tokens.push({ type: 'text', value: text.slice(cursor) });
  return tokens;
};

// ---- Bounded LRU + TTL cache & batched resolver store ----------------------------------

type CacheEntry = {
  resolved: ResolvedDocumentRef | null;
  expiresAt: number;
};

type ScopeState = {
  instanceId: string;
  sessionId: string;
  entries: Map<string, CacheEntry>;
  pendingCandidates: Set<string>;
  inFlight: Set<string>;
  scheduledFlush: boolean;
  generation: number;
  version: number;
  lastUsedAt: number;
};

const scopeKey = (instanceId: string, sessionId: string): string => `${instanceId}\u0000${sessionId}`;

const scopes = new Map<string, ScopeState>();
const unsupportedHosts = new Set<string>();
const listeners = new Set<() => void>();
let globalStoreVersion = 0;

const emitStoreChange = (): void => {
  globalStoreVersion += 1;
  for (const listener of [...listeners]) {
    listener();
  }
};

const touchScope = (instanceId: string, sessionId: string): ScopeState => {
  const key = scopeKey(instanceId, sessionId);
  let state = scopes.get(key);
  if (state) {
    // Refresh insertion order for scope-level LRU.
    scopes.delete(key);
    scopes.set(key, state);
    state.lastUsedAt = Date.now();
    return state;
  }
  if (scopes.size >= MAX_SCOPES) {
    const oldestKey = scopes.keys().next().value;
    if (oldestKey !== undefined) scopes.delete(oldestKey);
  }
  state = {
    instanceId,
    sessionId,
    entries: new Map(),
    pendingCandidates: new Set(),
    inFlight: new Set(),
    scheduledFlush: false,
    generation: 0,
    version: 0,
    lastUsedAt: Date.now(),
  };
  scopes.set(key, state);
  return state;
};

const setCachedEntry = (state: ScopeState, key: string, entry: CacheEntry): boolean => {
  const prev = state.entries.get(key);
  state.entries.delete(key);
  if (state.entries.size >= MAX_ENTRIES_PER_SCOPE) {
    const oldest = state.entries.keys().next().value;
    if (oldest !== undefined) state.entries.delete(oldest);
  }
  state.entries.set(key, entry);
  return prev?.resolved?.resolvedPath !== entry.resolved?.resolvedPath;
};

const getCachedEntry = (state: ScopeState, candidateKey: string, now = Date.now()): CacheEntry | undefined => {
  const entry = state.entries.get(candidateKey);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    state.entries.delete(candidateKey);
    return undefined;
  }
  // LRU bump on access
  state.entries.delete(candidateKey);
  state.entries.set(candidateKey, entry);
  return entry;
};

export const isHostDocumentResolveSupported = (instanceId: string): boolean => !unsupportedHosts.has(instanceId);

export const invalidateSessionDocuments = (instanceId: string, sessionId?: string): void => {
  if (sessionId !== undefined) {
    const state = scopes.get(scopeKey(instanceId, sessionId));
    if (!state) return;
    state.generation += 1;
    state.entries.clear();
    state.inFlight.clear();
    state.version += 1;
    emitStoreChange();
    return;
  }
  let changed = false;
  for (const state of scopes.values()) {
    if (state.instanceId === instanceId) {
      state.generation += 1;
      state.entries.clear();
      state.inFlight.clear();
      state.version += 1;
      changed = true;
    }
  }
  if (changed) emitStoreChange();
};

const flushScopeQueue = async (instanceId: string, sessionId: string): Promise<void> => {
  const state = scopes.get(scopeKey(instanceId, sessionId));
  if (!state) return;
  state.scheduledFlush = false;
  if (unsupportedHosts.has(instanceId) || state.pendingCandidates.size === 0) return;

  const piRequest = typeof window !== 'undefined' ? window.ember?.piRequest : undefined;
  if (!piRequest) return;

  const batchList = [...state.pendingCandidates].filter(
    (candidate) => !state.inFlight.has(candidate) && !getCachedEntry(state, candidate)
  );
  state.pendingCandidates.clear();
  if (batchList.length === 0) return;

  const generationAtStart = state.generation;
  for (const candidate of batchList) state.inFlight.add(candidate);

  const chunks: string[][] = [];
  for (let i = 0; i < batchList.length; i += MAX_RESOLVE_BATCH) {
    chunks.push(batchList.slice(i, i + MAX_RESOLVE_BATCH));
  }

  try {
    await Promise.all(
      chunks.map(async (candidates) => {
        try {
          const response = await piRequest<{ resolved?: ResolvedDocumentRef[]; error?: string }>(
            instanceId,
            `/conversations/${encodeURIComponent(sessionId)}/documents/resolve`,
            { method: 'POST', body: { candidates } }
          );

          if (!response.ok) {
            const errText = typeof response.data?.error === 'string' ? response.data.error : '';
            // Legacy hosts answer 404/405/501 when the document endpoints do not exist.
            // Only distinguish "conversation missing" so a deleted chat does not poison a modern host.
            const isMissingConversation =
              response.status === 404 && /there is no conversation/i.test(errText);
            if ((response.status === 404 || response.status === 405 || response.status === 501) && !isMissingConversation) {
              unsupportedHosts.add(instanceId);
              emitStoreChange();
            }
            return;
          }

          if (state.generation !== generationAtStart) return;
          const resolvedList = Array.isArray(response.data?.resolved) ? response.data.resolved : [];
          const resolvedByCandidate = new Map<string, ResolvedDocumentRef>();
          for (const item of resolvedList) {
            if (item && typeof item.candidate === 'string' && typeof item.resolvedPath === 'string') {
              resolvedByCandidate.set(item.candidate, item);
            }
          }

          const now = Date.now();
          let changed = false;
          for (const candidate of candidates) {
            const hit = resolvedByCandidate.get(candidate) ?? null;
            const entry: CacheEntry = {
              resolved: hit,
              expiresAt: now + (hit ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
            };
            if (setCachedEntry(state, candidate, entry)) changed = true;
          }
          if (changed) {
            state.version += 1;
            emitStoreChange();
          }
        } catch {
          // Transient transport errors leave links as plain text without surfacing noise.
        }
      })
    );
  } finally {
    for (const candidate of batchList) state.inFlight.delete(candidate);
  }
};

export const enqueueDocumentCandidates = (
  instanceId: string,
  sessionId: string,
  candidates: readonly string[]
): void => {
  if (!instanceId || !sessionId || unsupportedHosts.has(instanceId) || candidates.length === 0) return;
  const state = touchScope(instanceId, sessionId);
  const now = Date.now();
  let added = false;
  for (const raw of candidates) {
    const parsed = parseDocCandidate(raw);
    if (!parsed) continue;
    const key = parsed.requestPath;
    if (state.inFlight.has(key) || getCachedEntry(state, key, now)) continue;
    state.pendingCandidates.add(key);
    added = true;
  }
  if (added && !state.scheduledFlush) {
    state.scheduledFlush = true;
    queueMicrotask(() => {
      void flushScopeQueue(instanceId, sessionId);
    });
  }
};

export const lookupCachedDocument = (
  instanceId: string,
  sessionId: string,
  rawCandidate: string
): { resolved: ResolvedDocumentRef; fragment?: string } | null => {
  if (!instanceId || !sessionId || unsupportedHosts.has(instanceId)) return null;
  const parsed = parseDocCandidate(rawCandidate);
  if (!parsed) return null;
  const state = scopes.get(scopeKey(instanceId, sessionId));
  if (!state) return null;
  const hit = getCachedEntry(state, parsed.requestPath);
  if (!hit?.resolved) return null;
  return {
    resolved: hit.resolved,
    ...(parsed.fragment ? { fragment: parsed.fragment } : {}),
  };
};

// ---- Active Document Preview State & Safe Popout Handoff -------------------------------

export type ActiveDocumentPreviewState =
  | { open: false }
  | {
      open: true;
      instanceId: string;
      hostLabel: string;
      sessionId: string;
      requestedPath: string;
      basePath?: string;
      fragment?: string;
      loading: boolean;
      document: LoadedConversationDocument | null;
      error: string | null;
      history: Array<{ path: string; fragment?: string }>;
    };

let activePreview: ActiveDocumentPreviewState = { open: false };
let activeLoadSeq = 0;

type PopoutPayload = {
  instanceId: string;
  hostLabel: string;
  sessionId: string;
  document: LoadedConversationDocument;
  fragment?: string;
  createdAt: number;
};

const pendingPopouts = new Map<string, PopoutPayload>();
let popoutChannel: BroadcastChannel | null = null;

const getPopoutChannel = (): BroadcastChannel | null => {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!popoutChannel) {
    popoutChannel = new BroadcastChannel(POPOUT_CHANNEL_NAME);
    popoutChannel.onmessage = (event) => {
      const msg = event.data as { type?: unknown; popoutId?: unknown } | null;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'request' && typeof msg.popoutId === 'string') {
        const popoutId = msg.popoutId;
        const entry = pendingPopouts.get(popoutId);
        if (!entry || Date.now() - entry.createdAt > POPOUT_TTL_MS) {
          pendingPopouts.delete(popoutId);
          return;
        }
        // Keep briefly for React StrictMode double-mount, then drop from parent memory;
        // logout/session-expiry clears `pendingPopouts` synchronously.
        setTimeout(() => {
          pendingPopouts.delete(popoutId);
        }, 5_000);
        popoutChannel?.postMessage({ type: 'payload', popoutId, payload: entry });
      }
    };
  }
  return popoutChannel;
};

export const readConversationDocumentViaBridge = async (
  instanceId: string,
  sessionId: string,
  path: string,
  hostLabel: string,
  basePath?: string
): Promise<{ ok: true; document: LoadedConversationDocument } | { ok: false; error: string }> => {
  const piRequest = typeof window !== 'undefined' ? window.ember?.piRequest : undefined;
  if (!piRequest) {
    return { ok: false, error: `${hostLabel} cannot open "${path}" because the desktop or remote bridge is unavailable.` };
  }
  try {
    const response = await piRequest<LoadedConversationDocument & { error?: string }>(
      instanceId,
      `/conversations/${encodeURIComponent(sessionId)}/documents/read`,
      {
        method: 'POST',
        body: {
          path,
          ...(basePath ? { basePath } : {}),
        },
      }
    );
    if (!response.ok || typeof response.data?.content !== 'string' || typeof response.data?.path !== 'string') {
      const detail = typeof response.data?.error === 'string' && response.data.error.trim()
        ? response.data.error.trim()
        : 'It may have been moved, deleted, or excluded by host security rules.';
      return {
        ok: false,
        error: `${hostLabel} could not read "${path}". ${detail}`,
      };
    }
    return {
      ok: true,
      document: {
        path: response.data.path,
        kind: response.data.kind === 'html' ? 'html' : 'markdown',
        content: response.data.content,
        size: Number(response.data.size) || response.data.content.length,
        mtimeMs: Number(response.data.mtimeMs) || Date.now(),
      },
    };
  } catch {
    return {
      ok: false,
      error: `${hostLabel} could not read "${path}". Check that the host is reachable and try Refresh.`,
    };
  }
};

export const openDocumentPreview = async (options: {
  instanceId: string;
  hostLabel: string;
  sessionId: string;
  path: string;
  basePath?: string;
  fragment?: string;
  pushHistory?: boolean;
}): Promise<void> => {
  const seq = ++activeLoadSeq;
  const previousHistory =
    options.pushHistory && activePreview.open
      ? [
          ...activePreview.history,
          { path: activePreview.document?.path ?? activePreview.requestedPath, fragment: activePreview.fragment },
        ]
      : activePreview.open && options.pushHistory !== false && options.basePath
        ? activePreview.history
        : [];

  activePreview = {
    open: true,
    instanceId: options.instanceId,
    hostLabel: options.hostLabel,
    sessionId: options.sessionId,
    requestedPath: options.path,
    basePath: options.basePath,
    fragment: options.fragment,
    loading: true,
    document: activePreview.open && !options.basePath ? activePreview.document : null,
    error: null,
    history: previousHistory,
  };
  emitStoreChange();

  const result = await readConversationDocumentViaBridge(
    options.instanceId,
    options.sessionId,
    options.path,
    options.hostLabel,
    options.basePath
  );
  if (seq !== activeLoadSeq) return;

  if (!result.ok) {
    activePreview = {
      open: true,
      instanceId: options.instanceId,
      hostLabel: options.hostLabel,
      sessionId: options.sessionId,
      requestedPath: options.path,
      basePath: options.basePath,
      fragment: options.fragment,
      loading: false,
      document: null,
      error: result.error,
      history: previousHistory,
    };
    emitStoreChange();
    return;
  }

  activePreview = {
    open: true,
    instanceId: options.instanceId,
    hostLabel: options.hostLabel,
    sessionId: options.sessionId,
    requestedPath: result.document.path,
    fragment: options.fragment,
    loading: false,
    document: result.document,
    error: null,
    history: previousHistory,
  };
  emitStoreChange();
};

export const refreshActiveDocumentPreview = async (): Promise<void> => {
  if (!activePreview.open) return;
  invalidateSessionDocuments(activePreview.instanceId, activePreview.sessionId);
  await openDocumentPreview({
    instanceId: activePreview.instanceId,
    hostLabel: activePreview.hostLabel,
    sessionId: activePreview.sessionId,
    path: activePreview.document?.path ?? activePreview.requestedPath,
    fragment: activePreview.fragment,
  });
};

export const navigateBackDocumentPreview = async (): Promise<void> => {
  if (!activePreview.open || activePreview.history.length === 0) return;
  const nextHistory = activePreview.history.slice(0, -1);
  const target = activePreview.history[activePreview.history.length - 1]!;
  activePreview = { ...activePreview, history: nextHistory };
  await openDocumentPreview({
    instanceId: activePreview.instanceId,
    hostLabel: activePreview.hostLabel,
    sessionId: activePreview.sessionId,
    path: target.path,
    fragment: target.fragment,
  });
};

export const closeDocumentPreview = (): void => {
  activeLoadSeq += 1;
  if (!activePreview.open) return;
  activePreview = { open: false };
  emitStoreChange();
};

export type PopoutDocumentPointer = {
  instanceId: string;
  hostLabel: string;
  sessionId: string;
  path: string;
  fragment?: string;
};

const encodePointerHash = (ptr: PopoutDocumentPointer): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(ptr));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return encodeURIComponent(btoa(binary));
};

export const decodePopoutPointerFromLocation = (loc: { search: string; hash: string }): {
  isPopout: boolean;
  popoutId: string | null;
  pointer: PopoutDocumentPointer | null;
} => {
  const params = new URLSearchParams(loc.search);
  const isPopout = params.get('docPopout') === '1';
  const popoutId = params.get('popoutId');
  if (!isPopout) return { isPopout: false, popoutId: null, pointer: null };

  const hash = loc.hash.startsWith('#') ? loc.hash.slice(1) : loc.hash;
  const hashParams = new URLSearchParams(hash);
  const rawPtr = hashParams.get('ptr');
  if (!rawPtr) return { isPopout: true, popoutId, pointer: null };

  try {
    const decoded = atob(decodeURIComponent(rawPtr));
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (
      typeof parsed.instanceId === 'string' &&
      typeof parsed.sessionId === 'string' &&
      typeof parsed.path === 'string'
    ) {
      return {
        isPopout: true,
        popoutId,
        pointer: {
          instanceId: parsed.instanceId,
          hostLabel: typeof parsed.hostLabel === 'string' && parsed.hostLabel.trim() ? parsed.hostLabel : parsed.instanceId,
          sessionId: parsed.sessionId,
          path: parsed.path,
          ...(typeof parsed.fragment === 'string' && parsed.fragment ? { fragment: parsed.fragment } : {}),
        },
      };
    }
  } catch {
    // Malformed popout pointer
  }
  return { isPopout: true, popoutId, pointer: null };
};

export const openDocumentInPopoutWindow = (options: {
  instanceId: string;
  hostLabel: string;
  sessionId: string;
  document: LoadedConversationDocument;
  fragment?: string;
}): Window | null => {
  if (typeof window === 'undefined') return null;
  if (isRemoteExpired()) return null;

  const popoutId = `popout_${randomId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const now = Date.now();
  // Prune stale popouts
  for (const [id, entry] of pendingPopouts) {
    if (now - entry.createdAt > POPOUT_TTL_MS) pendingPopouts.delete(id);
  }
  pendingPopouts.set(popoutId, {
    instanceId: options.instanceId,
    hostLabel: options.hostLabel,
    sessionId: options.sessionId,
    document: options.document,
    fragment: options.fragment,
    createdAt: now,
  });
  getPopoutChannel();

  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('docPopout', '1');
  url.searchParams.set('popoutId', popoutId);
  const pointerHash = encodePointerHash({
    instanceId: options.instanceId,
    hostLabel: options.hostLabel,
    sessionId: options.sessionId,
    path: options.document.path,
    ...(options.fragment ? { fragment: options.fragment } : {}),
  });
  url.hash = `ptr=${pointerHash}`;

  return window.open(url.toString(), '_blank', 'noopener,noreferrer');
};

const popoutInFlightRequests = new Map<string, Promise<PopoutPayload | null>>();

export const requestPopoutInitialPayload = (
  popoutId: string,
  timeoutMs = 250
): Promise<PopoutPayload | null> => {
  if (!popoutId) return Promise.resolve(null);
  const existing = popoutInFlightRequests.get(popoutId);
  if (existing) return existing;

  const promise = new Promise<PopoutPayload | null>((resolve) => {
    const channel = getPopoutChannel();
    if (!channel) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (payload: PopoutPayload | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      channel.removeEventListener('message', onMessage);
      resolve(payload);
    };
    const onMessage = (event: MessageEvent) => {
      const msg = event.data as { type?: unknown; popoutId?: unknown; payload?: PopoutPayload } | null;
      if (msg?.type === 'payload' && msg.popoutId === popoutId && msg.payload) {
        finish(msg.payload);
      }
    };
    channel.addEventListener('message', onMessage);
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    channel.postMessage({ type: 'request', popoutId });
  });
  popoutInFlightRequests.set(popoutId, promise);
  return promise;
};

export const clearDocumentExplorationState = (): void => {
  scopes.clear();
  unsupportedHosts.clear();
  pendingPopouts.clear();
  popoutInFlightRequests.clear();
  activeLoadSeq += 1;
  activePreview = { open: false };
  try {
    getPopoutChannel()?.postMessage({ type: 'logout-wipe' });
  } catch {
    // Ignore channel errors on teardown
  }
  emitStoreChange();
};

export const subscribePopoutLogoutWipe = (onWipe: () => void): (() => void) => {
  const channel = getPopoutChannel();
  const handleChannel = (event: MessageEvent) => {
    const msg = event.data as { type?: unknown } | null;
    if (msg?.type === 'logout-wipe') onWipe();
  };
  channel?.addEventListener('message', handleChannel);
  window.addEventListener('ember:session-expired', onWipe);
  return () => {
    channel?.removeEventListener('message', handleChannel);
    window.removeEventListener('ember:session-expired', onWipe);
  };
};

// Install global session-expiration cleanup in browser contexts.
if (typeof window !== 'undefined') {
  window.addEventListener('ember:session-expired', clearDocumentExplorationState);
  window.addEventListener('ember:remote-connection', (event: Event) => {
    if ((event as CustomEvent<{ state?: string }>).detail?.state === 'expired') {
      clearDocumentExplorationState();
    }
  });
}

// ---- React Context & Hooks -------------------------------------------------------------

export type DocumentExplorationContextValue = {
  instanceId: string;
  hostLabel: string;
  sessionId: string;
  supported: boolean;
  lookup: (rawCandidate: string) => { resolved: ResolvedDocumentRef; fragment?: string } | null;
  requestResolve: (rawCandidates: readonly string[]) => void;
  openDocument: (path: string, fragment?: string, basePath?: string) => void;
  openResolved: (resolved: ResolvedDocumentRef, fragment?: string) => void;
};

export const DocumentExplorationContext = React.createContext<DocumentExplorationContextValue | null>(null);

export const useDocumentExploration = (): DocumentExplorationContextValue | null =>
  React.useContext(DocumentExplorationContext);

export const useDocumentStoreVersion = (): number =>
  React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => globalStoreVersion,
    () => 0
  );

export const useActiveDocumentPreview = (): ActiveDocumentPreviewState =>
  React.useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => activePreview,
    () => ({ open: false } as const)
  );

const extractCandidatesFromMessages = (messages: readonly ChatMessage[]): string[] => {
  const candidates = new Set<string>();
  const addFromText = (text: string) => {
    if (!DOC_EXTENSION_ANYWHERE_REGEX.test(text)) return;
    // Inline code backticks
    for (const match of text.matchAll(/`([^`\r\n]{1,512})`/g)) {
      const parsed = parseDocCandidate(match[1]!);
      if (parsed) candidates.add(parsed.requestPath);
    }
    // Markdown link targets `[label](target)`
    for (const match of text.matchAll(/\]\(([^)\s]{1,512})\)/g)) {
      const parsed = parseDocCandidate(match[1]!);
      if (parsed) candidates.add(parsed.requestPath);
    }
    // Bare prose doc tokens
    for (const token of tokenizeProseDocCandidates(text)) {
      if (token.type === 'doc') candidates.add(token.candidate.requestPath);
    }
  };

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'text' && typeof part.text === 'string') {
        addFromText(part.text);
      }
    }
  }
  return [...candidates];
};

type ProviderProps = {
  instance: Instance | null;
  session: Session | null;
  messages: readonly ChatMessage[];
  reloadEpoch?: number;
  children: React.ReactNode;
};

export function DocumentExplorationProvider({
  instance,
  session,
  messages,
  reloadEpoch = 0,
  children,
}: ProviderProps) {
  const storeVersion = useDocumentStoreVersion();
  const instanceId = instance?.id ?? '';
  const hostLabel = instance?.label ?? instanceId ?? 'Host';
  const sessionId = session?.id ?? '';
  const enabled = Boolean(instance && instance.kind === 'pi' && session && sessionId);

  // Invalidate cache when conversation opens or manually reloads.
  React.useEffect(() => {
    if (!enabled) return;
    invalidateSessionDocuments(instanceId, sessionId);
  }, [enabled, instanceId, sessionId, reloadEpoch]);

  // Invalidate cache on tool completion / message completion events for this session.
  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !window.ember?.onEvent) return;
    return window.ember.onEvent((rawEvent) => {
      const event = rawEvent as { type?: unknown; instanceId?: unknown; sessionId?: unknown } | null;
      if (!event || typeof event !== 'object') return;
      if (event.instanceId !== instanceId) return;
      if (event.type !== 'pi:message_end' && event.type !== 'pi:tool_execution_update') return;
      if (event.sessionId !== undefined && event.sessionId !== sessionId) return;
      invalidateSessionDocuments(instanceId, sessionId);
    });
  }, [enabled, instanceId, sessionId]);

  const extractedCandidates = React.useMemo(
    () => (enabled ? extractCandidatesFromMessages(messages) : []),
    [enabled, messages]
  );

  // Enqueue candidates when transcript updates OR after cache invalidation bumps storeVersion.
  React.useEffect(() => {
    if (!enabled || extractedCandidates.length === 0) return;
    enqueueDocumentCandidates(instanceId, sessionId, extractedCandidates);
  }, [enabled, instanceId, sessionId, extractedCandidates, storeVersion]);

  const supported = enabled && isHostDocumentResolveSupported(instanceId);

  const value = React.useMemo<DocumentExplorationContextValue | null>(() => {
    if (!enabled) return null;
    void storeVersion;
    return {
      instanceId,
      hostLabel,
      sessionId,
      supported,
      lookup: (rawCandidate: string) => lookupCachedDocument(instanceId, sessionId, rawCandidate),
      requestResolve: (rawCandidates: readonly string[]) => {
        enqueueDocumentCandidates(instanceId, sessionId, rawCandidates);
      },
      openDocument: (path: string, fragment?: string, basePath?: string) => {
        void openDocumentPreview({
          instanceId,
          hostLabel,
          sessionId,
          path,
          ...(basePath ? { basePath } : {}),
          ...(fragment ? { fragment } : {}),
        });
      },
      openResolved: (resolved: ResolvedDocumentRef, fragment?: string) => {
        void openDocumentPreview({
          instanceId,
          hostLabel,
          sessionId,
          path: resolved.resolvedPath,
          ...(fragment ? { fragment } : {}),
        });
      },
    };
  }, [enabled, instanceId, hostLabel, sessionId, supported, storeVersion]);

  return React.createElement(DocumentExplorationContext.Provider, { value }, children);
}
