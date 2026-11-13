/**
 * Google "Antigravity" sign-in: the Google account flow that fronts Gemini/Claude/GPT-OSS models
 * on the Cloud Code Assist endpoint (the wire format `./antigravity.ts` speaks).
 *
 * This is not a documented Google product API. It is the flow the Antigravity CLI uses, and the
 * shapes below — PKCE, a loopback redirect on a fixed port, `loadCodeAssist` for the project id —
 * are re-implemented from the community `pi-antigravity` extension so the wire traffic matches
 * what Google already accepts for that client. Nothing is imported from it.
 *
 * The credential is a pi-ai `OAuthCredential`: `access`/`refresh`/`expires` plus the Cloud Code
 * Assist `projectId` and the account `email`, both of which the streaming transport needs and must
 * not re-discover on every request.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";

/** The port Google's desktop client registers for the redirect, so the CLI fingerprint matches. */
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/oauth-callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

/** Ends a login nobody is completing, so a forgotten dialog does not hold a port forever. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Project discovery must be fast; a stalled endpoint falls through to the next candidate. */
const DISCOVERY_TIMEOUT_MS = 8_000;
/** Access tokens are treated as expiring five minutes early, so a request never races expiry. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

const SCOPES = [
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

/**
 * Google's public Antigravity desktop client, not a secret: it ships inside the CLI that everyone
 * can download, and it is what makes the resulting token valid for Cloud Code Assist.
 * `ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET` override it for anyone running their own
 * OAuth client; neither is ever logged.
 */
function clientId(): string {
  return (
    process.env.ANTIGRAVITY_CLIENT_ID?.trim() ||
    atob("MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc" + "C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==")
  );
}

function clientSecret(): string {
  return (
    process.env.ANTIGRAVITY_CLIENT_SECRET?.trim() ||
    atob("R09DU1BYLUs1OEZXUjQ" + "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=")
  );
}

/** Cloud Code Assist endpoints, in the order the CLI tries them. */
function endpointCandidates(): string[] {
  const explicit = process.env.ANTIGRAVITY_BASE_URL?.trim();
  if (explicit) return [explicit.replace(/\/+$/, "")];
  return [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ];
}

/**
 * The credential as the catalogue reader sees it: an OAuth record whose `access` is the bearer token
 * and whose `projectId` names the Cloud Code Assist project. Aliased rather than repeated so the
 * reader and the flow cannot drift on field names.
 */
export type AntigravityCredential = OAuthCredential;

// --- credential field access -------------------------------------------------------------------
// `OAuthCredential` carries an index signature for extension fields, so the two Antigravity
// additions are read through helpers rather than casts at every use.

/** The Cloud Code Assist project this sign-in belongs to. */
export function credentialProjectId(credential: OAuthCredential): string | undefined {
  const value = credential["projectId"];
  return typeof value === "string" && value ? value : undefined;
}

/** The signed-in Google account, shown in settings and used to seed the fallback project id. */
export function credentialEmail(credential: OAuthCredential): string | undefined {
  const value = credential["email"];
  return typeof value === "string" && value ? value : undefined;
}

// --- small crypto/url helpers ------------------------------------------------------------------

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/** PKCE: a random verifier and its S256 challenge. The verifier never leaves this process. */
function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  return { verifier, challenge: base64Url(createHash("sha256").update(verifier).digest()) };
}

