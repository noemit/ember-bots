import { Ban, Check, ChevronRight, CircleAlert, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ViewerImage } from '../../lib/gallery';
import { countToolCalls, foldedToolsLabel } from '../../lib/toolDisplay';
import { liveOutputTail } from '../../lib/toolTail';
import type { ToolCall } from '../../types';
import {
  describeInput,
  formatDuration,
  groupedToolTitle,
  nestedArgsPreview,
  nestedCalls,
  toolSummary,
  type NestedCall,
  type ToolBlock,
} from './blocks';
import { DiffView } from './DiffView';
import { panelClass, useExpansion } from './expansion';

const ScriptView = ({ code }: { code: string }) => (
  <div className="flex flex-col gap-1 rounded-md bg-background/70 px-2.5 py-2">
    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">Script</span>
    <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
      {code}
    </pre>
  </div>
);

const NestedStatusIcon = ({ status }: { status: NestedCall['status'] }) => {
  if (status === 'ok') return <Check className="size-3 flex-none text-success" />;
  if (status === 'error') return <CircleAlert className="size-3 flex-none text-destructive" />;
  if (status === 'cancelled') return <Ban className="size-3 flex-none text-warning" />;
  return <Loader2 className="size-3 flex-none animate-spin text-muted-foreground" />;
};

const NestedCallRow = ({ call }: { call: NestedCall }) => {
  const args = nestedArgsPreview(call.args);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-2">
        <NestedStatusIcon status={call.status} />
        <span className="flex-none font-mono text-[11px] text-foreground/90">{call.name}</span>
        {args ? (
          <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground/80">{args}</span>
        ) : null}
        {call.durationMs !== undefined ? (
          <span className="ml-auto flex-none tabular-nums text-[10.5px] text-muted-foreground/70">
            {formatDuration(call.durationMs)}
          </span>
        ) : null}
      </div>
      {call.error ? <div className="pl-[1.25rem] text-destructive">{call.error}</div> : null}
    </div>
  );
};

const NestedCallsSection = ({ calls }: { calls: NestedCall[] }) => (
  <div className="flex flex-col gap-1 rounded-md bg-background/70 px-2.5 py-2">
    <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
      Nested calls ({calls.length})
    </span>
    {calls.map((nested, index) => (
      <NestedCallRow key={`${nested.id}:${index}`} call={nested} />
    ))}
  </div>
);

export const ToolImages = ({
  calls,
  className,
  onOpen,
}: {
  calls: ToolCall[];
  className?: string;
  onOpen?: (image: ViewerImage) => void;
}) => {
  const images = calls.flatMap((call) =>
    (call.images ?? []).map((file, index) => ({ file, id: `${call.id}:${index}`, tool: call.tool }))
  );
  if (images.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {images.map(({ file, id, tool }) =>
        onOpen ? (
          <button
            key={id}
            type="button"
            onClick={() => onOpen({ id, url: file.url, filename: file.filename, mime: file.mime, tool })}
            className="cursor-zoom-in rounded-xl focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={`Open ${file.filename}`}
            title={`Open ${file.filename}`}
          >
            <img src={file.url} alt={file.filename} className="max-h-64 max-w-full rounded-xl border" />
          </button>
        ) : (
          <img
            key={id}
            src={file.url}
            alt={file.filename}
            title={file.filename}
            className="max-h-64 max-w-[70%] rounded-xl border"
          />
        )
      )}
    </div>
  );
};

const LiveOutputTail = ({ output }: { output?: string }) => {
  const lines = liveOutputTail(output ?? '');
  if (lines.length === 0) return null;
  return (
    <pre
      data-live-tail=""
      className="ml-6 mt-0.5 max-h-16 overflow-hidden rounded-md bg-muted/40 px-2 py-1 font-mono text-[10.5px] leading-snug break-all whitespace-pre-wrap text-muted-foreground"
    >
      {lines.join('\n')}
    </pre>
  );
};

