import * as React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Element, Root } from 'hast';
import {
  ArrowLeft,
  Check,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  FileText,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import {
  closeDocumentPreview,
  decodePopoutPointerFromLocation,
  isExternalWebHref,
  navigateBackDocumentPreview,
  openDocumentInPopoutWindow,
  openDocumentPreview,
  parseDocCandidate,
  readConversationDocumentViaBridge,
  refreshActiveDocumentPreview,
  requestPopoutInitialPayload,
  subscribePopoutLogoutWipe,
  useActiveDocumentPreview,
  type LoadedConversationDocument,
} from '@/lib/documentExploration';
import {
  buildHtmlScriptNoticePrompts,
  isSafeRasterDataImageUrl,
  MAX_MARKDOWN_RENDER_BYTES,
  sanitizeStaticHtml,
} from '@/lib/staticHtmlPreview';

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

const collectElementText = (node: Element): string =>
  node.children
    .map((child) => {
      if (child.type === 'text') return child.value;
      if (child.type === 'element') return collectElementText(child);
      return '';
    })
    .join('');

export const slugifyMarkdownHeading = (text: string): string =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';

/**
 * Deterministic `user-content-` heading slug plugin matching GitHub fragment anchors while
 * remaining pure across React strict-mode renders.
 */
const rehypeUserContentHeadingSlugs = () => (tree: Root) => {
  const counts = new Map<string, number>();
  const visit = (node: Root | Element): void => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      if (HEADING_TAGS.has(child.tagName)) {
        const base = slugifyMarkdownHeading(collectElementText(child));
        const seen = counts.get(base) ?? 0;
        counts.set(base, seen + 1);
        const unique = seen === 0 ? base : `${base}-${seen}`;
        child.properties = {
          ...(child.properties ?? {}),
          id: `user-content-${unique}`,
        };
      }
      visit(child);
    }
  };
  visit(tree);
};

const markdownRehypePlugins = [rehypeUserContentHeadingSlugs];
const markdownRemarkPlugins = [remarkGfm];

const markdownHasExternalImages = (markdown: string): boolean => {
  if (!/https?:\/\//i.test(markdown)) return false;
  return /!\[[^\]]*\]\(\s*<?https?:\/\/[^)\s]+/i.test(markdown);
};

const utf8ByteSize = (text: string): number => new TextEncoder().encode(text).byteLength;

const basenameOfPath = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) || 'document.txt' : normalized || 'document.txt';
};

const triggerSafeBlobDownload = (content: string, filename: string): void => {
  if (typeof document === 'undefined') return;
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  link.rel = 'noopener noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
  }, 0);
};

type SurfaceProps = {
  hostLabel: string;
  path: string;
  loading: boolean;
  document: LoadedConversationDocument | null;
  error: string | null;
  fragment?: string;
  canGoBack?: boolean;
  onBack?: () => void;
  onRefresh: () => void;
  onOpenRelativeDoc: (href: string, fragment?: string) => void;
  onPopout?: () => void;
  isPopoutWindow?: boolean;
};

