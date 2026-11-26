import * as React from 'react';
import { motion } from 'motion/react';
import { Check, Loader2, MessageCircleQuestion, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { approvalCommand } from '../../lib/permissionRules';
import { permissionDescription, permissionDetail } from '../../lib/piMapping';
import { isPiInstance } from '../../piApi';
import type {
  PermissionReply,
  PermissionRequest,
  QuestionAnswers,
  QuestionInfo,
  QuestionRequest,
  Session,
} from '../../types';
import Linkify from '../Linkify';
import { SimilarPermissionDialog } from '../PermissionRules';
import YoloLabel from '../YoloLabel';
import { spring } from './expansion';

export const PermissionCard = ({
  request,
  onReply,
}: {
  request: PermissionRequest;
  onReply: (reply: PermissionReply) => Promise<boolean>;
}) => {
  const [busy, setBusy] = React.useState<PermissionReply | null>(null);
  const [similarOpen, setSimilarOpen] = React.useState(false);
  const statusRef = React.useRef<HTMLParagraphElement>(null);
  const similarTrigger = React.useRef<HTMLButtonElement>(null);
  const [remembered, setRemembered] = React.useState(false);
  const detail = permissionDetail(request) || approvalCommand(request);
  const description = permissionDescription(request);
  const canRememberSimilar = isPiInstance(request.instanceId) && request.permission.trim().toLowerCase() === 'bash';

  const reply = async (value: PermissionReply) => {
    setBusy(value);
    if (!(await onReply(value))) setBusy(null);
  };

  if (remembered) {
    return <p ref={statusRef} tabIndex={-1} role="status" className="p-3 text-sm text-muted-foreground outline-none">Kiln saved the rule and allowed this command once.</p>;
  }
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={spring}
    >
      <Card className="border-warning/40 bg-warning/5 text-[13px]">
        <CardContent className="flex flex-col gap-2 p-3.5">
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-4 flex-none text-warning" />
            <span className="font-medium">Approval needed</span>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {request.permission}
            </span>
          </div>
          {description ? <p className="text-[12px] text-muted-foreground">{description}</p> : null}
          {detail ? (
            <pre className="max-h-48 overflow-auto rounded-md bg-background/80 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all">
              {detail}
            </pre>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <Button size="xs" disabled={busy !== null} onClick={() => void reply('once')}>
              {busy === 'once' ? <Loader2 className="animate-spin" /> : <Check />}
              Allow once
            </Button>
            {canRememberSimilar ? (
              <Button ref={similarTrigger} size="xs" variant="outline" disabled={busy !== null} onClick={() => setSimilarOpen(true)}>
                Allow similar…
              </Button>
            ) : null}
            <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => void reply('reject')}>
              {busy === 'reject' ? <Loader2 className="animate-spin" /> : null}
              Deny
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-warning/20 pt-2">
            <Button
              size="xs"
              variant="secondary"
              className="border border-warning/50 bg-warning/10 text-warning hover:bg-warning/20"
              title="Automatically approve all tools in this conversation, even while Ember is closed"
              disabled={busy !== null}
              onClick={() => void reply('always')}
            >
              {busy === 'always' ? <Loader2 className="animate-spin" /> : null}
              Switch to <YoloLabel /> mode
            </Button>
            <span className="text-xs text-muted-foreground">Approves every tool in this conversation.</span>
          </div>
          {similarOpen ? (
            <SimilarPermissionDialog
              request={request}
              onClose={() => setSimilarOpen(false)}
              onReturnFocus={() => {
                if (similarTrigger.current) similarTrigger.current.focus();
                else statusRef.current?.focus();
              }}
              onSaved={() => {
                setRemembered(true);
                window.dispatchEvent(new CustomEvent('ember:permission-rules-changed', { detail: { id: request.id, instanceId: request.instanceId } }));
              }}
            />
          ) : null}
        </CardContent>
      </Card>
    </motion.div>
  );
};

type Draft = { picked: string[]; custom: string };

export const QuestionCard = ({
  request,
  onAnswer,
  source,
  onOpenThread,
}: {
  source?: Session;
  onOpenThread?: (source: Session) => void;
  request: QuestionRequest;
  onAnswer: (answers: QuestionAnswers | null) => Promise<boolean>;
}) => {
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [drafts, setDrafts] = React.useState<Draft[]>(() =>
    request.questions.map(() => ({ picked: [], custom: '' }))
  );

  const update = (index: number, patch: Partial<Draft>) =>
    setDrafts((prev) => prev.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));

  const toggle = (index: number, question: QuestionInfo, label: string) => {
    const draft = drafts[index];
    const picked = question.multiple
      ? draft.picked.includes(label)
        ? draft.picked.filter((entry) => entry !== label)
        : [...draft.picked, label]
      : [label];
    update(index, { picked, custom: '' });
  };

  const answerFor = (draft: Draft): string[] =>
    draft.custom.trim() ? [draft.custom.trim()] : draft.picked;
  const complete = drafts.every((draft) => answerFor(draft).length > 0);

  const submit = async () => {
    if (!complete) return;
    setFailed(false);
    setBusy(true);
    if (!(await onAnswer(drafts.map(answerFor)))) {
      setBusy(false);
      setFailed(true);
    }
  };

  const dismiss = async () => {
    setFailed(false);
    setBusy(true);
    if (!(await onAnswer(null))) {
      setBusy(false);
      setFailed(true);
    }
  };

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={spring}
    >
      <Card className="border-highlight/40 bg-highlight/5 text-[13px]">
        <CardContent className="flex flex-col gap-3 p-3.5">
          <div className="flex items-center gap-2">
            <MessageCircleQuestion className="size-4 flex-none text-highlight" />
            <span className="font-medium">
              {source ? `Thread: ${source.title?.trim() || source.id}` : 'The bot has a question'}
            </span>
            {source && onOpenThread ? (
              <Button size="xs" variant="ghost" className="ml-auto" onClick={() => onOpenThread(source)}>
                Open thread
              </Button>
            ) : null}
          </div>

          {request.questions.map((question, index) => {
            const draft = drafts[index];
            return (
              <div key={index} className="flex flex-col gap-1.5">
                {request.questions.length > 1 && question.header ? (
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {question.header}
                  </span>
                ) : null}
                <p className="whitespace-pre-wrap">
                  <Linkify text={question.question} />
                </p>
                <div className="flex flex-col gap-1">
                  {question.options.map((option) => {
                    const picked = draft.picked.includes(option.label) && !draft.custom.trim();
                    return (
                      <button
                        key={option.label}
                        type="button"
                        disabled={busy}
                        onClick={() => toggle(index, question, option.label)}
                        aria-pressed={picked}
                        className={cn(
                          'flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-colors',
                          picked ? 'border-highlight/60 bg-highlight/10' : 'border-border hover:bg-muted/60'
                        )}
                      >
                        <span
                          className={cn(
                            'mt-[3px] flex size-3.5 flex-none items-center justify-center border',
                            question.multiple ? 'rounded-[3px]' : 'rounded-full',
                            picked
                              ? 'border-highlight bg-highlight text-highlight-foreground'
                              : 'border-muted-foreground/50'
                          )}
                        >
                          {picked ? <Check className="size-2.5" /> : null}
                        </span>
                        <span className="flex min-w-0 flex-col">
                          <span className="text-[12.5px]">{option.label}</span>
                          {option.description ? (
                            <span className="text-[11.5px] text-muted-foreground">{option.description}</span>
                          ) : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {question.custom !== false ? (
                  <Input
                    value={draft.custom}
                    disabled={busy}
                    aria-label={question.header ? `${question.header} custom answer` : 'Custom answer'}
                    placeholder="Or type your own answer…"
                    onChange={(event) => update(index, { custom: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void submit();
                      }
                    }}
                    className="h-8 text-xs shadow-none"
                  />
                ) : null}
              </div>
            );
          })}

          {failed ? (
            <p role="alert" className="text-xs text-destructive">
              The host did not confirm this question’s reply. Your answer is still here; try Answer or Dismiss again.
            </p>
          ) : null}
          <div className="flex items-center gap-1.5">
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void dismiss()}>
              Dismiss
            </Button>
            <div className="flex-1" />
            <Button size="xs" disabled={busy || !complete} onClick={() => void submit()}>
              {busy ? <Loader2 className="animate-spin" /> : <Check />}
              Answer
            </Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
};
