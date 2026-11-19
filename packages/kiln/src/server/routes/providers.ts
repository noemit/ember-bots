import { AgentsDoc, writePeersMirror, type PeerEndpoint } from "../../agents";
import {
  alignmentProviders,
  importApiKeys,
  importCredentials,
  mergePeers,
  portablePeer,
  shareApiKeys,
  type ShareTarget,
} from "../../alignment";
import { credentialEnvVar, importOpenCodeCredentials, isCredential, normalizeProviderId } from "../../credentials";
import { loginSupport, unreachableQuestion, type LoginInput, type LoginState } from "../../login";
import { ensureConditionalProviders } from "../../models";
import {
  badRequest,
  brief,
  decodeSegment,
  HttpFailure,
  json,
  noRoute,
  notFound,
  readBody,
  serverContext,
} from "../http";
import type { RouteContext } from "../types";

const context = serverContext;

const loginInput = (body: Record<string, unknown>): LoginInput => {
  const prompt = body.prompt;
  return { prompt: typeof prompt === "object" && prompt !== null && (prompt as { capable?: unknown }).capable === true };
};

const loginAnswer = (state: LoginState): Response =>
  json(
    state.status === "complete"
      ? { status: state.status, events: state.events, credentialType: state.credentialType }
      : state.status === "failed"
        ? { status: state.status, events: state.events, error: state.error }
        : { status: state.status, events: state.events }
  );

