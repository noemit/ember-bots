#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateToken } from '../packages/kiln/src/token';

/**
 * Tinder (`ember` / `tinder`) — launcher and setup CLI for Ember & Kiln.
 *
 * Brand glossary:
 * - Ember: the project and desktop GUI
 * - Kiln (`ember-harness`): Ember's durable agent harness
 * - Tinder (`ember` / `tinder`): this launcher & setup CLI for local desktops and headless remotes
 */

export const DEFAULT_KILN_PORT = 3002;

export type ServicePlatform = 'linux' | 'darwin' | 'win32';

export type CliFlags = {
  headless: boolean;
  harnessOnly: boolean;
  guiOnly: boolean;
  service: boolean;
  json: boolean;
  help: boolean;
  port: number;
  home: string;
  workspace: string;
  harnessDir?: string;
  url?: string;
  platform: ServicePlatform;
};

export type SetupResult = {
  homeDir: string;
  tokenPath: string;
  token: string;
  tokenCreated: boolean;
  agentsMdPath?: string;
  agentsMdCreated?: boolean;
  localUrl: string;
  tailscaleUrl?: string;
  servicePath?: string;
  serviceContent?: string;
  output: string;
};

export type StatusReport = {
  ok: boolean;
  url: string;
  version?: string;
  commit?: string;
  conversations?: number;
  output: string;
};

const isTailscaleIpv4 = (ip: string): boolean => {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  // Tailscale CGNAT range: 100.64.0.0/10 (100.64.0.0 – 100.127.255.255)
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
};

/** Detect the machine's Tailscale IPv4 address (100.64.0.0/10) from network interfaces, if active. */
export const detectTailscaleIp = (
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()
): string | undefined => {
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal && isTailscaleIpv4(entry.address)) {
        if (/tailscale|utun|ts/i.test(name)) return entry.address;
      }
    }
  }
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal && isTailscaleIpv4(entry.address)) {
        return entry.address;
      }
    }
  }
  return undefined;
};

export const defaultEmberHome = (
  homedir: string = os.homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env
): string => {
  const override = env.EMBER_HOME?.trim() || env.HEARTH_HOME?.trim();
  return override ? path.resolve(override) : path.join(homedir, '.ember');
};

/**
 * Ensure `<homeDir>/ember.token` exists with a four-word secret (`apple-venison-rainbow-copper`) and
 * mode `0o600`. The words come from `packages/kiln/src/token.ts`, the same generator the harness
 * uses, so a token made here and one made by an app-launched Kiln are the same kind of secret.
 * Idempotent: if a valid non-empty token is already on disk in `<homeDir>` or in a legacy
 * `~/.hearth/hearth.token` (or `/root/.pi/hearth.token`), it is adopted and preserved with `0o600`.
 */
export const ensureHarnessToken = (
  homeDir: string,
  userHome: string = os.homedir()
): { token: string; tokenPath: string; created: boolean } => {
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const tokenPath = path.join(homeDir, 'ember.token');
  const legacyPath = path.join(homeDir, 'hearth.token');
  const candidates = [
    tokenPath,
    legacyPath,
    ...(homeDir === path.join(userHome, '.ember')
      ? [path.join(userHome, '.hearth', 'hearth.token'), '/root/.pi/hearth.token']
      : []),
  ];

  for (const candidate of candidates) {
    try {
      const existing = fs.readFileSync(candidate, 'utf8').trim();
      if (existing.length > 0) {
        for (const target of [tokenPath, legacyPath]) {
          try {
            if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').trim() !== existing) {
              fs.writeFileSync(target, `${existing}\n`, { encoding: 'utf8', mode: 0o600 });
            }
            fs.chmodSync(target, 0o600);
          } catch {
            // Windows does not support POSIX mode bits.
          }
        }
        return { token: existing, tokenPath, created: false };
      }
    } catch {
      // Missing file; generate below.
    }
  }

  const token = generateToken();
  for (const target of [tokenPath, legacyPath]) {
    fs.writeFileSync(target, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // Ignore on platforms without POSIX chmod.
    }
  }
  return { token, tokenPath, created: true };
};

export type ServiceConfigOptions = {
  platform: ServicePlatform;
  homeDir: string;
  port: number;
  workspaceDir: string;
  harnessDir?: string;
  userHome?: string;
};

