import { describe, expect, test } from 'bun:test'
import { createKilnSharing, isTailnetAddress, sharingTarget, type KilnSharingDependencies } from '../electron/kilnSharing'

import { configDigest, LocalApiError } from '../electron/tailscaleLocalApi'

const options = { hostLabel: 'Tower', localUrl: 'http://127.0.0.1:3002', token: 'secret-not-in-copy', statePath: '/unused' }
function fixture() {
  let saved: string | undefined
  let config: Record<string, unknown> & { TCP?: Record<string, unknown> } = {}
  let ip = '100.64.0.2'
  let online = true
  let backend = 'Running'
  let anonymous = 401
  let authorized = 200
  let networkFailure = false
  let commandFailure = false
  const calls: string[][] = []
  const requests: [string, string | undefined][] = []
  const mutations: unknown[] = []
  const deps: KilnSharingDependencies = {
    read: async () => saved,
    save: async (value) => { saved = value },
    request: async (url, token) => {
      requests.push([url, token])
      if (networkFailure && url.includes('100.')) throw new Error('secret-not-in-copy')
      return token ? authorized : anonymous
    },
    run: async (args) => {
      calls.push(args)
      if (commandFailure) throw Object.assign(new Error('secret-not-in-copy'), { code: 'EACCES' })
      return '--bg --tcp status'
    },
    api: () => ({
      status: async () => {
        if (!online || backend !== 'Running' || !isTailnetAddress(ip)) throw new LocalApiError('unavailable')
        return { nodeId: 'synthetic-node', ip }
      },
      read: async () => ({ config: structuredClone(config), etag: configDigest(JSON.stringify(config)) }),
      compareAndSwap: async (snapshot, next) => {
        if (snapshot.etag !== configDigest(JSON.stringify(config))) throw new LocalApiError('conflict')
        mutations.push(next); config = structuredClone(next)
      },
    }),
  }
  return { deps, calls, requests, mutations, controller: () => createKilnSharing(options, deps),
    saved: () => saved, config: () => config,
    setSaved: (value: string) => { saved = value }, setConfig: (value: Record<string, unknown> & { TCP?: Record<string, unknown> }) => { config = value },
    setIp: (value: string) => { ip = value }, offline: () => { online = false }, logout: () => { backend = 'NeedsLogin' },
    anonymous: (value: number) => { anonymous = value }, authorized: (value: number) => { authorized = value },
    failNetwork: () => { networkFailure = true }, failCommand: () => { commandFailure = true } }
}

describe('loopback targets and tailnet addresses', () => {
  test('only numerical loopback HTTP targets, including IPv6', () => {
    expect(sharingTarget('http://127.0.0.1:3002')).toBe('127.0.0.1:3002')
    expect(sharingTarget('http://[::1]:3002')).toBe('[::1]:3002')
    for (const url of ['http://localhost:3002', 'http://0.0.0.0:3002', 'http://[::]:3002', 'http://[::ffff:127.0.0.1]:3002', 'http://100.64.0.1:3002', 'https://127.0.0.1:3002', 'http://a:b@127.0.0.1:3002', 'http://127.0.0.1:3002/path', 'http://127.0.0.1:3002/?token=bad']) {
      expect(() => sharingTarget(url)).toThrow()
    }
  })
  test('strict CGNAT and Tailscale IPv6 ranges, not arbitrary private or mapped addresses', () => {
    for (const ip of ['100.64.0.1', '100.127.255.255', 'fd7a:115c:a1e0::1234']) expect(isTailnetAddress(ip)).toBe(true)
    for (const ip of ['100.128.0.1', '100.63.0.1', '100.64.0.999', '100.64.1.1x', '10.0.0.1', 'fd7a:115c:a1e1::1', 'fe80::1%eth0', '::ffff:100.64.0.1']) expect(isTailnetAddress(ip)).toBe(false)
  })
})

