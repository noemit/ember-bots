import type { QuoteLink } from '../types';

export type MessageQuoteLink = { link: QuoteLink; source: boolean };

export const EMPTY_QUOTE_LINKS: readonly MessageQuoteLink[] = Object.freeze([]);

/** Entry IDs are only meaningful inside their host/conversation namespace. */
export const quoteLinksForMessage = (
  links: readonly QuoteLink[],
  sessionKey: string | null | undefined,
  messageId: string
): readonly MessageQuoteLink[] => {
  if (!sessionKey || links.length === 0) return EMPTY_QUOTE_LINKS;
  let matched: MessageQuoteLink[] | null = null;
  for (const link of links) {
    const source =
      link.source.sessionKey === sessionKey &&
      link.source.spans.some((span) => span.messageId === messageId);
    const destination =
      link.destination.sessionKey === sessionKey &&
      link.destination.kind === 'message' &&
      link.destination.id === messageId;
    if (source || destination) {
      matched ??= [];
      matched.push({ link, source });
    }
  }
  return matched ?? EMPTY_QUOTE_LINKS;
};
