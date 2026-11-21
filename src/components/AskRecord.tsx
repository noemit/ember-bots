import { useContext } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import type { ToolCall } from '../types';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import Linkify from './Linkify';
import { QuestionLinkContext } from './questionLinkContext';

/** A successful create records delivery to Questions, not the question's current status. */
const questionReceiptId = (call: ToolCall): string | null => {
  if (call.input?.action !== 'create' || call.status !== 'completed' || call.error || !call.output) return null;
  try {
    const receipt = JSON.parse(call.output);
    return receipt?.created === true && typeof receipt.conversationId === 'string' && typeof receipt.key === 'string'
      ? `${receipt.conversationId}:${receipt.key}`
      : null;
  } catch {
    return null;
  }
};

/** Durable question record; unanswered blocking asks are owned by the interactive QuestionCard. */
const AskRecord = ({ call }: { call: ToolCall }) => {
  const links = useContext(QuestionLinkContext);
  const receiptId = questionReceiptId(call);
  const open = receiptId ? links?.(receiptId) : undefined;
  const input = call.input ?? {};
  const question = typeof input.question === 'string' ? input.question : '';
  const detail = call.output?.trim() || call.error?.trim() || '';
  if (!question || !detail) return null;
  const options = Array.isArray(input.options)
    ? (input.options as unknown[]).filter((option): option is string => typeof option === 'string')
    : [];
  const legacy = input.action === undefined;
  const answered = legacy ? /^The user answered:\s*([\s\S]+)$/.exec(detail) : null;
  const answer = answered?.[1]?.trim() || null;
  const dismissed = legacy && !answer && /dismiss/i.test(detail);
  return (
    <div className="flex max-w-[85%] flex-col gap-1.5 self-start rounded-lg border border-highlight/30 bg-highlight/[0.04] px-3.5 py-2.5 text-[12.5px]">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <MessageCircleQuestion className="size-3.5 flex-none text-highlight" />
        <span>The bot asked</span>
      </div>
      <p className="whitespace-pre-wrap">
        <Linkify text={question} />
      </p>
      {!receiptId && options.length ? (
        <div className="flex flex-wrap gap-1">
          {options.map((option) => (
            <span
              key={option}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11.5px]',
                answer === option
                  ? 'border-highlight/60 bg-highlight/10 font-medium text-foreground'
                  : 'border-border text-muted-foreground'
              )}
            >
              {option}
            </span>
          ))}
        </div>
      ) : null}
      <p className="text-[11.5px] text-muted-foreground">
        {answer ? (
          <>
            You answered:{' '}
            <span className="font-medium text-foreground">
              <Linkify text={answer} />
            </span>
          </>
        ) : receiptId ? (
          open ? (
            <Button type="button" size="xs" variant="outline" onClick={open}>Open in Questions</Button>
          ) : 'The bot sent this question to Questions.'
        ) : dismissed ? (
          'You dismissed this question.'
        ) : call.status === 'interrupted' ? (
          'The question was interrupted.'
        ) : (
          detail.slice(0, 200)
        )}
      </p>
    </div>
  );
};

export default AskRecord;
