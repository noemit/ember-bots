import * as React from 'react';
import { Brain, ChevronRight, CircleAlert, FileText } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useStableCallback } from '@/lib/useStableCallback';
import { cn } from '@/lib/utils';
import { isRenderableImage } from '../../lib/gallery';
import type { FileAttachment } from '../../types';
import { reasoningTail } from './blocks';
import { Markdown, MarkdownFallback, useExpansion } from './expansion';

export const ReasoningRow = ({
  text,
  storageKey,
  partId,
  defaultOpen,
  onToggle,
  streaming = false,
}: {
  text: string;
  storageKey: string;
  partId: string;
  defaultOpen: boolean;
  onToggle?: (element: HTMLElement | null) => void;
  streaming?: boolean;
}) => {
  const [open, updateOpen] = useExpansion(storageKey, defaultOpen);
  const setOpen = useStableCallback(updateOpen);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const previousDefault = React.useRef(defaultOpen);
  React.useEffect(() => {
    if (previousDefault.current !== defaultOpen) setOpen(defaultOpen);
    previousDefault.current = defaultOpen;
  }, [defaultOpen, setOpen]);
  return (
    <div ref={rootRef} className="flex max-w-[85%] flex-col self-start">
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) onToggle?.(rootRef.current);
        }}
        aria-expanded={open}
        className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left text-[11.5px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        <Brain className={cn('size-3 flex-none', streaming && 'animate-pulse text-highlight')} />
        <span className="flex-none">{streaming ? 'Thinking…' : 'Thinking'}</span>
        {streaming && !open ? (
          <span className="min-w-0 flex-1 truncate text-left text-[11px] text-muted-foreground/70">
            {reasoningTail(text)}
          </span>
        ) : null}
        <ChevronRight className={cn('size-3 flex-none opacity-60 transition-transform', open && 'rotate-90')} />
      </button>
      {open ? (
        <div
          data-quote-part-id={partId}
          className="ml-6 mt-1 rounded-md bg-background/50 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground"
        >
          <React.Suspense fallback={<MarkdownFallback text={text} />}>
            {streaming ? (
              <span className="whitespace-pre-wrap break-words">{text}</span>
            ) : (
              <Markdown text={text} />
            )}
          </React.Suspense>
          {streaming ? (
            <span
              aria-hidden="true"
              className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-highlight align-middle"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const FileBlock = ({
  file,
  mine,
  onOpen,
}: {
  file: FileAttachment;
  mine: boolean;
  onOpen?: () => void;
}) =>
  isRenderableImage(file) ? (
    onOpen ? (
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'cursor-zoom-in rounded-xl focus-visible:outline-2 focus-visible:outline-ring',
          mine ? 'self-end' : 'self-start'
        )}
        aria-label={`Open ${file.filename}`}
        title={`Open ${file.filename}`}
      >
        <img src={file.url} alt={file.filename} className="max-h-64 max-w-full rounded-xl border" />
      </button>
    ) : (
      <img
        src={file.url}
        alt={file.filename}
        title={file.filename}
        className={cn('max-h-64 max-w-[70%] rounded-xl border', mine ? 'self-end' : 'self-start')}
      />
    )
  ) : (
    <span
      title={file.filename}
      className={cn(
        'flex max-w-[70%] items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px]',
        mine ? 'self-end' : 'self-start'
      )}
    >
      <FileText className="size-3.5 flex-none text-muted-foreground" />
      <span className="truncate">{file.filename}</span>
    </span>
  );

export const MessageError = ({ error }: { error: string }) => {
  const [title, ...rest] = error.split('\n');
  return (
    <Alert variant="destructive" className="max-w-[85%] self-start px-3.5 py-2.5 text-[12.5px]">
      <CircleAlert className="mt-0.5 size-4 flex-none" />
      <AlertTitle className="text-[12.5px]">{title}</AlertTitle>
      <AlertDescription className="whitespace-pre-wrap break-words text-foreground">
        {rest.join('\n')}
      </AlertDescription>
    </Alert>
  );
};
