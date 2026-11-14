import { join } from 'node:path';

/** Keep GUI/runtime plumbing, never the coordinator's discovery paths or provider credentials. */
export const isolatedNativeEnvironment = (
  home: string,
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR', 'LD_LIBRARY_PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  // In particular, EMBER_HOME/HEARTH_HOME, EMBER_BUNDLED_HARNESS, discovery ports and proxies
  // must not survive. HOME alone does not isolate localHarnessTokenPaths().
  return {
    ...env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
    TMPDIR: home, TMP: home, TEMP: home,
    EMBER_DATA_DIR: join(home, '.ember'), OPENCHAMBER_DATA_DIR: join(home, 'openchamber'),
    HEARTH_WORKSPACE: home, HEARTH_AUTORELOAD: '0',
  };
};
