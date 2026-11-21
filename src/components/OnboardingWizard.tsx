import type { ProjectUsage } from '../lib/projectUsage';
import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { ArrowLeftRight, Boxes, Cpu, Laptop, Monitor, ArrowRight, Check, CircleAlert, FolderOpen, KeyRound, Loader2, PlugZap, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import OnboardingPrivacy from './OnboardingPrivacy';
import Blob from '../blob/Blob';
import { blobColor } from '../blob/color';
import { MoodBadge } from '../blob/overlays';
import { randomId } from '@/lib/randomId';
import type { PiProviderInfo } from '../piApi';
import LocalTokenSettings from './LocalTokenSettings';
import ProvidersSettings from './ProvidersSettings';
import ProjectPicker from './ProjectPicker';
import { withInstanceDefaultModel } from '@/lib/instanceDefaultModel';
import { cn } from '@/lib/utils';
import {
  canDismissOnboarding,
  canFinish,
  onboardingModelReady,
  OPENCODE_ONBOARDING_TIP,
  isCompactStep,
  stepStates,
  stepsFor,
  type OnboardingState,
  type OnboardingStep,
  type OnboardingStepId,
} from '@/lib/onboarding';
import { modelRefKey } from '../types';
import type { EmberSettingsPatch, InstanceDefaults, ModelOption, Instance, LocalHarnessToken, PiEndpoint } from '../types';

type Props = {
  open: boolean;
  startAtWelcome?: boolean;
  state: OnboardingState;
  projectUsageByInstance?: Record<string, ProjectUsage[]>;
  instanceDefaults: Record<string, InstanceDefaults>;
  models: ModelOption[];
  onRefreshModels: (instanceId: string, options?: { upstream?: boolean; providers?: readonly string[] }) => void;
  /** The sentence from `localHarnessNotice` when the local host did not start. */
  localProblem: string | null;
  instances: Instance[];
  endpoints: PiEndpoint[];
  onDismiss: () => void;
  onRetryLocal: () => Promise<void>;
  onRefreshInstances: () => void;
  onChange: (patch: EmberSettingsPatch) => void | Promise<unknown>;
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
    case 'privacy':
      return Sparkles;
  }
};

/**
 * The first-run guide.
 *
 * A full-window surface rather than a dialog over Home, because a dialog over an empty Home reads
 * as an error to clear. Existing installs can dismiss from every step (Esc included): the app behind it
 * works. Fresh setup requires a model choice before dismissal so it cannot silently adopt a host fallback.
 *
 * Adaptive by design — see `lib/onboarding.ts` for the decisions. A person connected to one
 * computer never sees the container instructions, and the token step shrinks to a line.
 */
