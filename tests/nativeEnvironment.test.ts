import { expect, test } from 'bun:test';
import { isolatedNativeEnvironment } from '../e2e/fixtures/nativeEnvironment';
import { discoverLocalPiEndpoint, localHarnessTokenPaths } from '../electron/transport';

test('native children retain GUI plumbing but discard ambient discovery and provider credentials', () => {
  const env = isolatedNativeEnvironment('/fixture/home', {
    DISPLAY: ':99', PATH: '/fixture/bin', XDG_RUNTIME_DIR: '/run/user/fixture',
    HOME: '/daily', USERPROFILE: '/daily', XDG_CONFIG_HOME: '/daily/config',
    EMBER_HOME: '/daily/ember', HEARTH_HOME: '/daily/hearth', EMBER_DATA_DIR: '/daily/data',
    OPENCHAMBER_DATA_DIR: '/daily/chamber', EMBER_BUNDLED_HARNESS: '/daily/kiln',
    HEARTH_PORT: '3002', HEARTH_BIND: '0.0.0.0', HEARTH_CONVERSATION: 'live',
    HEARTH_WORKSPACE: '/daily/workspace', EMBER_WORKSPACE: '/daily/workspace',
    ELECTRON_RUN_AS_NODE: '1', OPENAI_API_KEY: 'not-a-real-key', HTTPS_PROXY: 'http://daily',
  });
  expect(env.DISPLAY).toBe(':99');
  expect(env.PATH).toBe('/fixture/bin');
  expect(env.XDG_RUNTIME_DIR).toBe('/run/user/fixture');
  expect(env.HOME).toBe('/fixture/home');
  expect(env.EMBER_DATA_DIR).toBe('/fixture/home/.ember');
  expect(env.OPENCHAMBER_DATA_DIR).toBe('/fixture/home/openchamber');
  expect(env.XDG_CONFIG_HOME).toBe('/fixture/home/.config');
  expect(env.HEARTH_WORKSPACE).toBe('/fixture/home');
  expect(env.EMBER_WORKSPACE).toBeUndefined();
  for (const key of ['EMBER_HOME', 'HEARTH_HOME', 'EMBER_BUNDLED_HARNESS', 'HEARTH_PORT',
    'HEARTH_BIND', 'HEARTH_CONVERSATION', 'ELECTRON_RUN_AS_NODE', 'OPENAI_API_KEY', 'HTTPS_PROXY']) {
    expect(env[key]).toBeUndefined();
  }
});

test('native discovery cannot see a parent-home token even when one exists', () => {
  const env = isolatedNativeEnvironment('/fixture/home', { EMBER_HOME: '/daily', HEARTH_HOME: '/daily' });
  const paths = localHarnessTokenPaths(env.HOME, env);
  expect(paths.every(path => path.startsWith('/fixture/home/'))).toBe(true);
  // Simulate the token; never inspect the actual filesystem or contact an endpoint.
  expect(discoverLocalPiEndpoint(path => path.startsWith('/daily/') ? 'synthetic-token' : undefined, env.HOME, env)).toBeNull();
});
