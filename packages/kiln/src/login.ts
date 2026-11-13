/**
 * Interactive provider sign-in (OAuth), driven from a client instead of a terminal.
 *
 * Hearth's credentials are normally an API key pasted into `auth.json`, but some providers only
 * issue an OAuth token that must be *earned* by a browser round-trip. pi-ai already implements
 * those flows — xAI is a device-code flow: ask for a code, show it to the human, poll until they
 * approve — and exposes them as `provider.auth.oauth.login(interaction)`, where `interaction`
 * receives the device code through `notify` and resolves when the token lands.
 *
 * The catch is that `login` **blocks** until the human finishes, and this server speaks JSON, not
 * SSE. So a login is a small state machine held in memory: `start` kicks the flow off, the client
 * polls for the device code, shows it, and polls until the flow settles. The credential itself
 * never leaves this module: the flow's terminal event hands it to the injected `persist`, so a
 * completed sign-in is stored whether the completing request is `start`, the first `poll`, or the
 * fortieth — and no client ever receives a secret it has no use for.
 *
 * Only one flow per provider runs at a time: a second `start` supersedes the first, because a
 * stale code is worse than a replaced one — the human is looking at exactly one of them.
 */

export type LoginEvent =
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "question";
      message: string;
      placeholder?: string;
      options?: Array<{ id: string; label: string }>;
    }
  | { type: "info"; message: string }
  | { type: "progress"; message: string };

/**
 * A question a flow asks mid-sign-in.
 *
 * `options` carries the choices of a `select` prompt; a flow that asks one can be answered by
 * `chooseHeadlessMethod` (see below), while text/secret/manual-code prompts cannot be answered at all
 * without a human typing.
 */
export type LoginPrompt = {
  type?: string;
  message: string;
  placeholder?: string;
  options?: ReadonlyArray<{ id: string; label: string }>;
};

/**
 * What a flow is handed, and what the supervisor has to be able to do with it.
 *
 * `ask` is the one addition to the pre-existing shape: a browser-callback flow needs a question
 * delivered to the human and the reply read back, which a request/response JSON API cannot do
 * inline. A client that declared it can carry questions gets this instead of the hand-me-down
 * `prompt` above, so the two never compete for the same flow.
 */
export type LoginInteraction = {
  signal: AbortSignal;
  prompt: (prompt: LoginPrompt) => Promise<string>;
  notify: (event: LoginEvent) => void;
  /** Only present when the client that started the flow can relay a question. */
  ask?: (prompt: LoginPrompt) => Promise<string>;
};
/**
 * What the client says it can do with a mid-flow question.
 *
 * A browser sign-in whose loopback callback the human cannot reach (Ember installed on one machine
 * and driven from another, a container, a remote box) leaves exactly one working path: the human
 * signs in wherever they have a browser and pastes the redirect URL back. The *host* cannot know
 * whether that browser can reach it — only the client can, because the client is the side that
 * holds the callback server's address — so the client declares it. Absent means "cannot ask", which
 * is the behaviour every client had before this existed: the flow is refused, with its own question
 * quoted in the reason.
 */
export type LoginInput = {
  /** The client can show a question and deliver what the human types back. */
  prompt: boolean;
};

/**
 * Providers whose *browser-callback* flow is offered to a client that can relay a question.
 *
 * pi-ai reports a provider, not a flow, and one provider can ship several flows with different
 * demands — openai ships a ChatGPT browser flow beside a device-code one. So "the device flow of
 * this provider cannot finish here" must not hide a browser flow that can: these are the ones a
 * connected client may drive.
 */
const BROWSER_SIGN_IN: ReadonlySet<string> = new Set(["openai"]);

/**
 * - `pending`: waiting on the human; `events` may already hold the device code.
 * - `complete`: the token arrived **and is stored**; `credentialType` says what landed (`credential` is retained for callers that read it directly).
 * - `failed`: cancelled, timed out, rejected by the provider, or not storable.
 */
