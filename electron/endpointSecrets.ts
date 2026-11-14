/** Access service credentials use the OS credential store, never plaintext settings. */
import type { PiEndpoint } from './transport';
export type SecretStore = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};
const available = (store: SecretStore): boolean => store.isEncryptionAvailable() && store.getSelectedStorageBackend?.() !== 'basic_text';
const sameOrigin = (left: string, right: string): boolean => {
  try { return new URL(left).origin === new URL(right).origin; } catch { return false; }
};
export const unlockEndpointSecrets = (values: unknown, store: SecretStore): unknown => {
  if (!Array.isArray(values)) return values;
  return values.map((value) => {
    if (!value || typeof value !== 'object') return value;
    const { accessEncrypted, ...rest } = value as Record<string, unknown>;
    if (typeof accessEncrypted !== 'string') return rest;
    try {
      if (!available(store)) throw new Error('locked');
      const access: unknown = JSON.parse(store.decryptString(Buffer.from(accessEncrypted, 'base64')));
      return { ...rest, access, hasAccessSecret: true };
    } catch {
      // Preserve the encrypted record on the next save; never silently downgrade authentication.
      return { ...rest, access: { clientId: '', clientSecret: '' }, hasAccessSecret: true };
    }
  });
};
export const lockEndpointSecrets = (endpoints: readonly PiEndpoint[], previous: unknown, store: SecretStore): unknown[] => {
  const prior = Array.isArray(previous) ? previous : [];
  return endpoints.map(({ access, hasAccessSecret, ...endpoint }) => {
    if (access?.clientSecret) {
      if (!available(store)) throw new Error('Ember cannot protect Cloudflare Access credentials on this computer. Unlock the system keyring, then save this instance again.');
      return { ...endpoint, accessEncrypted: store.encryptString(JSON.stringify(access)).toString('base64') };
    }
    if (hasAccessSecret) {
      const stored = prior.find((value) => value && typeof value === 'object' && value.id === endpoint.id);
      if (stored?.accessEncrypted && sameOrigin(stored.url, endpoint.url)) return { ...endpoint, accessEncrypted: stored.accessEncrypted };
      throw new Error('Ember no longer has this instance’s Cloudflare Access secret. Enter it again in Advanced, then save.');
    }
    return endpoint;
  });
};
export const maskEndpointSecrets = <T extends { piEndpoints: PiEndpoint[] }>(settings: T): T => ({
  ...settings,
  piEndpoints: settings.piEndpoints.map((endpoint) => ({
    ...endpoint,
    ...(endpoint.access ? { access: { clientId: endpoint.access.clientId, clientSecret: '' }, hasAccessSecret: true } : {}),
  })),
});
export const restoreEndpointSecrets = (values: unknown, current: readonly PiEndpoint[]): unknown => {
  if (!Array.isArray(values)) return values;
  return values.map((value) => {
    if (!value || typeof value !== 'object') return value;
    const endpoint = value as PiEndpoint;
    const saved = current.find((entry) => entry.id === endpoint.id);
    if (endpoint.hasAccessSecret && !endpoint.access?.clientSecret && saved?.access && !sameOrigin(endpoint.url, saved.url)) {
      throw new Error('Ember needs the Cloudflare Access secret again for this changed server address. Enter it in Advanced, then test or save again.');
    }
    return endpoint.hasAccessSecret && !endpoint.access?.clientSecret && saved?.access
      ? { ...endpoint, access: { clientId: endpoint.access?.clientId ?? saved.access.clientId, clientSecret: saved.access.clientSecret } }
      : endpoint;
  });
};
