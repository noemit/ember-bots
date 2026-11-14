import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { isIP } from 'node:net'

export type KilnSharingStatus = {
  state: 'off' | 'ready' | 'blocked'
  message: string
  url?: string
  /** A persisted intent, not a claim that the endpoint is reachable. */
  enabled: boolean
}
export type KilnSharingOptions = {
  hostLabel: string
  localUrl: string
  token: string
  statePath: string
  publicPort?: number
}
type Ownership = { version: 1; port: number; target: string; phase: 'pending' | 'active' }
export type KilnSharingDependencies = {
  run(args: string[]): Promise<string>
  request(url: string, token?: string): Promise<number>
  read(): Promise<string | undefined>
  save(value: string | undefined): Promise<void>
}

export function isTailnetAddress(value: string): boolean {
  if (isIP(value) === 4) {
    const p = value.split('.').map(Number)
    return p[0] === 100 && p[1] >= 64 && p[1] <= 127
  }
  if (isIP(value) !== 6 || value.includes('%')) return false
  return new URL(`http://[${value}]`).hostname.startsWith('[fd7a:115c:a1e0:')
}

export function sharingTarget(localUrl: string): string {
  const url = new URL(localUrl)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !(host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127'))) {
    throw new Error('loopback')
  }
  return `${isIP(host) === 6 ? `[${host}]` : host}:${url.port || '80'}`
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('configuration')
  return value as Record<string, unknown>
}
function parseConfig(raw: string): Record<string, unknown> {
  // Some versions emit an empty string when Serve has never been configured.
  return raw.trim() ? object(JSON.parse(raw)) : {}
}
function tcpAt(config: Record<string, unknown>, port: number): unknown {
  return config.TCP === undefined ? undefined : object(config.TCP)[String(port)]
}
function ownRule(rule: unknown, target: string): boolean {
  if (!rule || typeof rule !== 'object') return false
  const fields = Object.keys(rule)
  return fields.length === 1 && (rule as Record<string, unknown>).TCPForward === target
}
function occupiedPort(config: Record<string, unknown>, port: number): boolean {
  if (tcpAt(config, port) !== undefined) return true
  if (config.Web && Object.keys(object(config.Web)).some((key) => key.endsWith(`:${port}`))) return true
  // A foreground Serve session may also own this port. Do not replace its rule.
  if (config.Foreground && Object.values(object(config.Foreground)).some((entry) => occupiedPort(object(entry), port))) return true
  return false
}
function publicPortIn(config: Record<string, unknown>, port: number): boolean {
  if (!config.AllowFunnel) return false
  return Object.entries(object(config.AllowFunnel)).some(([key, value]) => key.endsWith(`:${port}`) && value === true)
}

/** No startup mutation: callers must invoke enable only after an explicit human action.
 * This owns a single persistent Serve TCP rule, never the daemon or the Kiln process.
 */
