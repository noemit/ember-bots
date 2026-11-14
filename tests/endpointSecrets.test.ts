import { describe, expect, test } from 'bun:test';
import { lockEndpointSecrets, unlockEndpointSecrets, maskEndpointSecrets, restoreEndpointSecrets, type SecretStore } from '../electron/endpointSecrets';
import { parsePiEndpoints, redactRemoteSettings } from '../electron/transport';
const store: SecretStore = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value) => Buffer.from(value.split('').reverse().join('')),
  decryptString: (value) => value.toString().split('').reverse().join(''),
};
const endpoint = { id: 'pi:tower', label: 'Tower', url: 'https://tower.example/kiln', token: 'bearer-private', access: { clientId: 'access-id', clientSecret: 'access-private' } };
describe('Access credential boundaries', () => {
  test('protects Access at rest and restores only in trusted transport', () => {
    const locked = lockEndpointSecrets([endpoint], [], store);
    expect(JSON.stringify(locked)).not.toContain('access-private');
    expect(parsePiEndpoints(unlockEndpointSecrets(locked, store))[0]?.access).toEqual(endpoint.access);
  });
  test('masks desktop previews and restores masked saves by endpoint identity', () => {
    const masked = maskEndpointSecrets({ piEndpoints: [endpoint] });
    expect(masked.piEndpoints[0]?.access?.clientSecret).toBe('');
    expect(masked.piEndpoints[0]?.hasAccessSecret).toBe(true);
    expect((restoreEndpointSecrets(masked.piEndpoints, [endpoint]) as typeof endpoint[])[0]?.access).toEqual(endpoint.access);
    expect((restoreEndpointSecrets([{ ...masked.piEndpoints[0], id: 'pi:other' }], [endpoint]) as typeof endpoint[])[0]?.access?.clientSecret).toBe('');
  });
  test('masked secrets cannot move to a changed HTTPS origin during test or save', () => {
    const masked = maskEndpointSecrets({ piEndpoints: [endpoint] }).piEndpoints[0]!;
    expect(() => restoreEndpointSecrets([{ ...masked, url: 'https://other.example' }], [endpoint])).toThrow(/Ember.*secret.*changed server address/);
    const encrypted = lockEndpointSecrets([endpoint], [], store);
    expect(() => lockEndpointSecrets([{ ...masked, url: 'https://other.example' }], encrypted, store)).toThrow(/Ember.*secret/);
  });
  test('remote previews contain neither bearer nor Access credentials', () => {
    const remote = JSON.stringify(redactRemoteSettings({ piEndpoints: [endpoint] }));
    expect(remote).not.toContain('bearer-private');
    expect(remote).not.toContain('access-private');
    expect(remote).not.toContain('access-id');
  });
  test('refuses plaintext Linux backend and names recovery', () => {
    expect(() => lockEndpointSecrets([endpoint], [], { ...store, getSelectedStorageBackend: () => 'basic_text' })).toThrow(/Ember.*keyring.*save/);
  });
  test('locked store preserves ciphertext on unrelated settings writes', () => {
    const locked = lockEndpointSecrets([endpoint], [], store);
    const unavailable = { ...store, isEncryptionAvailable: () => false };
    const parsed = parsePiEndpoints(unlockEndpointSecrets(locked, unavailable));
    expect(parsed[0]?.hasAccessSecret).toBe(true);
    expect(lockEndpointSecrets(parsed, locked, unavailable)).toEqual(locked);
  });
  test('explicit removal clears only Access while preserving bearer', () => {
    const without = { id: endpoint.id, label: endpoint.label, url: endpoint.url, token: endpoint.token };
    const locked = lockEndpointSecrets([without], lockEndpointSecrets([endpoint], [], store), store);
    expect(locked).toEqual([without]);
  });
});