/**
 * Path where the OS background service definition for Kiln lives.
 */
export const serviceFilePath = (opts: ServiceConfigOptions): string => {
  const userHome = opts.userHome ?? os.homedir();
  if (opts.platform === 'linux') {
    return path.join(userHome, '.config', 'systemd', 'user', 'ember-kiln.service');
  }
  if (opts.platform === 'darwin') {
    return path.join(userHome, 'Library', 'LaunchAgents', 'dev.ember.kiln.plist');
  }
  return path.join(opts.homeDir, 'install-kiln-task.ps1');
};

/**
 * Generate the background service definition for Kiln (`ember-harness`) on Linux (systemd),
 * macOS (launchd), or Windows (PowerShell Scheduled Task installer).
 */
export const generateServiceConfig = (opts: ServiceConfigOptions): string => {
  const harnessDir = opts.harnessDir ?? path.resolve(opts.workspaceDir, 'hearth');
  const entryScript = path.join(harnessDir, 'src', 'index.ts');

  if (opts.platform === 'linux') {
    return [
      '[Unit]',
      'Description=Kiln (ember-harness) — Durable Agent Harness for Ember',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `WorkingDirectory=${opts.workspaceDir}`,
      `Environment="EMBER_HOME=${opts.homeDir}"`,
      `Environment="HEARTH_HOME=${opts.homeDir}"`,
      `Environment="PORT=${opts.port}"`,
      `Environment="HEARTH_WORKSPACE=${opts.workspaceDir}"`,
      `ExecStart=/usr/bin/env bun run ${entryScript}`,
      'Restart=on-failure',
      'RestartSec=3',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
  }

  if (opts.platform === 'darwin') {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '  <dict>',
      '    <key>Label</key>',
      '    <string>dev.ember.kiln</string>',
      '    <key>ProgramArguments</key>',
      '    <array>',
      '      <string>/usr/bin/env</string>',
      '      <string>bun</string>',
      '      <string>run</string>',
      `      <string>${entryScript}</string>`,
      '    </array>',
      '    <key>WorkingDirectory</key>',
      `    <string>${opts.workspaceDir}</string>`,
      '    <key>EnvironmentVariables</key>',
      '    <dict>',
      '      <key>EMBER_HOME</key>',
      `      <string>${opts.homeDir}</string>`,
      '      <key>HEARTH_HOME</key>',
      `      <string>${opts.homeDir}</string>`,
      '      <key>PORT</key>',
      `      <string>${opts.port}</string>`,
      '    </dict>',
      '    <key>RunAtLoad</key>',
      '    <true/>',
      '    <key>KeepAlive</key>',
      '    <true/>',
      '    <key>StandardOutPath</key>',
      `    <string>${path.join(opts.homeDir, 'kiln.log')}</string>`,
      '    <key>StandardErrorPath</key>',
      `    <string>${path.join(opts.homeDir, 'kiln.err.log')}</string>`,
      '  </dict>',
      '</plist>',
      '',
    ].join('\n');
  }

  return [
    '# Install Kiln (ember-harness) as a background Windows Scheduled Task',
    '$ErrorActionPreference = "Stop"',
    `$TaskName = "EmberKiln"`,
    `$HomeDir = "${opts.homeDir}"`,
    `$WorkspaceDir = "${opts.workspaceDir}"`,
    `$EntryScript = "${entryScript}"`,
    `$Port = "${opts.port}"`,
    '',
    '$env:EMBER_HOME = $HomeDir',
    '$env:HEARTH_HOME = $HomeDir',
    '$env:PORT = $Port',
    '',
    '$Action = New-ScheduledTaskAction -Execute "bun.exe" -Argument "run `"$EntryScript`"" -WorkingDirectory $WorkspaceDir',
    '$Trigger = New-ScheduledTaskTrigger -AtLogOn',
    '$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)',
    'Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null',
    'Start-ScheduledTask -TaskName $TaskName',
    'Write-Host "Registered and started Scheduled Task: $TaskName (http://127.0.0.1:$Port)"',
    '',
  ].join('\n');
};

