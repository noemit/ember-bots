import * as React from 'react';
import type { QuestionAnswers, QuestionRequest } from '../types';
import { questionKey } from '../lib/threadQuestions';
import { questionStatusLabel, questionSupervisor } from '../lib/asyncQuestions';
import { randomId } from '../lib/randomId';
import { Button } from './ui/button';

// A folded tray or switched column must not erase an unconfirmed answer or its retry identity.
type Draft = { text: string; mutation?: NonNullable<QuestionRequest['mutation']>; failed?: boolean };
const drafts = new Map<string, Draft>();

const QuestionRow = ({ request, onAnswer, onOpenSource, hostLabel }: {
  request: QuestionRequest;
  hostLabel: string;
  onAnswer: (request: QuestionRequest, answers: QuestionAnswers | null) => Promise<boolean>;
  onOpenSource?: (request: QuestionRequest) => void;
}) => {
  const key = questionKey(request);
  const [draft, setDraft] = React.useState<Draft>(() => drafts.get(key) ?? { text: '' });
  const [busy, setBusy] = React.useState(false);
  const id = React.useId();
  const update = (next: Draft) => { drafts.set(key, next); setDraft(next); };
  const pending = !request.status || request.status === 'pending';
  const act = async (action: 'answer' | 'withdraw' | 'resume') => {
    if (draft.mutation && draft.mutation.action !== action) return;
    const mutation = draft.mutation ?? { requestId: randomId(), revision: request.revision ?? 1, action };
    const next = { ...draft, mutation, failed: false };
    update(next);
    setBusy(true);
    try {
      const ok = await onAnswer({ ...request, mutation }, [[draft.text]]);
      if (ok) { drafts.delete(key); setDraft({ text: '' }); }
      else update({ ...next, failed: true });
    } catch { update({ ...next, failed: true }); }
    finally { setBusy(false); }
  };
  return (
    <article className="space-y-2 border-b border-border/50 py-3 last:border-0" aria-labelledby={id}>
      <div className="flex items-start justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{'Conversation ' + request.sessionId}</span>
        {onOpenSource ? <Button size="xs" variant="ghost" onClick={() => onOpenSource(request)}>Open source</Button> : null}
      </div>
      <p id={id} className="text-sm font-medium whitespace-pre-wrap">{request.questions.map((item) => item.question).join('\n')}</p>
      {request.context ? <p className="text-xs whitespace-pre-wrap text-muted-foreground">{request.context}</p> : null}
      {request.decision ? <p className="text-xs">Decision: {request.decision}</p> : null}
      {request.delivery?.holdReason ? <p className="text-xs text-muted-foreground">{request.delivery.holdReason}</p> : null}
      {request.recommendation ? <p className="text-xs whitespace-pre-wrap"><span className="font-medium">Recommendation: </span>{request.recommendation}</p> : null}
      <p className="text-xs text-muted-foreground" role="status">{questionStatusLabel(request)}</p>
      {request.answer || request.receipt?.answer ? <p className="text-sm whitespace-pre-wrap">Your answer: {request.answer || request.receipt?.answer}</p> : null}
      {pending ? <>
        <div className="flex flex-wrap gap-1">{request.questions[0]?.options.map((option) => <Button key={option.label} aria-pressed={draft.text === option.label} size="xs" variant="outline" disabled={busy || !!draft.mutation} onClick={() => update({ text: option.label })}>{option.label}</Button>)}</div>
        <label htmlFor={id + '-answer'} className="sr-only">Your answer to {request.questions[0]?.question}</label>
        <textarea maxLength={32000} id={id + '-answer'} value={draft.text} disabled={busy || !!draft.mutation || request.freeText === false} rows={2} className="w-full rounded-md border border-input bg-transparent p-2 text-sm" placeholder="Write your answer" onChange={(event) => update({ text: event.target.value })} />
        <Button size="sm" disabled={busy || !draft.text.trim() || !!draft.mutation} onClick={() => void act('answer')}>{busy ? 'Saving answer…' : 'Save answer'}</Button>
        {!draft.mutation ? <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act('withdraw')}>Withdraw question</Button> : null}
      </> : null}
      {request.status === 'answered' && request.delivery?.status === 'held' && !draft.mutation ? <div className="flex gap-2"><Button size="xs" disabled={busy} onClick={() => void act('resume')}>Resume with answer</Button><Button size="xs" variant="ghost" disabled={busy} onClick={() => void act('withdraw')}>Withdraw answer</Button></div> : null}
      {draft.failed ? <p role="alert" className="text-xs text-destructive">{hostLabel} did not confirm this change. Your answer is kept here. Use Retry to send the same request again.</p> : null}
      {draft.failed ? <Button size="xs" onClick={() => void act(draft.mutation?.action ?? 'answer')}>Retry {draft.mutation?.action === 'answer' ? 'answer' : draft.mutation?.action === 'withdraw' ? 'withdrawal' : 'resume'}</Button> : null}
      {draft.failed && request.revision !== draft.mutation?.revision ? <Button size="xs" variant="ghost" onClick={() => update({ text: draft.text })}>Review current revision and edit</Button> : null}
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Source and delivery history</summary><div className="space-y-1 pt-2"><p>Revision {request.revision ?? 1}</p>{request.ancestry?.map((item) => <p key={item.conversationId}>{item.title || item.conversationId}</p>)}{request.source ? <p className="whitespace-pre-wrap">Source: {request.source}</p> : null}{request.origin?.taskKey ? <p>Assignment: {request.origin.taskKey} · {request.origin.assignmentVersion}</p> : null}<p>{questionStatusLabel(request)}</p>{request.origin?.toolTaskId ? <p>Original tool request: {request.origin.toolTaskId}</p> : null}{request.receipt ? <><p>Answer saved: {new Date(request.receipt.at).toLocaleString()}</p><p>Receipt: {request.receipt.requestId}</p></> : null}{request.delivery?.admittedAt ? <p>Admitted: {new Date(request.delivery.admittedAt).toLocaleString()}</p> : null}{request.delivery?.submissionId ? <p>Delivery reference: {request.delivery.submissionId}</p> : null}</div></details>
    </article>
  );
};