export const handleProviderRoutes = async (ctx: RouteContext): Promise<Response | null> => {
  const { request, path, runtime } = ctx;
  const { deps, runLiveModelRefresh, refreshModelCatalog, loginSupervisor } = runtime;
  const { config, harness, models, defaultAgent, store, localRuntimes } = deps;

  if (path === "/custom-providers" || path.startsWith("/custom-providers/")) {
    const custom = deps.customProviders;
    if (!custom) return badRequest("This Kiln cannot manage custom providers yet. Update Kiln, then try again.");
    try {
      if (path === "/custom-providers" && request.method === "GET") return json({ providers: await custom.list() });
      if (path === "/custom-providers/discover" && request.method === "POST") {
        const body = await readBody(request);
        return json(await custom.discover(body.baseUrl, body.apiKey, body.id));
      }
      if (path === "/custom-providers" && request.method === "POST") {
        return json(await custom.save(await readBody(request)));
      }
      const id = decodeSegment(path.slice("/custom-providers/".length));
      if (id && request.method === "PUT") return json(await custom.save(await readBody(request), id));
      if (id && request.method === "DELETE") {
        await custom.remove(id);
        return json({ ok: true });
      }
    } catch (error) {
      if (error instanceof HttpFailure) throw error;
      const message = error instanceof Error ? error.message : "";
      return badRequest(
        /^(Use |Enter |Give |Discover |Kiln |The base URL)/.test(message)
          ? message
          : "Kiln could not save this provider. Retry, or check that its storage is writable."
      );
    }
  }

  const availableModelsResponse = async () => {
    const available = await models.getAvailable().catch(() => models.getModels());
    return json({
      models: available.map((model) =>
        model.provider.startsWith("custom-")
          ? { ...model, providerName: models.getProvider(model.provider)?.name ?? model.provider }
          : model
      ),
      default: defaultAgent.model,
    });
  };

  if (request.method === "GET" && path === "/models") {
    return await availableModelsResponse();
  }
  if (request.method === "POST" && path === "/models/refresh") {
    const body = await readBody(request).catch((): Record<string, unknown> => ({}));
    let providers: string[] | undefined;
    if (body.providers !== undefined) {
      if (
        !Array.isArray(body.providers) ||
        body.providers.length > 50 ||
        body.providers.some((id: unknown) => typeof id !== "string" || !id.trim())
      ) {
        return badRequest("providers must be a list of provider IDs.");
      }
      providers = [...new Set((body.providers as string[]).map((id) => normalizeProviderId(id.trim())))];
    }
    await runLiveModelRefresh(providers, AbortSignal.timeout(12_000));
    return await availableModelsResponse();
  }
  if (request.method === "GET" && path === "/usage") {
    return json(await harness.usage(context));
  }

  if (path.startsWith("/providers/") && path.endsWith("/login/answer")) {
    const providerId = decodeSegment(path.slice("/providers/".length, -"/login/answer".length));
    if (!providerId) return badRequest("missing provider id");
    if (request.method !== "POST") return noRoute(request.method, path, ["POST"]);
    const body = await readBody(request);
    const answer = typeof body.answer === "string" ? body.answer.trim() : "";
    if (!answer) return badRequest("Send the answer the sign-in is waiting for, or cancel the sign-in.");
    if (answer.length > 8192) {
      return badRequest(
        "That answer is longer than the sign-in can use. Paste just the address from your browser, not the page."
      );
    }
    if (!loginSupervisor.answer(providerId, answer)) {
      return badRequest(`No sign-in for ${providerId} is waiting for an answer. Start the sign-in again.`);
    }
    return json({ ok: true });
  }

  if (path.startsWith("/providers/") && path.endsWith("/login")) {
    const providerId = decodeSegment(path.slice("/providers/".length, -"/login".length));
    if (!providerId) return badRequest("missing provider id");

    if (request.method === "GET") {
      const state = await loginSupervisor.settled(providerId);
      if (state?.status === "pending" && state.question) {
        return json({ status: "failed", events: state.events, error: unreachableQuestion(state.question.message) });
      }
      if (!state) return notFound(`no sign-in is in progress for provider "${brief(providerId, 100)}"`);
      return loginAnswer(state);
    }

    if (request.method === "DELETE") {
      return json({ ok: true, cancelled: loginSupervisor.cancel(providerId) });
    }

    if (request.method === "POST") {
      if (!store) return badRequest("no credential store");
      const input = loginInput(await readBody(request));
      try {
        return loginAnswer(await loginSupervisor.start(providerId, input));
      } catch (error) {
        return badRequest(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (request.method === "GET" && path === "/providers") {
    const stored = store ? await store.list() : [];
    const types = new Map(stored.map((entry) => [entry.providerId, entry.type]));
    const providers = models.getProviders().map((provider) => {
      const oauth = provider.auth.oauth;
      const support = loginSupport(provider.id);
      const credential = types.get(provider.id) ?? null;
      return {
        id: provider.id,
        name: provider.name,
        credential,
        envVar: credential ? undefined : credentialEnvVar(provider.id),
        custom: provider.id.startsWith("custom-"),
        signIn:
          oauth?.login && support.supported
            ? {
                label: oauth.loginLabel ?? oauth.name ?? "Sign in",
                pending: loginSupervisor.pending(provider.id),
              }
            : null,
      };
    });
    return json({ providers, default: defaultAgent.model, ...(localRuntimes ? { localRuntimes } : {}) });
  }

  // Old boot imports could leave unrelated credentials on disk. Never advertise or transfer
  // them as accounts of this Kiln; don't delete potentially user-owned data during discovery.
  const registeredProviders = () => new Set(models.getProviders().map((provider) => provider.id));
  if (path === "/alignment" && request.method === "GET") {
    try {
      const state = await harness.snapshot(AgentsDoc, context);
      const registered = registeredProviders();
      const providers = store ? (await alignmentProviders(store, deps.alignmentConfig)).filter(p => registered.has(p.providerId)) : [];
      const credentials = providers.filter(p => p.source === "stored");
      return json({
        providers,
        apiKeys: credentials.filter((c) => c.type === "api_key").map((c) => c.providerId),
        signIns: credentials.filter((c) => c.type === "oauth").length,
        peers: (state?.peers ?? []).filter((p) => portablePeer(p)).map(({ id, label, url }) => ({ id, label, url })),
      });
    } catch {
      return json(
        { error: "Kiln could not read its provider metadata. Check its credential storage, then refresh this review." },
        503
      );
    }
  }
  if (path === "/alignment/connections" && request.method === "POST") {
    const state = await harness.snapshot(AgentsDoc, context);
    return json({
      peers: (state?.peers ?? []).flatMap((p) => {
        const peer = portablePeer(p);
        return peer ? [peer] : [];
      }),
    });
  }
  if (path === "/alignment/import" && request.method === "POST") {
    const body = await readBody(request);
    if (!Array.isArray(body.peers) || body.peers.length > 100) {
      return badRequest("Choose up to 100 connections to align.");
    }
    const peers = body.peers.map(portablePeer);
    if (peers.some((p) => !p)) {
      return badRequest("Use private-network or HTTPS addresses reachable from another computer.");
    }
    let keys = 0;
    try {
      if (body.keys !== undefined && !Array.isArray(body.keys)) throw new Error();
      if (body.credentials !== undefined && !Array.isArray(body.credentials)) throw new Error();
      if (body.keys !== undefined && body.credentials !== undefined) throw new Error();
      if (
        (Array.isArray(body.keys) && body.keys.length > 0) ||
        (Array.isArray(body.credentials) && body.credentials.length > 0)
      ) {
        if (!store) return badRequest("This Kiln cannot store provider credentials. Update it, then try again.");
        keys =
          body.credentials !== undefined
            ? await importCredentials(store, body.credentials, deps.alignmentConfig)
            : await importApiKeys(store, body.keys);
      }
    } catch {
      return badRequest("The provider list is not valid. Review the source instance and try again.");
    }
    let added = 0;
    let merged: PeerEndpoint[] = [];
    await harness.commit(async (tx) => {
      const doc = await tx.doc(AgentsDoc);
      merged = mergePeers(doc.peers ?? [], peers as PeerEndpoint[]);
      added = merged.length - (doc.peers?.length ?? 0);
      doc.peers = merged;
    }, context);
    writePeersMirror(config.home, merged);
    if (keys > 0 && store) await ensureConditionalProviders(models, store);
    return json({ connections: added, keys });
  }
  if (path === "/alignment/share" && request.method === "POST") {
    if (!store) return badRequest("This Kiln cannot read stored provider credentials. Update it, then try again.");
    const body = await readBody(request);
    if (!Array.isArray(body.targets) || body.targets.length > 100) {
      return badRequest("Choose up to 100 destination instances.");
    }
    try {
      const results = await shareApiKeys(store, body.targets as ShareTarget[], fetch, deps.alignmentConfig, registeredProviders());
      return json({ results });
    } catch {
      return badRequest("Kiln could not validate the provider review. Refresh providers and review the selection again.");
    }
  }

  if (request.method === "POST" && path === "/providers/import") {
    if (!store) return badRequest("no credential store");
    const imported = await importOpenCodeCredentials(store, registeredProviders(), deps.openCodeImportSource);
    if (imported.length > 0) refreshModelCatalog("an import");
    return json({ imported });
  }

  if (path.startsWith("/providers/") && (request.method === "POST" || request.method === "DELETE")) {
    if (!store) return badRequest("no credential store");
    const providerId = decodeSegment(path.slice("/providers/".length));
    if (!providerId) return badRequest("missing provider id");
    if (providerId.startsWith("custom-")) {
      return badRequest("Edit custom providers in Settings → Providers so Kiln can keep each key bound to its destination.");
    }
    if (request.method === "DELETE") {
      await store.delete(providerId);
      refreshModelCatalog(`clearing ${providerId}`);
      return json({ ok: true, provider: providerId, credential: null });
    }
    const body = (await readBody(request)) as unknown;
    if (!isCredential(body)) return badRequest('expected a credential, e.g. { "type": "api_key", "key": "…" }');
    const credential = await store.modify(providerId, async () => body);
    refreshModelCatalog(`a credential for ${providerId}`);
    return json({ ok: true, provider: providerId, credential: credential?.type ?? null });
  }

  return null;
};
