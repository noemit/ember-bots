import * as React from 'react';
import { useImageViewer } from './imageViewerContext';
import { cn } from '@/lib/utils';
import { isRenderableImage } from '../lib/gallery';
import type { ChatMessage, MessagePart, ToolCall } from '../types';

const Markdown = React.lazy(() => import('./Markdown'));

/**
 * One message, read whole.
 *
 * This is the reading view's body, not the transcript's: no virtualizer, no per-turn footer, no
 * pin or reply affordances. What it keeps is everything needed to *understand* the message — the
 * prose (through the same Markdown renderer), the reasoning folded behind a disclosure, the tools
 * as one compact line each that opens for output, and images that open in the shared viewer.
 */
export default function SheetMessage({ message }: { message: ChatMessage }) {
  const blocks = message.parts.length
    ? message.parts
    : message.text
      ? ([{ type: 'text', id: `${message.id}-text`, text: message.text }] as MessagePart[])
      : [];

  return (
    <div className="conversation-prose flex flex-col gap-3 text-foreground">
      {blocks.map((part) => {
        if (part.type === 'text') {
          if (!part.text.trim()) return null;
          return (
            <React.Suspense key={part.id} fallback={<p className="whitespace-pre-wrap">{part.text}</p>}>
              <Markdown text={part.text} />
            </React.Suspense>
          );
        }
        if (part.type === 'reasoning') {
          return (
            <details key={part.id} className="rounded-md border border-border/60 bg-muted/30">
              <summary className="cursor-pointer select-none px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Thinking
              </summary>
              <p className="max-h-64 overflow-y-auto whitespace-pre-wrap px-2.5 pb-2 text-[12px] leading-relaxed text-muted-foreground">
                {part.text}
              </p>
            </details>
          );
        }
        if (part.type === 'tool') {
          return <SheetTool key={part.id} call={part.call} />;
        }
        const file = part.file;
        const viewer = isRenderableImage(file) ? file : null;
        if (!viewer) {
          return (
            <p key={part.id} className="text-[12px] text-muted-foreground">
              {file.filename}
            </p>
          );
        }
        return <SheetImage key={part.id} url={file.url} alt={file.filename} />;
      })}

      {message.error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[12px] text-destructive">
          {message.error}
        </p>
      ) : null}
    </div>
  );
}

function SheetImage({ url, alt }: { url: string; alt: string }) {
  const viewer = useImageViewer();
  return (
    <button
      type="button"
      onClick={() => viewer?.openOne({ id: url, url, filename: alt, mime: '' })}
      className="w-fit rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img
        src={url}
        alt={alt}
        className="max-h-[420px] max-w-full rounded-md border object-contain"
        loading="lazy"
      />
    </button>
  );
}

/** A tool call as one line, with its output behind a disclosure: present, but never in the way. */
function SheetTool({ call }: { call: ToolCall }) {
  const detail = call.error ?? call.diff ?? call.output ?? '';
  const label = call.title?.trim() || call.tool;
  const tone =
    call.status === 'error'
      ? 'text-destructive'
      : call.status === 'running' || call.status === 'pending'
        ? 'text-highlight'
        : 'text-muted-foreground';
  const body = (
    <span className="flex min-w-0 items-baseline gap-2 text-[12px]">
      <span className={cn('flex-none font-medium', tone)}>{call.tool}</span>
      <span className="min-w-0 truncate text-muted-foreground">{label}</span>
    </span>
  );
  if (!detail) {
    return <div className="border-l-2 border-border/70 pl-2.5">{body}</div>;
  }
  return (
    <details className="border-l-2 border-border/70 pl-2.5">
      <summary className="cursor-pointer select-none">{body}</summary>
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[11.5px] leading-relaxed">
        {detail}
      </pre>
    </details>
  );
}
