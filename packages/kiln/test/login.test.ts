import { describe, expect, test } from 'bun:test';
import { createLoginSupervisor, loginSupport, type LoginProvider, type LoginPrompt } from '../src/login';

/**
 * The sign-in supervisor is the part of OAuth that is Hearth's own: pi-ai owns the device-code flow,
 * and this owns "one flow per provider, pollable, stored exactly when it finishes, never a secret on
 * the wire". Those are the behaviours worth pinning, because every one of them is a way a completed
 * sign-in could be lost, or a fresh flow killed by the one it replaced.
 */

const deviceCode = {
  type: 'device_code' as const,
  userCode: 'ABCD-1234',
  verificationUri: 'https://x.ai/device',
};

const credentialA = { type: 'oauth', access: 'access-a', refresh: 'refresh-a', expires: 1 };
const credentialB = { type: 'oauth', access: 'access-b', refresh: 'refresh-b', expires: 2 };

/** A pause long enough for a detached `.then`/`.catch` chain to run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Poll until `predicate` holds, so a test never depends on one sleep being long enough. */
const waitFor = async (predicate: () => boolean, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await settle();
  }
  throw new Error('condition did not become true');
};

type FakeFlow = {
  /** What the flow does when the human approves; throws if the test wants a failure. */
  complete: (credential?: unknown) => void;
  fail: (message: string) => void;
  /** True once the host's abort reached the flow, as every real pi-ai flow does honour it. */
  aborted: () => boolean;
};

/**
 * A fake provider whose flow emits one device code and then waits for the test, **honouring its
 * signal**. The previous fake ignored the signal, which is exactly why the shipped test could not
 * see a superseded flow's rejection landing on its replacement.
 */
const fakeProvider = (options: { onStart?: (prompt: (prompt: LoginPrompt) => Promise<string>) => Promise<unknown> | void } = {}) => {
  const flows: FakeFlow[] = [];
  const provider: LoginProvider = {
    id: 'xai',
    oauth: {
      loginLabel: 'Sign in with SuperGrok or X Premium',
      name: 'xAI',
      login(interaction) {
        interaction.notify(deviceCode);
        let resolve: (value: unknown) => void = () => {};
        let reject: (error: unknown) => void = () => {};
        let aborted = false;
        const flow: FakeFlow = {
          complete: (credential = credentialA) => resolve(credential),
          fail: (message) => reject(new Error(message)),
          aborted: () => aborted,
        };
        flows.push(flow);
        const promise = new Promise<unknown>((done, failed) => {
          resolve = done;
          reject = failed;
        });
        interaction.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('the host cancelled the flow'));
        });
        // A flow that asks a question dies when the question cannot be answered, exactly as a real
        // one does — the fake relays that rejection into its own outcome.
        void Promise.resolve(options.onStart?.(interaction.prompt)).catch((error: unknown) => reject(error));
        return promise;
      },
    },
  };
  return { provider, flows };
};

