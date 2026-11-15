import * as React from 'react';
import type { QuestionAnswers, QuestionRequest } from '../types';
import { questionKey } from '../lib/threadQuestions';
import { questionFollowups, questionSourceMessage, questionStatusLabel, questionSupervisor } from '../lib/asyncQuestions';
import { randomId } from '../lib/randomId';
import { Button } from './ui/button';
import { questionDrafts, type AsyncQuestionDraft as Draft } from '../lib/asyncQuestionDrafts';
type Answer = (request: QuestionRequest, answers: QuestionAnswers | null) => Promise<boolean>;

const QuestionRow = ({ request, followups, onAnswer, onOpenSource, hostLabel }: {
  request: QuestionRequest; followups: QuestionRequest[]; hostLabel: string;
  onAnswer: Answer; onOpenSource?: (request: QuestionRequest) => void;
}) => {
  const key = questionKey(request);
  const subscribe = React.useCallback((listener: () => void) => questionDrafts.subscribe(key, listener), [key]);
  const getDraft = React.useCallback(() => questionDrafts.get(key), [key]);
  const draft = React.useSyncExternalStore(subscribe, getDraft, getDraft);
  const [busy, setBusy] = React.useState(false);
  const sending = React.useRef(false);
  const id = React.useId();
  const update = (next: Draft) => questionDrafts.put(key, next);
  const pending = (!request.status || request.status === 'pending') && !draft.accepted;
  const sentAnswer = request.receipt?.answer ?? request.answer ?? draft.accepted;
  const answerConflict = draft.mutation?.action === 'answer' && request.status === 'answered' && request.receipt && request.receipt.requestId !== draft.mutation.requestId;
  React.useEffect(() => {
    const mutation = draft.mutation;
    if (!mutation) return;
    const receipts = mutation.action === 'context' ? followups.map(item => item.receipt) : [request.receipt];
    const confirmed = receipts.some(receipt => receipt?.requestId === mutation.requestId && receipt.revision === mutation.revision && receipt.answer === draft.text);
    if (!confirmed) return;
    const next: Draft = { text: '', accepted: sentAnswer };
    questionDrafts.settle(key, mutation.requestId, next);
  }, [draft.mutation, draft.text, followups, key, request.receipt, sentAnswer]);
  const act = async (action: 'answer' | 'withdraw' | 'context') => {
    if (sending.current || (draft.mutation && draft.mutation.action !== action)) return;
    const mutation = draft.mutation ?? { requestId: randomId(), revision: request.revision ?? 1, action };
    const next = { ...draft, mutation, failed: false };
    update(next); sending.current = true; setBusy(true);
    try {
      const ok = await onAnswer({ ...request, mutation }, [[draft.text]]);
      if (ok) {
        const accepted = action === 'answer' ? draft.text : sentAnswer;
        questionDrafts.settle(key, mutation.requestId, accepted ? { text: '', accepted } : undefined);
      } else questionDrafts.settle(key, mutation.requestId, { ...next, failed: true });
    } catch { questionDrafts.settle(key, mutation.requestId, { ...next, failed: true }); }
    finally { sending.current = false; setBusy(false); }
  };
  return <article className="space-y-2 border-b border-border/50 py-3 last:border-0" aria-labelledby={id}>
    <div className="flex items-start justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{request.sourceTitle || request.assignment?.title || 'Conversation ' + request.sessionId}</span>
      {onOpenSource ? <Button size="xs" variant="ghost" onClick={() => onOpenSource(request)}>{questionSourceMessage(request) ? 'Go to question' : 'Open source chat'}</Button> : null}
    </div>
    <p id={id} className="text-sm font-medium whitespace-pre-wrap">{request.questions.map(item => item.question).join('\n')}</p>
    {request.context ? <p className="text-xs whitespace-pre-wrap text-muted-foreground">{request.context}</p> : null}
    {request.decision ? <p className="text-xs">Decision: {request.decision}</p> : null}
    {request.recommendation ? <p className="text-xs whitespace-pre-wrap"><span className="font-medium">Recommendation: </span>{request.recommendation}</p> : null}
    <p className="text-xs text-muted-foreground" role="status">{questionStatusLabel(draft.accepted && request.status === 'pending' ? { ...request, status: 'answered' } : request)}</p>
    {request.delivery?.holdReason ? <p className="text-xs text-muted-foreground">{request.delivery.holdReason}</p> : null}
    {sentAnswer ? <p className="text-sm whitespace-pre-wrap">Your answer: {sentAnswer}</p> : null}
    {followups.length ? <ol aria-label="Additional context" className="space-y-3 border-l border-border pl-3">{followups.map(item => <li key={questionKey(item)}>
      <p className="text-sm whitespace-pre-wrap">{item.receipt?.answer ?? item.answer}</p>
      <p className="text-xs text-muted-foreground">{questionStatusLabel(item)}</p>
      {item.delivery?.holdReason ? <p className="text-xs text-muted-foreground">{item.delivery.holdReason}</p> : null}
    </li>)}</ol> : null}
    {pending || draft.adding ? <>
      {pending ? <div className="flex flex-wrap gap-1">{request.questions[0]?.options.map(option => <Button key={option.label} aria-pressed={draft.text === option.label} size="xs" variant="outline" disabled={busy || !!draft.mutation} onClick={() => update({ text: option.label })}>{option.label}</Button>)}</div> : null}
      <label htmlFor={id + '-answer'} className="sr-only">{pending ? 'Your answer to ' : 'Additional context for '}{request.questions[0]?.question}</label>
      <textarea maxLength={32000} id={id + '-answer'} value={draft.text} disabled={busy || !!draft.mutation || (pending && request.freeText === false)} rows={2} className="w-full rounded-md border border-input bg-transparent p-2 text-sm" placeholder={pending ? 'Write your answer' : 'Add context without changing your original answer'} onChange={event => update({ ...draft, text: event.target.value })} />
      <Button size="sm" disabled={busy || !draft.text.trim() || !!draft.mutation} onClick={() => void act(pending ? 'answer' : 'context')}>{busy ? 'Sending…' : 'Send'}</Button>
      {pending && !draft.mutation ? <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act('withdraw')}>Withdraw question</Button> : null}
    </> : null}
    {!pending && request.status === 'answered' && !draft.adding && !draft.mutation && followups.length < 100 ? <Button size="xs" variant="ghost" onClick={() => update({ text: '', accepted: sentAnswer, adding: true })}>Add more context</Button> : null}
    {followups.length >= 100 ? <p className="text-xs text-muted-foreground">This question has 100 additional messages. Open its source chat to continue.</p> : null}
    {draft.failed ? <><p role="alert" className="text-xs text-destructive">{answerConflict ? `${hostLabel} already has an answer to this question. Your draft was not sent; you can keep it as more context below.` : `${hostLabel} did not confirm this change. Your text is kept here. Use Retry to send the same request again.`}</p>{!answerConflict ? <Button size="xs" disabled={busy} onClick={() => void act(draft.mutation?.action === 'context' ? 'context' : draft.mutation?.action === 'withdraw' ? 'withdraw' : 'answer')}>Retry</Button> : null}</> : null}
    {draft.failed && request.revision !== draft.mutation?.revision ? <Button size="xs" variant="ghost" onClick={() => update({ text: draft.text, adding: !pending })}>{request.status === 'answered' ? 'Keep this draft as more context' : 'Edit this draft'}</Button> : null}
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Source and delivery history</summary><div className="space-y-1 pt-2">
      {request.ancestry?.map(item => <p key={item.conversationId}>{item.title || 'Conversation ' + item.conversationId}</p>)}
      {request.source ? <p className="whitespace-pre-wrap">Source: {request.source}</p> : null}
      {!questionSourceMessage(request) ? <p>Kiln has no saved link to this question’s original message.</p> : null}
      {request.origin?.taskKey ? <p>Assignment: {request.origin.taskKey}</p> : null}
      {request.receipt ? <p>Sent: {new Date(request.receipt.at).toLocaleString()}</p> : null}
      {request.delivery?.admittedAt ? <p>Accepted for delivery: {new Date(request.delivery.admittedAt).toLocaleString()}</p> : null}
      <p>Sending does not confirm the bot has used your answer. Held answers never restart stopped or explicitly completed tasks. Open the source chat to decide how to continue.</p>
    </div></details>
  </article>;
};

