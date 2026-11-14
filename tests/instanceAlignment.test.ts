import { expect, test } from 'bun:test';
import { mergeConnections, portableConnection } from '../src/lib/instanceAlignment';
const peer = (url: string, token = 'private-token') => ({ id: 'pi:one', label: 'One', url, token });
test('alignment shares only portable private or HTTPS addresses', () => {
  for (const url of ['https://localhost:3002', 'https://[::1]:3002', 'http://127.0.0.1:3002', 'http://localhost:3002', 'http://[::1]:3002', 'http://0.0.0.0:3002', 'http://example.com:3002', 'https://user:pass@example.com']) expect(portableConnection(peer(url))).toBe(false);
  for (const url of ['http://100.66.91.124:3002', 'http://10.0.0.2:3002', 'https://kiln.example.com']) expect(portableConnection(peer(url))).toBe(true);
});
test('private network sharing rejects deceptive hostnames and malformed IP addresses', () => {
  for (const host of ['10.attacker.com', '192.168.attacker.com', '172.16.attacker.com', '100.64.attacker.com', '10.0.0.256', '100.127.1.999', 'attacker-ts.net', 'ts.net', 'kiln.ts.net.attacker.com']) {
    expect(portableConnection(peer(`http://${host}:3002`))).toBe(false);
  }
  for (const host of ['10.0.0.1', '192.168.255.255', '172.16.0.1', '172.31.255.255', '100.64.0.1', '100.127.255.255', 'kiln.example.ts.net']) {
    expect(portableConnection(peer(`http://${host}:3002`))).toBe(true);
  }
  for (const host of ['172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1']) {
    expect(portableConnection(peer(`http://${host}:3002`))).toBe(false);
  }
});
test('alignment adds discovered connections without replacing existing credentials or ids', () => {
  const existing = peer('http://100.64.0.1:3002');
  const merged = mergeConnections([existing], [peer(existing.url + '/', 'different'), peer('http://100.64.0.2:3002'), peer('http://localhost:3002')]);
  expect(merged).toHaveLength(2);
  expect(merged[0]).toEqual(existing);
  expect(merged[1].id).not.toBe(existing.id);
});
