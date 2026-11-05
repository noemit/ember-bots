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
  | { type: "info"; message: string }
  | { type: "progress"; message: string };

export type LoginPrompt = { type?: string; message: string; placeholder?: string };

/**
 * - `pending`: waiting on the human; `events` may already hold the device code.
 * - `complete`: the token arrived **and is stored**; `credentialType` says what landed (`credential` is retained for callers that read it directly).
 * - `failed`: cancelled, timed out, rejected by the provider, or not storable.
 */
export type LoginState =
  | { status: "pending"; provider: string; events: LoginEvent[]; startedAt: number }
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
    login(
      interaction: {
        signal: AbortSignal;
        prompt: (prompt: LoginPrompt) => Promise<string>;
        notify: (event: LoginEvent) => void;
      },
      options?: { agentName?: string }
    ): Promise<unknown>;
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
export const CAN_COMPLETE: ReadonlySet<string> = new Set(["xai", "kimi-coding"]);
export const VERIFIED_FLOWS = CAN_COMPLETE;

/** Why a known flow is not offered, in words the person reading the refusal can use. */
const OBSTRUCTIONS: Record<string, string> = {
  openai:
    "Sign in with ChatGPT needs an installation id and a code pasted back from the browser, and Hearth cannot ask you for the code yet. Paste a ChatGPT API key for openai instead.",
};

export const loginSupport = (providerId: string): LoginSupport =>
  CAN_COMPLETE.has(providerId)
    ? { supported: true }
    : {
        supported: false,
        reason:
          OBSTRUCTIONS[providerId] ??
          "Hearth has not been shown to finish this provider's sign-in, so it does not offer it. Paste an API key for this provider instead.",
      };

export const canCompleteLogin = (providerId: string): boolean => CAN_COMPLETE.has(providerId);

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
const unanswerable = async (prompt: LoginPrompt): Promise<string> => {
  throw new Error(`This provider's sign-in asks "${prompt.message}", and Hearth has no way to ask you for it.`);
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
     */
    async start(providerId: string): Promise<LoginState> {
      sweep();
      const provider = resolveProvider(providerId);
      if (!provider) throw new Error(`unknown provider: ${providerId}`);
      const oauth = provider.oauth;
      if (!oauth?.login) throw new Error(`provider ${providerId} does not support signing in`);
      const support = loginSupport(providerId);
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
            prompt: unanswerable,
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