export default function QuestionsShelf({ requests, sessionId, onAnswer, onOpenSource, hostLabel = 'Kiln' }: {
  requests: QuestionRequest[]; sessionId: string; hostLabel?: string; onAnswer: Answer;
  onOpenSource?: (request: QuestionRequest) => void;
}) {
  const [limit, setLimit] = React.useState(20);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const roots = requests.filter(request => !request.replyTo);
  const active = roots.filter(request => request.status === 'pending');
  const history = roots.filter(request => request.status !== 'pending').sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const answer: Answer = async (request, answers) => {
    const ok = await onAnswer(request, answers);
    setHistoryOpen(true);
    return ok;
  };
  const render = (rows: QuestionRequest[]) => {
    const groups = new Map<string, QuestionRequest[]>();
    rows.forEach(request => { const name = questionSupervisor(request, sessionId); groups.set(name, [...(groups.get(name) ?? []), request]); });
    return [...groups].map(([name, grouped]) => <section key={name} aria-label={name}><h3 className="pt-2 text-xs font-semibold">{name}</h3>{grouped.map(request => <QuestionRow key={questionKey(request)} request={request} followups={questionFollowups(request, requests)} hostLabel={hostLabel} onAnswer={answer} onOpenSource={request.sessionId === sessionId && !questionSourceMessage(request) ? undefined : onOpenSource} />)}</section>);
  };
  return <div className="max-h-80 overflow-y-auto px-1" aria-label="Questions">
    <p className="py-2 text-xs text-muted-foreground">Answer once, then add more context if you need to. The bot can keep working while you decide.</p>
    {render(active)}
    {history.length ? <details open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary className="cursor-pointer py-2 text-xs text-muted-foreground">Answered and closed ({history.length})</summary>{render(history.slice(0, limit))}{history.length > limit ? <Button size="sm" variant="ghost" onClick={() => setLimit(value => value + 20)}>Show 20 more questions</Button> : null}</details> : null}
  </div>;
}
