import { createContext } from 'react';

export type ThreadLinks = { has(id: string): boolean; open(id: string): void };
/** Scoped to a column: references only open known descendants on that leader's own host. */
export const ThreadLinkContext = createContext<ThreadLinks | null>(null);
export const threadIdFromLink = (href: string | undefined): string | null => {
  const match = /^\/threads\/(\d+)$/.exec(href ?? '');
  return match?.[1] ?? null;
};
