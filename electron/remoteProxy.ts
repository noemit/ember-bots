/** Explicit browser UI proxy configuration, never inferred from request headers or Kiln sharing. */
export const parseRemoteProxyOrigin = (value: unknown): string | undefined => {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('Enter the HTTPS address of your Ember browser proxy, or clear it to use direct Tailscale HTTP.');
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch {
    throw new Error('Enter an HTTPS origin such as https://ember.example.ts.net, without a path, credentials or query.');
  }
};

export const isLoopbackPeer = (address: string | undefined): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

/** The proxy must preserve the external Host and overwrite X-Forwarded-Proto, not append it. */
export const isTrustedHttpsProxy = (
  origin: string,
  peer: string | undefined,
  host: string | undefined,
  proto: string | string[] | undefined,
): boolean => isLoopbackPeer(peer) && host === new URL(origin).host && proto === 'https';

/** Invalid persisted configuration fails closed: never silently fall back to HTTP exposure. */
export const remoteBindAddress = (proxyOrigin: unknown, tailscale: () => string | null): string | null =>
  parseRemoteProxyOrigin(proxyOrigin) ? '127.0.0.1' : tailscale();
