import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test.skipIf(process.platform !== 'linux')('compiled Bun verifies HTTPS and WSS against system roots unless opted out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kiln-system-ca-'));
  try {
    const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe', timeout: 5000 });
    const key = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
    // Unhashed PEMs in SSL_CERT_DIR exercise the system store. SSL_CERT_FILE or a rehashed
    // directory would also be consulted by Bun's underlying TLS library even when opted out.
    for (const name of ['trusted', 'unrelated']) {
      mkdirSync(join(dir, name));
      openssl('req', '-x509', ...key, '-keyout', `${name}.key`, '-out', `${name}/root.pem`,
        '-days', '1', '-subj', `/CN=${name}`, '-addext', 'basicConstraints=critical,CA:TRUE');
    }
    openssl('req', '-new', ...key, '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=loopback');
    writeFileSync(join(dir, 'extensions'), 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
    openssl('x509', '-req', '-in', 'server.csr', '-CA', 'trusted/root.pem', '-CAkey', 'trusted.key',
      '-set_serial', '1', '-days', '1', '-extfile', 'extensions', '-out', 'server.pem');

    const binary = join(dir, 'probe');
    writeFileSync(join(dir, 'probe.ts'), `
      import ${JSON.stringify(resolve('packages/kiln/src/systemCa.ts'))};
      const url = process.argv.at(-1);
      const https = await fetch(url).then(r => r.text()).catch(e => e.code);
      const wss = await new Promise(resolve => {
        const ws = new WebSocket(url.replace('https:', 'wss:'));
        ws.onmessage = e => { resolve(e.data); ws.close(); };
        ws.onerror = e => resolve(e.message);
      });
      console.log(JSON.stringify({ https, wss }));
    `);
    execFileSync(process.execPath, ['build', '--compile', '--define=KILN_STANDALONE=true', 'probe.ts', '--outfile', binary], { cwd: dir, timeout: 30000 });
    const server = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      tls: { cert: readFileSync(join(dir, 'server.pem')), key: readFileSync(join(dir, 'server.key')) },
      fetch(req, server) { if (!server.upgrade(req)) return new Response('HTTPS reply'); },
      websocket: { open(ws) { ws.send('WSS reply'); }, message() {} },
    });
    try {
      const probe = async (store: string, extraEnv: Record<string, string> = {}) => {
        const child = Bun.spawn([binary, server.url.href], {
          cwd: dir, env: { HOME: dir, SSL_CERT_DIR: join(dir, store), ...extraEnv },
          stdout: 'pipe', stderr: 'pipe', timeout: 5000,
        });
        const [code, stdout, stderr] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
        expect(code, stderr).toBe(0);
        return JSON.parse(stdout);
      };
      const rejected = { https: expect.stringMatching(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/), wss: expect.stringMatching(/TLS handshake failed/i) };
      expect(await probe('trusted', { NODE_USE_SYSTEM_CA: '0' })).toEqual(rejected);
      expect(await probe('unrelated')).toEqual(rejected);
      const accepted = { https: 'HTTPS reply', wss: 'WSS reply' };
      expect(await probe('trusted', { NODE_USE_SYSTEM_CA: '1' })).toEqual(accepted);
      // This process inherits no CA toggle from the test runner: the production entry import
      // must establish the default, not just respect a setting supplied before Bun starts.
      expect(await probe('trusted')).toEqual(accepted);
    } finally { await server.stop(true); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60000);

test('the source Tinder entry keeps its script and arguments when no trust policy is inherited', () => {
  const env = { ...process.env };
  delete env.NODE_USE_SYSTEM_CA;
  const output = execFileSync(process.execPath, [resolve('packages/kiln/src/tinder.ts'), 'help'], {
    env, encoding: 'utf8', timeout: 5000,
  });
  expect(output).toContain('Unified Launcher');
});