export function DocumentPreviewSurface({
  hostLabel,
  path,
  loading,
  document: loadedDoc,
  error,
  fragment,
  canGoBack = false,
  onBack,
  onRefresh,
  onOpenRelativeDoc,
  onPopout,
  isPopoutWindow = false,
}: SurfaceProps) {
  const [viewMode, setViewMode] = React.useState<'rendered' | 'source'>('rendered');
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const [showExternalImages, setShowExternalImages] = React.useState(false);
  const [activeFragment, setActiveFragment] = React.useState<string | undefined>(fragment);
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    setActiveFragment(fragment);
  }, [fragment, loadedDoc?.path]);

  React.useEffect(() => {
    setShowExternalImages(false);
  }, [loadedDoc?.path, loadedDoc?.mtimeMs]);

  React.useEffect(() => {
    if (!copiedKey) return;
    const timer = window.setTimeout(() => setCopiedKey(null), 1800);
    return () => window.clearTimeout(timer);
  }, [copiedKey]);

  const handleCopy = React.useCallback(async (key: string, text: string) => {
    const ok = await copyText(text);
    if (ok) setCopiedKey(key);
  }, []);

  const markdownByteCount = React.useMemo(
    () => (loadedDoc?.kind === 'markdown' ? utf8ByteSize(loadedDoc.content) : 0),
    [loadedDoc]
  );

  const markdownTooLarge =
    loadedDoc?.kind === 'markdown' && markdownByteCount > MAX_MARKDOWN_RENDER_BYTES;

  const htmlAnalysis = React.useMemo(
    () => (loadedDoc?.kind === 'html' ? sanitizeStaticHtml(loadedDoc.content) : null),
    [loadedDoc]
  );

  const forcedSourceReason = markdownTooLarge
    ? 'This Markdown document exceeds 512 KB, so Ember opened it directly in Source view.'
    : htmlAnalysis?.fallbackToSource
      ? htmlAnalysis.fallbackReason ?? 'This HTML document exceeded the complexity limit, so Ember opened it in Source view.'
      : null;

  const effectiveMode: 'rendered' | 'source' = forcedSourceReason ? 'source' : viewMode;

  const hasExternalMdImages = React.useMemo(
    () => (loadedDoc?.kind === 'markdown' ? markdownHasExternalImages(loadedDoc.content) : false),
    [loadedDoc]
  );

  const scrollToFragment = React.useCallback((rawFrag: string) => {
    const container = scrollContainerRef.current;
    if (!container || !rawFrag) return;
    const cleaned = decodeURIComponent(rawFrag.replace(/^#/, '')).trim().toLowerCase();
    if (!cleaned) return;
    const targetId = cleaned.startsWith('user-content-') ? cleaned : `user-content-${cleaned}`;
    const headings = container.querySelectorAll('[id]');
    for (const el of Array.from(headings)) {
      const id = el.getAttribute('id')?.toLowerCase();
      if (id === targetId || id === cleaned) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
  }, []);

  React.useEffect(() => {
    if (
      effectiveMode === 'rendered' &&
      loadedDoc?.kind === 'markdown' &&
      activeFragment
    ) {
      const timer = window.setTimeout(() => scrollToFragment(activeFragment), 20);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [effectiveMode, loadedDoc, activeFragment, scrollToFragment]);

  const markdownComponents = React.useMemo<Components>(() => ({
    a: ({ node: _node, href, children, ...props }) => {
      if (typeof href === 'string' && href.startsWith('#')) {
        return (
          <a
            {...props}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              setActiveFragment(href.slice(1));
              scrollToFragment(href);
            }}
            className="cursor-pointer underline decoration-current/50 underline-offset-2 hover:decoration-current"
          >
            {children}
          </a>
        );
      }
      if (typeof href === 'string' && isExternalWebHref(href)) {
        return (
          <a
            {...props}
            href={href}
            title={href}
            onClick={(event) => {
              event.preventDefault();
              void window.ember?.openExternal(href);
            }}
            className="cursor-pointer break-all underline decoration-current/50 underline-offset-2 hover:decoration-current"
          >
            {children}
          </a>
        );
      }
      if (typeof href === 'string' && parseDocCandidate(href)) {
        const parsed = parseDocCandidate(href)!;
        return (
          <a
            {...props}
            href={href}
            title={`Open ${parsed.requestPath} via ${hostLabel}`}
            onClick={(event) => {
              event.preventDefault();
              onOpenRelativeDoc(parsed.requestPath, parsed.fragment);
            }}
            className="cursor-pointer break-all underline decoration-current/50 underline-offset-2 hover:decoration-current"
          >
            {children}
          </a>
        );
      }
      return (
        <span className="text-muted-foreground" title={href ? `Link blocked in preview: ${href}` : undefined}>
          {children}
        </span>
      );
    },
    img: ({ node: _node, src, alt, ...props }) => {
      const srcStr = typeof src === 'string' ? src.trim() : '';
      if (srcStr && isSafeRasterDataImageUrl(srcStr)) {
        return (
          <img
            {...props}
            src={srcStr}
            alt={alt ?? ''}
            className="my-2 max-h-96 max-w-full rounded-md border border-border/60"
          />
        );
      }
      if (srcStr && /^https?:\/\//i.test(srcStr) && showExternalImages) {
        return (
          <img
            {...props}
            src={srcStr}
            alt={alt ?? ''}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="my-2 max-h-96 max-w-full rounded-md border border-border/60"
          />
        );
      }
      return (
        <span
          data-blocked-md-image="true"
          className="my-1 inline-flex items-center rounded border border-border/70 bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
        >
          {alt ? `[Hidden image: ${alt}]` : '[Image hidden in preview]'}
        </span>
      );
    },
  }), [hostLabel, onOpenRelativeDoc, scrollToFragment, showExternalImages]);

  const prompts = React.useMemo(
    () => buildHtmlScriptNoticePrompts(hostLabel, loadedDoc?.path ?? path),
    [hostLabel, loadedDoc?.path, path]
  );

  const displayedPath = loadedDoc?.path ?? path;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground" data-testid="document-preview-surface">
      <div className={cn('flex flex-none flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5', !isPopoutWindow && 'pr-12')}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {canGoBack && onBack ? (
            <Button type="button" variant="ghost" size="icon-xs" onClick={onBack} aria-label="Previous document">
              <ArrowLeft className="size-3.5" />
            </Button>
          ) : null}
          {loadedDoc?.kind === 'html' ? (
            <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <FileText className="size-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                {hostLabel}
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground" title={displayedPath} data-testid="document-preview-path">
                {displayedPath}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => void handleCopy('path', displayedPath)}
                aria-label="Copy path"
                title="Copy file path"
              >
                {copiedKey === 'path' ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
                <span>{copiedKey === 'path' ? 'Copied' : 'Copy path'}</span>
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {loadedDoc ? (
            <div className="inline-flex items-center rounded-md border bg-muted/40 p-0.5" role="group" aria-label="View mode">
              <Button
                type="button"
                variant={effectiveMode === 'rendered' ? 'secondary' : 'ghost'}
                size="xs"
                disabled={Boolean(forcedSourceReason)}
                onClick={() => setViewMode('rendered')}
                aria-pressed={effectiveMode === 'rendered'}
              >
                <Eye className="size-3" />
                <span>Rendered</span>
              </Button>
              <Button
                type="button"
                variant={effectiveMode === 'source' ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setViewMode('source')}
                aria-pressed={effectiveMode === 'source'}
              >
                <Code2 className="size-3" />
                <span>Source</span>
              </Button>
            </div>
          ) : null}

          <Button type="button" variant="outline" size="xs" onClick={onRefresh} disabled={loading}>
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
            <span>Refresh</span>
          </Button>

          {loadedDoc ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => triggerSafeBlobDownload(loadedDoc.content, basenameOfPath(loadedDoc.path))}
            >
              <Download className="size-3" />
              <span>Download</span>
            </Button>
          ) : null}

          {!isPopoutWindow && onPopout && loadedDoc ? (
            <Button type="button" variant="outline" size="xs" onClick={onPopout}>
              <ExternalLink className="size-3" />
              <span>Open in new window</span>
            </Button>
          ) : null}
        </div>
      </div>

      {forcedSourceReason && loadedDoc ? (
        <div className="flex-none border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground" role="status">
          {forcedSourceReason}
        </div>
      ) : null}

      {effectiveMode === 'rendered' && loadedDoc?.kind === 'markdown' && hasExternalMdImages && !showExternalImages ? (
        <div className="flex flex-none items-center justify-between gap-3 border-b bg-muted/35 px-4 py-2 text-xs text-muted-foreground" role="status">
          <span>External images are hidden in preview.</span>
          <Button type="button" variant="outline" size="xs" onClick={() => setShowExternalImages(true)}>
            Show external images
          </Button>
        </div>
      ) : null}

      {effectiveMode === 'rendered' && htmlAnalysis?.scriptsDetected ? (
        <div
          data-testid="html-script-notice"
          className="flex flex-none flex-wrap items-center justify-between gap-2 border-b bg-muted/35 px-4 py-2 text-xs"
          role="status"
        >
          <p className="min-w-0 flex-1 text-muted-foreground">
            Static preview turns off scripts and external embeds, so interactive controls or app content may not appear.
            {htmlAnalysis.spaMountLikely ? ' This file appears to require JavaScript at runtime.' : ''}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void handleCopy('serve', prompts.serveLocally)}
            >
              {copiedKey === 'serve' ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
              <span>{copiedKey === 'serve' ? 'Copied prompt' : 'Copy prompt to serve locally'}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void handleCopy('static', prompts.staticCopy)}
            >
              {copiedKey === 'static' ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
              <span>{copiedKey === 'static' ? 'Copied prompt' : 'Copy prompt for static HTML/CSS copy'}</span>
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        {loading && !loadedDoc ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            <span>Loading {path} from {hostLabel}…</span>
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
            <p className="max-w-lg text-sm text-muted-foreground" data-testid="document-preview-error">
              {error}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
              <RefreshCw className="size-3.5" />
              <span>Retry Refresh</span>
            </Button>
          </div>
        ) : loadedDoc ? (
          effectiveMode === 'source' ? (
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <pre
                data-testid="document-preview-source"
                className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground"
              >
                {loadedDoc.content}
              </pre>
            </div>
          ) : loadedDoc.kind === 'markdown' ? (
            <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto p-6" data-testid="document-preview-markdown">
              <div className="mx-auto max-w-3xl text-sm leading-relaxed [&>*:first-child]:mt-0 [&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold [&_p]:my-2.5 [&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted/60 [&_pre]:p-3 [&_code]:font-mono [&_code]:text-[12.5px] [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5">
                <ReactMarkdown
                  remarkPlugins={markdownRemarkPlugins}
                  rehypePlugins={markdownRehypePlugins}
                  components={markdownComponents}
                >
                  {loadedDoc.content}
                </ReactMarkdown>
              </div>
            </div>
          ) : (
            <iframe
              title={`Static HTML preview: ${basenameOfPath(loadedDoc.path)}`}
              data-testid="document-preview-iframe"
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={htmlAnalysis?.srcdoc ?? ''}
              className="h-full w-full flex-1 border-0 bg-white"
            />
          )
        ) : null}
      </div>
    </div>
  );
}

/** Mounted once inside `RemoteAppBoundary` in `App.tsx` so `App.tsx` stays thin. */
export function DocumentPreviewDialogHost() {
  const state = useActiveDocumentPreview();
  if (!state.open) return null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeDocumentPreview();
      }}
    >
      <DialogContent
        data-testid="document-preview-dialog"
        className="flex h-[calc(100dvh-1.5rem)] max-h-[920px] w-[calc(100vw-1.5rem)] flex-col gap-0 overflow-hidden p-0 sm:h-[min(90dvh,920px)] sm:w-[min(1160px,94vw)] sm:max-w-[1160px]"
      >
        <DialogTitle className="sr-only">
          Document preview: {state.document?.path ?? state.requestedPath}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Verified read-only document preview from {state.hostLabel}.
        </DialogDescription>
        <DocumentPreviewSurface
          hostLabel={state.hostLabel}
          path={state.requestedPath}
          loading={state.loading}
          document={state.document}
          error={state.error}
          fragment={state.fragment}
          canGoBack={state.history.length > 0}
          onBack={() => void navigateBackDocumentPreview()}
          onRefresh={() => void refreshActiveDocumentPreview()}
          onOpenRelativeDoc={(href, nextFrag) => {
            if (!state.document) return;
            void openDocumentPreview({
              instanceId: state.instanceId,
              hostLabel: state.hostLabel,
              sessionId: state.sessionId,
              path: href,
              basePath: state.document.path,
              fragment: nextFrag,
              pushHistory: true,
            });
          }}
          onPopout={
            state.document
              ? () => {
                  if (!state.document) return;
                  openDocumentInPopoutWindow({
                    instanceId: state.instanceId,
                    hostLabel: state.hostLabel,
                    sessionId: state.sessionId,
                    document: state.document,
                    fragment: state.fragment,
                  });
                }
              : undefined
          }
        />
      </DialogContent>
    </Dialog>
  );
}