/**
 * Generate the default `AGENTS.md` guide tailored to the host OS (`darwin`, `win32`, or `linux`).
 *
 * Placed in `<homeDir>/AGENTS.md` on `ember setup` so every agent session on this machine starts
 * with practical instructions for built-in tools, computer navigation, Playwright/MCP browser
 * automation, adding model providers, and pairing remote hosts.
 */
export const generateDefaultAgentsMd = (opts: {
  platform: ServicePlatform;
  homeDir: string;
  port: number;
}): string => {
  const osLabel =
    opts.platform === 'darwin' ? 'macOS' : opts.platform === 'win32' ? 'Windows' : 'Linux';

  const osSection =
    opts.platform === 'darwin'
      ? [
          '## Computer Navigation & macOS Tools',
          '',
          '- **Open URLs, files, or apps:** `open <url-or-path>` or `open -a "App Name"`.',
          '- **Reveal a file in Finder:** `open -R <path>`.',
          '- **Clipboard:** `pbcopy` and `pbpaste`.',
          '- **Screenshots:** `screencapture -x /tmp/screen.png`, then inspect it with the `view` tool (`view({ path: "/tmp/screen.png" })`).',
          '- **AppleScript / UI automation:** `osascript -e \'...\'`.',
          '- **Background services:** Managed via `launchctl` (`~/Library/LaunchAgents/dev.ember.kiln.plist`).',
        ].join('\n')
      : opts.platform === 'win32'
        ? [
            '## Computer Navigation & Windows Tools (Path Rules)',
            '',
            '- **CRITICAL — Two path conventions in one session:**',
            '  - The `bash` tool runs **Git Bash (MSYS)**, where paths look like `/c/Users/<you>/project`.',
            '  - The `read`, `write`, `edit`, and `view` tools use **Windows paths** (`C:/Users/<you>/project` or `C:\\Users\\<you>\\project`). A leading `/c/...` in a file tool resolves to `C:\\c\\...`!',
            '  - **Rule:** Always pass `C:/Users/...` to `read`/`write`/`edit`/`view`, and translate `pwd`/`find` output before handing it to a file tool.',
            '- **Open files, folders, or URLs:** `start "" "<path-or-url>"` or `explorer.exe "<path>"`.',
            '- **PowerShell commands:** `powershell.exe -NoProfile -Command "..."`.',
            '- **Processes & ports:** `tasklist`, `taskkill /F /PID <pid>`, `netstat -ano`.',
            '- **Background services:** Managed via Windows Task Scheduler (`Get-ScheduledTask -TaskName EmberKiln`).',
          ].join('\n')
        : [
            '## Computer Navigation & Linux Tools',
            '',
            '- **Open files or URLs on a desktop:** `xdg-open <path-or-url>`.',
            '- **System & process inspection:** `ps aux`, `ss -tulpn`, `systemctl --user status ember-kiln.service`, `journalctl --user -u ember-kiln.service -n 50`.',
            '- **Clipboard (when a display is active):** `wl-copy` / `wl-paste` (Wayland) or `xclip -selection clipboard` (X11).',
            '- **Screenshots:** Use Playwright MCP (`browser` with `action: "take_screenshot"`) or `import` / `grim`, then inspect with `view`.',
          ].join('\n');

  const mcpPath = path.join(opts.homeDir, 'mcp.json');

  return [
    `# Agent Environment Guide (${osLabel})`,
    '',
    'This file provides default guidance for agents running in **Kiln** (`ember-harness`) and **Ember** on this machine. Project-specific `AGENTS.md` files in a project folder take precedence over this default.',
    '',
    '## Core Tools & File Navigation',
    '',
    '- **Prefer built-in file tools over shell redirection:**',
    '  - `read({ path, offset?, limit? })` — read text files.',
    '  - `write({ path, content })` — create or overwrite files (automatically creates parent directories).',
    '  - `edit({ path, edits: [{ oldText, newText }] })` — exact text replacements.',
    '  - `view({ path })` — inspect images (`png`, `jpg`, `webp`, `gif`, `bmp`). Always use `view` for screenshots and images (`read` is for text only).',
    '- **`bash({ command, timeout? })`:**',
    '  - Runs shell commands in the session working directory.',
    '  - Avoid leaving background processes (like dev servers or watchers) running after a turn unless asked; Kiln tracks leftover processes and reports their memory footprint.',
    '- **`codemode({ code })` & `scratchpad`:**',
    '  - Chain multiple tool calls (`await tools.read(...)`, `await tools.bash(...)`) inside a single QuickJS turn and persist intermediate JSON across turns with `store(key, value)` / `load(key)`.',
    '',
    osSection,
    '',
    '## Browser Automation (Playwright MCP)',
    '',
    '- If the `browser` tool is loaded, use it to navigate and interact with web pages:',
    '  - Prefer `browser({ action: "snapshot" })` or `browser({ action: "find", query: "..." })` to inspect the accessibility tree and get element `ref`s before clicking (`action: "click"`) or typing (`action: "type"`).',
    '  - Use `browser({ action: "take_screenshot" })` when checking visual layout.',
    '- If `browser` is not yet configured, you can enable Playwright MCP in `' + mcpPath + '` and restart Kiln:',
    '  ```json',
    '  {',
    '    "mcpServers": {',
    '      "playwright": {',
    '        "tool": "browser",',
    '        "command": "npx",',
    '        "args": ["-y", "@playwright/mcp@latest", "--headless"]',
    '      }',
    '    }',
    '  }',
    '  ```',
    '  *(Use `tool_search` to discover any deferred MCP tools.)*',
    '',
    '## Coagents, Crews & Messaging',
    '',
    '- **`session` tool:** Spawn hidden crew workers (`action: "spawn"`, always pass a short `role` like `"Researcher"` or `"Builder"`) when a task splits cleanly into independent parallel parts, then `wait` and read `results`.',
    '- **`agents` tool:** List known agents (`action: "directory"`) or message another agent by name (`action: "send"`, `name`, `message`) — works across local sessions and federated remote Kiln hosts.',
    '',
    '## Adding Model Providers',
    '',
    '- **From Ember Desktop:** Open **Settings → Providers** to add an API key, complete an OAuth device-code sign-in, or import credentials from OpenCode.',
    '- **From the terminal (headless or local):**',
    '  ```bash',
    '  bun packages/kiln/scripts/provider.ts list',
    '  bun packages/kiln/scripts/provider.ts set <provider-id> <api-key>',
    '  bun packages/kiln/scripts/provider.ts login <provider-id>',
    '  bun packages/kiln/scripts/provider.ts import',
    '  ```',
    '',
    '## Adding & Pairing Remote Hosts',
    '',
    `1. **On the remote machine (macOS, Windows, or headless Linux):** Run \`ember setup --headless\` (or \`ember token\`). It initializes \`${opts.homeDir}\`, starts Kiln on port \`${opts.port}\`, and prints the URL (including Tailscale IPv4 \`http://100.x.y.z:${opts.port}\` when Tailscale is active) plus the 64-character bearer token.`,
    '2. **In Ember Desktop:** Open **Settings → Instances → Add endpoint**, enter a label (e.g. `Studio`), the remote URL, and the bearer token. Ember automatically syncs peer lists across your connected hosts so agents can message each other by name across machines.',
    '',
  ].join('\n');
};