/** The consent screen URL: offline access and forced consent are what make Google return a refresh token. */
function authorizationUrl(state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/**
 * A UUID-shaped v5 id from a seed. Used both for the fallback project id and for trajectory ids:
 * Cloud Code Assist only wants the shape, and a stable value means the same account keeps the same
 * project across logins even when discovery is unavailable.
 */
export function stableUuid(seed: string): string {
  const bytes = createHash("sha1").update(seed).digest().subarray(0, 16);
  // RFC 4122 version 5 and the RFC 4122 variant bits.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Fallback project id: shaped like a real one, derived from the account so it does not drift. */
function defaultProjectId(seed: string): string {
  return stableUuid(`antigravity:project:${seed}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Provider error bodies are JSON with the useful sentence in `error_description`/`message`. */
function providerErrorText(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      const parts = [parsed["error"], parsed["error_description"], parsed["message"]].filter(
        (part): part is string => typeof part === "string" && part.length > 0
      );
      if (parts.length) return parts.join(": ").slice(0, 300);
    }
  } catch {
    // not JSON, fall through to the raw text
  }
  return raw.trim().slice(0, 300) || "no details from Google";
}

// --- token exchange ----------------------------------------------------------------------------

type TokenResponse = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };

function readTokenResponse(data: TokenResponse): { access: string; refresh?: string; expires: number } {
  const access = asString(data.access_token);
  if (!access) throw new Error("Google answered without an access token. Sign in again from Ember's Providers screen.");
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  return {
    access,
    refresh: asString(data.refresh_token),
    expires: Date.now() + expiresIn * 1000 - EXPIRY_SKEW_MS,
  };
}

async function postToken(body: URLSearchParams, signal: AbortSignal): Promise<Response> {
  return fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal,
  });
}

// --- project + identity discovery --------------------------------------------------------------

/**
 * Walk the `loadCodeAssist` answer for a project id. The field has moved between releases, and the
 * value is sometimes an object (`{ id }`) or an array of them, so every plausible location is read
 * rather than guessing one.
 */
export function extractProjectId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const direct =
    data["antigravityProjectId"] ??
    data["projectId"] ??
    data["backendProjectId"] ??
    data["cloudaicompanionProject"] ??
    data["project"] ??
    (isRecord(data["direct"]) ? data["direct"]["id"] : undefined);
  const directId = asString(direct);
  if (directId) return directId;
  if (isRecord(direct)) {
    const nestedId = asString(direct["id"]);
    if (nestedId) return nestedId;
  }
  for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
    const value = data[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      // An entry is either a bare id or an object; an object may still hold its id deeper, but the
      // loop above already knows every key that holds one.
      const nested = asString(item) ?? (isRecord(item) ? asString(item["id"]) : undefined);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** The account email, used as the seed for a fallback project id. Failure is not an error. */
async function fetchEmail(access: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${access}` }, signal });
    if (!response.ok) return undefined;
    const data: unknown = await response.json();
    return isRecord(data) ? asString(data["email"]) : undefined;
  } catch {
    return undefined;
  }
}

/** Ask each endpoint in turn for the project this account belongs to. */
async function loadCodeAssist(access: string, signal: AbortSignal): Promise<string | undefined> {
  const body = JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } });
  for (const endpoint of endpointCandidates()) {
    const attempt = AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]);
    try {
      const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
        body,
        signal: attempt,
      });
      if (!response.ok) continue;
      const project = extractProjectId(await response.json());
      if (project) return project;
    } catch (error) {
      // A cancelled login must stop the whole flow; an endpoint that is merely slow or broken
      // just hands over to the next candidate.
      if (signal.aborted) throw error;
    }
  }
  return undefined;
}

// --- the browser callback ----------------------------------------------------------------------

type CallbackResult = { code: string; state: string };

const CALLBACK_HEADERS: Record<string, string> = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/**
 * Start the loopback callback server. Resolves `undefined` when the port is taken (another login,
 * or another CLI): the flow then relies on the pasted redirect URL alone, which is a working path,
 * not a degraded one.
 */
function startCallbackServer(
  expectedState: string
): Promise<{ waitForCode: Promise<CallbackResult>; close: () => void } | undefined> {
  return new Promise((resolve) => {
    let settle: (result: CallbackResult) => void = () => {};
    let fail: (error: Error) => void = () => {};
    const waitForCode = new Promise<CallbackResult>((res, rej) => {
      settle = res;
      fail = rej;
    });
    // Nothing awaits `waitForCode` when the paste path wins, so keep the loss from surfacing as an
    // unhandled rejection.
    waitForCode.catch(() => {});

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404, CALLBACK_HEADERS);
        response.end("Not an Antigravity sign-in callback.\n");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (error) {
        response.writeHead(400, CALLBACK_HEADERS);
        response.end("Google refused the sign-in. Return to Ember and try again.\n");
        fail(new Error(`Google refused the sign-in: ${error.slice(0, 200)}`));
        return;
      }
      if (!code) {
        response.writeHead(400, CALLBACK_HEADERS);
        response.end("This callback carried no authorization code. Return to Ember and try again.\n");
        fail(new Error("The Google sign-in callback carried no authorization code."));
        return;
      }
      if (state !== expectedState) {
        response.writeHead(400, CALLBACK_HEADERS);
        response.end("This callback belongs to a different sign-in. Return to Ember and try again.\n");
        fail(new Error("OAuth state mismatch: this callback belongs to a different sign-in."));
        return;
      }
      response.writeHead(200, CALLBACK_HEADERS);
      response.end("Antigravity sign-in complete. You can close this tab and return to Ember.\n");
      settle({ code, state });
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(undefined);
        return;
      }
      fail(error);
      resolve(undefined);
    });

    // Loopback only: this listens for a redirect carrying an authorization code, so it must not be
    // reachable from the network the machine happens to be on.
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      resolve({ waitForCode, close: () => server.close() });
    });
  });
}

/**
 * Read a pasted value: the full redirect URL (an address bar is the usual source), a bare query
 * string, or just the code. A `state` that comes with it must match, because a mismatch means the
 * human signed in to a different attempt than the one this flow is holding.
 */