export type LoginState =
  | {
      status: "pending";
      provider: string;
      events: LoginEvent[];
      startedAt: number;
      /**
       * The question this flow is blocked on, when it has nowhere to go.
       *
       * A flow started without `input.prompt` that then asks something is not progress: nothing will
       * ever answer it, and a client polling "pending" would wait for a human who was never asked.
       * The supervisor records the question so the answer can be a failure that quotes it.
       */
      question?: { message: string };
      /**
       * How to deliver an answer to that question, while the flow is still running.
       *
       * Held here rather than in a module-level map so it dies with the flow that asked: a stale
       * resolver can only answer the flow it was made for, and a second `start` replaces it instead
       * of leaving two ways to answer one question.
       */
      answer?: (value: string) => void;
    }
  | { status: "complete"; provider: string; events: LoginEvent[]; credentialType: string; credential?: unknown; settledAt: number }
  | { status: "failed"; provider: string; events: LoginEvent[]; error: string; settledAt: number };

/** How long a finished result is kept so a late poll can still read it. */
const RESULT_TTL_MS = 60_000;
/** xAI's device code lives 10 minutes; allow a little slack before declaring the flow dead. */
const PENDING_TTL_MS = 15 * 60_000;
/** How long `start` waits for the provider to emit its first event (the device code). */
const FIRST_EVENT_WAIT_MS = 10_000;

export type LoginSupervisor = ReturnType<typeof createLoginSupervisor>;

/** The provider-facing slice a login needs, injected so this module stays free of pi-ai's types. */
export type LoginProvider = {
  id: string;
  oauth?: {
    loginLabel?: string;
    name?: string;
    login(interaction: LoginInteraction, options?: { agentName?: string }): Promise<unknown>;
  };
};

/** Saves a finished flow's credential. Called once, on the flow's terminal event. */
export type LoginPersist = (providerId: string, credential: unknown) => Promise<void> | void;

export type LoginSupport = { supported: true } | { supported: false; reason: string };

/**
 * The flows Hearth has actually driven to completion.
 *
 * pi-ai's flows differ in what they demand of their host. A device-code flow needs only `notify`
 * and a signal (xAI, Kimi Code). A browser-callback flow asks `prompt` a question mid-flow — the
 * pasted redirect URL, an enterprise domain — and OpenAI's ChatGPT flow additionally demands a
 * stable installation id (`options.getDeviceId`, a UUID), which Hearth does not keep. Hearth has no
 * wire for relaying a question to the human, so it cannot finish those; advertising one puts a
 * button on screen that can only fail, with a message nobody can act on. Verified rather than
 * inferred: a flow absent from this list is not offered until someone runs it to completion.
 */
/**
 * The subscription flows Hearth can finish.
 *
 * `xai` and `kimi-coding` are device-code flows that ask nothing. `openai-codex` (ChatGPT Plus/Pro)
 * and `radius` ask a single question — browser or device code — which `chooseHeadlessMethod` answers
 * with the device branch. `anthropic` and `github-copilot` are excluded by `OBSTRUCTIONS`: they need a
 * pasted-back code and a host choice respectively, and an offer that fails halfway is worse than a
 * sentence explaining why it is not offered.
 */
export const CAN_COMPLETE: ReadonlySet<string> = new Set([
  "xai",
  "kimi-coding",
  "openai-codex",
  "radius",
  // Google Antigravity's flow is Hearth's own (./antigravity-oauth.ts), built for this wire: it
  // shows the link, then asks through `ask` when the client can carry a question and through the
  // hand-me-down `prompt` otherwise, so the browser leg can finish either way.
  "antigravity",
  // Both ask nothing at all: a browser round-trip that reports its own result.
  "meta",
  "openrouter",
]);
export const VERIFIED_FLOWS = CAN_COMPLETE;

