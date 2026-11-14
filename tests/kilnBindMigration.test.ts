import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { defaultBind, ensureHome, hearthConfig } from '../packages/kiln/src/config'
import { generateServiceConfig, parseArgs, runSetup, serviceFilePath } from '../cli/ember'
const homes: string[] = []
const temp = () => { const home = mkdtempSync(join(tmpdir(), 'kiln-bind-')); homes.push(home); return home }
const previous = { hearth: process.env.HEARTH_BIND, ember: process.env.EMBER_BIND }
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  if (previous.hearth === undefined) delete process.env.HEARTH_BIND; else process.env.HEARTH_BIND = previous.hearth
  if (previous.ember === undefined) delete process.env.EMBER_BIND; else process.env.EMBER_BIND = previous.ember
})
function clearEnv() { delete process.env.HEARTH_BIND; delete process.env.EMBER_BIND }

test('new data homes stay loopback across database creation and restart', () => {
  clearEnv(); const home = temp()
  const first = hearthConfig({ home })
  expect(first.bind).toBe('127.0.0.1')
  expect(ensureHome(first)).toBe(true)
  writeFileSync(first.databasePath, 'fake sqlite')
  expect(hearthConfig({ home }).bind).toBe('127.0.0.1')
  expect(ensureHome(hearthConfig({ home }))).toBe(false)
  expect(readFileSync(join(home, 'kiln-bind-default'), 'utf8').trim()).toBe('127.0.0.1')
})
test('pre-upgrade database retains implicit wildcard bind for saved service compatibility', () => {
  clearEnv(); const home = temp(); writeFileSync(join(home, 'hearth.sqlite'), 'existing')
  expect(hearthConfig({ home }).bind).toBe('0.0.0.0')
  ensureHome(hearthConfig({ home }))
  expect(readFileSync(join(home, 'kiln-bind-default'), 'utf8').trim()).toBe('0.0.0.0')
  expect(hearthConfig({ home }).bind).toBe('0.0.0.0')
})
test('explicit environment binds win but do not contaminate new-install private default', () => {
  clearEnv(); const home = temp()
  process.env.EMBER_BIND = '::1'
  expect(hearthConfig({ home }).bind).toBe('::1')
  process.env.HEARTH_BIND = '0.0.0.0'
  expect(hearthConfig({ home }).bind).toBe('0.0.0.0')
  ensureHome(hearthConfig({ home })); writeFileSync(join(home, 'hearth.sqlite'), 'new')
  clearEnv()
  expect(hearthConfig({ home }).bind).toBe('127.0.0.1')
})
test('invalid saved default fails private rather than expanding access', () => {
  const home = temp(); writeFileSync(join(home, 'hearth.sqlite'), 'existing')
  writeFileSync(join(home, 'kiln-bind-default'), '::')
  expect(defaultBind(home)).toBe('127.0.0.1')
})
test('new standalone service definitions explicitly bind loopback across all platforms; explicit overrides retained', () => {
  const base = { homeDir: '/tmp/fake', port: 3002, workspaceDir: '/tmp/fake', launchCommand: ['fake-kiln'] }
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    expect(generateServiceConfig({ ...base, platform })).toContain('127.0.0.1')
    expect(generateServiceConfig({ ...base, platform, bind: '::1' })).toContain('::1')
  }
  expect(parseArgs(['serve', '--bind', '::1'], '/tmp/fake', {}).flags.bind).toBe('::1')
  expect(parseArgs(['serve'], '/tmp/fake', { HEARTH_BIND: '0.0.0.0' }).flags.bind).toBe('0.0.0.0')
})
test('setup never rewrites existing saved service configuration', () => {
  const root = temp()
  const { flags } = parseArgs(['setup', '--headless', '--home', join(root, 'data')], root, {})
  flags.platform = 'linux'
  const file = serviceFilePath({ platform: 'linux', homeDir: flags.home, port: flags.port, workspaceDir: root, userHome: root })
  mkdirSync(dirname(file), { recursive: true })
  const existing = 'Existing legacy service with HEARTH_BIND=0.0.0.0 and custom command\n'
  writeFileSync(file, existing)
  const result = runSetup(flags, { userHome: root })
  expect(readFileSync(file, 'utf8')).toBe(existing)
  expect(result.serviceContent).toBe(existing)
  expect(result.output).toContain('Preserved existing configuration')
})