export function parseCallbackInput(raw: string, expectedState: string): CallbackResult {
  const text = raw.trim();
  if (!text) throw new Error("Nothing was pasted. Paste the full URL from your browser's address bar.");
  let params: URLSearchParams | undefined;
  try {
    params = new URL(text).searchParams;
  } catch {
    if (text.includes("code=") || text.includes("state=")) {
      params = new URLSearchParams(text.startsWith("?") ? text.slice(1) : text);
    }
  }
  if (!params) return { code: text, state: expectedState };
  const error = params.get("error");
  if (error) throw new Error(`Google refused the sign-in: ${error.slice(0, 200)}`);
  const code = params.get("code");
  if (!code) throw new Error("That URL has no authorization code in it. Paste the full URL from your browser's address bar.");
  const state = params.get("state");
  if (state !== null && state !== expectedState) {
    throw new Error("That callback is from a different sign-in. Start the sign-in again and paste the new URL.");
  }
  return { code, state: expectedState };
}

type ManualCodePrompt = { type: "manual_code"; message: string; placeholder?: string };

/** How the flow reaches the human: it shows them events, and asks them one question. */
type AskSurface = {
  /**
   * Deliver a question and wait for the reply — what a browser sign-in needs and what a
   * request/response JSON API cannot do inline. Present only when the host can carry an answer back
   * while the flow is still running.
   */
  ask?: (prompt: ManualCodePrompt) => Promise<string>;
  /**
   * Ask inline, for a host that answers questions itself. It is the only surface that can *refuse*
   * honestly: when nobody can be asked, a pending question has to become an error rather than a
   * wait that nothing will ever end.
   */
  prompt: (prompt: ManualCodePrompt & { signal?: AbortSignal }) => Promise<string>;
  notify: (event: AskEvent) => void;
};

/** What the flow has to say: the link to open, and the occasional correction on a paste. */
type AskEvent = { type: "auth_url"; url: string; instructions?: string } | { type: "info"; message: string };

/**
 * Whichever path answers first wins: the loopback callback (browser on this machine) or a pasted
 * redirect URL (browser elsewhere). The loser is abandoned — the server is closed by the caller and
 * the paste question is cancelled through its own signal — and either way the flow's signal ends it.
 */
async function acquireCode(
  expectedState: string,
  callback: { waitForCode: Promise<CallbackResult>; close: () => void } | undefined,
  surface: AskSurface,
  signal: AbortSignal
): Promise<CallbackResult> {
  const paste = new AbortController();
  const candidates: Promise<CallbackResult>[] = [];
  if (callback) candidates.push(callback.waitForCode);
  candidates.push(
    (async () => {
      for (;;) {
        const message = callback
          ? "Paste the URL from your browser's address bar after signing in. If this machine can reach the sign-in callback, you can ignore this."
          : `Paste the URL from your browser's address bar after signing in. Ember could not listen on port ${CALLBACK_PORT}, so this is the only way back.`;
        const placeholder = REDIRECT_URI + "?state=…&code=…";
        const pasted = surface.ask
          ? await surface.ask({ type: "manual_code", message, placeholder })
          : await surface.prompt({ type: "manual_code", message, placeholder, signal: paste.signal });
        try {
          return parseCallbackInput(pasted, expectedState);
        } catch (error) {
          // Keep asking: a truncated paste is the ordinary failure, and cancelling the whole sign-in
          // over it would make the human start again. A cancellation is the caller's, so it escapes.
          if (paste.signal.aborted) throw error;
          surface.notify({ type: "info", message: error instanceof Error ? error.message : String(error) });
        }
      }
    })()
  );
  for (const candidate of candidates) candidate.catch(() => {});

  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Sign-in cancelled."));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("Sign-in cancelled.")), { once: true });
  });

  try {
    return await Promise.race([...candidates, aborted]);
  } finally {
    paste.abort();
    callback?.close();
  }
}

// --- login / refresh ---------------------------------------------------------------------------

async function login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  // A login nobody completes must not hold the callback port forever, and a cancelled one must stop
  // the token exchange too, so both limits hang off the same signal.
  const signal = AbortSignal.any([interaction.signal, AbortSignal.timeout(LOGIN_TIMEOUT_MS)]);
  return runLogin(
    {
      // `ask` is the surface this wire can carry: the question becomes an event, and the answer
      // arrives later from whoever is looking at the screen. Without it the flow still gets a
      // `prompt` — and that one refuses rather than parks, which is the honest answer when nobody
      // can be asked.
      ...(interaction.ask === undefined ? {} : { ask: (prompt: ManualCodePrompt) => interaction.ask!(prompt) }),
      prompt: (prompt) => interaction.prompt(prompt),
      notify: (event) => interaction.notify(event),
    },
    signal
  );
}

