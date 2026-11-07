import { expect, test } from 'bun:test';
import { mergeConnections, portableConnection } from '../src/lib/instanceAlignment';
const peer = (url: string, token = 'private-token') => ({ id: 'pi:one', label: 'One', url, token });
test('alignment shares only portable private or HTTPS addresses', () => {
  for (const url of ['https://localhost:3002', 'https://[::1]:3002', 'http://127.0.0.1:3002', 'http://localhost:3002', 'http://[::1]:3002', 'http://0.0.0.0:3002', 'http://example.com:3002', 'https://user:pass@example.com']) expect(portableConnection(peer(url))).toBe(false);
  for (const url of ['http://100.66.91.124:3002', 'http://10.0.0.2:3002', 'https://kiln.example.com']) expect(portableConnection(peer(url))).toBe(true);
});
test('alignment adds discovered connections without replacing existing credentials or ids', () => {
  const existing = peer('http://100.64.0.1:3002');
  const merged = mergeConnections([existing], [peer(existing.url + '/', 'different'), peer('http://100.64.0.2:3002'), peer('http://localhost:3002')]);
  expect(merged).toHaveLength(2);
  expect(merged[0]).toEqual(existing);
  expect(merged[1].id).not.toBe(existing.id);
});
