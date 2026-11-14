import { normalizeEndpointUrl, upsertEndpoint } from './endpoints';
import type { PiEndpoint } from '../types';

export type AlignmentSummary = { apiKeys: string[]; signIns: number; peers: Array<{ id: string; label: string; url: string }> };

/** Never teach another machine that its own loopback is a different machine. */
export const portableConnection = (endpoint: PiEndpoint): boolean => {
  try {
    const u = new URL(endpoint.url);
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.startsWith('127.') || ['0.0.0.0', '[::]', '[::1]'].includes(host)) return false;
    const octets = host.split('.');
    const ipv4 = octets.length === 4 && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
    const [a, b] = octets.map(Number);
    const privateIp = ipv4 && (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127));
    const tailscaleHost = host.endsWith('.ts.net') && host.length > '.ts.net'.length;
    return Boolean(endpoint.token) && !u.username && !u.password && !u.search && !u.hash &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && (privateIp || tailscaleHost)));
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
