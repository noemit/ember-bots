import { tokenizeLinks } from '../components/Linkify';
import type { UnreadDigest, UnreadItem } from './unreadDigest';

/**
 * The links Home's right column offers: reports, running apps, pages and files that sessions
 * shared, so one can be grabbed (or dragged out) without opening the conversation.
 *
 * v1 reads them from the unread excerpts Home already holds — no transcripts, no network, no page
 * previews. Anything that needs a full read (old links, images as thumbnails) waits for a later
 * pass.
 */

export type SharedLinkKind = 'app' | 'report' | 'page' | 'file';

export type SharedLink = {
  /** The URL or local path as a transcript printed it. */
  url: string;
  kind: SharedLinkKind;
  /** Something readable to click: the filename, or the host. */
  title: string;
  /** Session that shared it, as `instance::session`. */
  sessionKey: string;
  /**
   * The message that mentioned it, so the column can offer a way back to the words. Absent when the
   * link came from a pending question or approval — that text is not in the transcript yet, so the
   * bar offers the session rather than a jump it cannot make.
   */
  messageId?: string;
  /** A short quote of that message, the context bar under the link. */
  context: string;
  /** When that session last spoke, so the column can order and time its rows. */
  at: number;
};

/** Links per column. Beyond this the newest are kept. */
export const SHARED_LINK_LIMIT = 24;

const REPORT_EXTENSIONS = /\.(html?|pdf|md|csv|jsonl?|txt)$/i;

export const linkKindFor = (url: string): SharedLinkKind => {
  if (/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/i.test(url)) return 'app';
  // A local path is a file even when it ends in .md: "report" means a document the agent produced
  // and served, which a path on this machine is not.
  if (url.startsWith('/') || url.startsWith('~')) return 'file';
  if (REPORT_EXTENSIONS.test(url)) return 'report';
  if (/^https?:\/\//i.test(url) || /^www\./i.test(url)) return 'page';
  return 'file';
};

/** A short label: the last path segment when there is one, else the host. */
export const linkTitle = (url: string): string => {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  const segments = withoutQuery.replace(/\/+$/, '').split('/');
  const last = segments[segments.length - 1] || '';
  // A bare hostname lands here (it is the last "segment" of its own URL): keep it, minus www.
  if (last && !/^https?:?$/.test(last) && last.includes('.')) return last.replace(/^www\./i, '');
  const host = /^(?:https?:\/\/)?([^/]+)/i.exec(url)?.[1];
  return host ? host.replace(/^www\./i, '') : last || url;
};

const targetOf = (link: string): string => link.trim();

/** Characters of the message kept for a link's context bar: one line, with the link inside it. */
export const LINK_CONTEXT_LIMIT = 120;

/**
 * A short quote of the message around the link, so the bar says *why* this link is here.
 *
 * The window is centred on the link where it can be, because "…see the staging page…" is useless
 * when the sentence that matters is the one containing the URL.
 */
export const contextAround = (
  text: string,
  link: string,
  limit = LINK_CONTEXT_LIMIT
): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const at = flat.indexOf(link);
  if (at < 0) return `${flat.slice(0, limit).trimEnd()}…`;
  const start = Math.max(0, Math.min(at - Math.floor(limit / 2), flat.length - limit));
  const slice = flat.slice(start, start + limit).trim();
  return `${start > 0 ? '…' : ''}${slice}${start + limit < flat.length ? '…' : ''}`;
};

/**
 * Every link mentioned in the given digests, newest first, one row per URL.
 *
 * The same link shared twice is one card — the newest wins — because the column is a place to grab
 * something, not a log of who said it when.
 */
export const linksFromItems = (
  sources: ReadonlyArray<{
    sessionKey: string;
    at: number;
    items: readonly Pick<UnreadItem, 'excerpt' | 'id'>[];
  }>,
  limit = SHARED_LINK_LIMIT
): SharedLink[] => {
  const byUrl = new Map<string, SharedLink>();
  sources.forEach(({ sessionKey, at, items }) => {
    items.forEach((item) => {
      tokenizeLinks(item.excerpt).forEach((token) => {
        if (token.type !== 'link') return;
        const url = targetOf(token.value);
        if (!url) return;
        const existing = byUrl.get(url);
        if (existing && existing.at >= at) return;
        byUrl.set(url, {
          url,
          kind: linkKindFor(url),
          title: linkTitle(url),
          sessionKey,
          // A prompt's id (`question:…`) is not a transcript message; jumping to it would go nowhere.
          ...(item.id.includes(':') ? {} : { messageId: item.id }),
          context: contextAround(item.excerpt, token.value),
          at,
        });
      });
    });
  });
  return [...byUrl.values()].sort((a, b) => b.at - a.at).slice(0, limit);
};

/** The digest-shaped wrapper, for callers that have nothing but digests. */
export const linksFromDigests = (
  digests: Readonly<Record<string, UnreadDigest>>,
  sessionTime: (key: string) => number,
  limit = SHARED_LINK_LIMIT
): SharedLink[] =>
  linksFromItems(
    Object.entries(digests).map(([sessionKey, digest]) => ({
      sessionKey,
      at: sessionTime(sessionKey),
      items: digest.items,
    })),
    limit
  );