export default function OnboardingWizard({
  open,
  startAtWelcome = false,
  state,
  instanceDefaults = {},
  projectUsageByInstance,
  models,
  onRefreshModels,
  localProblem,
  instances,
  endpoints,
  onDismiss,
  onRetryLocal,
  onRefreshInstances,
  onChange,
  onStartAgent,
  loadToken,
}: Props) {
  const steps = React.useMemo(() => stepsFor(state), [state]);
  const initialStep: OnboardingStepId = startAtWelcome ? 'welcome' : state.localReady ? 'providers' : 'connection';
  const [active, setActive] = React.useState<OnboardingStepId>(initialStep);
  const [retrying, setRetrying] = React.useState(false);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const activeStepButton = React.useRef<HTMLButtonElement | null>(null);
  const marks = stepStates(state, localProblem);
  const target = state.targetInstanceId;
  const [projectChoice, setProjectChoice] = React.useState<{ instanceId: string | null; directory: string }>({ instanceId: null, directory: '' });
  const project = projectChoice.instanceId === target ? projectChoice.directory : '';
  const setProject = (directory: string) => setProjectChoice({ instanceId: target, directory });
  const defaultModel = target ? instanceDefaults[target]?.model : undefined;
  const [providerCatalog, setProviderCatalog] = React.useState<{ id: string; providers: PiProviderInfo[] } | null>(null);
  const providersReady = Boolean(target && (
    (providerCatalog?.id === target && providerCatalog.providers.some((provider) => provider.credential || provider.envVar || provider.custom)) ||
    models.some((model) => model.providerID === 'ollama' || model.providerID === 'lmstudio') ||
    instances.find((instance) => instance.id === target)?.kind !== 'pi'
  ));
  const modelReady = providersReady && onboardingModelReady(defaultModel, models);
  const canDismiss = canDismissOnboarding(startAtWelcome, modelReady);
  if (modelReady) marks.providers = { kind: 'done' };

  const hasOpened = React.useRef(false);
  React.useEffect(() => {
    if (!open) { hasOpened.current = false; return; }
    if (hasOpened.current) return;
    hasOpened.current = true;
    setActive(initialStep);
  }, [open, initialStep]);

  React.useEffect(() => {
    if (!open) return;
    activeStepButton.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [open, active]);

  if (!open) return null;

  const index = Math.max(0, steps.findIndex((step) => step.id === active));
  const step = steps[index] ?? steps[0];
  const last = index === steps.length - 1;
  const next = () => {
    const following = steps[index + 1];
    if (following) setActive(following.id);
    else onDismiss();
  };

  const finish = () => {
    const workspace = target ? instanceDefaults[target]?.workspaceDirectory : undefined;
    if (target && workspace && modelReady) onStartAgent({ instanceId: target, directory: project || workspace });
    else onDismiss();
  };

  const retry = async () => {
    setRetrying(true);
    try { await onRetryLocal(); } finally { setRetrying(false); }
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && canDismiss) onDismiss();
      }}
    >
      <DialogPrimitive.Content
        aria-modal="true"
        aria-labelledby="onboarding-title"
        data-testid="onboarding"
        onEscapeKeyDown={(event) => {
          if (!canDismiss) event.preventDefault();
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={() => {
          if (typeof document !== 'undefined') {
            returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (typeof document !== 'undefined' && document.activeElement && document.activeElement !== document.body) {
            return;
          }
          const previous = returnFocus.current;
          if (previous?.isConnected && previous !== document.body) previous.focus();
        }}
        className="fixed inset-0 z-50 isolate overflow-hidden bg-background text-base outline-none [&_button]:text-base"
      >
        <DialogPrimitive.Description asChild>
          <span className="sr-only">Set up Kiln, AI providers, and your workspace in Ember Bots.</span>
        </DialogPrimitive.Description>
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
          style={{ backgroundImage: `radial-gradient(ellipse at 100% 0%, color-mix(in oklab, ${blobColor('lava', 'onboarding-fireglow')} 10%, transparent), transparent 55%), radial-gradient(ellipse at 0% 100%, color-mix(in oklab, ${blobColor('crystal', 'onboarding-crystalglow')} 10%, transparent), transparent 50%)` }}>
          <div
            data-testid="onboarding-lava-glow"
            className="absolute -right-24 -top-24 size-[400px] rotate-12 rounded-full opacity-15"
            style={{
              backgroundImage: `radial-gradient(circle at 46% 52%, color-mix(in oklab, ${blobColor('lava', 'onboarding-fireglow')} 65%, #fbbf24), color-mix(in oklab, ${blobColor('lava', 'onboarding-fireglow')} 80%, #ea580c) 38%, transparent 70%)`,
            }}
          />
          <div className="absolute -bottom-24 -left-20 -rotate-12 opacity-10 blur-[40px]">
            <Blob style="crystal" seed="onboarding-crystalglow" size={340} mood="idle" interactive={false} />
          </div>
        </div>
        <div data-testid="onboarding-surface" className="flex h-full w-full flex-col">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border/60 bg-background/65 px-4 py-3.5 backdrop-blur-xl md:flex-nowrap md:gap-4 md:px-6 md:py-[26px]">
            <DialogPrimitive.Title id="onboarding-title" className="text-base font-semibold">
              Setting up Ember Bots
            </DialogPrimitive.Title>
            <div className="flex items-center gap-2">
              <span className="text-base text-muted-foreground">
                Step {index + 1} of {steps.length}
              </span>
              <Button size="sm" variant="ghost" onClick={onDismiss} disabled={!canDismiss} title={!canDismiss ? "Choose a default model in Choose an AI before finishing setup" : undefined}>
                Skip for now
              </Button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            {/* The plan, not tabs: a tick means done, a dot means not yet, and a warning is the one
                step whose failure changes what the rest of the list means. */}
            <ol
              className="flex w-full flex-none flex-row gap-1.5 overflow-x-auto border-b border-border/60 bg-background/45 px-3 py-2 backdrop-blur-xl md:w-[240px] md:flex-col md:gap-0.5 md:overflow-y-auto md:overflow-x-hidden md:border-r md:border-b-0 md:p-3 lg:w-[260px]"
              aria-label="Setup steps"
            >
              {steps.map((entry: OnboardingStep, position) => {
                const mark = marks[entry.id];
                const Icon = stepIcon(entry.id);
                const current = entry.id === step.id;
                return (
                  <li key={entry.id} className="flex-none md:w-full">
                    <button
                      ref={current ? activeStepButton : undefined}
                      type="button"
                      onClick={() => setActive(entry.id)}
                      aria-current={current ? 'step' : undefined}
                      className={cn(
                        'flex items-center gap-2 whitespace-nowrap rounded-full px-3 py-1.5 text-left transition-colors md:w-full md:items-start md:whitespace-normal md:rounded-md md:px-2',
                        current ? 'bg-background shadow-sm ring-1 ring-border/60 md:ring-0' : 'hover:bg-background/60'
                      )}
                    >
                      <span className="flex-none md:mt-0.5">
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
                        <span className="hidden text-base leading-snug text-muted-foreground md:block">{entry.summary}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background/50">
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-7">
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
                  />
                ) : null}

                {step.id === 'token' ? (
                  <Token state={state} compact={isCompactStep('token', state)} loadToken={loadToken} />
                ) : null}

                {step.id === 'providers' && providersReady ? (
                  <div className="mb-6 flex flex-col gap-3 rounded-xl border border-border/80 bg-card/60 p-4 shadow-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label htmlFor="onboarding-default-model" className="text-base font-semibold">
                        Default model for {instances.find((instance) => instance.id === target)?.label ?? 'this instance'}
                      </label>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => { if (target) onRefreshModels(target); }}
                        disabled={!target}
                      >
                        <RefreshCw className="size-3.5" />
                        Refresh models
                      </Button>
                    </div>
                    <p className="text-base text-muted-foreground">Choose the model Ember will use for new bots on this instance. This does not change Kiln’s own default or existing conversations.</p>
                    <select
                      id="onboarding-default-model"
                      className="h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base shadow-xs transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                      value={defaultModel ? modelRefKey(defaultModel) : ''}
                      onChange={(event) => {
                        const model = models.find((entry) => modelRefKey(entry) === event.target.value);
                        if (!target || !model) return;
                        onChange({ instanceDefaults: { ...instanceDefaults, [target]: withInstanceDefaultModel(instanceDefaults[target], model) } });
                      }}
                    >
                      <option value="" disabled>Choose a default model</option>
                      {defaultModel && !modelReady ? <option value={modelRefKey(defaultModel)} disabled>{modelRefKey(defaultModel)} (unavailable)</option> : null}
                      {models.map((model) => <option key={modelRefKey(model)} value={modelRefKey(model)}>{model.label}</option>)}
                    </select>
                    {!modelReady ? <p className="text-base text-muted-foreground">Choose an available model, then select Continue. If a model is missing, refresh models or connect another provider below.</p> : null}
                  </div>
                ) : null}

                {step.id === 'providers' ? (
                  <>
                    {!target ? (
                      <div className="mb-6 flex flex-col items-start gap-2 text-muted-foreground">
                        <p>Ember needs a connected Kiln before it can list providers or models. Retry this computer or connect another host.</p>
                        <Button variant="secondary" onClick={() => setActive('connection')}>Where to run Kiln</Button>
                      </div>
                    ) : null}
                    <Providers instanceDefaults={instanceDefaults} state={state} endpoints={endpoints} instances={instances} onChange={onChange} onRefreshInstances={onRefreshInstances} onRefreshModels={onRefreshModels} onProviderCatalog={(id, providers) => setProviderCatalog({ id, providers })} providersReady={providersReady} />
                  </>
                ) : null}

                {step.id === 'first-agent' ? (
                  <FirstAgent
                    key={state.targetInstanceId}
                    instanceDefaults={instanceDefaults}
                    projectUsageByInstance={projectUsageByInstance}
                    state={state}
                    instances={instances}
                    onChange={onChange}
                    onStart={next}
                    project={project}
                    setProject={setProject}
                    modelReady={modelReady}
                  />
                ) : null}
                {step.id === 'privacy' ? <OnboardingPrivacy /> : null}
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-background/65 px-4 py-3 backdrop-blur-xl md:flex-nowrap md:px-6 md:py-4">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setActive(steps[Math.max(0, index - 1)]?.id ?? 'welcome')}
                  disabled={index === 0}
                >
                  Back
                </Button>
                <div className="flex-1" />
                {last && !modelReady ? <span className="text-sm text-muted-foreground md:text-base">Choose a default model in Choose an AI before finishing setup.</span> : null}
                {last || (canFinish(state) && step.id === 'first-agent') ? null : (
                  <span className="text-sm text-muted-foreground md:text-base">
                    {step.id === 'providers' && !providersReady ? 'Connect a provider first' : step.id === 'providers' && !modelReady ? 'Choose a default model to continue' : marks[step.id]?.kind === 'pending' ? 'Continue when you’re ready' : ''}
                  </span>
                )}
                <Button size="sm" disabled={(last || step.id === 'providers' || step.id === 'first-agent') && !modelReady} onClick={last ? finish : next} data-testid="onboarding-next">
                  {last ? 'Finish' : canFinish(state) && step.id === 'providers' ? 'Continue' : 'Next'}
                  <ArrowRight />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  );
}

function KilnDiagram() {
  const hosts = [
    { name: 'Container', detail: 'A separate space on a computer', Icon: Boxes },
    { name: 'Mac Studio', detail: 'A Mac you leave running', Icon: Cpu },
    { name: 'Old PC running Omarchy', detail: 'A spare computer', Icon: Monitor },
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
            <div className="mt-0.5 text-base text-muted-foreground">Talk to your bots</div>
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
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:gap-4">
        <div className="flex-none p-2">
          <Blob style="buddy" seed="onboarding" size={56} mood="thinking" />
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="text-2xl font-semibold">Where the work happens</h3>
          <p className="text-base leading-relaxed text-muted-foreground">
            Ember is an easy bot workspace where you can send out requests, review results and set scheduled
            messages. You see each bot session embodied in a cute little blob. This, alongside other features,
            helps you use your bots more easily.
          </p>
        </div>
      </div>
      <p className="text-base leading-relaxed text-muted-foreground">
        <strong className="text-foreground">Ember is where you direct bots to do work, and observe the work they do.</strong>{' '}
        It connects to a piece of software behind the scenes called a <strong className="text-foreground">Kiln</strong>.
        It’s all set up for you here — but if you want to add another Kiln on another computer, you can set that up in
        minutes.
      </p>
      <p className="text-base leading-relaxed text-muted-foreground">
        Kiln uses Pi behind the scenes, specifically Pi-durable, to keep conversations and ongoing work
        on the computer running your bots.
      </p>
      <KilnDiagram />
      <p className="text-base leading-relaxed text-muted-foreground">
        One Ember can connect to several Kilns that are running on various computers you’ve set up. Bots can even
        talk to each other across machines.
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
}: {
  state: OnboardingState;
  problem: string | null;
  retrying: boolean;
  onRetry: () => void;
  endpoints: PiEndpoint[];
  instances: Instance[];
  onChange: (patch: EmberSettingsPatch) => void;
  onAdded: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-2xl font-semibold">Choose where the work happens</h3>
      <p className="text-base leading-relaxed text-muted-foreground">
        Ember includes a Kiln on this computer, so you can start here. This enables the bots to edit files and run
        commands. This Kiln stops when you quit Ember; the conversations are saved to your hard drive.
      </p>

      {state.localReady ? (
        <div className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/5 px-3 py-2">
          <Check className="mt-0.5 size-4 flex-none text-success" />
          <div className="flex flex-col gap-0.5">
            <span className="text-base font-medium">Connected to this computer</span>
            <span className="text-base text-muted-foreground">
              Kiln is running on this computer and Ember has its token.
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
        Once you get a hang of Ember, we recommend you give your bots a separate place to work off of your computer.
        A container can be a good option for providing a separate work environment. Another physical computer is
        also a good choice. These computers can keep working even if you close your laptop lid or close your
        computer entirely — as long as their computer (and Kiln) stays on.
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

function RemoteSetup({ endpoints, instances, onChange, onAdded }: {
  endpoints: PiEndpoint[];
  instances: Instance[];
  onChange: (patch: EmberSettingsPatch) => void | Promise<unknown>;
  onAdded: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-base text-muted-foreground">Connect to another computer with its Kiln URL and bearer token. Ember’s included Kiln can be shared deliberately from Settings → Remote access → Share this Kiln on that computer. Tinder runs a standalone Kiln independently of Ember.</p>
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
  onChange: (patch: EmberSettingsPatch) => void | Promise<unknown>;
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
  instanceDefaults,
  onRefreshInstances,
  onRefreshModels,
  onProviderCatalog,
  providersReady,
}: {
  state: OnboardingState;
  endpoints: PiEndpoint[];
  instanceDefaults: Record<string, InstanceDefaults>;
  instances: Instance[];
  onChange: (patch: EmberSettingsPatch) => void;
  onRefreshInstances: () => void;
  onRefreshModels: (instanceId: string, options?: { upstream?: boolean; providers?: readonly string[] }) => void;
  onProviderCatalog: (id: string, providers: PiProviderInfo[]) => void;
  providersReady: boolean;
}) {
  const [tipSeed] = React.useState(() => randomId());
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-base font-semibold">{providersReady ? 'Connected AI services' : 'First, connect an AI service'}</h3>
      {!providersReady ? <p className="font-medium">Connect Ollama, sign in, or save an API key below. Then choose the default model for new chats.</p> : null}
      <p className="text-base leading-relaxed text-muted-foreground">
        Your bots can use Ollama without an account or API key. Start Ollama on the selected Kiln’s
        computer, then choose Test / Refresh in the Ollama section below. Or connect an AI service
        such as OpenAI or Anthropic by signing in or pasting its API key.
      </p>
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <span aria-hidden="true" className="relative inline-flex size-20 flex-none">
          <Blob style="buddy" seed={tipSeed} size={80} mood="thinking" />
          <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 size-full"><MoodBadge mood="question" /></svg>
        </span>
        <aside className="rounded-lg bg-muted/40 px-3 py-2 text-muted-foreground" aria-label="Tip for getting started">
          <strong className="font-bold text-highlight">TIP</strong> — {OPENCODE_ONBOARDING_TIP}{' '}
          <button type="button" className="underline" onClick={() => void window.ember.openExternal('https://opencode.ai/zen')}>Open OpenCode</button>
        </aside>
      </div>
      <ProvidersSettings
        onboarding
        onProviderCatalog={onProviderCatalog}
        endpoints={endpoints}
        instances={instances}
        onProviderChange={(id, options) => { onRefreshInstances(); onRefreshModels(id, options); }}
        instanceDefaults={instanceDefaults}
        onDefaultChange={(id, model) => onChange({ instanceDefaults: { ...instanceDefaults, [id]: { ...instanceDefaults[id], model, variant: model?.variant } } })}
        {...(state.targetInstanceId ? { initialEndpointId: state.targetInstanceId } : {})}
      />
      <p className="text-base text-muted-foreground">
        You can change all of this later in Settings → Providers (it saves as you go).
      </p>
    </div>
  );
}

function FirstAgent({ state, instances, projectUsageByInstance, instanceDefaults, onChange, onStart, modelReady, project, setProject }: {
  state: OnboardingState;
  instances: Instance[];
  projectUsageByInstance?: Record<string, ProjectUsage[]>;
  instanceDefaults: Record<string, InstanceDefaults>;
  onChange: (patch: EmberSettingsPatch) => void;
  onStart: () => void;
  project: string;
  setProject: (directory: string) => void;
  modelReady: boolean;
}) {
  const target = instances.find((instance) => instance.id === state.targetInstanceId);
  const workspace = target ? instanceDefaults[target.id]?.workspaceDirectory : undefined;
  return (
    <div className="flex max-w-xl flex-col gap-5">
      <h3 className="text-base font-semibold">Where does your work live?</h3>
      <p className="leading-relaxed text-muted-foreground">
        Choose your workspace — the folder where you already keep your projects or work.
        You can pick a project inside it for each new chat. You can always access folders elsewhere if you wish,
        as well.
      </p>
      {/* The approved copy omits the per-step model hint. Model validation stays unchanged;
          the final step's footer explains how to choose a default before finishing setup. */}
      {target ? <div className="rounded-lg border bg-background/60 p-4">
        <p className="mb-2 text-sm text-muted-foreground">Workspace on {target.label}</p>
        <ProjectPicker key={target.id} instance={target} projects={[]} projectUsage={projectUsageByInstance?.[target.id]} workspaceOnly value={workspace ?? ''} workspace={workspace}
          onWorkspaceChange={(directory) => {
            setProject('');
            onChange({ instanceDefaults: { ...instanceDefaults, [target.id]: { ...instanceDefaults[target.id], workspaceDirectory: directory } } });
          }} onSelect={() => {}} />
        {workspace ? <p className="mt-2 break-all text-sm text-muted-foreground">{workspace}</p> : null}
      </div> : <p className="text-muted-foreground">Connect a Kiln in the setup steps to choose a workspace.</p>}
      {target && workspace ? <div>
        <p className="mb-2 text-sm text-muted-foreground">Start in a project, or work directly in your workspace.</p>
        <ProjectPicker key={`${target.id}:${workspace}`} instance={target} projects={[]} projectUsage={projectUsageByInstance?.[target.id]} value={project || workspace} workspace={workspace}
          onWorkspaceChange={(directory) => {
            setProject('');
            onChange({ instanceDefaults: { ...instanceDefaults, [target.id]: { ...instanceDefaults[target.id], workspaceDirectory: directory } } });
          }} onSelect={setProject} />
      </div> : null}
      <Button className="self-start" disabled={!target || !workspace || !modelReady} onClick={() => {
        if (target && workspace && modelReady) onStart();
      }}>Continue<ArrowRight /></Button>
    </div>
  );
}
