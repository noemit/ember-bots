import * as React from 'react';

export const Markdown = React.lazy(() => import('../Markdown'));

export const MarkdownFallback = ({ text }: { text: string }) => (
  <span className="whitespace-pre-wrap break-words">{text}</span>
);

export const spring = { type: 'spring', stiffness: 420, damping: 32 } as const;

// Expanded details belong to the transcript scroll, not a second vertical scroll area.
export const panelClass =
  'overflow-x-auto rounded-md bg-background/70 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all';

export const ExpansionContext = React.createContext<Map<string, boolean> | null>(null);

export const useExpansion = (key: string, initial: boolean) => {
  const saved = React.useContext(ExpansionContext);
  const [open, setOpen] = React.useState(() => saved?.get(key) ?? initial);
  const set = (value: boolean | ((previous: boolean) => boolean)) =>
    setOpen((previous) => {
      const next = typeof value === 'function' ? value(previous) : value;
      saved?.set(key, next);
      return next;
    });
  return [open, set] as const;
};