/**
 * Ensure `<homeDir>/AGENTS.md` exists. Preserves any existing file so user customizations are never
 * overwritten.
 */
export const ensureDefaultAgentsMd = (opts: {
  platform: ServicePlatform;
  homeDir: string;
  port: number;
}): { agentsMdPath: string; created: boolean } => {
  fs.mkdirSync(opts.homeDir, { recursive: true, mode: 0o700 });
  const agentsMdPath = path.join(opts.homeDir, 'AGENTS.md');
  if (fs.existsSync(agentsMdPath)) {
    return { agentsMdPath, created: false };
  }
  const content = generateDefaultAgentsMd(opts);
  fs.writeFileSync(agentsMdPath, content, 'utf8');
  return { agentsMdPath, created: true };
};

export const parseArgs = (
  argv: readonly string[],
  homedir: string = os.homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env
): { command: string; flags: CliFlags } => {
  const args = [...argv];
  let command = 'help';
  if (args.length > 0 && !args[0].startsWith('-')) {
    command = args.shift()!;
  }

  const detectedPlatform: ServicePlatform =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';

  const flags: CliFlags = {
    headless: false,
    harnessOnly: false,
    guiOnly: false,
    service: false,
    json: false,
    help: false,
    port: Number(env.PORT) > 0 ? Number(env.PORT) : DEFAULT_KILN_PORT,
    home: defaultEmberHome(homedir, env),
    workspace: process.cwd(),
    platform: detectedPlatform,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--headless') flags.headless = true;
    else if (arg === '--harness-only') flags.harnessOnly = true;
    else if (arg === '--gui-only') flags.guiOnly = true;
    else if (arg === '--service') flags.service = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--port' && args[i + 1]) {
      const parsed = Number(args[++i]);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) flags.port = parsed;
    } else if (arg === '--home' && args[i + 1]) {
      flags.home = path.resolve(args[++i]);
    } else if (arg === '--workspace' && args[i + 1]) {
      flags.workspace = path.resolve(args[++i]);
    } else if (arg === '--harness-dir' && args[i + 1]) {
      flags.harnessDir = path.resolve(args[++i]);
    } else if (arg === '--url' && args[i + 1]) {
      flags.url = args[++i];
    } else if (arg === '--platform' && args[i + 1]) {
      const value = args[++i];
      if (value === 'linux' || value === 'darwin' || value === 'win32') {
        flags.platform = value;
      }
    }
  }

  if (flags.help) command = 'help';
  return { command, flags };
};

