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
import CopyButton from './CopyButton';
import { codeSource, safeMarkdownUrlTransform } from '../lib/markdownHelpers';
import {
  closeDocumentPreview,
  decodePopoutPointerFromLocation,
  isExternalWebHref,
  navigateBackDocumentPreview,
  openDocumentInPopoutWindow,
  openDocumentPreview,
  parseDocCandidate,
  parseLineRangeFragment,
  readConversationDocumentViaBridge,
  refreshActiveDocumentPreview,
  requestPopoutInitialPayload,
  subscribePopoutLogoutWipe,
  useActiveDocumentPreview,
  type DocumentLineRange,
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

const SOURCE_LINE_RENDER_CAP = 10_000;

const SourceLineRow = ({
  lineNumber,
  text,
  highlighted,
}: {
  lineNumber: number;
  text: string;
  highlighted: boolean;
}) => (
  <div
    data-line={lineNumber}
    data-line-highlighted={highlighted ? 'true' : undefined}
    className={cn(
      'flex items-start px-2 py-px',
      highlighted ? 'border-l-2 border-highlight bg-highlight/15' : 'border-l-2 border-transparent'
    )}
  >
    <span
      aria-hidden="true"
      className="w-12 shrink-0 select-none pr-3 text-right tabular-nums text-muted-foreground/60"
    >
      {lineNumber}
    </span>
    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
      {text || '\u200b'}
    </span>
  </div>
);

const DocumentSourceView = ({
  content,
  lineRange,
}: {
  content: string;
  lineRange: DocumentLineRange | null;
}) => {
  const lines = React.useMemo(() => content.split(/\r?\n/), [content]);

  if (lines.length <= SOURCE_LINE_RENDER_CAP) {
    return (
      <div
        data-testid="document-preview-source"
        className="font-mono text-xs leading-relaxed text-foreground"
      >
        {lines.map((line, index) => {
          const lineNumber = index + 1;
          const highlighted =
            lineRange !== null && lineNumber >= lineRange.startLine && lineNumber <= lineRange.endLine;
          return (
            <SourceLineRow
              key={lineNumber}
              lineNumber={lineNumber}
              text={line}
              highlighted={highlighted}
            />
          );
        })}
      </div>
    );
  }

  // For massive files (>10k lines), keep non-targeted sections as compact blocks so rendering stays fast
  // while still highlighting and anchoring the requested line range.
  const start = lineRange ? Math.max(1, lineRange.startLine) : 0;
  const end = lineRange ? Math.min(lines.length, lineRange.endLine) : 0;
  const before = start > 1 ? lines.slice(0, start - 1).join('\n') : '';
  const targetLines = lineRange && start <= end ? lines.slice(start - 1, end) : [];
  const after = lineRange && end < lines.length ? lines.slice(end).join('\n') : '';

  if (!lineRange || targetLines.length === 0) {
    return (
      <pre
        data-testid="document-preview-source"
        className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground"
      >
        {content}
      </pre>
    );
  }

  return (
    <div
      data-testid="document-preview-source"
      className="font-mono text-xs leading-relaxed text-foreground"
    >
      {before ? (
        <pre className="px-2 whitespace-pre-wrap break-words text-foreground">{before}</pre>
      ) : null}
      {targetLines.map((line, offset) => (
        <SourceLineRow
          key={start + offset}
          lineNumber={start + offset}
          text={line}
          highlighted
        />
      ))}
      {after ? (
        <pre className="px-2 whitespace-pre-wrap break-words text-foreground">{after}</pre>
      ) : null}
    </div>
  );
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
  const [viewMode, setViewMode] = React.useState<'rendered' | 'source'>(() =>
    parseLineRangeFragment(fragment) ? 'source' : 'rendered'
  );
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const [showExternalImages, setShowExternalImages] = React.useState(false);
  const [activeFragment, setActiveFragment] = React.useState<string | undefined>(fragment);
  const scrollContainerRef = React.useRef<HTMLDivElement | null>(null);
  const sourceScrollContainerRef = React.useRef<HTMLDivElement | null>(null);
  const lastAutoModeKeyRef = React.useRef<string>('');

  React.useEffect(() => {
    setActiveFragment(fragment);
  }, [fragment, loadedDoc?.path]);

  React.useEffect(() => {
    if (!loadedDoc) return;
    const autoKey = `${loadedDoc.path}\u0000${fragment ?? ''}`;
    if (lastAutoModeKeyRef.current === autoKey) return;
    lastAutoModeKeyRef.current = autoKey;
    setViewMode(parseLineRangeFragment(fragment) ? 'source' : 'rendered');
  }, [loadedDoc, fragment]);

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
    setCopiedKey(ok ? key : `${key}-failed`);
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
  const lineRange = React.useMemo(() => parseLineRangeFragment(activeFragment), [activeFragment]);

  const hasExternalMdImages = React.useMemo(
    () => (loadedDoc?.kind === 'markdown' ? markdownHasExternalImages(loadedDoc.content) : false),
    [loadedDoc]
  );

  const scrollToFragment = React.useCallback((rawFrag: string) => {
    const container = scrollContainerRef.current;
    if (!container || !rawFrag) return;
    let decoded = rawFrag.replace(/^#/, '');
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Keep raw fragment when malformed %-escapes appear.
    }
    const cleaned = decoded.trim().toLowerCase();
    if (!cleaned) return;
    const targetId = cleaned.startsWith('user-content-') ? cleaned : `user-content-${cleaned}`;
    const headings = container.querySelectorAll('[id]');
    for (const el of Array.from(headings)) {
      const id = el.getAttribute('id')?.toLowerCase();
      if (id === targetId || id === cleaned) {
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        return;
      }
    }
  }, []);

  const scrollToSourceLine = React.useCallback((range: DocumentLineRange) => {
    const container = sourceScrollContainerRef.current;
    if (!container) return;
    const direct = container.querySelector(`[data-line="${range.startLine}"]`);
    const target = direct ?? container.querySelector('[data-line-highlighted="true"]');
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  React.useEffect(() => {
    if (
      effectiveMode === 'rendered' &&
      loadedDoc?.kind === 'markdown' &&
      activeFragment &&
      !lineRange
    ) {
      const timer = window.setTimeout(() => scrollToFragment(activeFragment), 20);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [effectiveMode, loadedDoc, activeFragment, lineRange, scrollToFragment]);

  React.useEffect(() => {
    if (effectiveMode === 'source' && loadedDoc && lineRange) {
      const timer = window.setTimeout(() => scrollToSourceLine(lineRange), 20);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [effectiveMode, loadedDoc, lineRange, scrollToSourceLine]);

  const markdownComponents = React.useMemo<Components>(() => ({
    pre: ({ node, children }) => (
      <div className="group/code relative my-3">
        <pre className="overflow-x-auto rounded-md border border-border/50 bg-muted/60 p-3 pr-10 leading-relaxed">
          {children}
        </pre>
        <div className="absolute right-1.5 top-1.5">
          <CopyButton text={() => codeSource(node)} label="Copy code" done="Copied code" alwaysVisible />
        </div>
      </div>
    ),
    a: ({ node: _node, href, children, ...props }) => {
      if (!href) {
        return (
          <span className="text-muted-foreground" title="Link blocked in preview">
            {children}
          </span>
        );
      }
      if (href.startsWith('#')) {
        const nextFrag = href.slice(1);
        return (
          <a
            {...props}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              setActiveFragment(nextFrag);
              if (parseLineRangeFragment(nextFrag)) {
                setViewMode('source');
              } else {
                if (!forcedSourceReason) setViewMode('rendered');
                scrollToFragment(href);
              }
            }}
            className="cursor-pointer underline decoration-current/50 underline-offset-2 hover:decoration-current"
          >
            {children}
          </a>
        );
      }
      if (isExternalWebHref(href)) {
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
      const parsed = parseDocCandidate(href, { allowSpaces: true });
      if (parsed) {
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
        <span className="text-muted-foreground" title={`Link blocked in preview: ${href}`}>
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
  }), [forcedSourceReason, hostLabel, onOpenRelativeDoc, scrollToFragment, showExternalImages]);

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
                <span>
                  {copiedKey === 'path' ? 'Copied' : copiedKey === 'path-failed' ? 'Copy failed' : 'Copy path'}
                </span>
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

      {loadedDoc && lineRange ? (
        <div
          data-testid="document-line-range-bar"
          className="flex flex-none items-center justify-between gap-2 border-b bg-muted/35 px-4 py-1.5 text-xs text-muted-foreground"
        >
          <span>
            {lineRange.startLine === lineRange.endLine
              ? `Highlighted line ${lineRange.startLine}`
              : `Highlighted lines ${lineRange.startLine}–${lineRange.endLine}`}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              if (effectiveMode !== 'source') {
                setViewMode('source');
              } else {
                scrollToSourceLine(lineRange);
              }
            }}
          >
            {effectiveMode !== 'source' ? 'Jump to lines in Source' : 'Jump to lines'}
          </Button>
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
            <div ref={sourceScrollContainerRef} className="min-h-0 flex-1 overflow-auto p-3">
              <DocumentSourceView content={loadedDoc.content} lineRange={lineRange} />
            </div>
          ) : loadedDoc.kind === 'markdown' ? (
            <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto p-6" data-testid="document-preview-markdown">
              <div className="mx-auto max-w-3xl text-[length:var(--conversation-text-size,14px)] leading-relaxed [&>*:first-child]:mt-0 [&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold [&_p]:my-2.5 [&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-6 [&_ul.contains-task-list]:list-none [&_ul.contains-task-list]:pl-2 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1 [&_li.task-list-item>input[type='checkbox']]:mr-2 [&_li.task-list-item>input[type='checkbox']]:align-middle [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_hr]:my-4 [&_hr]:border-border [&_code]:font-mono [&_code]:text-[12.5px] [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted/70 [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_table]:my-3 [&_table]:block [&_table]:w-max [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-border [&_td]:px-2.5 [&_td]:py-1.5">
                <ReactMarkdown
                  remarkPlugins={markdownRemarkPlugins}
                  rehypePlugins={markdownRehypePlugins}
                  urlTransform={safeMarkdownUrlTransform}
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
    basePath?: string;
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
    error: initialInfo.popoutId || initialInfo.pointer
      ? null
      : 'This document preview window has no document reference. Open the document from its conversation again.',
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
          error: 'Your Ember session ended, so this preview was cleared. Reconnect and open it from the conversation again.',
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

  const loadSeqRef = React.useRef(0);
  const loadPath = React.useCallback(
    async (targetPath: string, opts?: { basePath?: string; fragment?: string; pushHistory?: boolean }) => {
      if (!state.instanceId || !state.sessionId) return;
      const seq = ++loadSeqRef.current;
      setState((prev) => ({
        ...prev,
        path: targetPath,
        basePath: opts?.basePath,
        loading: true,
        document: opts?.basePath ? null : prev.document,
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
      if (seq !== loadSeqRef.current) return;
      setState((prev) => {
        if (prev.wiped) return prev;
        return res.ok
          ? {
              ...prev,
              loading: false,
              document: res.document,
              path: res.document.path,
              basePath: undefined,
              error: null,
            }
          : {
              ...prev,
              loading: false,
              document: null,
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
        onRefresh={() =>
          void loadPath(state.document?.path ?? state.path, {
            ...(state.basePath ? { basePath: state.basePath } : {}),
            fragment: state.fragment,
          })
        }
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
