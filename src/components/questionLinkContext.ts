import { createContext } from 'react';

/** Resolve a receipt only against Questions available in this chat column. */
export const QuestionLinkContext = createContext<((id: string) => (() => void) | undefined) | null>(null);