export default function QuestionsShelf({ requests, sessionId, onAnswer, onOpenSource, hostLabel = 'Kiln' }: {
  requests: QuestionRequest[]; sessionId: string; hostLabel?: string;
  onAnswer: (request: QuestionRequest, answers: QuestionAnswers | null) => Promise<boolean>;
  onOpenSource?: (request: QuestionRequest) => void;
}) {
  const [limit, setLimit] = React.useState(20);
  const groups = new Map<string, QuestionRequest[]>();
  const priority = (request: QuestionRequest) => request.status === 'pending' ? 0 : request.delivery?.status === 'held' && request.status === 'answered' ? 1 : 2;
  [...requests].sort((a, b) => priority(a) - priority(b) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, limit).forEach((request) => { const name = questionSupervisor(request, sessionId); groups.set(name, [...(groups.get(name) ?? []), request]); });
  return <div className="max-h-80 overflow-y-auto px-1" aria-label="Questions"><p className="py-2 text-xs text-muted-foreground">Questions stay here while the bot continues. Saving an answer is not proof the bot has used it.</p>{[...groups].map(([name, rows]) => <section key={name} aria-label={name}><h3 className="pt-2 text-xs font-semibold">{name}</h3>{rows.map((request) => <QuestionRow key={questionKey(request)} request={request} hostLabel={hostLabel} onAnswer={onAnswer} onOpenSource={onOpenSource} />)}</section>)}{requests.length > limit ? <Button size="sm" variant="ghost" onClick={() => setLimit((value) => value + 20)}>Show 20 more questions</Button> : null}</div>;
}