describe('provider sign-in', () => {
  test('start returns the device code the human needs', async () => {
    const { provider } = fakeProvider();
    const persisted: unknown[] = [];
    const supervisor = createLoginSupervisor(() => provider, (_id, credential) => void persisted.push(credential));
    const state = await supervisor.start('xai');
    expect(state.status).toBe('pending');
    expect(state.events[0]).toEqual(deviceCode);
    expect(persisted).toEqual([]);
  });

  test('a flow that finishes inside the first request is stored before the answer', async () => {
    const provider: LoginProvider = {
      id: 'xai',
      oauth: {
        loginLabel: 'Sign in with SuperGrok or X Premium',
        async login(interaction) {
          interaction.notify(deviceCode);
          return credentialA;
        },
      },
    };
    const persisted: unknown[] = [];
    const supervisor = createLoginSupervisor(() => provider, (_id, credential) => void persisted.push(credential));
    const state = await supervisor.start('xai');
    expect(state.status).toBe('complete');
    // Stored, not merely reported: the answer the client gets is about the host's state.
    expect(persisted).toEqual([credentialA]);
  });

  test('a flow that finishes after the client started polling is stored exactly once', async () => {
    const { provider, flows } = fakeProvider();
    const persisted: Array<{ provider: string; credential: unknown }> = [];
    const supervisor = createLoginSupervisor(() => provider, (id, credential) => {
      persisted.push({ provider: id, credential });
    });
    await supervisor.start('xai');
    expect(persisted).toEqual([]);

    // The human approves while the client is polling: the completion is observed by a `poll`, not
    // by the request that started the flow. It used to be handed to the client and dropped.
    flows[0]!.complete(credentialA);
    await waitFor(() => supervisor.poll('xai')?.status === 'complete');
    expect(persisted).toEqual([{ provider: 'xai', credential: credentialA }]);

    // Reading the result again — or twenty times — stores nothing more.
    supervisor.poll('xai');
    supervisor.poll('xai');
    await settle();
    expect(persisted).toHaveLength(1);
  });

  test('the completed state reports what was stored, never the secret', async () => {
    const { provider, flows } = fakeProvider();
    const supervisor = createLoginSupervisor(() => provider, () => {});
    await supervisor.start('xai');
    flows[0]!.complete(credentialA);
    await waitFor(() => supervisor.poll('xai')?.status === 'complete');
    const state = supervisor.poll('xai')!;
    expect(state).toMatchObject({ status: 'complete', provider: 'xai', credentialType: 'oauth' });
    expect(state).not.toHaveProperty('credential');
    expect(JSON.stringify(state)).not.toContain('access-a');
  });

  test('a second start does not let the first flow settle it', async () => {
    const { provider, flows } = fakeProvider();
    const persisted: unknown[] = [];
    const supervisor = createLoginSupervisor(() => provider, (_id, credential) => void persisted.push(credential));

    await supervisor.start('xai');
    await supervisor.start('xai');
    await settle();
    // The replaced flow honours the abort and rejects — after the new state is installed. Before the
    // identity guard, that rejection overwrote the new flow with `failed / "login cancelled"`.
    expect(flows[0]!.aborted()).toBe(true);
    expect(supervisor.poll('xai')?.status).toBe('pending');

    flows[1]!.complete(credentialB);
    await waitFor(() => supervisor.poll('xai')?.status === 'complete');
    expect(persisted).toEqual([credentialB]);
  });

  test('a flow that cannot be stored fails with the reason instead of claiming success', async () => {
    const { provider, flows } = fakeProvider();
    const supervisor = createLoginSupervisor(() => provider, () => {
      throw new Error('auth.json is read-only');
    });
    await supervisor.start('xai');
    flows[0]!.complete(credentialA);
    await waitFor(() => supervisor.poll('xai')?.status === 'failed');
    const state = supervisor.poll('xai');
    expect(state?.status === 'failed' ? state.error : '').toContain('auth.json is read-only');
    expect(state?.status === 'failed' ? state.error : '').toContain('could not save the credential');
  });

  test('a flow that asks a question is refused rather than answered with an empty string', async () => {
    // ChatGPT's flow races a `manual_code` prompt against its browser callback; answering "" made the
    // exchange reject before the callback could land, which is what broke that button.
    const { provider, flows } = fakeProvider({
      onStart: (prompt) => prompt({ type: 'manual_code', message: 'Paste the final redirect URL here:' }),
    });
    const supervisor = createLoginSupervisor(() => provider, () => {});
    await supervisor.start('xai');
    await waitFor(() => supervisor.poll('xai')?.status === 'failed');
    const state = supervisor.poll('xai');
    expect(state?.status === 'failed' ? state.error : '').toContain('Paste the final redirect URL here:');
    expect(flows[0]!.aborted()).toBe(false);
  });

  test('a flow waiting on the human stays pending and can be cancelled', async () => {
    const { provider, flows } = fakeProvider();
    const persisted: unknown[] = [];
    const supervisor = createLoginSupervisor(() => provider, (id, credential) => void persisted.push([id, credential]));
    await supervisor.start('xai');
    expect(supervisor.poll('xai')?.status).toBe('pending');
    expect(supervisor.pending('xai')).toBe(true);

    expect(supervisor.cancel('xai')).toBe(true);
    await settle();
    expect(flows[0]!.aborted()).toBe(true);
    const after = supervisor.poll('xai');
    expect(after?.status).toBe('failed');
    expect(after && after.status === 'failed' ? after.error : '').toBe('login cancelled');
    expect(supervisor.pending('xai')).toBe(false);
    // A cancelled flow stores nothing, even though its abort also rejects the provider's promise.
    expect(persisted).toEqual([]);
  });

  test('a cancelled flow keeps the device code it had already shown', async () => {
    const { provider } = fakeProvider();
    const supervisor = createLoginSupervisor(() => provider, () => {});
    await supervisor.start('xai');
    supervisor.cancel('xai');
    const after = supervisor.poll('xai');
    expect(after?.events[0]).toEqual(deviceCode);
  });

  test('two starts run two flows but only the newer one owns the result', async () => {
    const { provider, flows } = fakeProvider();
    const supervisor = createLoginSupervisor(() => provider, () => {});
    await supervisor.start('xai');
    await supervisor.start('xai');
    expect(flows).toHaveLength(2);
    // Still exactly one flow, and it is pending.
    expect(supervisor.poll('xai')?.status).toBe('pending');
  });

  test('a provider that fails reports why', async () => {
    const { provider, flows } = fakeProvider();
    const supervisor = createLoginSupervisor(() => provider, () => {});
    await supervisor.start('xai');
    flows[0]!.fail('authorization denied');
    await waitFor(() => supervisor.poll('xai')?.status === 'failed');
    const state = supervisor.poll('xai');
    expect(state?.status === 'failed' ? state.error : '').toBe('authorization denied');
  });

  test('an unknown provider or one without OAuth is a clear error, not a hang', async () => {
    const supervisor = createLoginSupervisor((id) => (id === 'plain' ? { id: 'plain' } : undefined), () => {});
    await expect(supervisor.start('nope')).rejects.toThrow('unknown provider');
    await expect(supervisor.start('plain')).rejects.toThrow('does not support signing in');
  });

  test('cancel on a flow that is not running is a no-op', () => {
    const supervisor = createLoginSupervisor(() => undefined, () => {});
    expect(supervisor.cancel('xai')).toBe(false);
  });

  test('polling a provider with no login returns nothing', () => {
    const supervisor = createLoginSupervisor(() => undefined, () => {});
    expect(supervisor.poll('xai')).toBeUndefined();
  });
});