/**
 * Why a known flow is not offered, in words the person reading the refusal can use.
 *
 * Only flows that genuinely cannot complete belong here. A flow whose *only* question is a choice of
 * method is not obstructed — see `chooseHeadlessMethod` — because defaulting it is exactly what a
 * person would answer on a server with no browser.
 */
const OBSTRUCTIONS: Record<string, string> = {
  anthropic:
    "Claude's sign-in opens a browser and then asks you to paste back the code it shows there. Hearth can show you a link but cannot ask you for a code, so this flow cannot finish here. Paste an Anthropic API key instead.",
  openai:
    "Sign in with ChatGPT needs an installation id and a code pasted back from the browser, and this client cannot pass that question through to you. Paste a ChatGPT API key instead, or start the sign-in from Ember on the machine running this Hearth.",
  "github-copilot":
    "GitHub Copilot's sign-in asks which host and organisation to authenticate against, and Hearth cannot ask you that. Paste a Copilot token instead.",
};

/**
 * The refusal for a browser-only flow when the client cannot relay a question: a fact about the
 * connection, not about the provider, because the same button works from the machine running Hearth.
 */
const browserSignInNeedsTheHost = (what: string): string =>
  `${what} finishes in a browser that can reach this Hearth's loopback callback, and this connection cannot pass the redirect URL back to it. Use Ember on the machine running this Hearth, or paste an API key instead.`;

/**
 * Whether a flow is offered, for a client that can relay a question (`input.prompt`).
 *
 * Three answers, not two: a flow Hearth finishes unattended is always offered; a browser-callback
 * flow is offered to a client that can carry the pasted redirect URL and refused — naming the
 * reason and the way round it — to one that cannot. `input` defaults to "cannot ask", which keeps
 * the decision safe for any caller that predates the field: a flow offered on a promise it cannot
 * keep is a button that fails halfway.
 */
export const loginSupport = (providerId: string, input: LoginInput = { prompt: false }): LoginSupport => {
  if (CAN_COMPLETE.has(providerId)) return { supported: true };
  if (BROWSER_SIGN_IN.has(providerId)) {
    // Refused with the provider's own explanation: an OpenAI key on openai is a different provider
    // from ChatGPT on openai-codex, and offering the wrong one is the confusion this note prevents.
    return input.prompt ? { supported: true } : { supported: false, reason: OBSTRUCTIONS["openai"] ?? "" };
  }
  return {
    supported: false,
    reason:
      OBSTRUCTIONS[providerId] ??
      "Hearth has not been shown to finish this provider's sign-in, so it does not offer it. Paste an API key for this provider instead.",
  };
};

export const canCompleteLogin = (providerId: string, input: LoginInput = { prompt: false }): boolean =>
  loginSupport(providerId, input).supported;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What a stored credential is, for a client that wants to say so. Never the secret itself. */
export const credentialTypeOf = (credential: unknown): string =>
  (credential as { type?: unknown } | null | undefined)?.type === "oauth" ? "oauth" : "api_key";

/**
 * A flow that asks a question mid-sign-in cannot be answered here: Hearth shows the device code and
 * polls, and nothing relays a question to the human. Refuse with the question in the message rather
 * than answer `""` — an empty answer is not "no answer", it is a wrong answer that rejects the flow
 * (ChatGPT's code exchange) or silently chooses a default (GitHub Copilot's domain).
 */
/**
 * Answer the one kind of prompt a headless flow can answer on the human's behalf.
 *
 * Several subscription flows ask *how* to sign in before they start — browser or device code. Hearth
 * runs on a machine whose user may have no browser (a container, a remote box), and the device-code
 * branch is the one that works there without a callback server, so that is the branch taken. Any
 * other question is still refused: an invented answer is worse than a refusal, because it either
 * rejects the flow (ChatGPT's code exchange) or silently picks a default (Copilot's domain).
 */
const DEVICE_CODE_LABELS = /device\s*code|headless|another device/i;