/**
 * The flow itself, over whichever surface it was given.
 *
 * Split from `login` because the two entry points differ only in how a reply gets back to the
 * human: Hearth passes its own `ask`, and a host driving pi-ai's interface passes `prompt`.
 */
async function runLogin(surface: AskSurface, signal: AbortSignal): Promise<OAuthCredential> {
  const { verifier, challenge } = generatePkce();
  // Independent of the PKCE verifier, so a leaked callback URL cannot also disclose the verifier
  // that mints tokens.
  const state = base64Url(randomBytes(32));
  const callback = await startCallbackServer(state);
  try {
    surface.notify({
      type: "auth_url",
      url: authorizationUrl(state, challenge),
      instructions:
        "Sign in with the Google account that has Antigravity access. Ember catches the redirect when this machine's browser can reach it; otherwise paste the URL your browser lands on.",
    });
    const { code } = await acquireCode(state, callback, surface, signal);
    const tokenResponse = await postToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId(),
        client_secret: clientSecret(),
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
      signal
    );
    if (!tokenResponse.ok) {
      throw new Error(`Google rejected the token exchange: `);
    }
    const token = readTokenResponse((await tokenResponse.json()) as TokenResponse);
    if (!token.refresh) {
      throw new Error(
        "Google sent no refresh token. Sign in again and allow offline access when it asks, or the sign-in will expire within the hour."
      );
    }

    // Neither is required for the credential to work: the email only seeds the fallback project id,
    // and discovery has its own fallback. Both are best-effort, so neither fails a login.
    const [email, discovered] = await Promise.all([
      fetchEmail(token.access, signal),
      loadCodeAssist(token.access, signal),
    ]);
    return {
      type: "oauth",
      access: token.access,
      refresh: token.refresh,
      expires: token.expires,
      projectId: discovered ?? defaultProjectId(email ?? "antigravity-default"),
      ...(email ? { email } : {}),
    };
  } finally {
    callback?.close();
  }
}

async function refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
  const response = await postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId(),
      client_secret: clientSecret(),
      refresh_token: credential.refresh,
    }),
    signal
  );
  if (!response.ok) {
    throw new Error(`Antigravity token refresh failed: ${providerErrorText(await response.text())}`);
  }
  const token = readTokenResponse((await response.json()) as TokenResponse);
  // The project id does not change between tokens, and every refresh mints a new access token that
  // discovery would not recognise anyway — so rediscovering here is a round-trip that can only fail.
  const projectId = credentialProjectId(credential) ?? defaultProjectId(credentialEmail(credential) ?? "antigravity-default");
  return {
    ...credential,
    access: token.access,
    refresh: token.refresh ?? credential.refresh,
    expires: token.expires,
    projectId,
  };
}

/**
 * The api key the transport receives is this JSON, minted at `toAuth` time. It is a string because
 * pi-ai's `ModelAuth` has no field for a project id, and the transport needs both values.
 */
export function parseAntigravityApiKey(raw: string): { token: string; projectId: string } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && asString(parsed["token"]) && asString(parsed["projectId"])) {
      return { token: parsed["token"] as string, projectId: parsed["projectId"] as string };
    }
  } catch {
    // fall through: the message below is the only thing the human should see, never the input
  }
  throw new Error("Missing Antigravity credentials. Sign in again from Ember's Providers screen.");
}

export const antigravityOAuth: OAuthAuth = {
  name: "Google (Antigravity)",
  isSubscription: true,
  loginLabel: "Sign in with Google (Antigravity)",
  login,
  /**
   * The same flow in pi-ai's legacy extension shape, so a host that drives pi-ai's own surfaces (pi
   * the coding agent) finishes this sign-in exactly as Ember does. It goes through the same
   * `runLogin`: one flow, two ways to answer it. `onPrompt` is the surface that refuses when nobody
   * can be asked, which is what keeps this from parking forever on a question no one sees.
   */
  extensionLogin: async (callbacks) => {
    const signal = AbortSignal.any([
      callbacks.signal ?? new AbortController().signal,
      AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    ]);
    return runLogin(
      {
        prompt: (prompt) =>
          callbacks.onPrompt({
            message: prompt.message,
            ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
          }),
        notify: (event) => {
          if (event.type === "info") {
            callbacks.onProgress?.(event.message);
            return;
          }
          callbacks.onAuth({ url: event.url, ...(event.instructions === undefined ? {} : { instructions: event.instructions }) });
        },
      },
      signal
    );
  },
  refresh,
  async toAuth(credential) {
    const projectId = credentialProjectId(credential);
    if (!projectId) {
      throw new Error("Missing Antigravity credentials. Sign in again from Ember's Providers screen.");
    }
    return { apiKey: JSON.stringify({ token: credential.access, projectId }) };
  },
};
