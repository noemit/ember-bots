import * as React from 'react';
import { ArrowLeftRight, Boxes, Cpu, Laptop, Monitor, ArrowRight, Check, CircleAlert, FolderOpen, KeyRound, Loader2, PlugZap, Sparkles } from 'lucide-react';
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
  instanceDefaults: Record<string, InstanceDefaults>;
  models: ModelOption[];
  onRefreshModels: (instanceId: string) => void;
  /** The sentence from `localHarnessNotice` when the local host did not start. */
  localProblem: string | null;
  instances: Instance[];
  endpoints: PiEndpoint[];
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
  const [active, setActive] = React.useState<OnboardingStepId>('welcome');
  const [retrying, setRetrying] = React.useState(false);
  const marks = stepStates(state, localProblem);
  const target = state.targetInstanceId;
  const [projectChoice, setProjectChoice] = React.useState<{ instanceId: string | null; directory: string }>({ instanceId: null, directory: '' });
  const project = projectChoice.instanceId === target ? projectChoice.directory : '';
  const setProject = (directory: string) => setProjectChoice({ instanceId: target, directory });
  const defaultModel = target ? instanceDefaults[target]?.model : undefined;
  const [providerCatalog, setProviderCatalog] = React.useState<{ id: string; providers: PiProviderInfo[] } | null>(null);
  const providersReady = Boolean(target && (
    (providerCatalog?.id === target && providerCatalog.providers.some((provider) => provider.credential || provider.custom)) ||
    models.some((model) => model.providerID === 'ollama' || model.providerID === 'lmstudio') ||
    instances.find((instance) => instance.id === target)?.kind !== 'pi'
  ));
  const modelReady = providersReady && onboardingModelReady(defaultModel, models);
  const canDismiss = !startAtWelcome || modelReady;
  if (modelReady) marks.providers = { kind: 'done' };

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
      if (event.key === 'Escape' && !event.defaultPrevented && canDismiss) {
        event.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onDismiss, canDismiss]);

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
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      data-testid="onboarding"
      className="fixed inset-0 z-50 isolate overflow-hidden bg-background text-base [&_button]:text-base"
    >
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
        style={{ backgroundImage: `radial-gradient(ellipse at 100% 0%, color-mix(in oklab, ${blobColor('lava', 'onboarding-fireglow')} 10%, transparent), transparent 55%), radial-gradient(ellipse at 0% 100%, color-mix(in oklab, ${blobColor('crystal', 'onboarding-crystalglow')} 10%, transparent), transparent 50%)` }}>
        <div className="absolute -right-24 -top-24 rotate-12 opacity-10 blur-[48px]">
          <Blob style="lava" seed="onboarding-fireglow" size={400} mood="idle" interactive={false} />
        </div>
        <div className="absolute -bottom-24 -left-20 -rotate-12 opacity-10 blur-[40px]">
          <Blob style="crystal" seed="onboarding-crystalglow" size={340} mood="idle" interactive={false} />
        </div>
      </div>
      <div data-testid="onboarding-surface" className="flex h-full w-full flex-col">
        <div className="flex items-center justify-between gap-4 border-b border-border/60 bg-background/65 px-6 py-[26px] backdrop-blur-xl">
          <h2 id="onboarding-title" className="text-base font-semibold">
            Setting up Ember Bots
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-base text-muted-foreground">
              Step {index + 1} of {steps.length}
            </span>
            <Button size="sm" variant="ghost" onClick={onDismiss} disabled={!canDismiss} title={!canDismiss ? "Choose a default model in Choose an AI before finishing setup" : undefined}>
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
                />
              ) : null}

              {step.id === 'token' ? (
                <Token state={state} compact={isCompactStep('token', state)} loadToken={loadToken} />
              ) : null}

              {step.id === 'providers' && providersReady ? (
                <div className="mb-6 flex flex-col gap-2">
                  <label htmlFor="onboarding-default-model" className="font-semibold">Default model for {instances.find((instance) => instance.id === target)?.label ?? 'this instance'}</label>
                  <p className="text-muted-foreground">Choose the model Ember will use for new bots on this instance. This does not change Kiln’s own default or existing conversations.</p>
                  <select id="onboarding-default-model" className="h-10 rounded-md border bg-background px-3" value={defaultModel ? modelRefKey(defaultModel) : ''} onChange={(event) => {
                    const model = models.find((entry) => modelRefKey(entry) === event.target.value);
                    if (!target || !model) return;
                    onChange({ instanceDefaults: { ...instanceDefaults, [target]: withInstanceDefaultModel(instanceDefaults[target], model) } });
                  }}>
                    <option value="" disabled>Choose a default model</option>
                    {defaultModel && !modelReady ? <option value={modelRefKey(defaultModel)} disabled>{modelRefKey(defaultModel)} (unavailable)</option> : null}
                    {models.map((model) => <option key={modelRefKey(model)} value={modelRefKey(model)}>{model.label}</option>)}
                  </select>
                  {!modelReady ? <p className="text-muted-foreground">Choose an available model, then select Continue. If a model is missing, refresh models or connect another provider below.</p> : null}
                  <Button variant="ghost" onClick={() => { if (target) onRefreshModels(target); }} disabled={!target}>Refresh models</Button>
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
              {last && !modelReady ? <span className="text-base text-muted-foreground">Choose a default model in Choose an AI before finishing setup.</span> : null}
              {last || (canFinish(state) && step.id === 'first-agent') ? null : (
                <span className="text-base text-muted-foreground">
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
      <div className="flex items-start gap-4">
        <div className="flex-none p-2">
          <Blob style="buddy" seed="onboarding" size={56} mood="thinking" />
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="text-2xl font-semibold">Where the work happens</h3>
          <p className="text-base leading-relaxed text-muted-foreground">
            Ember takes its name from the embers that glow in a fire. Think of <strong className="text-foreground">Kiln</strong>{' '}
            as the hot, concentrated space where bots take action: editing files, running commands and carrying out your instructions.{' '}
            Think of <strong className="text-foreground">Ember</strong> as your connection to the powerful energy inside the kiln.
          </p>
        </div>
      </div>
      <p className="text-base leading-relaxed text-muted-foreground">
        <strong className="text-foreground">Ember is where you direct bots to do work, and observe the work they do.</strong>{' '}
        It connects to Kiln using a connection password and gives you a view of your conversations, each bot’s progress,
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
        Ember includes a Kiln on this computer, so you can start here. Bots using it edit files and run
        commands here. This Kiln stops when you quit Ember; its conversations stay on disk.
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
        You can also give bots a separate place to work. A container provides a separate working environment;
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

function RemoteSetup({ endpoints, instances, onChange, onAdded }: {
  endpoints: PiEndpoint[];
  instances: Instance[];
  onChange: (patch: EmberSettingsPatch) => void;
  onAdded: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-base text-muted-foreground">Connect to another computer with its Kiln URL and bearer token. Ember’s included Kiln can be shared deliberately from Settings → Instances → Share this Kiln on that computer. Tinder runs a standalone Kiln independently of Ember.</p>
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
  onRefreshModels: (instanceId: string) => void;
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
      <div className="flex items-center gap-3">
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
        onProviderCatalog={onProviderCatalog}
        endpoints={endpoints}
        instances={instances}
        onProviderChange={(id) => { onRefreshInstances(); onRefreshModels(id); }}
        instanceDefaults={instanceDefaults}
        onDefaultChange={(id, model) => onChange({ instanceDefaults: { ...instanceDefaults, [id]: { ...instanceDefaults[id], model, variant: model?.variant } } })}
        {...(state.targetInstanceId ? { initialEndpointId: state.targetInstanceId } : {})}
      />
      <p className="text-base text-muted-foreground">
        You can change all of this later in Settings → Providers ({String(onChange === undefined ? '' : 'it saves as you go')}).
      </p>
    </div>
  );
}

function FirstAgent({ state, instances, instanceDefaults, onChange, onStart, modelReady, project, setProject }: {
  state: OnboardingState;
  instances: Instance[];
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
        You can pick a project inside it for each new chat.
      </p>
      {!modelReady ? <p className="text-muted-foreground">Open Choose an AI and select a default model before starting your first bot.</p> : null}
      {target ? <div className="rounded-lg border bg-background/60 p-4">
        <p className="mb-2 text-sm text-muted-foreground">Workspace on {target.label}</p>
        <ProjectPicker key={target.id} instance={target} projects={[]} workspaceOnly value={workspace ?? ''} workspace={workspace}
          onWorkspaceChange={(directory) => {
            setProject('');
            onChange({ instanceDefaults: { ...instanceDefaults, [target.id]: { ...instanceDefaults[target.id], workspaceDirectory: directory } } });
          }} onSelect={() => {}} />
        {workspace ? <p className="mt-2 break-all text-sm text-muted-foreground">{workspace}</p> : null}
      </div> : <p className="text-muted-foreground">Connect a Kiln in the setup steps to choose a workspace.</p>}
      {target && workspace ? <div>
        <p className="mb-2 text-sm text-muted-foreground">Start in a project, or work directly in your workspace.</p>
        <ProjectPicker key={`${target.id}:${workspace}`} instance={target} projects={[]} value={project || workspace} workspace={workspace}
          onWorkspaceChange={(directory) => {
            setProject('');
            onChange({ instanceDefaults: { ...instanceDefaults, [target.id]: { ...instanceDefaults[target.id], workspaceDirectory: directory } } });
          }} onSelect={setProject} />
      </div> : null}
      <p className="text-sm leading-relaxed text-muted-foreground">Nothing is sent until you write your first message.</p>
      <Button className="self-start" disabled={!target || !workspace || !modelReady} onClick={() => {
        if (target && workspace && modelReady) onStart();
      }}>Continue<ArrowRight /></Button>
    </div>
  );
}