export const formatHelp = (): string =>
  [
    'Tinder (ember / tinder) — Unified Launcher & Setup CLI',
    '',
    '  Ember   Desktop control room GUI for your agents',
    '  Kiln    Durable agent harness (ember-harness)',
    '  Tinder  Setup, token & service CLI for desktop and headless hosts',
    '',
    'Usage:',
    '  ember <command> [options]',
    '  tinder <command> [options]',
    '',
    'Commands:',
    '  setup, install    Initialize ~/.ember, generate ember.token (0600), and optionally write service files',
    '  token             Print endpoint URLs (local + Tailscale) and the bearer token',
    '  status            Probe Kiln (/health) and report its version, build, and conversation count',
    '  service-config    Print the background service config for systemd, launchd, or Windows Task Scheduler',
    '  help              Show this usage guide',
    '',
    'Setup / Install Options:',
    '  --headless        Headless remote mode: configure Kiln token & OS service, skip desktop GUI steps',
    '  --harness-only    Configure Kiln harness token only without desktop GUI steps',
    '  --gui-only        Print desktop GUI instructions only',
    '  --service         Write the OS background service definition for Kiln',
    '  --port <port>     Kiln HTTP port (default: 3002)',
    '  --home <dir>      Kiln data directory (default: ~/.ember or $EMBER_HOME)',
    '  --workspace <dir> Default working directory for Kiln sessions',
    '',
    'Other Options:',
    '  --json            Output machine-readable JSON (for `ember token --json`)',
    '  --url <url>       Target URL for `ember status` (default: http://127.0.0.1:<port>)',
    '  --platform <os>   Target OS for `ember service-config`: linux | darwin | win32',
    '',
    'Examples:',
    '  ember setup                        # Local desktop: sets up Kiln token + Ember GUI instructions',
    '  ember setup --headless             # Headless server: sets up Kiln token + background service',
    '  ember token                        # Copy endpoint URL and token into Ember → Settings → Instances',
    '  ember status                       # Check if Kiln is running and answering',
    '  ember service-config --platform linux',
  ].join('\n');

