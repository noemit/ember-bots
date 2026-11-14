import type { QuoteLink } from '../types';

export type MessageQuoteLink = { link: QuoteLink; source: boolean };

/** Entry IDs are only meaningful inside their host/conversation namespace. */
export const quoteLinksForMessage = (links: readonly QuoteLink[], sessionKey: string | null | undefined, messageId: string): MessageQuoteLink[] => {
  if (!sessionKey) return [];
  return links.flatMap((link) => {
    const source = link.source.sessionKey === sessionKey && link.source.spans.some((span) => span.messageId === messageId);
    const destination = link.destination.sessionKey === sessionKey && link.destination.kind === 'message' && link.destination.id === messageId;
    return source || destination ? [{ link, source }] : [];
  });
};
