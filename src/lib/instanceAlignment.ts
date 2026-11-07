import { normalizeEndpointUrl, upsertEndpoint } from './endpoints';
import type { PiEndpoint } from '../types';

export type AlignmentSummary = { apiKeys: string[]; signIns: number; peers: Array<{ id: string; label: string; url: string }> };

/** Never teach another machine that its own loopback is a different machine. */
export const portableConnection = (endpoint: PiEndpoint): boolean => {
  try {
    const u = new URL(endpoint.url);
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || ['0.0.0.0', '[::]', '[::1]'].includes(host)) return false;
    return Boolean(endpoint.token) && !u.username && !u.password && !u.search && !u.hash &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host)) || (u.protocol === 'http:' && host.endsWith('.ts.net')));
  } catch { return false; }
};

export const mergeConnections = (existing: readonly PiEndpoint[], incoming: readonly PiEndpoint[]): PiEndpoint[] => {
  let merged = [...existing];
  for (const peer of incoming) {
    if (!portableConnection(peer) || !peer.label?.trim() || peer.label.length > 120 || peer.url.length > 500 || peer.token.length > 4096) continue;
    if (merged.some(p => normalizeEndpointUrl(p.url) === normalizeEndpointUrl(peer.url))) continue;
    merged = upsertEndpoint(merged, { label: peer.label, url: peer.url, token: peer.token });
  }
  return merged;
};