/** Standalone minimal read-only Viewer shell rendered when opened with `?docPopout=1`. */
export function DocumentPopoutView() {
  const initialInfo = React.useMemo(
    () =>
      typeof window === 'undefined'
        ? { isPopout: false, popoutId: null, pointer: null }
        : decodePopoutPointerFromLocation(window.location),
    []
  );

  const [state, setState] = React.useState<{
    hostLabel: string;
    instanceId: string;
    sessionId: string;
    path: string;
    fragment?: string;
    loading: boolean;
    document: LoadedConversationDocument | null;
    error: string | null;
    history: Array<{ path: string; fragment?: string }>;
    wiped: boolean;
  }>(() => ({
    hostLabel: initialInfo.pointer?.hostLabel ?? 'Host',
    instanceId: initialInfo.pointer?.instanceId ?? '',
    sessionId: initialInfo.pointer?.sessionId ?? '',
    path: initialInfo.pointer?.path ?? '',
    fragment: initialInfo.pointer?.fragment,
    loading: Boolean(initialInfo.popoutId || initialInfo.pointer),
    document: null,
    error: initialInfo.popoutId || initialInfo.pointer ? null : 'This document preview window has no document reference.',
    history: [],
    wiped: false,
  }));

  React.useEffect(() => {
    const titlePath = state.document?.path ?? state.path;
    if (titlePath) {
      document.title = `${basenameOfPath(titlePath)} — Ember Document Preview`;
    }
  }, [state.document?.path, state.path]);

  React.useEffect(
    () =>
      subscribePopoutLogoutWipe(() => {
        setState((prev) => ({
          ...prev,
          loading: false,
          document: null,
          error: 'Session ended. Preview cleared.',
          wiped: true,
        }));
        window.close();
      }),
    []
  );

  React.useEffect(() => {
    let cancelled = false;
    const loadInitial = async () => {
      const fromChannel = initialInfo.popoutId
        ? await requestPopoutInitialPayload(initialInfo.popoutId, 200)
        : null;
      if (cancelled) return;
      if (fromChannel) {
        setState((prev) =>
          prev.wiped
            ? prev
            : {
                ...prev,
                hostLabel: fromChannel.hostLabel,
                instanceId: fromChannel.instanceId,
                sessionId: fromChannel.sessionId,
                path: fromChannel.document.path,
                fragment: fromChannel.fragment,
                loading: false,
                document: fromChannel.document,
                error: null,
              }
        );
        return;
      }
      const ptr = initialInfo.pointer;
      if (!ptr) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: 'Ember could not recover this popout document reference. Open it from the conversation again.',
        }));
        return;
      }
      const res = await readConversationDocumentViaBridge(ptr.instanceId, ptr.sessionId, ptr.path, ptr.hostLabel);
      if (cancelled) return;
      setState((prev) => {
        if (prev.wiped) return prev;
        return res.ok
          ? {
              ...prev,
              loading: false,
              document: res.document,
              path: res.document.path,
              error: null,
            }
          : {
              ...prev,
              loading: false,
              document: null,
              error: res.error,
            };
      });
    };
    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, [initialInfo]);

  const loadPath = React.useCallback(
    async (targetPath: string, opts?: { basePath?: string; fragment?: string; pushHistory?: boolean }) => {
      if (!state.instanceId || !state.sessionId) return;
      setState((prev) => ({
        ...prev,
        loading: true,
        error: null,
        fragment: opts?.fragment,
        history:
          opts?.pushHistory && prev.document
            ? [...prev.history, { path: prev.document.path, fragment: prev.fragment }]
            : prev.history,
      }));
      const res = await readConversationDocumentViaBridge(
        state.instanceId,
        state.sessionId,
        targetPath,
        state.hostLabel,
        opts?.basePath
      );
      setState((prev) => {
        if (prev.wiped) return prev;
        return res.ok
          ? {
              ...prev,
              loading: false,
              document: res.document,
              path: res.document.path,
              error: null,
            }
          : {
              ...prev,
              loading: false,
              error: res.error,
            };
      });
    },
    [state.instanceId, state.sessionId, state.hostLabel]
  );

  if (state.wiped) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background p-6 text-sm text-muted-foreground">
        This preview cleared when your Ember session ended.
      </div>
    );
  }

  return (
    <div className="flex h-dvh w-screen flex-col overflow-hidden bg-background">
      <DocumentPreviewSurface
        isPopoutWindow
        hostLabel={state.hostLabel}
        path={state.path}
        loading={state.loading}
        document={state.document}
        error={state.error}
        fragment={state.fragment}
        canGoBack={state.history.length > 0}
        onBack={() => {
          if (state.history.length === 0) return;
          const prevEntry = state.history[state.history.length - 1]!;
          setState((prev) => ({ ...prev, history: prev.history.slice(0, -1) }));
          void loadPath(prevEntry.path, { fragment: prevEntry.fragment });
        }}
        onRefresh={() => void loadPath(state.document?.path ?? state.path, { fragment: state.fragment })}
        onOpenRelativeDoc={(href, nextFrag) => {
          if (!state.document) return;
          void loadPath(href, {
            basePath: state.document.path,
            fragment: nextFrag,
            pushHistory: true,
          });
        }}
      />
    </div>
  );
}
