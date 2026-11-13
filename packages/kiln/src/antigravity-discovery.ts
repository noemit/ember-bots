/**
 * Reading Antigravity's catalogue over the wire, at the moment a refresh happens.
 *
 * Three endpoints, because the backend rotates models across them: a new Flash generation reaches
 * the daily and sandbox hosts before production, and reading only production is how a release the
 * account is entitled to stays invisible. The answers are unioned — a model present on any host is
 * a model the account can use.
 *
 * Everything here is best-effort by design. A refresh happens on boot, on a sign-in, and when a
 * person presses Refresh; none of those may fail because one host is slow, and none of them should
 * replace a working list with nothing. A failed read keeps whatever the store already holds.
 */

import type { Credential, Model, ModelCost } from "@earendil-works/pi-ai";
import { buildDiscoveredCatalog, type AntigravityRouting } from "./antigravity-catalog";
import { ANTIGRAVITY_PROVIDER_ID, credentialProjectId } from "./antigravity-oauth";

/**
 * Where the catalogue lives, in the order the first-party client tries them.
 *
 * `ANTIGRAVITY_BASE_URL` overrides the whole list, for pointing Hearth at a proxy or a test double;
 * one explicit host means one host is asked, because a person who named an endpoint did not mean
 * "and also three Google ones".
 */
const endpointCandidates = (): string[] => {
  const explicit = process.env.ANTIGRAVITY_BASE_URL?.trim();
  if (explicit) return [explicit.replace(/\/+$/, "")];
  return [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ];
};

/** A catalogue read must not outlast a person's patience for a Refresh button. */
const CATALOG_TIMEOUT_MS = 8_000;

/**
 * The fingerprint the CLI sends. The backend gates catalogue *visibility* on it — a catalogue read
 * with a browser-ish agent string comes back smaller than the same read from the CLI — so this is
 * part of the request, not decoration.
 */
export const ANTIGRAVITY_USER_AGENT = "antigravity/cli/1.5.5 (aidev_client; os_type=linux; arch=amd64; auth=consumer)";

type RawAnswer = {
  endpoint: string;
  models: Record<string, unknown>;
  agentModelSorts?: unknown;
};

/**
 * Ask every endpoint that answers, and union the results.
 *
 * `allSettled` rather than `all`: one slow or broken host must not discard the others' answers. An
 * endpoint that returns nothing usable is skipped rather than failing the refresh.
 */
export const fetchAvailableCatalog = async (
  token: string,
  projectId: string,
  signal: AbortSignal,
  endpoints: readonly string[] = endpointCandidates()
): Promise<RawAnswer | undefined> => {
  const answers = await Promise.allSettled(
    endpoints.map(async (endpoint): Promise<RawAnswer | undefined> => {
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]);
      try {
        const response = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": ANTIGRAVITY_USER_AGENT,
          },
          body: JSON.stringify({ project: projectId }),
          signal: attempt,
        });
        if (!response.ok) return undefined;
        const data: unknown = await response.json();
        if (typeof data !== "object" || data === null) return undefined;
        const record = data as { models?: unknown; agentModelSorts?: unknown };
        if (typeof record.models !== "object" || record.models === null) return undefined;
        const models = record.models as Record<string, unknown>;
        if (Object.keys(models).length === 0) return undefined;
        return {
          endpoint,
          models,
          ...(record.agentModelSorts === undefined ? {} : { agentModelSorts: record.agentModelSorts }),
        };
      } catch {
        // A cancelled refresh is the caller's business; a broken endpoint is not.
        return undefined;
      }
    })
  );
  const usable = answers.flatMap((answer) => (answer.status === "fulfilled" && answer.value ? [answer.value] : []));
  if (usable.length === 0) return undefined;
  if (usable.length === 1) return usable[0];

  // Union the model maps, and keep every host's curated ordering: a model only the daily host
  // recommends is still a model, and dropping its sort entry would hide it from the grouped view.
  const models: Record<string, unknown> = {};
  const sorts: unknown[] = [];
  for (const answer of usable) {
    Object.assign(models, answer.models);
    if (Array.isArray(answer.agentModelSorts)) sorts.push(...answer.agentModelSorts);
  }
  return { endpoint: usable.at(-1)!.endpoint, models, agentModelSorts: sorts.length > 0 ? sorts : undefined };
};

/**
 * The `fetchModels` a provider installs.
 *
 * pi-ai hands over the stored credential and a publish channel; this returns the chat models to
 * show. A missing credential is not an error — the provider is registered with no credential too,
 * and it simply has no catalogue to offer.
 */
export const fetchAntigravityModels = async (
  context: {
    credential?: Credential;
    allowNetwork: boolean;
    signal: AbortSignal;
  },
  /**
   * The static table's own entries, consulted only for what a discovered family does not report:
   * a brand-new Flash inherits the Flash family's window and price rather than a guess.
   */
  defaults: (publicId: string) => { contextWindow?: number; maxTokens?: number; input?: Array<"text" | "image">; reasoning?: boolean; cost?: ModelCost },
  /** Called with the routes the read produced, when it produces any. */
  installRouting?: (routing: Record<string, AntigravityRouting>) => void
): Promise<Model<"antigravity">[]> => {
  if (!context.allowNetwork || context.signal.aborted) return [];
  const credential = context.credential;
  if (!credential || credential.type !== "oauth" || typeof credential.access !== "string") return [];
  // The same JSON the transport receives, built here from the stored credential: the OAuth record
  // carries the project id the endpoint needs, and it is not in `access`.
  const projectId = typeof credential["projectId"] === "string" ? credential["projectId"] : undefined;
  if (!projectId) return [];

  const answer = await fetchAvailableCatalog(credential.access, projectId, context.signal);
  if (!answer) return [];

  const catalog = buildDiscoveredCatalog(answer.models as never, { defaults }, answer.agentModelSorts);
  if (catalog.models.length === 0) return [];
  // The routes travel with the models: a discovered id with no route would send the public id,
  // which this backend does not serve. Installed by the caller rather than imported here, because
  // the transport imports this module, not the other way round.
  installRouting?.(catalog.routing);

  const models: Model<"antigravity">[] = [];
  for (const entry of catalog.models) {
    const routing = catalog.routing[entry.id];
    if (!routing) continue;
    models.push({
      id: entry.id,
      name: entry.name,
      api: "antigravity",
      provider: ANTIGRAVITY_PROVIDER_ID,
      baseUrl: answer.endpoint,
      input: entry.input,
      reasoning: entry.reasoning,
      ...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
      // Prices live in the static table, keyed by public id. A discovered family takes its
      // family's rate rather than zero: zero would be rendered as "free" and quietly hide real
      // spend. A family the table does not know reports zero, the honest "unknown".
      cost: defaults(entry.id).cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
    });
  }
  return models;
};

