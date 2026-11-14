/**
 * Pure helpers for Hearth endpoint configuration (`piEndpoints` in settings), kept out of
 * the component so they can be unit-tested: id derivation, validation, upsert/remove, and
 * token masking. The endpoint values themselves are user config, never code.
 */
import type { PiEndpoint } from '../types';

const MAX_LABEL = 60;
const MAX_URL = 500;
const MAX_TOKEN = 4_096;

/**
 * Every Hearth endpoint id carries this prefix. Ember's OpenChamber instance ids are `local`,
 * `ssh-…`, relay URLs and UUIDs — none contain a colon — so a prefixed id can never collide
 * with one, which is exactly the bug that made a Hearth endpoint named "Local" fight the
 * built-in OpenChamber `local` instance over one namespace.
 */
export const PI_ENDPOINT_PREFIX = 'pi:';

export const isPiEndpointId = (id: string): boolean => id.startsWith(PI_ENDPOINT_PREFIX);

export type EndpointDraft = { id?: string; label: string; url: string; token: string; hasAccessSecret?: boolean; access?: { clientId: string; clientSecret: string } };

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

/** A stable, unique, prefixed id from the label (or the URL host when the label is empty). */
export const endpointIdFrom = (label: string, url: string, taken: readonly string[] = []): string => {
  let base = slug(label);
  if (!base) {
    try {
      base = slug(new URL(url).hostname.replace(/\./g, '-')) || 'hearth';
    } catch {
      base = 'hearth';
    }
  }
  const prefixed = `${PI_ENDPOINT_PREFIX}${base}`;
  if (!taken.includes(prefixed)) return prefixed;
  for (let index = 2; index < 1_000; index += 1) {
    const candidate = `${prefixed}-${index}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${prefixed}-${Date.now()}`;
};

/** Accepts a bare host:port (agents' habit) by prepending http://; rejects non-http(s). */
export const normalizeEndpointUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    // Keep the path (a reverse-proxied Hearth may live under one) but drop a trailing slash.
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
};

/** The first validation failure for a draft, or null when it is ready to save. */
export const endpointError = (draft: EndpointDraft, existing: readonly PiEndpoint[] = []): string | null => {
  if (!draft.label.trim()) return 'Give the endpoint a name.';
  if (draft.label.length > MAX_LABEL) return 'That name is too long.';
  const url = normalizeEndpointUrl(draft.url);
  if (!url) return 'Enter an http(s) address, e.g. http://100.64.0.1:3002.';
  if (draft.url.length > MAX_URL) return 'That address is too long.';
  if (draft.access && (!draft.access.clientId.trim() || (!draft.access.clientSecret.trim() && !draft.hasAccessSecret))) return 'Enter both Cloudflare Access fields, or remove the Access credentials.';
  if (draft.access && (draft.access.clientId.length > MAX_TOKEN || draft.access.clientSecret.length > MAX_TOKEN)) return 'Those Access credentials are too long. Check the values from Cloudflare.';
  if (draft.token.length > MAX_TOKEN) return 'That token is too long.';
  const duplicate = existing.find(
    (endpoint) => endpoint.id !== draft.id && normalizeEndpointUrl(endpoint.url) === url
  );
  if (duplicate) return `That address is already used by “${duplicate.label}”.`;
  return null;
};

/** Add or replace one endpoint (matched by id), returning a new list. */
export const upsertEndpoint = (
  endpoints: readonly PiEndpoint[],
  draft: EndpointDraft
): PiEndpoint[] => {
  const url = normalizeEndpointUrl(draft.url);
  if (!url) return [...endpoints];
  const id = draft.id ?? endpointIdFrom(draft.label, url, endpoints.map((endpoint) => endpoint.id));
  const next: PiEndpoint = { id, label: draft.label.trim(), url, token: draft.token.trim(), ...(draft.access ? { access: { clientId: draft.access.clientId.trim(), clientSecret: draft.access.clientSecret.trim() }, ...(draft.hasAccessSecret ? { hasAccessSecret: true } : {}) } : {}) };
  const index = endpoints.findIndex((endpoint) => endpoint.id === id);
  if (index === -1) return [...endpoints, next];
  return endpoints.map((endpoint, position) => (position === index ? next : endpoint));
};

export const removeEndpoint = (endpoints: readonly PiEndpoint[], id: string): PiEndpoint[] =>
  endpoints.filter((endpoint) => endpoint.id !== id);

/** Never render a full token: a fixed mask plus the last four characters. */
export const maskToken = (token: string): string =>
  token.length <= 4 ? '••••' : `••••••••${token.slice(-4)}`;

/** Use fixed, actionable copy, never raw diagnostics that might contain credentials. */
export function endpointTestCopy(label: string, outcome: string): string {
  const actor = label.trim() || 'This Kiln';
  switch (outcome) {
    case 'ready': return actor + ` answered as Kiln and accepted the connection. You can add this instance.`;
    case 'auth-rejected': return actor + ` rejected the credentials. Check the bearer token and, if used, Cloudflare Access credentials, then test again.`;
    case 'wrong-service': return actor + ` answered, but not as Kiln. Use its Kiln API URL, not Ember’s browser UI or a sign-in page, then test again.`;
    case 'tls-error': return actor + ` could not establish a trusted secure connection. Ask its owner to check the certificate and HTTPS address, then test again.`;
    case 'timeout': return actor + ` did not answer in time. Check that the host is awake and Kiln is running, then test again.`;
    default: return actor + ` could not be reached. Check the URL, host and network connection, then test again.`;
  }
}