export const runSetup = (
  flags: CliFlags,
  opts: { userHome?: string; tailscaleIp?: string } = {}
): SetupResult => {
  const localUrl = `http://127.0.0.1:${flags.port}`;
  const tsIp = opts.tailscaleIp ?? detectTailscaleIp();
  const tailscaleUrl = tsIp ? `http://${tsIp}:${flags.port}` : undefined;

  if (flags.guiOnly) {
    const lines = [
      'Ember Desktop GUI',
      '  Start from source:  bun run dev',
      '  Package installer:  bun run dist',
      '  Add instances in:   Settings → Instances',
    ];
    return {
      homeDir: flags.home,
      tokenPath: path.join(flags.home, 'ember.token'),
      token: '',
      tokenCreated: false,
      localUrl,
      tailscaleUrl,
      output: lines.join('\n'),
    };
  }

  const { token, tokenPath, created } = ensureHarnessToken(flags.home, opts.userHome);
  const agentsMd = ensureDefaultAgentsMd({
    platform: flags.platform,
    homeDir: flags.home,
    port: flags.port,
  });
  const lines: string[] = [
    'Kiln (ember-harness) setup complete',
    `  Home directory:  ${flags.home}`,
    `  Token file:      ${tokenPath} (${created ? 'generated, mode 0600' : 'existing, mode 0600'})`,
    `  Agent guide:     ${agentsMd.agentsMdPath} (${agentsMd.created ? `created for ${flags.platform}` : 'existing preserved'})`,
    `  Local URL:       ${localUrl}`,
  ];
  if (tailscaleUrl) {
    lines.push(`  Tailscale URL:   ${tailscaleUrl}`);
  }
  lines.push(`  Bearer token:    ${token}`);

  let servicePath: string | undefined;
  let serviceContent: string | undefined;

  if (flags.service || flags.headless) {
    const svcOpts: ServiceConfigOptions = {
      platform: flags.platform,
      homeDir: flags.home,
      port: flags.port,
      workspaceDir: flags.workspace,
      harnessDir: flags.harnessDir,
      userHome: opts.userHome,
    };
    servicePath = serviceFilePath(svcOpts);
    serviceContent = generateServiceConfig(svcOpts);
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, serviceContent, 'utf8');

    lines.push('');
    lines.push('Background service configuration:');
    lines.push(`  Wrote: ${servicePath}`);
    if (flags.platform === 'linux') {
      lines.push('  Enable & start: systemctl --user daemon-reload && systemctl --user enable --now ember-kiln.service');
    } else if (flags.platform === 'darwin') {
      lines.push(`  Load agent:     launchctl load -w "${servicePath}"`);
    } else {
      lines.push(`  Run installer:  powershell -ExecutionPolicy Bypass -File "${servicePath}"`);
    }
  }

  if (flags.headless || flags.harnessOnly) {
    lines.push('');
    lines.push('Connect from Ember on your laptop:');
    lines.push(`  Open Settings → Instances → Add endpoint, paste ${tailscaleUrl ?? localUrl} and the bearer token above.`);
  } else {
    lines.push('');
    lines.push('Ember Desktop GUI:');
    lines.push('  Ember automatically discovers ~/.ember/ember.token on first launch.');
    lines.push('  Launch from source: bun run dev');
    lines.push('  Build installer:    bun run dist');
  }

  return {
    homeDir: flags.home,
    tokenPath,
    token,
    tokenCreated: created,
    agentsMdPath: agentsMd.agentsMdPath,
    agentsMdCreated: agentsMd.created,
    localUrl,
    tailscaleUrl,
    servicePath,
    serviceContent,
    output: lines.join('\n'),
  };
};

export const runToken = (
  flags: CliFlags,
  opts: { tailscaleIp?: string } = {}
): { localUrl: string; tailscaleUrl?: string; token: string; tokenPath: string; output: string } => {
  const { token, tokenPath } = ensureHarnessToken(flags.home);
  const localUrl = `http://127.0.0.1:${flags.port}`;
  const tsIp = opts.tailscaleIp ?? detectTailscaleIp();
  const tailscaleUrl = tsIp ? `http://${tsIp}:${flags.port}` : undefined;

  if (flags.json) {
    const payload = {
      localUrl,
      ...(tailscaleUrl ? { tailscaleUrl } : {}),
      token,
      tokenPath,
    };
    return {
      localUrl,
      tailscaleUrl,
      token,
      tokenPath,
      output: JSON.stringify(payload, null, 2),
    };
  }

  const lines = [
    `Local URL:      ${localUrl}`,
    ...(tailscaleUrl ? [`Tailscale URL:  ${tailscaleUrl}`] : []),
    `Bearer token:   ${token}`,
    `Token file:     ${tokenPath}`,
  ];
  return { localUrl, tailscaleUrl, token, tokenPath, output: lines.join('\n') };
};