export const ToolRow = ({
  call,
  defaultOpen = false,
  fillWidth = false,
  onOpen,
}: {
  call: ToolCall;
  defaultOpen?: boolean;
  fillWidth?: boolean;
  onOpen?: (image: ViewerImage) => void;
}) => {
  const [open, setOpen] = useExpansion(`tool:${call.id}`, defaultOpen);
  const nested = nestedCalls(call);
  const script = call.tool === 'codemode' && typeof call.input?.code === 'string' ? call.input.code : null;
  const hasDetail = Boolean(call.input || call.output || call.diff || call.error || nested.length > 0);
  const interrupted = call.status === 'interrupted';
  const summary = toolSummary(call) ?? call.title;

  return (
    <div className={cn('flex flex-col self-start', fillWidth ? 'w-full min-w-0' : 'max-w-[85%]')}>
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          'flex items-center gap-2 rounded-md px-1 py-0.5 text-left text-[11.5px] text-muted-foreground',
          hasDetail && 'hover:bg-muted/60 hover:text-foreground',
          call.status === 'error' && 'text-destructive'
        )}
        title={interrupted ? 'This step was interrupted by the stop' : call.error ?? summary}
      >
        {call.status === 'completed' ? (
          <Check className="size-3 flex-none text-success" />
        ) : call.status === 'error' ? (
          <CircleAlert className="size-3 flex-none" />
        ) : interrupted ? (
          <Ban className="size-3 flex-none text-warning" />
        ) : (
          <Loader2 className="size-3 flex-none animate-spin" />
        )}
        <span className="flex-none font-mono text-[11px]">{call.tool}</span>
        {interrupted ? (
          <span className="flex-none font-normal italic">[step interrupted]</span>
        ) : summary ? (
          <span className="min-w-0 truncate font-mono">{summary}</span>
        ) : null}
        {call.exitCode !== undefined && call.exitCode !== 0 ? (
          <span
            className="flex-none rounded-sm bg-destructive/15 px-1 font-mono text-[10px] leading-4 text-destructive"
            title={`The command exited with code ${call.exitCode}`}
          >
            exit {call.exitCode}
          </span>
        ) : null}
        {hasDetail ? (
          <ChevronRight className={cn('size-3 flex-none opacity-60 transition-transform', open && 'rotate-90')} />
        ) : null}
      </button>

      <ToolImages calls={[call]} className="ml-6 mt-1" onOpen={onOpen} />

      {!open && call.status === 'running' ? <LiveOutputTail output={call.output} /> : null}

      {open ? (
        <div className="ml-6 mt-1 flex flex-col gap-1.5 text-[11px]">
          {script ? <ScriptView code={script} /> : null}
          {call.input && !call.diff && script === null ? (
            <pre className={panelClass}>{describeInput(call.input)}</pre>
          ) : null}
          {nested.length > 0 ? <NestedCallsSection calls={nested} /> : null}
          {call.diff ? <DiffView diff={call.diff} storageKey={`diff:${call.id}`} /> : null}
          {call.error ? <pre className={cn(panelClass, 'text-destructive')}>{call.error}</pre> : null}
          {call.truncated ? (
            <div className="px-1 text-[10.5px] text-muted-foreground/70">
              Earlier output was dropped — this is the tail the host kept.
            </div>
          ) : null}
          {call.output ? <pre className={panelClass}>{call.output}</pre> : null}
          {call.fullOutputPath ? (
            <div className="min-w-0 px-1 text-[10.5px] text-muted-foreground/70">
              Full output:{' '}
              <span className="break-all font-mono text-muted-foreground">{call.fullOutputPath}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const ToolGroupRow = ({
  tool,
  calls,
  defaultOpen = false,
  fillWidth = false,
  onOpen,
}: {
  tool: string;
  calls: ToolCall[];
  defaultOpen?: boolean;
  fillWidth?: boolean;
  onOpen?: (image: ViewerImage) => void;
}) => {
  const [open, setOpen] = useExpansion(`group:${calls[0]?.id}`, defaultOpen);
  if (calls.length === 1) return <ToolRow call={calls[0]} defaultOpen={defaultOpen} fillWidth={fillWidth} onOpen={onOpen} />;
  const status = calls.some((call) => call.status === 'error')
    ? 'error'
    : calls.some((call) => call.status === 'running' || call.status === 'pending')
      ? 'running'
      : calls.some((call) => call.status === 'interrupted')
        ? 'interrupted'
        : 'completed';

  return (
    <div className={cn('flex flex-col self-start', fillWidth ? 'w-full min-w-0' : 'max-w-[85%]')}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          'flex items-center gap-2 rounded-md px-1 py-0.5 text-left text-[11.5px] text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          status === 'error' && 'text-destructive'
        )}
      >
        {status === 'completed' ? (
          <Check className="size-3 flex-none text-success" />
        ) : status === 'error' ? (
          <CircleAlert className="size-3 flex-none" />
        ) : status === 'interrupted' ? (
          <Ban className="size-3 flex-none text-warning" />
        ) : (
          <Loader2 className="size-3 flex-none animate-spin" />
        )}
        <span>{groupedToolTitle(tool, calls.length)}</span>
        {status === 'interrupted' ? (
          <span className="flex-none font-normal italic">[step interrupted]</span>
        ) : null}
        <ChevronRight className={cn('size-3 flex-none opacity-60 transition-transform', open && 'rotate-90')} />
      </button>
      {open ? (
        <div className="ml-3 mt-1 flex flex-col gap-1 border-l pl-2">
          {calls.map((call) => (
            <ToolRow key={call.id} call={call} defaultOpen={defaultOpen} fillWidth={fillWidth} onOpen={onOpen} />
          ))}
        </div>
      ) : null}
    </div>
  );
};

export const ToolRollup = ({
  messageId,
  blocks,
  expandToolCalls,
  onOpen,
  streaming,
}: {
  messageId: string;
  blocks: ToolBlock[];
  expandToolCalls: boolean;
  onOpen?: (image: ViewerImage) => void;
  streaming: boolean;
}) => {
  const count = countToolCalls(blocks);
  const [open, setOpen] = useExpansion(`rollup:${messageId}`, false);
  const label = foldedToolsLabel(count, { live: streaming });
  if (count === 0) return null;
  const status = blocks.some((block) => block.calls.some((call) => call.status === 'error'))
    ? 'error'
    : blocks.some((block) => block.calls.some((call) => call.status === 'running' || call.status === 'pending'))
      ? 'running'
      : blocks.some((block) => block.calls.some((call) => call.status === 'interrupted'))
        ? 'interrupted'
        : 'completed';
  return (
    <div className="flex w-full max-w-[85%] flex-col self-start">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          'flex items-center gap-2 rounded-md px-1 py-0.5 text-left text-[11.5px] text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          status === 'error' && 'text-destructive'
        )}
      >
        {status === 'completed' ? (
          <Check className="size-3 flex-none text-success" />
        ) : status === 'error' ? (
          <CircleAlert className="size-3 flex-none" />
        ) : status === 'interrupted' ? (
          <Ban className="size-3 flex-none text-warning" />
        ) : (
          <Loader2 className="size-3 flex-none animate-spin" />
        )}
        <span>{label}</span>
        <ChevronRight className={cn('size-3 flex-none opacity-60 transition-transform', open && 'rotate-90')} />
      </button>
      {open ? (
        <div className="ml-3 mt-1 flex flex-col gap-1 border-l pl-2">
          {blocks.map((block) => (
            <ToolGroupRow
              key={block.id}
              tool={block.tool}
              calls={block.calls}
              fillWidth
              defaultOpen={expandToolCalls}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};