/**
 * How a question with nowhere to go is reported.
 *
 * Both halves of the wire use this sentence: the supervisor puts it on the failure the client reads,
 * and the poll route answers with it when a flow is found blocked on a question that client cannot
 * carry. One sentence, so the two cannot drift apart.
 */
export const unreachableQuestion = (message: string): string =>
  `This sign-in asked "${message}", and the client that started it cannot pass a question to you. Start the sign-in from Ember on the machine running this Hearth, or paste an API key instead.`;

/**
 * The question handler for a flow whose client cannot carry questions.
 *
 * `chooseHeadlessMethod` answers what can be answered on the human's behalf; anything else throws
 * (see `start`, which also records the question), and the failure carries it.
 */
const chooseHeadlessMethod = async (prompt: LoginPrompt): Promise<string> => {
  if (prompt.type === "select" && Array.isArray(prompt.options)) {
    const match = prompt.options.find((option) => DEVICE_CODE_LABELS.test(option.label) || DEVICE_CODE_LABELS.test(option.id));
    if (match) return match.id;
  }
  throw new Error(
    `This provider's sign-in asks "${prompt.message}", and Hearth has no way to ask you for it.`
  );
};

export const createLoginSupervisor = (
  resolveProvider: (id: string) => LoginProvider | undefined,
  persistOrOptions?: LoginPersist | { persist?: LoginPersist }
) => {
  const persist: LoginPersist =
    typeof persistOrOptions === "function"
      ? persistOrOptions
      : persistOrOptions?.persist ?? (() => {});
  const logins = new Map<string, LoginState>();
  const aborts = new Map<string, AbortController>();
  /** One terminal signal per pending state, so a poll can wait for the store write it raced. */
  const terminals = new WeakMap<LoginState, Promise<void>>();
  const terminalFor = (state: LoginState): Promise<void> => terminals.get(state) ?? Promise.resolve();

  /** Forget results nobody could still be polling, and kill flows whose code has expired. */
  const sweep = () => {
    const now = Date.now();
    for (const [provider, state] of logins) {
      if (state.status === "pending") {
        if (now - state.startedAt > PENDING_TTL_MS) {
          aborts.get(provider)?.abort();
          aborts.delete(provider);
          logins.set(provider, {
            status: "failed",
            provider,
            events: state.events,
            error: "login timed out",
            settledAt: now,
          });
        }
        continue;
      }
      // A settled state only needs to survive long enough for the client to read it once.
      if (now - state.settledAt > RESULT_TTL_MS) logins.delete(provider);
    }
  };

  return {
    /**
     * Begin (or restart) a provider login and return as soon as the provider emits its first event,
     * which for a device-code flow is the code the human needs. Throws when the provider cannot
     * sign in interactively — or when Hearth cannot finish that particular flow — so the caller can
     * answer with a clear 400.
     *
     * `input.prompt` is what the client can do with a mid-flow question; see `LoginInput`. It gates
     * *whether* a browser-callback flow starts, and it is deliberately not remembered: a second
     * start without it is refused rather than resumed, because a flow whose question has nowhere to
     * go can only sit until the human notices it never moved.
     */
    async start(providerId: string, input: LoginInput = { prompt: false }): Promise<LoginState> {
      sweep();
      const provider = resolveProvider(providerId);
      if (!provider) throw new Error(`unknown provider: ${providerId}`);
      const oauth = provider.oauth;
      if (!oauth?.login) throw new Error(`provider ${providerId} does not support signing in`);
      const support = loginSupport(providerId, input);
      if (!support.supported) throw new Error(support.reason);

      aborts.get(providerId)?.abort();
      const controller = new AbortController();
      aborts.set(providerId, controller);

      const state: LoginState = {
        status: "pending",
        provider: providerId,
        events: [],
        startedAt: Date.now(),
      };
      logins.set(providerId, state);

      /**
       * Only the flow that owns the map may write to it. Testing `status === "pending"` is not
       * enough: a superseded flow's rejection arrives *after* its replacement is installed, so it
       * would settle the new flow as "login cancelled" while that flow's own credential is still on
       * its way. Identity says which flow this outcome belongs to.
       */
      const owns = () => logins.get(providerId) === state;
      const forget = () => {
        if (aborts.get(providerId) === controller) aborts.delete(providerId);
      };
      const fail = (error: string) => {
        if (!owns()) return;
        logins.set(providerId, { status: "failed", provider: providerId, events: state.events, error, settledAt: Date.now() });
        forget();
      };

      /**
       * The delivery for a client that cannot carry questions.
       *
       * It must exist either way: a flow that only asks when one is present would take a different
       * route here — fail for a reason that has nothing to do with the person, and say nothing about
       * what it needed. This one records the question, exactly like a real one, and then throws it:
       * nothing will ever answer, so waiting would be a lie.
       */
      const askForHuman = async (prompt: LoginPrompt): Promise<string> => {
        if (owns()) state.question = { message: prompt.message };
        throw new Error(unreachableQuestion(prompt.message));
      };

      /**
       * Ask the human, when this client can carry a question.
       *
       * The flow parks on this promise, which is the point: a browser sign-in cannot progress without
       * the redirect URL, and inventing one rejects the exchange. Besides a real answer, two things
       * end the wait — the client cancels, or a newer flow replaces this one — and both reject rather
       * than hang, so `start` always settles.
       *
       * Only a flow that actually asks gets it: one provider can ship several flows, and handing this
       * to a device-code flow would leave it looking for answers to a question it never asked.
       */
      const ask = input.prompt
        ? (prompt: LoginPrompt): Promise<string> =>
            new Promise<string>((resolve, reject) => {
              if (controller.signal.aborted) {
                reject(new Error("login cancelled"));
                return;
              }
              const onAbort = () => {
                if (owns()) state.answer = undefined;
                reject(new Error("login cancelled"));
              };
              controller.signal.addEventListener("abort", onAbort, { once: true });
              state.question = { message: prompt.message };
              state.answer = (value) => {
                controller.signal.removeEventListener("abort", onAbort);
                if (owns()) {
                  state.question = undefined;
                  state.answer = undefined;
                }
                resolve(value);
              };
              // The question rides the event list as well, so a client that only knows about events
              // sees it without learning a second scheme, and a failure is reported with it in hand.
              state.events.push({
                type: "question",
                message: prompt.message,
                ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
                ...(prompt.options === undefined
                  ? {}
                  : { options: prompt.options.map((option) => ({ id: option.id, label: option.label })) }),
              });
            })
        : undefined;
      // `login` resolves only when the human finishes, so it runs detached; its outcome is read
      // later by `poll`.
      let flow: Promise<unknown>;
      try {
        flow = oauth.login(
          {
            signal: controller.signal,
            notify: (event) => {
              if (owns()) state.events.push(event);
            },
            // With no wire back to the human, only a question that can be answered on their behalf
            // is answered; a client that carries questions is not a client that needs this. The
            // question a flow gets stuck on is recorded, so the answer can say what was asked.
                prompt: async (prompt) => {
              try {
                return await chooseHeadlessMethod(prompt);
              } catch (error) {
                if (owns()) state.question = { message: prompt.message };
                throw error;
              }
            },
            ...(ask === undefined ? { ask: askForHuman } : { ask }),
          },
          { agentName: "Hearth" }
        );
      } catch (error) {
        // A flow that cannot even be launched leaves no pending state behind for the next 15 minutes.
        logins.delete(providerId);
        forget();
        throw error;
      }
      const settled: Promise<void> = flow
        .then(async (credential) => {
          // Store first, publish second. A client that reads `complete` must find the credential in
          // the store — "signed in" is a claim about the host, not about this process's memory.
          try {
            await persist(providerId, credential);
          } catch (error) {
            fail(`Hearth signed in but could not save the credential: ${messageOf(error)}. Try again.`);
            return;
          }
          // The credential is real even if a newer flow has since taken over the provider, so it is
          // stored either way — but only the owning flow may report it.
          if (!owns()) return;
          const credentialType = credentialTypeOf(credential);
          logins.set(providerId, {
            status: "complete",
            provider: providerId,
            events: state.events,
            credentialType,
            settledAt: Date.now(),
          });
          forget();
          console.log(`[hearth] stored a ${credentialType} credential for ${providerId} from a sign-in`);
        })
        .catch((error: unknown) => {
          // An abort is a deliberate cancel, not a failure worth shouting about.
          fail(controller.signal.aborted ? "login cancelled" : messageOf(error));
        });
      // The terminal moment of this flow — stored (or failed to store), or failed — so a poll that
      // races the store write can wait for it instead of reading `pending` and asking again.
      let markSettled: () => void = () => {};
      const terminal = new Promise<void>((resolve) => {
        markSettled = resolve;
      });
      terminals.set(state, terminal);
      void settled.finally(() => markSettled());

      // Wait for the device code so the caller can return it in one round trip. Once the code is
      // out, give the flow a brief moment to settle too: a provider that resolves or rejects without
      // waiting on the human (a machine-id flow, or an outright rejection) should not force the
      // client into a poll cycle just to learn the outcome. Anything slower — the normal case — is
      // still reported as pending and picked up by `poll`.
      const deadline = Date.now() + FIRST_EVENT_WAIT_MS;
      let sawEvent = false;
      while (Date.now() < deadline) {
        const current = logins.get(providerId);
        // Settled, or replaced by a newer flow: either way this one is no longer the answer.
        if (current !== state) return current ?? state;
        if (state.events.length > 0) {
          if (sawEvent) break;
          sawEvent = true;
        }
        await sleep(50);
      }
      return logins.get(providerId) ?? state;
    },

    /**
     * The current state of a provider's login. A `complete` state means the credential is already
     * stored; the credential itself is never part of the answer.
     */
    poll(providerId: string): LoginState | undefined {
      sweep();
      return logins.get(providerId);
    },

    /**
     * The same answer, but never `pending` for a flow that has already *succeeded*: the flow only
     * publishes `complete` after the store write, and that write is an `await`, so a poll landing in
     * the window would tell the client to poll again for a finished sign-in. The wire awaits this
     * one; the synchronous `poll` stays for callers with a strict answer-now contract.
     */
    async settled(providerId: string): Promise<LoginState | undefined> {
      sweep();
      const current = logins.get(providerId);
      if (current !== undefined && current.status === "pending") {
        await Promise.race([terminalFor(current), sleep(50)]);
        sweep();
      }
      return logins.get(providerId);
    },

    /**
     * Hand a human's answer to the question a flow is blocked on.
     *
     * The flow is parked inside its own `login` call waiting for this string, so there is exactly
     * one recipient and no ordering to get wrong. Answers arrive with the flow that asked them,
     * through `state.answer`, which dies when that flow does.
     */
    answer(providerId: string, value: string): boolean {
      sweep();
      const state = logins.get(providerId);
      if (state?.status !== "pending" || state.answer === undefined) return false;
      state.answer(value);
      return true;
    },

    /** Abandon a running login. Idempotent. */
    cancel(providerId: string): boolean {
      const controller = aborts.get(providerId);
      if (!controller) return false;
      controller.abort();
      aborts.delete(providerId);
      const state = logins.get(providerId);
      if (state?.status === "pending") {
        logins.set(providerId, {
          status: "failed",
          provider: providerId,
          events: state.events,
          error: "login cancelled",
          settledAt: Date.now(),
        });
      }
      return true;
    },

    /** True when a flow is in flight, so `GET /providers` can report it. */
    pending(providerId: string): boolean {
      return logins.get(providerId)?.status === "pending";
    },
  };
};
