import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { discoverMacDaemonProof, macLsofArgs, parseMacProofLookup, readMacsysProof } from '../electron/tailscaleMacDiscovery';
import { configDigest, macLocalApiTransport, TailscaleLocalApi } from '../electron/tailscaleLocalApi';

const proof = { port: 61577, token: '0123456789abcdefabcd' };
const lookup = 'p123\ncIPNExtension\nn/Users/synthetic/Library/Group Containers/W5364U7YZB.io.tailscale.ipn.macos/sameuserproof-' + proof.port + '-' + proof.token + '\n';

test('App Store discovery matches only official same-user proof name fields', async () => {
  expect(macLsofArgs(501)).toEqual(['-n', '-a', '-u501', '-c', 'IPNExtension', '-F']);
  expect(parseMacProofLookup(lookup)).toEqual(proof);
  expect(parseMacProofLookup('n/Users/synthetic/general-credentials-' + proof.token)).toBeUndefined();
  expect(parseMacProofLookup(lookup.replace('n/Users', 'f/Users'))).toBeUndefined();
  expect(parseMacProofLookup(lookup + lookup)).toEqual(proof);
  expect(() => parseMacProofLookup(lookup.replace(proof.token, 'changed-format'))).toThrow();
  await expect(discoverMacDaemonProof({ lsof: async () => lookup, macsys: () => { throw new Error('must not inspect other credentials'); } })).resolves.toEqual(proof);
});
test('ambiguous daemon proofs fail closed with no proof contents in diagnostics', async () => {
  try {
    await discoverMacDaemonProof({ lsof: async () => lookup + lookup.replace('61577', '61578'), macsys: () => proof });
    throw new Error('Expected discovery refusal');
  } catch (error) { expect(String(error)).not.toContain(proof.token); expect(String(error)).toContain('unsupported'); }
  expect(() => parseMacProofLookup('x'.repeat(300 * 1024))).toThrow();
});
test('macsys discovery reads only a bounded literal-port sameuserproof file in a protected directory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-mac-proof-'));
  try {
    fs.symlinkSync(String(proof.port), path.join(directory, 'ipnport'));
    const file = path.join(directory, 'sameuserproof-' + proof.port);
    fs.writeFileSync(file, proof.token + '\n', { mode: 0o640 });
    const read = () => readMacsysProof(directory, process.getuid!());
    expect(read()).toEqual(proof);
    expect(await discoverMacDaemonProof({ lsof: async () => { throw new Error('synthetic lsof unavailable'); }, macsys: read })).toEqual(proof);
    fs.chmodSync(file, 0o666);
    expect(read).toThrow();
    fs.chmodSync(file, 0o640);
    fs.unlinkSync(file); fs.symlinkSync('/tmp/not-a-proof', file);
    expect(read).toThrow();
    fs.unlinkSync(path.join(directory, 'ipnport')); fs.symlinkSync('../elsewhere', path.join(directory, 'ipnport'));
    expect(read).toThrow();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('no proof discovered leaves the standard daemon socket as the only eligible fallback', async () => {
  expect(await discoverMacDaemonProof({ lsof: async () => 'p123\ncOtherProcess', macsys: () => undefined })).toBeUndefined();
});
test('Mac loopback proxy transport sends scoped Basic auth and If-Match only to literal loopback', async () => {
  let config: Record<string, unknown> = {};
  const received: { auth?: string; host?: string; url?: string; etag?: string }[] = [];
  const server = http.createServer((request, response) => {
    received.push({ auth: request.headers.authorization, host: request.headers.host, url: request.url, etag: request.headers['if-match'] as string | undefined });
    if (request.method === 'GET') {
      const body = JSON.stringify(config); response.setHeader('ETag', configDigest(body)); response.end(body); return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.headers['if-match'] !== configDigest(JSON.stringify(config))) { response.writeHead(412).end(); return; }
      config = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No synthetic port');
  try {
    const api = new TailscaleLocalApi(macLocalApiTransport({ ...proof, port: address.port }));
    const snapshot = await api.read();
    await api.compareAndSwap(snapshot, { TCP: { '3002': { TCPForward: '127.0.0.1:3002' } } });
    expect(received).toHaveLength(2);
    for (const request of received) {
      expect(request.auth).toBe('Basic ' + Buffer.from(':' + proof.token).toString('base64'));
      expect(request.host).toBe('local-tailscaled.sock'); expect(request.url).toBe('/localapi/v0/serve-config');
      expect(request.url).not.toContain(proof.token);
    }
    expect(received[1].etag).toBe(snapshot.etag);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
