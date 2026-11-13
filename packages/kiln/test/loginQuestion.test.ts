import { describe, expect, test } from 'bun:test';
import { createLoginSupervisor, loginSupport, type LoginInteraction, type LoginProvider } from '../src/login';

/**
 * A browser-callback sign-in parks inside its own `login` call waiting for the human to paste the
 * redirect URL back. That is the one shape of OAuth this host could not do before: pi-ai's own
 * flows ask a question mid-flow, and the supervisor used to answer questions by refusing them,
 * because nothing existed to carry an answer to a person. These tests pin both halves of the new
 * arrangement — the wire that delivers an answer while the flow is running, and the refusal that
 * has to stand in its place when the client that started the flow cannot ask.
 */

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await settle();
  }
  throw new Error('condition did not become true');
};

const REDIRECT = 'http://localhost:51121/oauth-callback';
const credential = { type: 'oauth', access: 'access-a', refresh: 'refresh-a', expires: 1 };

type AskingFlow = {
  asked: string[];
  /** What the flow did with each answer, for asserting on the value the human's reply became. */
  answers: string[];
  finish: () => void;
};

/**
 * A flow shaped like a browser sign-in: announce the link, then ask for the redirect URL and park
 * on the answer until the test supplies one.
 */
const askingProvider = (options: { asks?: number; notifyFirst?: boolean } = {}) => {
  const asks = options.asks ?? 1;
  const flow: AskingFlow = { asked: [], answers: [], finish: () => {} };
  const provider: LoginProvider = {
    id: 'antigravity',
    oauth: {
      loginLabel: 'Sign in with Google (Antigravity)',
      name: 'Google (Antigravity)',
      async login(interaction: LoginInteraction) {
        if (options.notifyFirst !== false) {
          interaction.notify({ type: 'auth_url', url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
        }
        for (let index = 0; index < asks; index += 1) {
          const ask = interaction.ask;
          // A flow with no way to ask is a flow that looks at the same prompt and gives up, which is
          // what the supervisor's fallback does; throwing here keeps the two paths distinguishable.
          if (!ask) throw new Error('no way to ask');
          flow.asked.push('question');
          const answer = await ask({
            type: 'manual_code',
            message: `Paste the redirect URL (${index + 1})`,
            placeholder: REDIRECT,
          });
          flow.answers.push(answer);
        }
        flow.finish();
        return credential;
      },
    },
  };
  return { provider, flow };
};

describe('answering a question while a sign-in is running', () => {
  test('an answer reaches the flow that asked, and the credential lands', async () => {
    const { provider, flow } = askingProvider();
    const persisted: unknown[] = [];
    const supervisor = createLoginSupervisor(() => provider, (_id, value) => void persisted.push(value));

    const start = await supervisor.start('antigravity', { prompt: true });
    expect(start.status).toBe('pending');
    const pending = supervisor.poll('antigravity');
    expect(pending?.status === 'pending' ? pending.question?.message : '').toContain('Paste the redirect URL');

    expect(supervisor.answer('antigravity', `${REDIRECT}?code=abc&state=xyz`)).toBe(true);
    await waitFor(() => supervisor.poll('antigravity')?.status === 'complete');
    expect(flow.answers).toEqual([`${REDIRECT}?code=abc&state=xyz`]);
    expect(persisted).toEqual([credential]);
  });

  test('the question is also an event, so a client that only knows events sees it', async () => {
    const { provider } = askingProvider();
    const supervisor = createLoginSupervisor(() => provider, () => {});
    await supervisor.start('antigravity', { prompt: true });
    await waitFor(() => supervisor.poll('antigravity')?.status === 'pending');
    const state = supervisor.poll('antigravity');
    const events = state?.events ?? [];
    expect(events.some((event) => event.type === 'auth_url')).toBe(true);
    const question = events.find((event) => event.type === 'question');
    expect(question?.type === 'question' ? question.placeholder : undefined).toBe(REDIRECT);
  });

  test('answering a second time is refused rather than resolving a settled question', async () => {
    const { provider } = askingProvider();
    const supervisor = createLoginSupervisor(() => provider, () => {});
    await supervisor.start('antigravity', { prompt: true });
    expect(supervisor.answer('antigravity', `${REDIRECT}?code=one`)).toBe(true);
    // The flow is past its question and has not settled yet; the answer has been delivered once and
    // there is nobody left to deliver it to.
    expect(supervisor.answer('antigravity', `${REDIRECT}?code=two`)).toBe(false);
    await waitFor(() => supervisor.poll('antigravity')?.status === 'complete');
  });

  test('a re-asked question replaces the first, so the newest message is the one shown', async () => {
    const { provider } = askingProvider({ asks: 2 });
    const supervisor = createLoginSupervisor(() => provider, () => {});
    await supervisor.start('antigravity', { prompt: true });
    expect(supervisor.answer('antigravity', 'not a url')).toBe(true);
    await waitFor(() => supervisor.poll('antigravity')?.status === 'pending');
    const state = supervisor.poll('antigravity');
    const questions = (state?.events ?? []).filter((event) => event.type === 'question');
    expect(questions).toHaveLength(2);
    // A client reads the last one; the first is history, not a question still waiting.
    expect(state?.status === 'pending' ? state.question?.message : '').toContain('(2)');
  });

  test('answering a provider with no running sign-in is refused', () => {
    const supervisor = createLoginSupervisor(() => undefined, () => {});
    expect(supervisor.answer('antigravity', 'x')).toBe(false);
  });

  test('a pending question ends when the human cancels instead of hanging', async () => {
    const { provider } = askingProvider();
    const supervisor = createLoginSupervisor(() => provider, () => {});
    await supervisor.start('antigravity', { prompt: true });
    expect(supervisor.poll('antigravity')?.status).toBe('pending');
    expect(supervisor.cancel('antigravity')).toBe(true);
    await waitFor(() => supervisor.poll('antigravity')?.status === 'failed');
    const state = supervisor.poll('antigravity');
    expect(state?.status === 'failed' ? state.error : '').toBe('login cancelled');
    expect(supervisor.answer('antigravity', `${REDIRECT}?code=late`)).toBe(false);
  });

  test('a flow started by a client that cannot ask fails with the question quoted', async () => {
    // Antigravity is offered to every client, so a flow reaching for an answer it cannot be given
    // is a bug — but the fallback still has to say where the sign-in can be finished, so it is
    // pinned on a provider whose flow this test drives directly (one Hearth does offer every time).
    const { provider } = askingProvider();
    (provider as { id: string }).id = 'openrouter';

    const supervisor = createLoginSupervisor(() => provider, () => {});
    await supervisor.start('openrouter');
    await waitFor(() => supervisor.poll('openrouter')?.status === 'failed');
    const state = supervisor.poll('openrouter');
    const error = state?.status === 'failed' ? state.error : '';
    // The person reading this has to learn what was asked and where to go instead.
    expect(error).toContain('Paste the redirect URL');
    expect(error.toLowerCase()).toContain('machine running this hearth');
  });
});

describe('which providers a client that can ask is offered', () => {
  test('Antigravity is a browser sign-in Hearth runs itself, so it is always offered', () => {
    // It ships in Hearth rather than pi-ai, and its flow asks through `ask`, which the supervisor
    // supplies whenever the client can carry a question — so the offer does not depend on the ask.
    expect(loginSupport('antigravity')).toEqual({ supported: true });
  });

  test('OpenAI’s browser flow is offered only to a client that can relay the pasted code', () => {
    const without = loginSupport('openai');
    expect(without.supported).toBe(false);
    // Names what is missing (the pasted code) and the way forward (the host's own Ember, or a key).
    expect(without.supported ? '' : without.reason).toContain('code pasted back');
    expect(without.supported ? '' : without.reason).toContain('machine running this Hearth');
    expect(loginSupport('openai', { prompt: true })).toEqual({ supported: true });
  });

  test('a device-code flow is offered either way', () => {
    expect(loginSupport('xai', { prompt: false })).toEqual({ supported: true });
    expect(loginSupport('openai-codex', { prompt: true })).toEqual({ supported: true });
  });

  test('a flow nobody has finished is still refused, whatever the client can do', () => {
    expect(loginSupport('some-provider-added-later', { prompt: true }).supported).toBe(false);
  });
});
