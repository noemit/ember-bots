import { modelRefKey, type ModelRef, type ModelOption } from '../types';

/**
 * First-run onboarding: which steps exist, which are blocked, and what "set up" means.
 *
 * Pure on purpose. The wizard is the one screen that has to work when *nothing* is working — no
 * instance, no models, no network — which is also the hardest state to reproduce, so the decisions
 * live here and are tested directly rather than through a component.
 *
 * The shape is **adaptive**, not linear: a person with one computer should not be walked through
 * container instructions, and a person whose local harness failed is exactly who needs them.
 */

/** The steps, in the order they are drawn when every one applies. */
export type OnboardingStepId = 'welcome' | 'connection' | 'token' | 'providers' | 'first-agent';

export type OnboardingStep = {
  id: OnboardingStepId;
  title: string;
  /** One line in the step list, so the rail reads as a plan rather than a set of tabs. */
  summary: string;
  /**
   * A step that cannot be skipped because nothing after it would work. Only `connection` is
   * blocking: without a host there is no provider screen to show and no agent to start.
   */
  blocking?: boolean;
};

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  { id: 'welcome', title: 'Ember and Kiln', summary: 'Where the work happens' },
  { id: 'connection', title: 'Where to run Kiln', summary: 'Start here, or connect another computer', blocking: true },
  { id: 'token', title: 'Your token', summary: 'The password for connecting to Kiln' },
  { id: 'providers', title: 'Choose an AI', summary: 'Sign in or add an access code' },
  { id: 'first-agent', title: 'First bot', summary: 'Pick a folder and say hello' },
];

/** What the wizard knows about the world when it decides what to show. */
export type OnboardingState = {
  /** A harness on this machine is answering and its token is readable. */
  localReady: boolean;
  /** This launch started (or rotated) the local harness, so its token is ours to show and rotate. */
  canRotate: boolean;
  /** Another host (an endpoint or an OpenChamber instance) answered. */
  remoteReady: boolean;
  /** The instance the provider step should talk to; null when there is nothing to configure. */
  targetInstanceId: string | null;
};

/**
 * Whether the wizard should appear at all.
 *
 * A marked fresh install keeps the guide until dismissal: a healthy Kiln still needs a provider.
 * For older installs the rule is **no functioning local instance, and nothing else working either** — not "first
 * launch", and not "no sessions". Two reasons:
 *
 * - A person with a working container and no local harness is set up. Interrupting them with a
 *   guide to hardware they deliberately are not running is the wizard being wrong, not helpful.
 * - A person whose `local` is broken *is* a first-run user in every way that matters, even if their
 *   settings file holds ten remote endpoints. That was the state that motivated this: a settings
 *   file with one remote endpoint, a Kiln installed on the machine, and no local row anywhere.
 */
export const needsOnboarding = (state: OnboardingState, dismissedAt: number | null | undefined, startedAt?: number): boolean => {
  if (dismissedAt) return false;
  if (startedAt) return true;
  return !state.localReady && !state.remoteReady;
};

/** Optional computer and networking instructions stay collapsed on the connection page. */
export const stepsFor = (_state: OnboardingState): OnboardingStep[] => [...ONBOARDING_STEPS];

/**
 * Whether a step's `compact` form should be drawn instead of the full one.
 *
 * Only the token step has a compact form today: a host this app started needs no explanation of how
 * to copy a token *to* somewhere when the person has not said they want another machine.
 */
export const isCompactStep = (id: OnboardingStepId, state: OnboardingState): boolean =>
  id === 'token' && state.localReady;

/** What a step reports about itself, shown as the tick in the list. */
export type StepDone =
  | { kind: 'done' }
  | { kind: 'pending' }
  | { kind: 'skipped' }
  | { kind: 'failed'; problem: string };

/**
 * The step list's ticks.
 *
 * `connection` is the only step whose failure changes what the rest of the list means, so it is the
 * only one that can be `failed` — everywhere else, "not configured yet" is the normal state and
 * `pending` is the honest word.
 */
export const stepStates = (state: OnboardingState, problem?: string | null): Record<OnboardingStepId, StepDone> => ({
  welcome: { kind: 'done' },
  connection: state.localReady ? { kind: 'done' } : problem ? { kind: 'failed', problem } : { kind: 'pending' },
  token: state.localReady ? { kind: 'done' } : { kind: 'pending' },
  providers: { kind: 'pending' },
  'first-agent': { kind: 'pending' },
});

/** Where the wizard opens: the first step that is not already satisfied. */
export const firstIncompleteStep = (state: OnboardingState): OnboardingStepId =>
  state.localReady ? (state.remoteReady ? 'providers' : 'providers') : 'connection';

/**
 * Whether the person can leave the wizard for the workspace.
 *
 * A blocking step that failed keeps the *guide* open on its own step, but never traps anyone: the
 * app behind the wizard works, and "Skip for now" is always available. This function only decides
 * whether the primary button says "Finish" or "Continue".
 */
export const canFinish = (state: OnboardingState): boolean => state.localReady || state.remoteReady;

/**
 * The sentence under the folder field on the last step.
 *
 * Kept here rather than in the component because it is the one piece of copy in the wizard that
 * states a fact about the install (`/workspace` on a container, `~/workspace` elsewhere) and it has
 * to read the same wherever it appears.
 */
export const workspaceHint = (root: string | null): string => {
  if (!root) return 'Each folder in here is a project — a place a bot can read, write and run things.';
  if (root === '/workspace') {
    return 'Each folder in here is a project. On this machine the default is /workspace, the container mount.';
  }
  return `Each folder in here is a project. The default is ${root}; you can point it anywhere.`;
};

/** A host fallback is not a person's choice; require a saved, currently offered model. */
export const onboardingModelReady = (model: ModelRef | undefined, models: ModelOption[]): boolean =>
  Boolean(model && models.some((entry) => modelRefKey(entry) === modelRefKey(model)));

export const OPENCODE_ONBOARDING_TIP = 'No provider account yet? You can sign in or sign up on OpenCode’s website, which may offer free models. Availability and pricing can change; not every model is free. Copy an API key from OpenCode, paste it into OpenCode Zen below and select Save, then choose a model.';
