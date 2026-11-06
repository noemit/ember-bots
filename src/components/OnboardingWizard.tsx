import * as React from 'react';
import { ArrowRight, Check, CircleAlert, FolderOpen, KeyRound, Loader2, PlugZap, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Blob from '../blob/Blob';
import LocalTokenSettings from './LocalTokenSettings';
import ProvidersSettings from './ProvidersSettings';
import { cn } from '@/lib/utils';
import {
  canFinish,
  isCompactStep,
  stepStates,
  stepsFor,
  workspaceHint,
  type OnboardingState,
  type OnboardingStep,
  type OnboardingStepId,
} from '@/lib/onboarding';
import type { EmberSettingsPatch, Instance, LocalHarnessToken, PiEndpoint } from '../types';

type Props = {
  open: boolean;
  state: OnboardingState;
  /** The sentence from `localHarnessNotice` when the local host did not start. */
  localProblem: string | null;
  instances: Instance[];
  endpoints: PiEndpoint[];
  /** The folder root Kiln resolved (or the wizard asked for); shown, and used for the first agent. */
  workspaceRoot: string | null;
  onDismiss: () => void;
  onRetryLocal: () => Promise<void>;
  onRefreshInstances: () => void;
  onChange: (patch: EmberSettingsPatch) => void;
  onStartAgent: (input: { instanceId: string; directory: string | null }) => void;
  loadToken?: (options?: { rotate?: boolean }) => Promise<LocalHarnessToken>;
};

const stepIcon = (id: OnboardingStepId) => {
  switch (id) {
    case 'welcome':
      return Sparkles;
    case 'connection':
      return PlugZap;
    case 'token':
      return KeyRound;
    case 'instance':
      return PlugZap;
    case 'providers':
      return KeyRound;
    case 'first-agent':
      return FolderOpen;
  }
};

/**
 * The first-run guide.
 *
 * A full-window surface rather than a dialog over Home, because a dialog over an empty Home reads
 * as an error to clear. It is **dismissible from every step** (Esc included): the app behind it
 * works, and a guide that traps someone in a broken state is worse than no guide.
 *
 * Adaptive by design — see `lib/onboarding.ts` for the decisions. A person connected to one
 * computer never sees the container instructions, and the token step shrinks to a line.
 */
export default function OnboardingWizard({
  open,
  state,
  localProblem,
  instances,
  endpoints,
  workspaceRoot,
  onDismiss,
  onRetryLocal,
  onRefreshInstances,
  onChange,
  onStartAgent,
  loadToken,
}: Props) {
  const steps = React.useMemo(() => stepsFor(state), [state]);
  const [active, setActive] = React.useState<OnboardingStepId>('welcome');
  const [retrying, setRetrying] = React.useState(false);
  const marks = stepStates(state, localProblem);

  // Land on the step that needs attention: a failed connection is where the work is, a working
  // install belongs on the provider screen.
  React.useEffect(() => {
    if (!open) return;
    setActive(state.localReady ? 'providers' : 'connection');
  }, [open, state.localReady]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onDismiss]);

  if (!open) return null;

  const index = Math.max(0, steps.findIndex((step) => step.id === active));
  const step = steps[index] ?? steps[0];
  const last = index === steps.length - 1;
  const go = (next: OnboardingStepId) => setActive(next);
  const next = () => {
    const following = steps[index + 1];
    if (following) setActive(following.id);
    else onDismiss();
  };

  const retry = async () => {
    setRetrying(true);
    try { await onRetryLocal(); } finally { setRetrying(false); }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      data-testid="onboarding"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
    >
      <div className="flex h-[min(88vh,780px)] w-[min(96vw,1040px)] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl">
        <div className="flex items-center justify-between gap-4 border-b px-5 py-3">
          <h2 id="onboarding-title" className="text-[13px] font-semibold">
            Setting up Ember
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              Step {index + 1} of {steps.length}
            </span>
            <Button size="xs" variant="ghost" onClick={onDismiss}>
              Skip for now
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* The plan, not tabs: a tick means done, a dot means not yet, and a warning is the one
              step whose failure changes what the rest of the list means. */}
          <ol className="flex w-[240px] flex-none flex-col gap-0.5 border-r bg-muted/20 p-2" aria-label="Setup steps">
            {steps.map((entry: OnboardingStep, position) => {
              const mark = marks[entry.id];
              const Icon = stepIcon(entry.id);
              const current = entry.id === step.id;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => go(entry.id)}
                    aria-current={current ? 'step' : undefined}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                      current ? 'bg-background shadow-sm' : 'hover:bg-background/60'
                    )}
                  >
                    <span className="mt-0.5 flex-none">
                      {mark.kind === 'done' ? (
                        <Check className="size-3.5 text-success" />
                      ) : mark.kind === 'failed' ? (
                        <CircleAlert className="size-3.5 text-destructive" />
                      ) : (
                        <Icon className={cn('size-3.5', current ? 'text-foreground' : 'text-muted-foreground')} />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className={cn('text-[12px]', current ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                        {position + 1}. {entry.title}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">{entry.summary}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {step.id === 'welcome' ? <Welcome /> : null}

              {step.id === 'connection' ? (
                <Connection
                  state={state}
                  problem={localProblem}
                  retrying={retrying}
                  onRetry={retry}
                  onGoToInstance={() => go('instance')}
                  workspaceRoot={workspaceRoot}
                />
              ) : null}

              {step.id === 'token' ? (
                <Token state={state} compact={isCompactStep('token', state)} loadToken={loadToken} />
              ) : null}

              {step.id === 'instance' ? (
                <InstanceStep
                  endpoints={endpoints}
                  instances={instances}
                  onChange={onChange}
                  onAdded={onRefreshInstances}
                />
              ) : null}

              {step.id === 'providers' ? (
                <Providers state={state} endpoints={endpoints} instances={instances} onChange={onChange} onRefreshInstances={onRefreshInstances} />
              ) : null}

              {step.id === 'first-agent' ? (
                <FirstAgent
                  state={state}
                  instances={instances}
                  workspaceRoot={workspaceRoot}
                  onChange={onChange}
                  onStart={onStartAgent}
                />
              ) : null}
            </div>

            <div className="flex items-center gap-2 border-t px-5 py-3">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setActive(steps[Math.max(0, index - 1)]?.id ?? 'welcome')}
                disabled={index === 0}
              >
                Back
              </Button>
              <div className="flex-1" />
              {last || (canFinish(state) && step.id === 'first-agent') ? null : (
                <span className="text-[11px] text-muted-foreground">
                  {marks[step.id]?.kind === 'pending' ? 'You can finish this later' : ''}
                </span>
              )}
              <Button size="sm" onClick={last ? onDismiss : next} data-testid="onboarding-next">
                {last ? 'Done' : canFinish(state) && step.id === 'providers' ? 'Continue' : 'Next'}
                <ArrowRight />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        {/* The real blob, not an illustration: what you see here is what the rail looks like after. */}
        <div className="flex-none rounded-2xl bg-muted/40 p-2">
          <Blob style="buddy" seed="onboarding" size={72} mood="thinking" interactive={false} />
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="text-[15px] font-semibold">Ember is your workspace (with blobs!)</h3>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Agents do the work. Ember is the window you watch them through, arranged the way you left it.
          </p>
        </div>
      </div>

      <p className="text-[12.5px] leading-relaxed">
        Every Kiln you connect is an <strong>instance</strong>: one on your laptop, maybe one in a container on a
        server. Ember lists them together and you work in whichever you like.{' '}
        <strong>Agents from different instances can even talk to each other if you ask them to.</strong>
      </p>

      <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
        <p className="text-[12.5px] font-medium">Kiln has pi-durable built in, which gives us some unique benefits:</p>
        <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-5 text-[12px] leading-relaxed text-muted-foreground">
          <li>
            a turn keeps running on its instance after you close Ember or your laptop sleeps —{' '}
            <strong className="text-foreground">except on your local instance</strong>, which we named{' '}
            <code className="rounded bg-background px-1 text-[11px]">local</code> so it's easy to spot. It has the
            same rules: it lives and dies with this computer.
          </li>
          <li>
            the conversation, its tool runs and its approvals are on the instance's disk, so it's easy to pick up work
            even if the computer hosting it suddenly shut down.
          </li>
          <li>an approval waits for you instead of failing the run.</li>
        </ul>
      </div>
    </div>
  );
}

function Connection({
  state,
  problem,
  retrying,
  onRetry,
  onGoToInstance,
  workspaceRoot,
}: {
  state: OnboardingState;
  problem: string | null;
  retrying: boolean;
  onRetry: () => void;
  onGoToInstance: () => void;
  workspaceRoot: string | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[15px] font-semibold">Is a harness running on this computer?</h3>

      {state.localReady ? (
        <div className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/5 px-3 py-2">
          <Check className="mt-0.5 size-4 flex-none text-success" />
          <div className="flex flex-col gap-0.5">
            <span className="text-[12.5px] font-medium">Connected to this computer</span>
            <span className="text-[11.5px] text-muted-foreground">
              Kiln is running on this computer and Ember holds its token.
              {workspaceRoot ? ` Work lives in ${workspaceRoot}.` : ''}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2">
          <div className="flex items-start gap-2">
            <CircleAlert className="mt-0.5 size-4 flex-none text-destructive" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[12.5px] font-medium">No harness is answering here</span>
              <span className="text-[11.5px] leading-relaxed text-muted-foreground">
                {problem ?? "Kiln isn't running on this computer, so there's nothing to connect to yet."}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pl-6">
            <Button size="xs" variant="secondary" onClick={onRetry} disabled={retrying}>
              {retrying ? <Loader2 className="animate-spin" /> : null}
              Retry
            </Button>
            <Button size="xs" variant="ghost" onClick={onGoToInstance}>
              Install Kiln on another machine
            </Button>
          </div>
        </div>
      )}

      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Ember ships with Kiln and starts it for you here. If you already run one in a container or on a server, you can
        connect to that instead — both work side by side.
      </p>
    </div>
  );
}

function Token({
  state,
  compact,
  loadToken,
}: {
  state: OnboardingState;
  compact: boolean;
  loadToken?: (options?: { rotate?: boolean }) => Promise<LocalHarnessToken>;
}) {
  const [expanded, setExpanded] = React.useState(!compact);
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[15px] font-semibold">Your token</h3>
      <p className="text-[12.5px] leading-relaxed">
        A <strong>token is a special password for computers to talk to each other.</strong> Kiln only answers clients
        that present its token.
      </p>
      {state.localReady ? (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Kiln is running here, and Ember already has its token — you only need to read it when you want to connect
          from another machine.
        </p>
      ) : null}
      {compact && !expanded ? (
        <Button size="xs" variant="secondary" onClick={() => setExpanded(true)}>
          Show it
        </Button>
      ) : (
        <LocalTokenSettings
          canRotate={state.canRotate}
          {...(loadToken ? { loadToken } : {})}
        />
      )}
    </div>
  );
}

function InstanceStep({
  endpoints,
  instances,
  onChange,
  onAdded,
}: {
  endpoints: PiEndpoint[];
  instances: Instance[];
  onChange: (patch: EmberSettingsPatch) => void;
  onAdded: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[15px] font-semibold">Connect another machine</h3>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        Working just on your current computer, with no containers or remotes? Skip this. You can add instances any time
        in Settings → Instances.
      </p>
      <div className="rounded-lg border bg-muted/20 px-3 py-2.5 text-[11.5px] leading-relaxed">
        <p className="mb-1.5 font-medium text-foreground">In a container or on a server</p>
        <pre className="overflow-x-auto rounded bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed">
{`curl -fsSL https://raw.githubusercontent.com/noemit/ember-bots/main/cli/ember.ts -o tinder
bun tinder setup --headless
bun tinder token`}
        </pre>
        <p className="mt-1.5 text-muted-foreground">
          Running the <code className="rounded bg-background px-1">token</code> command prints the token — the password
          you need to connect to it. Paste it below.
        </p>
      </div>
      <EndpointsInline endpoints={endpoints} instances={instances} onChange={onChange} onAdded={onAdded} />
    </div>
  );
}

function EndpointsInline({
  endpoints,
  instances,
  onChange,
  onAdded,
}: {
  endpoints: PiEndpoint[];
  instances: Instance[];
  onChange: (patch: EmberSettingsPatch) => void;
  onAdded: () => void;
}) {
  const EndpointsSettings = React.lazy(() => import('./EndpointsSettings'));
  return (
    <React.Suspense fallback={<span className="text-[11.5px] text-muted-foreground">Loading…</span>}>
      <EndpointsSettings endpoints={endpoints} instances={instances} onChange={onChange} onRefreshInstances={onAdded} />
    </React.Suspense>
  );
}

function Providers({
  state,
  endpoints,
  instances,
  onChange,
  onRefreshInstances,
}: {
  state: OnboardingState;
  endpoints: PiEndpoint[];
  instances: Instance[];
  onChange: (patch: EmberSettingsPatch) => void;
  onRefreshInstances: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[15px] font-semibold">Give it a model</h3>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        An instance can't run anything until one provider has a credential. Sign in where a sign-in exists; paste a key
        everywhere else. Local runtimes (Ollama, LM Studio) need no account at all — Ember lists them when they're
        running.
      </p>
      <ProvidersSettings
        endpoints={endpoints}
        instances={instances}
        onProviderChange={() => onRefreshInstances()}
        {...(state.targetInstanceId ? { initialEndpointId: state.targetInstanceId } : {})}
      />
      <p className="text-[11px] text-muted-foreground">
        You can change all of this later in Settings → Providers ({String(onChange === undefined ? '' : 'it saves as you go')}).
      </p>
    </div>
  );
}

function FirstAgent({
  state,
  instances,
  workspaceRoot,
  onChange,
  onStart,
}: {
  state: OnboardingState;
  instances: Instance[];
  workspaceRoot: string | null;
  onChange: (patch: EmberSettingsPatch) => void;
  onStart: (input: { instanceId: string; directory: string | null }) => void;
}) {
  const target = state.targetInstanceId ?? instances[0]?.id ?? null;
  const label = instances.find((instance) => instance.id === target)?.label ?? null;
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[15px] font-semibold">Start your first agent</h3>
      <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
        <p className="text-[12px] text-muted-foreground">Agents start in</p>
        <p className="mt-0.5 font-mono text-[12.5px]">{workspaceRoot ?? '(no folder set)'}</p>
        {workspaceRoot ? (
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">{workspaceHint(workspaceRoot)}</p>
        ) : null}
      </div>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Nothing is sent until you type. Ember opens a new agent and leaves the message box to you.
      </p>
      <div>
        <Button
          size="sm"
          disabled={!target}
          onClick={() => {
            if (!target) return;
            // Persist the folder as this instance's default so the draft prefills it: the choice made
            // here is what the composer will offer next time, without a second dialog asking again.
            if (workspaceRoot) {
              onChange({ instanceDefaults: { [target]: { directory: workspaceRoot } } });
            }
            onStart({ instanceId: target, directory: workspaceRoot });
          }}
        >
          New agent{label ? ` on ${label}` : ''}
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}
