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
export type OnboardingStepId = 'welcome' | 'connection' | 'token' | 'instance' | 'providers' | 'first-agent';

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
  { id: 'welcome', title: 'What Ember is', summary: 'The window, the instances, and what durable means' },
  { id: 'connection', title: 'This computer', summary: 'Is a harness running here?', blocking: true },
  { id: 'token', title: 'Your token', summary: 'The password machines use to talk to each other' },
  { id: 'instance', title: 'Another machine', summary: 'Optional: connect a container or a server' },
  { id: 'providers', title: 'A model', summary: 'Give the instance something to think with' },
  { id: 'first-agent', title: 'First agent', summary: 'Pick a folder and say hello' },
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
 * The rule is **no functioning local instance, and nothing else working either** — not "first
 * launch", and not "no sessions". Two reasons:
 *
 * - A person with a working container and no local harness is set up. Interrupting them with a
 *   guide to hardware they deliberately are not running is the wizard being wrong, not helpful.
 * - A person whose `local` is broken *is* a first-run user in every way that matters, even if their
 *   settings file holds ten remote endpoints. That was the state that motivated this: a settings
 *   file with one remote endpoint, a Kiln installed on the machine, and no local row anywhere.
 */
export const needsOnboarding = (state: OnboardingState, dismissedAt: number | null | undefined): boolean => {
  if (dismissedAt) return false;
  return !state.localReady && !state.remoteReady;
};

/**
 * The steps this run actually shows.
 *
 * Three adaptations, each removing work rather than adding it:
 *
 * - **Connected here** → the token step collapses to one line (it is still in the list, because it
 *   is where "Show it" lives, but `compact` tells the component to draw a single row).
 * - **Nothing else to connect, and the local host works** → the "another machine" step is dropped
 *   entirely. Its copy is the longest in the wizard, and someone on one laptop will never use it.
 * - **Local host failed** → the container step is the way forward, so it stays and the local step
 *   stays blocking.
 */
export const stepsFor = (state: OnboardingState): OnboardingStep[] =>
  ONBOARDING_STEPS.filter((step) => step.id !== 'instance' || !state.localReady);

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
  instance: state.remoteReady ? { kind: 'done' } : { kind: 'skipped' },
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
  if (!root) return 'Each folder in here is a project — a place an agent can read, write and run things.';
  if (root === '/workspace') {
    return 'Each folder in here is a project. On this machine the default is /workspace, the container mount.';
  }
  return `Each folder in here is a project. The default is ${root}; you can point it anywhere.`;
};