export function createKilnSharing(options: KilnSharingOptions, injected?: Partial<KilnSharingDependencies>) {
  const defaults: KilnSharingDependencies = {
    run: (args) => new Promise((resolve, reject) => {
      execFile('tailscale', args, { timeout: 12_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    }),
    request: async (url, token) => {
      const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: 'error', signal: AbortSignal.timeout(5000) })
      await response.body?.cancel()
      return response.status
    },
    read: async () => {
      try { return await fs.readFile(options.statePath, 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    },
    save: async (value) => {
      if (value === undefined) { await fs.rm(options.statePath, { force: true }); return }
      await fs.mkdir(dirname(options.statePath), { recursive: true, mode: 0o700 })
      const temp = `${options.statePath}.tmp`
      await fs.writeFile(temp, value, { mode: 0o600 })
      await fs.chmod(temp, 0o600)
      await fs.rename(temp, options.statePath)
    },
  }
  const deps = { ...defaults, ...injected }
  const host = options.hostLabel
  let enabled = false
  const blocked = (reason: string): KilnSharingStatus => ({ state: 'blocked', enabled, message: `${host}: ${reason}` })
  const off = (): KilnSharingStatus => ({ state: 'off', enabled: false, message: `${host} is not shared. Choose Share this Kiln to enable tailnet access.` })
  async function ownership(): Promise<Ownership | undefined> {
    const raw = await deps.read()
    if (!raw) { enabled = false; return undefined }
    const value = object(JSON.parse(raw))
    if (value.version !== 1 || !Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535 ||
      typeof value.target !== 'string' || !['pending', 'active'].includes(String(value.phase))) throw new Error('ownership')
    // Metadata must also contain a strict numerical loopback target.
    if (sharingTarget(`http://${value.target}`) !== value.target) throw new Error('ownership')
    enabled = true
    return value as unknown as Ownership
  }
  async function config() { return parseConfig(await deps.run(['serve', 'status', '--json'])) }
  async function address(): Promise<string> {
    const status = object(JSON.parse(await deps.run(['status', '--json'])))
    const self = object(status.Self)
    if (status.BackendState !== 'Running' || self.Online !== true || !Array.isArray(self.TailscaleIPs)) throw new Error('membership')
    const ip = self.TailscaleIPs.find((ip: unknown) => typeof ip === 'string' && isTailnetAddress(ip))
    if (typeof ip !== 'string') throw new Error('membership')
    return ip
  }
  async function authenticated(base: string): Promise<boolean> {
    if (!options.token.trim() || /[\r\n]/.test(options.token)) return false
    // Health is public on Kiln; it cannot establish that bearer authentication is enforced.
    const denied = await deps.request(`${base}/conversations`)
    if (denied !== 401 && denied !== 403) return false
    return await deps.request(`${base}/conversations`, options.token) === 200
  }
  async function inspectInternal(): Promise<KilnSharingStatus> {
    const own = await ownership()
    if (!own) return off()
    if (own.target !== sharingTarget(options.localUrl)) return blocked('Kiln’s local address changed. Stop sharing before enabling it again.')
    const current = await config()
    if (!ownRule(tcpAt(current, own.port), own.target) || publicPortIn(current, own.port)) {
      return blocked('Tailscale’s forwarding changed. Review its Serve settings; Ember will not replace them.')
    }
    const ip = await address()
    const url = `http://${isIP(ip) === 6 ? `[${ip}]` : ip}:${own.port}`
    if (!await authenticated(url)) return blocked('Kiln’s shared address did not pass its access check. Check the bearer token and Tailscale access rules, then try again.')
    return { state: 'ready', enabled: true, url, message: `${host} is shared with your tailnet. Other computers still need its bearer token and permission in Tailscale.` }
  }
  async function disableInternal(): Promise<KilnSharingStatus> {
    const own = await ownership()
    if (!own) return off()
    const current = await config()
    const rule = tcpAt(current, own.port)
    if (rule !== undefined) {
      if (!ownRule(rule, own.target) || publicPortIn(current, own.port)) return blocked('Tailscale’s forwarding changed. Review its Serve settings; Ember will not remove another setup.')
      await deps.run(['serve', `--tcp=${own.port}`, 'off'])
      if (tcpAt(await config(), own.port) !== undefined) return blocked('Tailscale kept its forwarding rule. Check permission to manage Serve, then stop sharing again.')
    }
    await deps.save(undefined)
    enabled = false
    return off()
  }
  async function enableInternal(): Promise<KilnSharingStatus> {
    const target = sharingTarget(options.localUrl)
    const port = options.publicPort ?? Number(target.slice(target.lastIndexOf(':') + 1))
    if (!Number.isInteger(port) || port < 1 || port > 65535) return blocked('Choose a valid sharing port and try again.')
    const own = await ownership()
    if (own) return inspectInternal()
    await address()
    if (!await authenticated(options.localUrl.replace(/\/$/, ''))) return blocked('Kiln must require its bearer token before sharing. Check its authentication settings and try again.')
    const current = await config()
    if (occupiedPort(current, port) || publicPortIn(current, port)) return blocked('Tailscale already uses this port. Choose another sharing port or review its Serve settings first.')
    const pending: Ownership = { version: 1, port, target, phase: 'pending' }
    await deps.save(JSON.stringify(pending))
    enabled = true
    try {
      // Supported persistent TCP Serve syntax; never Funnel, reset, or whole-config replacement.
      await deps.run(['serve', '--bg', `--tcp=${port}`, `tcp://${target}`])
      const result = await inspectInternal()
      if (result.state !== 'ready') { await disableInternal(); return { ...result, enabled } }
      await deps.save(JSON.stringify({ ...pending, phase: 'active' }))
      return result
    } catch (error) {
      try { await disableInternal() } catch { /* Keep durable pending ownership for a later explicit recovery. */ }
      throw error
    }
  }
  function diagnostic(error: unknown): KilnSharingStatus {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return blocked('Tailscale is not installed or not on Ember’s command path. Install it, sign in, and try again.')
    // Never echo subprocess stderr, URLs, or credentials into user-facing diagnostics.
    return blocked('Tailscale sharing could not be checked or changed. Check that Tailscale is signed in, its access rules allow this connection, and you can manage Serve on this host, then try again.')
  }
  let chain: Promise<unknown> = Promise.resolve()
  function serial(action: () => Promise<KilnSharingStatus>): Promise<KilnSharingStatus> {
    const next = chain.then(action).catch(diagnostic)
    chain = next
    return next
  }
  return { inspect: () => serial(inspectInternal), enable: () => serial(enableInternal), disable: () => serial(disableInternal) }
}