describe('which flows Hearth offers', () => {
  test('a device-code flow Hearth can finish is offered', () => {
    expect(loginSupport('xai')).toEqual({ supported: true });
    expect(loginSupport('kimi-coding')).toEqual({ supported: true });
  });

  /**
   * A subscription flow whose only question is "browser or device code" is answerable: on a host with
   * no browser the human would choose the device branch anyway, so Hearth chooses it. Before this, the
   * ChatGPT Plus/Pro row had no button at all and the answer to "how do I sign in" was "you can't".
   */
  test('a flow that only asks which method is offered, and takes the device branch', async () => {
    expect(loginSupport('openai-codex')).toEqual({ supported: true });
    let chosen: string | null = null as string | null;
    const provider: LoginProvider = {
      id: 'openai-codex',
      oauth: {
        loginLabel: 'Sign in with ChatGPT',
        async login(interaction) {
          const answer = await interaction.prompt({
            type: 'select',
            message: 'Select OpenAI Codex login method:',
            options: [
              { id: 'browser', label: 'Browser login (default)' },
              { id: 'device', label: 'Device code login (headless)' },
            ],
          });
          chosen = answer;
          interaction.notify({ type: 'device_code', userCode: 'ABCD', verificationUri: 'https://example.test' } as never);
          return { type: 'oauth', refresh: 'r', access: 'a', expires: Date.now() + 60_000 };
        },
      },
    };
    const persist = () => {};
    const supervisor = createLoginSupervisor(() => provider, persist);
    supervisor.start('openai-codex');
    await Promise.resolve();
    await Promise.resolve();
    // The device branch, not the browser one — the browser path needs a callback server a container
    // may not have.
    expect(chosen).toBe('device');
  });

  test('a question that is not a method choice is still refused', async () => {
    const provider: LoginProvider = {
      id: 'anthropic',
      oauth: {
        loginLabel: 'Sign in',
        async login(interaction) {
          await interaction.prompt({ type: 'manual_code', message: 'Paste the code from the browser' });
          return { type: 'oauth', refresh: 'r', access: 'a', expires: Date.now() + 60_000 };
        },
      },
    };
    // Not offered at all, so the refusal never even reaches the prompt.
    const support = loginSupport('anthropic');
    expect(support.supported).toBe(false);
    expect(support.supported ? '' : support.reason).toMatch(/paste/i);
    expect(provider.oauth).toBeDefined();
  });

  test('a flow that needs an installation id and a pasted code is not offered, and says why', () => {
    const openai = loginSupport('openai');
    expect(openai.supported).toBe(false);
    const reason = openai.supported ? '' : openai.reason;
    // Names what is missing and what the reader can do instead: an API key.
    expect(reason).toContain('installation id');
    expect(reason.toLowerCase()).toContain('api key');
  });

  test('an unknown flow is not offered by default', () => {
    expect(loginSupport('some-provider-added-later').supported).toBe(false);
  });

  test('starting a flow that is not offered is refused before anything runs', async () => {
    let launched = 0;
    let prompted = 0;
    const provider: LoginProvider = {
      id: 'openai',
      oauth: {
        loginLabel: 'Sign in with ChatGPT',
        async login(interaction) {
          launched += 1;
          await interaction.prompt({ type: 'manual_code', message: 'Paste the code' });
          prompted += 1;
          return credentialA;
        },
      },
    };
    const persisted: unknown[] = [];
    const supervisor = createLoginSupervisor(() => provider, (id, credential) => void persisted.push([id, credential]));
    await expect(supervisor.start('openai')).rejects.toThrow('installation id');
    expect(launched).toBe(0);
    expect(prompted).toBe(0);
    expect(persisted).toEqual([]);
  });
});
