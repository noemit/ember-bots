import type { PiEndpoint } from './transport';
import { testPiEndpoint } from './piConnection';

/** Sharing requires both authenticated readiness and explicit anonymous denial. */
export async function checkSharedKilnAuth(endpoint: PiEndpoint, request: typeof fetch = fetch): Promise<{ ok: boolean }> {
  if ((await testPiEndpoint(endpoint, { request })).outcome !== 'ready') return { ok: false };
  try {
    const response = await request(`${endpoint.url.replace(/\/+$/, '')}/conversations?limit=1`, {
      redirect: 'manual', signal: AbortSignal.timeout(8_000),
    });
    void response.body?.cancel().catch(() => {});
    return { ok: response.status === 401 || response.status === 403 };
  } catch { return { ok: false }; }
}
