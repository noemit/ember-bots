import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKilnSharing, type KilnSharingDependencies } from '../electron/kilnSharing'
const options = { hostLabel: 'Tower', localUrl: 'http://127.0.0.1:3002', token: 'private-token', statePath: '/unused' }
const member = JSON.stringify({ BackendState: 'Running', Self: { Online: true, TailscaleIPs: ['100.64.0.2'] } })

test.each([
  { TCP: { '3002': { HTTPS: true } } },
  { Web: { 'tower.ts.net:3002': { Handlers: {} } } },
  { Foreground: { 'session-id': { TCP: { '3002': { TCPForward: '127.0.0.1:9999' } } } } },
])('all occupied Serve port forms block enable without writes', async (config) => {
  const mutations: unknown[] = []
  const deps: KilnSharingDependencies = {
    read: async () => undefined, save: async (v) => { mutations.push(v) },
    request: async (_url, token) => token ? 200 : 401,
    run: async (args) => { if (args[0] === 'status') return member; if (args[1] === 'status') return JSON.stringify(config); mutations.push(args); return '' },
  }
  expect((await createKilnSharing(options, deps).enable()).state).toBe('blocked')
  expect(mutations).toEqual([])
})

test('missing Tailscale diagnostic is actionable and host-named', async () => {
  const result = await createKilnSharing(options, { read: async () => undefined,
    run: async () => { throw Object.assign(new Error('private-token'), { code: 'ENOENT' }) } }).enable()
  expect(result.message).toContain('Tower')
  expect(result.message).toMatch(/Install|install/)
  expect(result.message).toContain('sign in')
  expect(result.message).not.toContain('private-token')
})

test('unrecognized or malformed Serve status fails closed before persisting intent', async () => {
  for (const raw of ['not json', '[]', '{"TCP":42}', 'null']) {
    let saved = false
    const result = await createKilnSharing(options, { read: async () => undefined,
      save: async () => { saved = true }, request: async (_url, token) => token ? 200 : 401,
      run: async (args) => args[0] === 'status' ? member : raw }).enable()
    expect(result.state).toBe('blocked')
    expect(saved).toBe(false)
  }
})

test('persistent ownership is private, atomic and sufficient after a controller restart', async () => {
  const home = await mkdtemp(join(tmpdir(), 'kiln-share-state-'))
  try {
    const statePath = join(home, 'private', 'share.json')
    let rule = false
    const deps = {
      request: async (_url: string, token?: string) => token ? 200 : 401,
      run: async (args: string[]) => {
        if (args[0] === 'status') return member
        if (args[1] === 'status') return JSON.stringify(rule ? { TCP: { '3002': { TCPForward: '127.0.0.1:3002' } } } : {})
        rule = !args.includes('off'); return ''
      },
    }
    const localOptions = { ...options, statePath }
    expect((await createKilnSharing(localOptions, deps).enable()).state).toBe('ready')
    expect(await readFile(statePath, 'utf8')).not.toContain(options.token)
    if (process.platform !== 'win32') expect((await stat(statePath)).mode & 0o777).toBe(0o600)
    expect((await createKilnSharing(localOptions, deps).inspect()).state).toBe('ready')
    expect((await createKilnSharing(localOptions, deps).disable()).state).toBe('off')
    expect(rule).toBe(false)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('a newly public rule is never called ready or removed', async () => {
  let mutations = 0
  const result = await createKilnSharing(options, {
    read: async () => JSON.stringify({ version: 1, port: 3002, target: '127.0.0.1:3002', phase: 'active' }),
    run: async (args) => { if (args[1] !== 'status') mutations++; return JSON.stringify({ TCP: { '3002': { TCPForward: '127.0.0.1:3002' } }, AllowFunnel: { 'tower.ts.net:3002': true } }) },
  }).disable()
  expect(result.state).toBe('blocked')
  expect(result.url).toBeUndefined()
  expect(mutations).toBe(0)
})

test('an inaccessible tailnet address never receives the bearer token or a forwarding rule', async () => {
  for (const address of ['192.168.1.1', '::1', 'fd00::1', '100.64.0.256']) {
    const requests: unknown[] = []
    const writes: unknown[] = []
    const result = await createKilnSharing(options, {
      read: async () => undefined, save: async (v) => { writes.push(v) },
      request: async (...args) => { requests.push(args); return 200 },
      run: async () => JSON.stringify({ BackendState: 'Running', Self: { Online: true, TailscaleIPs: [address] } }),
    }).enable()
    expect(result.state).toBe('blocked')
    expect(requests).toEqual([])
    expect(writes).toEqual([])
  }
})