export const runStatus = async (
  flags: CliFlags,
  fetchImpl: typeof fetch = fetch
): Promise<StatusReport> => {
  const baseUrl = (flags.url ?? `http://127.0.0.1:${flags.port}`).replace(/\/+$/, '');
  const tokenPath = path.join(flags.home, 'ember.token');
  let token = '';
  for (const candidate of [
    tokenPath,
    path.join(flags.home, 'hearth.token'),
    path.join(os.homedir(), '.hearth', 'hearth.token'),
    '/root/.pi/hearth.token',
  ]) {
    try {
      const val = fs.readFileSync(candidate, 'utf8').trim();
      if (val) {
        token = val;
        break;
      }
    } catch {
      // Try next candidate.
    }
  }

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const healthRes = await fetchImpl(`${baseUrl}/health`, {
      headers,
      signal: AbortSignal.timeout(4000),
    });
    if (!healthRes.ok) {
      return {
        ok: false,
        url: baseUrl,
        output: `Kiln at ${baseUrl} returned HTTP ${healthRes.status}. Check that your token in ${tokenPath} matches the running server.`,
      };
    }
    const body = (await healthRes.json().catch(() => ({}))) as Record<string, unknown>;
    const version = typeof body.version === 'string' ? body.version : undefined;
    const commit = typeof body.commit === 'string' ? body.commit : undefined;
    let conversations = typeof body.conversations === 'number' ? body.conversations : undefined;

    if (conversations === undefined && token) {
      try {
        const convRes = await fetchImpl(`${baseUrl}/conversations`, {
          headers,
          signal: AbortSignal.timeout(4000),
        });
        if (convRes.ok) {
          const convBody = (await convRes.json().catch(() => null)) as unknown;
          if (Array.isArray(convBody)) conversations = convBody.length;
          else if (convBody && typeof convBody === 'object' && Array.isArray((convBody as { conversations?: unknown[] }).conversations)) {
            conversations = (convBody as { conversations: unknown[] }).conversations.length;
          }
        }
      } catch {
        // Optional count probe.
      }
    }

    const lines = [
      `Kiln is answering at ${baseUrl}`,
      ...(version ? [`  Version:        ${version}`] : []),
      ...(commit ? [`  Build:          ${commit}`] : []),
      ...(conversations !== undefined ? [`  Conversations:  ${conversations}`] : []),
    ];
    return {
      ok: true,
      url: baseUrl,
      version,
      commit,
      conversations,
      output: lines.join('\n'),
    };
  } catch {
    return {
      ok: false,
      url: baseUrl,
      output: [
        `Kiln did not answer at ${baseUrl}.`,
        'It may not be running yet — run `ember setup --service` to install the background service, or start Kiln directly and try `ember status` again.',
      ].join(' '),
    };
  }
};

export const runCli = async (argv: readonly string[] = process.argv.slice(2)): Promise<{ exitCode: number; output: string }> => {
  const { command, flags } = parseArgs(argv);

  if (command === 'help' || command === '--help' || command === '-h') {
    return { exitCode: 0, output: formatHelp() };
  }

  if (command === 'setup' || command === 'install') {
    const res = runSetup(flags);
    return { exitCode: 0, output: res.output };
  }

  if (command === 'token') {
    const res = runToken(flags);
    return { exitCode: 0, output: res.output };
  }

  if (command === 'status') {
    const res = await runStatus(flags);
    return { exitCode: res.ok ? 0 : 1, output: res.output };
  }

  if (command === 'service-config') {
    const content = generateServiceConfig({
      platform: flags.platform,
      homeDir: flags.home,
      port: flags.port,
      workspaceDir: flags.workspace,
      harnessDir: flags.harnessDir,
    });
    return { exitCode: 0, output: content.trimEnd() };
  }

  return {
    exitCode: 1,
    output: `Unknown command "${command}". Run \`ember help\` to see available commands.`,
  };
};

export const isMain = (
  entry: string | undefined = process.argv[1],
  metaUrl: string = import.meta.url
): boolean => {
  if (!entry) return false;
  if (entry.includes('$bunfs') || metaUrl.includes('$bunfs')) return true;
  try {
    return (
      metaUrl === pathToFileURL(fs.realpathSync(entry)).href ||
      metaUrl === pathToFileURL(path.resolve(entry)).href
    );
  } catch {
    return false;
  }
};

if ((import.meta as { main?: boolean }).main || isMain()) {
  runCli().then(({ exitCode, output }) => {
    if (exitCode === 0) console.log(output);
    else console.error(output);
    process.exit(exitCode);
  });
}
