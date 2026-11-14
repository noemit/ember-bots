import { describe, expect, test } from 'bun:test'
import { createKilnSharing, isTailnetAddress, sharingTarget, type KilnSharingDependencies } from '../electron/kilnSharing'

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
      if (args[0] === 'status') return JSON.stringify({ BackendState: backend, Self: { Online: online, TailscaleIPs: [ip] } })
      if (args[1] === 'status') return JSON.stringify(config)
      if (args.includes('off')) { delete config.TCP?.['3002']; return '' }
      config = { ...config, TCP: { ...config.TCP, '3002': { TCPForward: '127.0.0.1:3002' } } }
      return ''
    },
  }
  return { deps, calls, requests, controller: () => createKilnSharing(options, deps),
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
  test('inspection with no intent never runs Tailscale or changes anything', async () => {
    const f = fixture()
    expect((await f.controller().inspect()).state).toBe('off')
    expect(f.calls).toEqual([])
    expect(f.saved()).toBeUndefined()
  })
  test('enable verifies anonymous denial and bearer success locally and through forwarding; restart and disable preserve unrelated config', async () => {
    const f = fixture()
    const unrelated = { TCP: { '8443': { HTTPS: true } }, Web: { 'tower.ts.net:8443': { Handlers: { '/': { Proxy: 'http://localhost:8888' } } } } }
    f.setConfig(structuredClone(unrelated))
    const result = await f.controller().enable()
    expect(result.state).toBe('ready')
    expect(result.url).toBe('http://100.64.0.2:3002')
    expect(JSON.parse(f.saved()!).phase).toBe('active')
    expect(f.saved()).not.toContain(options.token)
    expect(f.calls).toContainEqual(['serve', '--bg', '--tcp=3002', 'tcp://127.0.0.1:3002'])
    expect(f.requests).toContainEqual(['http://100.64.0.2:3002/conversations', undefined])
    expect(f.requests).toContainEqual(['http://100.64.0.2:3002/conversations', options.token])
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
    expect(f.calls.every((args) => args[0] === 'status' || args[1] === 'status')).toBe(true)
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
  test('pending ownership is restart safe and explicitly removable', async () => {
    const f = fixture()
    f.setSaved(JSON.stringify({ version: 1, port: 3002, target: '127.0.0.1:3002', phase: 'pending' }))
    expect((await f.controller().inspect()).state).toBe('blocked')
    expect((await f.controller().disable()).state).toBe('off')
    expect(f.saved()).toBeUndefined()
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
    expect(f.calls).toContainEqual(['serve', '--tcp=3002', 'off'])
    expect(f.saved()).toBeUndefined()
  })
  test('privilege diagnostics identify host and next step without leaking subprocess output', async () => {
    const f = fixture(); f.failCommand()
    const result = await f.controller().enable()
    expect(result.message).toContain('Tower')
    expect(result.message).toMatch(/try again|Install/)
    expect(result.message).not.toContain(options.token)
    expect(result.message).not.toMatch(/EACCES|undefined|HTTP \d/)
  })
  test('corrupt ownership fails closed, with no mutations', async () => {
    const f = fixture(); f.setSaved('{bad')
    expect((await f.controller().disable()).state).toBe('blocked')
    expect(f.calls).toEqual([])
  })
})