describe('explicit persistent tailnet-only sharing', () => {
  test('inspection without consent can only read, never create a forward', async () => {
    const f = fixture()
    expect((await f.controller().inspect()).state).toBe('off')
    expect(f.mutations).toEqual([])
    expect(f.saved()).toBeUndefined()
  })
  test('enable verifies anonymous denial and bearer success locally and through forwarding; restart and disable preserve unrelated config', async () => {
    const f = fixture()
    const unrelated = { TCP: { '8443': { HTTPS: true } }, Web: { 'tower.ts.net:8443': { Handlers: { '/': { Proxy: 'http://localhost:8888' } } } } }
    f.setConfig(structuredClone(unrelated))
    const result = await f.controller().enable()
    expect(result.state).toBe('ready')
    expect(result.url).toBe('http://100.64.0.2:3002')
    expect(JSON.parse(f.saved()!).etag).toBe(configDigest(JSON.stringify(f.config())))
    expect(f.saved()).not.toContain(options.token)
    expect(f.mutations).toHaveLength(1)
    expect(f.calls.every(args => args.join(' ') === 'serve --help')).toBe(true)
    expect(f.requests).toContainEqual(['http://100.64.0.2:3002/conversations?limit=1', undefined])
    expect(f.requests).toContainEqual(['http://100.64.0.2:3002/conversations?limit=1', options.token])
    const restarted = f.controller()
    expect((await restarted.inspect()).state).toBe('ready')
    expect((await restarted.disable()).state).toBe('off')
    expect(f.saved()).toBeUndefined()
    expect(f.config()).toEqual(unrelated)
    expect(f.calls.flat().join(' ')).not.toMatch(/funnel|reset|set-config/)
  })
  test('even an identical pre-existing rule cannot be adopted', async () => {
    const f = fixture()
    f.setConfig({ TCP: { '3002': { TCPForward: '127.0.0.1:3002' } } })
    expect((await f.controller().enable()).state).toBe('blocked')
    expect(f.saved()).toBeUndefined()
    expect(f.mutations).toEqual([])
  })
  test('public forwarding on chosen port blocks enable without mutation', async () => {
    const f = fixture()
    f.setConfig({ AllowFunnel: { 'tower.ts.net:3002': true } })
    expect((await f.controller().enable()).state).toBe('blocked')
    expect(f.saved()).toBeUndefined()
  })
  test('never unshares a changed rule or public rule after restart', async () => {
    const f = fixture()
    await f.controller().enable()
    f.setConfig({ TCP: { '3002': { TCPForward: '127.0.0.1:9999' } } })
    expect((await f.controller().disable()).state).toBe('blocked')
    expect(f.calls.some((args) => args.includes('off'))).toBe(false)
    expect(f.saved()).toBeDefined()
  })
  test('desired enabled state alone cannot claim ready when host logs out or becomes offline', async () => {
    const f = fixture()
    await f.controller().enable()
    f.logout()
    expect(await f.controller().inspect()).toMatchObject({ state: 'blocked', enabled: true })
    f.offline()
    expect((await f.controller().inspect()).url).toBeUndefined()
  })
  test('legacy pending intent is not authority to delete a matching forward after restart', async () => {
    const f = fixture()
    f.setSaved(JSON.stringify({ version: 1, port: 3002, target: '127.0.0.1:3002', phase: 'pending' }))
    f.setConfig({ TCP: { '3002': { TCPForward: '127.0.0.1:3002' } } })
    expect((await f.controller().inspect()).canChange).toBe(false)
    expect((await f.controller().disable()).state).toBe('blocked')
    expect(f.mutations).toEqual([])
  })
  test('IPv6 membership is formatted as a bracketed endpoint', async () => {
    const f = fixture()
    f.setIp('fd7a:115c:a1e0::12')
    expect((await f.controller().enable()).url).toBe('http://[fd7a:115c:a1e0::12]:3002')
  })
  test.each([200, 404, 500])('anonymous response %i is not proof of enforced auth', async (status) => {
    const f = fixture(); f.anonymous(status)
    expect((await f.controller().enable()).state).toBe('blocked')
    expect(f.saved()).toBeUndefined()
    expect(f.calls.some((args) => args.includes('--bg'))).toBe(false)
  })
  test('wrong bearer token prevents sharing', async () => {
    const f = fixture(); f.authorized(401)
    expect((await f.controller().enable()).state).toBe('blocked')
    expect(f.saved()).toBeUndefined()
  })
  test('failed reachability rolls back only the newly owned rule', async () => {
    const f = fixture(); f.failNetwork()
    const result = await f.controller().enable()
    expect(result.state).toBe('blocked')
    expect(result.url).toBeUndefined()
    expect(f.mutations).toHaveLength(2)
    expect(f.saved()).toBeUndefined()
  })
  test('privilege diagnostics identify host and next step without leaking subprocess output', async () => {
    const f = fixture(); f.failCommand()
    const result = await f.controller().enable()
    expect(result.message).toContain('Tower')
    expect(result.message).toMatch(/Check sharing|Update|administrator/)
    expect(result.message).not.toContain(options.token)
    expect(result.message).not.toMatch(/EACCES|undefined|HTTP \d/)
  })
  test('corrupt ownership fails closed, with no mutations', async () => {
    const f = fixture(); f.setSaved('{bad')
    expect((await f.controller().disable()).state).toBe('blocked')
    expect(f.mutations).toEqual([])
  })
})

// The existing factory supports a chosen port, including authenticated IPv6 targets.
test('chosen sharing port is preserved in CAS configuration, URL and durable receipt', async () => {
  const f = fixture()
  const custom = createKilnSharing({ ...options, publicPort: 7443, localUrl: 'http://[::1]:3003' }, f.deps)
  const ready = await custom.enable()
  expect(ready.state).toBe('ready')
  expect(ready.url).toBe('http://100.64.0.2:7443')
  expect(f.config().TCP?.['7443']).toEqual({ TCPForward: '[::1]:3003' })
  expect(JSON.parse(f.saved()!).port).toBe(7443)
  expect((await custom.disable()).state).toBe('off')
  expect(f.config().TCP?.['7443']).toBeUndefined()
})

test('explicit external-process guard refuses the existing factory before contacting a daemon', async () => {
  const f = fixture()
  const blocked = createKilnSharing({ ...options, ownedProcess: false }, { ...f.deps, api: () => { throw new Error('must not contact daemon') } })
  expect((await blocked.enable()).state).toBe('blocked')
  expect(f.calls).toEqual([])
})

test('changing the chosen port or target cannot orphan the old receipt or remove a foreign rule', async () => {
  const f = fixture()
  expect((await f.controller().enable()).state).toBe('ready')
  const moved = createKilnSharing({ ...options, publicPort: 7443, localUrl: 'http://[::1]:3003' }, f.deps)
  expect((await moved.inspect()).canChange).toBe(true)
  expect((await moved.enable()).state).toBe('blocked')
  expect(f.mutations).toHaveLength(1)
  expect((await moved.disable()).state).toBe('off')
  expect(f.config().TCP?.['3002']).toBeUndefined()
  expect((await moved.enable()).url).toBe('http://100.64.0.2:7443')
  expect(f.config().TCP?.['7443']).toEqual({ TCPForward: '[::1]:3003' })
})
