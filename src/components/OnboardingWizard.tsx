import * as React from 'react';
import { ArrowLeftRight, Boxes, Cpu, Laptop, Monitor, ArrowRight, Check, CircleAlert, FolderOpen, KeyRound, Loader2, PlugZap, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Blob from '../blob/Blob';
import LocalTokenSettings from './LocalTokenSettings';
import ProvidersSettings from './ProvidersSettings';
import { copyText } from '@/lib/clipboard';
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
  startAtWelcome?: boolean;
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
  startAtWelcome = false,
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

  const hasOpened = React.useRef(false);
  React.useEffect(() => {
    if (!open) { hasOpened.current = false; return; }
    if (hasOpened.current) return;
    hasOpened.current = true;
    setActive(startAtWelcome ? 'welcome' : state.localReady ? 'providers' : 'connection');
  }, [open, startAtWelcome, state.localReady]);

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
      className="fixed inset-0 z-50 isolate overflow-hidden bg-background text-base [&_button]:text-base"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
        style={{ backgroundImage: 'radial-gradient(ellipse at 100% 0%, rgba(249,115,22,0.24), transparent 55%), radial-gradient(ellipse at 0% 100%, rgba(245,158,11,0.18), transparent 50%), radial-gradient(ellipse at 65% 75%, rgba(167,139,250,0.12), transparent 55%)' }}>
        <div className="absolute -right-24 -top-24 rotate-12 opacity-30 blur-[48px]">
          <Blob style="lava" seed="onboarding-fireglow" size={400} mood="idle" interactive={false} />
        </div>
        <div className="absolute -bottom-24 -left-20 -rotate-12 opacity-20 blur-[40px]">
          <Blob style="crystal" seed="onboarding-crystalglow" size={340} mood="idle" interactive={false} />
        </div>
      </div>
      <div data-testid="onboarding-surface" className="flex h-full w-full flex-col">
        <div className="flex items-center justify-between gap-4 border-b border-border/60 bg-background/65 px-6 py-4 backdrop-blur-xl">
          <h2 id="onboarding-title" className="text-base font-semibold">
            Setting up Ember
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-base text-muted-foreground">
              Step {index + 1} of {steps.length}
            </span>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Skip for now
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* The plan, not tabs: a tick means done, a dot means not yet, and a warning is the one
              step whose failure changes what the rest of the list means. */}
          <ol className="flex w-[260px] flex-none flex-col gap-0.5 border-r border-border/60 bg-background/45 p-3 backdrop-blur-xl" aria-label="Setup steps">
            {steps.map((entry: OnboardingStep, position) => {
              const mark = marks[entry.id];
              const Icon = stepIcon(entry.id);
              const current = entry.id === step.id;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => setActive(entry.id)}
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
                      <span className={cn('text-base', current ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                        {position + 1}. {entry.title}
                      </span>
                      <span className="text-base leading-snug text-muted-foreground">{entry.summary}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background/50">
            <div className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
              {step.id === 'welcome' ? <Welcome /> : null}

              {step.id === 'connection' ? (
                <Connection
                  state={state}
                  problem={localProblem}
                  retrying={retrying}
                  onRetry={retry}
                  endpoints={endpoints}
                  instances={instances}
                  onChange={onChange}
                  onAdded={onRefreshInstances}
                  workspaceRoot={workspaceRoot}
                />
              ) : null}

              {step.id === 'token' ? (
                <Token state={state} compact={isCompactStep('token', state)} loadToken={loadToken} />
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

            <div className="flex items-center gap-2 border-t border-border/60 bg-background/65 px-6 py-4 backdrop-blur-xl">
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
                <span className="text-base text-muted-foreground">
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

function KilnDiagram() {
  const hosts = [
    { name: 'Container', detail: 'A separate space on a computer', Icon: Boxes },
    { name: 'Mac Studio', detail: 'A Mac you leave running', Icon: Cpu },
    { name: 'Old PC', detail: 'A spare computer', Icon: Monitor },
  ];
  return (
    <figure className="@container" aria-label="Ember connects to the included Kiln on your computer and Kilns on other computers">
      <div className="rounded-xl border bg-muted/20 p-3">
        <div className="mb-3 flex items-center gap-1.5 text-base font-medium text-muted-foreground">
          <Laptop className="size-3.5" aria-hidden="true" /> Your computer
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className="rounded-lg bg-highlight/10 px-3 py-2.5 text-center">
            <div className="text-base font-semibold">Ember</div>
            <div className="mt-0.5 text-base text-muted-foreground">Talk to your agents</div>
          </div>
          <ArrowLeftRight className="size-4 text-muted-foreground" aria-hidden="true" />
          <div className="rounded-lg bg-background px-3 py-2.5 text-center">
            <div className="text-base font-semibold">Kiln</div>
            <div className="mt-0.5 text-base text-muted-foreground">Does the work here</div>
          </div>
        </div>
      </div>
      <svg className="hidden h-9 w-full text-border @min-[420px]:block" viewBox="0 0 600 36" preserveAspectRatio="none" fill="none" aria-hidden="true">
        <path d="M150 0V14H100V36 M150 14H500V36 M300 14V36" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="my-2 text-center text-base text-muted-foreground @min-[420px]:hidden">Ember can also connect to:</p>
      <div className="grid gap-2 @min-[420px]:grid-cols-3">
        {hosts.map(({ name, detail, Icon }) => (
          <div key={name} className="min-w-0 rounded-xl border border-dashed bg-muted/10 p-3 text-center">
            <div className="flex items-center justify-center gap-1.5 text-base font-medium">
              <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />{name}
            </div>
            <p className="mt-1 text-base text-muted-foreground">{detail}</p>
            <div className="mt-2 rounded-lg bg-background py-2 text-base font-semibold">Kiln</div>
          </div>
        ))}
      </div>
      <figcaption className="mt-3 text-center text-base leading-relaxed text-muted-foreground">
        Start with this computer. Connect others whenever you need them.
      </figcaption>
    </figure>
  );
}

function Welcome() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <div className="flex-none p-2">
          <Blob style="buddy" seed="onboarding" size={56} mood="thinking" interactive={false} />
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="text-2xl font-semibold">Where the work happens</h3>
          <p className="text-base leading-relaxed text-muted-foreground">
            Ember takes its name from the embers that glow in a fire. Think of <strong className="text-foreground">Kiln</strong>{' '}
            as the hot, concentrated space where agents take action: editing files, running commands and carrying out your instructions.{' '}
            Think of <strong className="text-foreground">Ember</strong> as your connection to the powerful energy inside the kiln.
          </p>
        </div>
      </div>
      <p className="text-base leading-relaxed text-muted-foreground">
        <strong className="text-foreground">Ember is where you direct agents to do work, and observe the work they do.</strong>{' '}
        It connects to Kiln using a connection password and gives you a view of your conversations, each agent’s progress,
        their specific actions, what images they are looking at, errors they run into, what they are thinking
        (with models that support this), and more.
      </p>
      <KilnDiagram />
      <p className="text-base leading-relaxed text-muted-foreground">
        One Ember can connect to several Kilns — on this computer, in a container, on a Mac Studio or on an old PC.
        Each Kiln keeps its conversations and files on the computer doing the work. You can also use Ember on
        different computers to direct the same Kilns.
      </p>
    </div>
  );
}

function Connection({
  state,
  problem,
  retrying,
  onRetry,
  endpoints,
  instances,
  onChange,
  onAdded,
  workspaceRoot,
}: {
  state: OnboardingState;
  problem: string | null;
  retrying: boolean;
  onRetry: () => void;
  endpoints: PiEndpoint[];
  instances: Instance[];
  onChange: (patch: EmberSettingsPatch) => void;
  onAdded: () => void;
  workspaceRoot: string | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-2xl font-semibold">Choose where the work happens</h3>
      <p className="text-base leading-relaxed text-muted-foreground">
        Ember includes a Kiln on this computer, so you can start here. Agents using it edit files and run
        commands here. This Kiln stops when you quit Ember; its conversations stay on disk.
      </p>

      {state.localReady ? (
        <div className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/5 px-3 py-2">
          <Check className="mt-0.5 size-4 flex-none text-success" />
          <div className="flex flex-col gap-0.5">
            <span className="text-base font-medium">Connected to this computer</span>
            <span className="text-base text-muted-foreground">
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
              <span className="text-base font-medium">Kiln is not ready on this computer</span>
              <span className="text-base leading-relaxed text-muted-foreground">
                {problem ?? "Kiln isn't running on this computer, so there's nothing to connect to yet."}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pl-6">
            <Button size="sm" variant="secondary" onClick={onRetry} disabled={retrying}>
              {retrying ? <Loader2 className="animate-spin" /> : null}
              Retry
            </Button>
          </div>
        </div>
      )}

      <p className="text-base leading-relaxed text-muted-foreground">
        You can also give agents a separate place to work. A container provides a separate working environment;
        another computer also moves the workload off your personal computer. Kilns running separately can
        keep working after you quit Ember, as long as their computer stays on.
      </p>
      <RemoteSetup endpoints={endpoints} instances={instances} onChange={onChange} onAdded={onAdded} />
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
      <h3 className="text-base font-semibold">Your token</h3>
      <p className="text-base leading-relaxed">
        A <strong>token is a special password for computers to talk to each other.</strong> Kiln only answers clients
        that present its token.
      </p>
      {state.localReady ? (
        <p className="text-base leading-relaxed text-muted-foreground">
          Kiln is running here, and Ember already has its token — you only need to read it when you want to connect
          from another machine.
        </p>
      ) : null}
      {compact && !expanded ? (
        <Button size="sm" variant="secondary" onClick={() => setExpanded(true)}>
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

const TAILSCALE_PROMPT = `Help me connect Ember on my personal computer to a standalone Kiln on [other computer] using Tailscale. Check how Kiln is installed and whether Tailscale is available on both computers. Configure the connection, keep Kiln's password out of source files, and verify that Ember can connect. Finish by telling me which address to enter in Ember and where to find the connection password.`;

function SetupPrompt() {
  const [result, setResult] = React.useState('');
  return (
    <div className="mt-3 flex flex-col gap-2">
      <p className="font-medium text-foreground">Ask an agent to help</p>
      <p className="text-base leading-relaxed">Replace [other computer] with its name or description before using this prompt.</p>
      <p className="select-text rounded-md bg-background p-3 text-base leading-relaxed">{TAILSCALE_PROMPT}</p>
      <Button className="self-start" size="sm" variant="secondary" onClick={async () => {
        const ok = await copyText(TAILSCALE_PROMPT);
        setResult(ok ? 'Copied' : 'Ember could not copy the prompt. Select the text above and copy it manually.');
      }}>Copy setup prompt</Button>
      <span role="status" className="text-base">{result}</span>
    </div>
  );
}

function RemoteSetup({ endpoints, instances, onChange, onAdded }: {
  endpoints: PiEndpoint[];
  instances: Instance[];
  onChange: (patch: EmberSettingsPatch) => void;
  onAdded: () => void;
}) {
  const disclosure = 'rounded-lg border bg-muted/10 p-3 text-base leading-relaxed text-muted-foreground';
  const summary = 'cursor-pointer text-base font-medium text-foreground';
  return (
    <div className="flex flex-col gap-2">
      <details className={disclosure}>
        <summary className={summary}>Use Ember on another computer</summary>
        <p className="mt-3">
          Install Ember there to get its own included Kiln. That Kiln starts and stops with that copy of Ember.
          For a Kiln you can connect to from this window over the network, use Tinder below.
        </p>
      </details>
      <details className={disclosure}>
        <summary className={summary}>Run Kiln on its own with Tinder</summary>
        <p className="mt-3">
          Tinder is our launcher for Kiln without the Ember application. Download the matching Tinder executable
          from Ember’s releases and keep it in a permanent folder on the computer that will do the work.
        </p>
        <Button size="sm" variant="link" className="h-auto px-0" onClick={() => void window.ember.openExternal('https://github.com/noemit/ember-bots/releases')}>Ember and Tinder downloads</Button>
        <p className="mt-2">On macOS or Linux, name the downloaded executable tinder, open a terminal in its folder, and run:</p>
        <pre className="mt-2 overflow-x-auto rounded bg-background p-2 text-base">{`chmod +x ./tinder
./tinder serve --home ~/.ember-kiln --port 3003`}</pre>
        <p className="mt-2">Keep that terminal open. In a second terminal, print the connection password:</p>
        <pre className="mt-2 overflow-x-auto rounded bg-background p-2 text-base">./tinder token --home ~/.ember-kiln --port 3003</pre>
        <p className="mt-2">To run Kiln as a background service instead, use:</p>
        <pre className="mt-2 overflow-x-auto rounded bg-background p-2 text-base">./tinder setup --headless --home ~/.ember-kiln --port 3003</pre>
        <p className="mt-2">Tinder prints the command to enable and start that service. Follow it, then add the address and password below.</p>
      </details>
      <details className={disclosure}>
        <summary className={summary}>Connect over Tailscale</summary>
        <p className="mt-3">You don’t need this for the Kiln included on this computer. Use it to reach a separate Kiln on another computer.</p>
        <ol className="mt-2 list-decimal space-y-2 pl-5">
          <li>Install Tailscale on both computers and connect them to the same Tailscale network.</li>
          <li>Start Kiln with Tinder on the computer doing the work. For a container, make its Kiln port reachable from that computer’s Tailscale connection.</li>
          <li>Find that computer’s Tailscale address in the Tailscale app, or run <code>tailscale ip -4</code> there.</li>
          <li>Add the Kiln below using an address such as <code>http://100.x.y.z:3003</code> and the password printed by <code>tinder token</code>. Use the port you chose for Kiln.</li>
        </ol>
        <p className="mt-2">Tailscale connects the computers; Kiln’s connection password determines who can direct its agents.</p>
        <Button size="sm" variant="link" className="h-auto px-0" onClick={() => void window.ember.openExternal('https://tailscale.com/docs/how-to/quickstart')}>Tailscale setup guide</Button>
        <SetupPrompt />
      </details>
      <details className={disclosure}>
        <summary className={summary}>Connect a Kiln that is already running</summary>
        <p className="my-3">Enter that Kiln’s address and connection password. You can also do this later in Settings → Instances.</p>
        <EndpointsInline endpoints={endpoints} instances={instances} onChange={onChange} onAdded={onAdded} />
      </details>
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
    <React.Suspense fallback={<span className="text-base text-muted-foreground">Loading…</span>}>
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
      <h3 className="text-base font-semibold">Connect an AI service</h3>
      <p className="text-base leading-relaxed text-muted-foreground">
        Your agents need an AI service, such as OpenAI or Anthropic. Use a sign-in option below, or paste
        an API key — an access code you get from that service. If you use Ollama or LM Studio to run AI on
        your own computer, start it first and Ember will show it here.
      </p>
      <ProvidersSettings
        endpoints={endpoints}
        instances={instances}
        onProviderChange={() => onRefreshInstances()}
        {...(state.targetInstanceId ? { initialEndpointId: state.targetInstanceId } : {})}
      />
      <p className="text-base text-muted-foreground">
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
      <h3 className="text-base font-semibold">Start your first agent</h3>
      <div className="rounded-lg border bg-muted/20 px-3 py-2.5">
        <p className="text-base text-muted-foreground">Agents start in</p>
        <p className="mt-0.5 font-mono text-base">{workspaceRoot ?? '(no folder set)'}</p>
        {workspaceRoot ? (
          <p className="mt-1.5 text-base leading-relaxed text-muted-foreground">{workspaceHint(workspaceRoot)}</p>
        ) : null}
      </div>
      <p className="text-base leading-relaxed text-muted-foreground">
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
