import * as React from 'react';
import { Check, Copy, Loader2, RefreshCw, ShieldAlert, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { copyText } from '../lib/clipboard';
import type {
  PiEndpoint,
  SshHostCandidate,
  SshLifetime,
  SshProbeResult,
  SshSetupMode,
  SshSetupResult,
} from '../types';

export type SshEndpointSetupProps = {
  onConnected: (endpoint: PiEndpoint, message: string) => Promise<void> | void;
};

const candidateSubtitle = (host: SshHostCandidate): string => {
  const parts: string[] = [];
  if (host.user && host.hostName) parts.push(`${host.user}@${host.hostName}`);
  else if (host.hostName) parts.push(host.hostName);
  else if (host.user) parts.push(host.user);
  if (host.port && host.port !== 22) parts.push(`port ${host.port}`);
  if (host.proxyJump) parts.push(`via ${host.proxyJump}`);
  return parts.join(' · ');
};

export default function SshEndpointSetup({ onConnected }: SshEndpointSetupProps) {
  const [hosts, setHosts] = React.useState<SshHostCandidate[]>([]);
  const [loadingHosts, setLoadingHosts] = React.useState(false);
  const [target, setTarget] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [lifetime, setLifetime] = React.useState<SshLifetime>('service');
  const [probing, setProbing] = React.useState(false);
  const [probe, setProbe] = React.useState<SshProbeResult | null>(null);
  const [trusting, setTrusting] = React.useState(false);
  const [trustError, setTrustError] = React.useState('');
  const [installing, setInstalling] = React.useState(false);
  const [setupStatus, setSetupStatus] = React.useState<SshSetupResult | null>(null);
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const mounted = React.useRef(true);

  const canUseSsh =
    typeof window !== 'undefined' &&
    window.ember?.capabilities?.endpointManagement !== false &&
    typeof window.ember?.listSshHosts === 'function' &&
    typeof window.ember?.probeSshHost === 'function' &&
    typeof window.ember?.setupSshKiln === 'function';

  const loadCandidates = React.useCallback(async () => {
    if (!canUseSsh || !window.ember?.listSshHosts) return;
    setLoadingHosts(true);
    try {
      const list = await window.ember.listSshHosts();
      if (mounted.current && Array.isArray(list)) setHosts(list);
    } catch {
      if (mounted.current) setHosts([]);
    } finally {
      if (mounted.current) setLoadingHosts(false);
    }
  }, [canUseSsh]);

  React.useEffect(() => {
    mounted.current = true;
    void loadCandidates();
    return () => {
      mounted.current = false;
    };
  }, [loadCandidates]);

  const handleCopy = async (key: string, text: string) => {
    const ok = await copyText(text);
    if (!mounted.current || !ok) return;
    setCopiedKey(key);
    setTimeout(() => {
      if (mounted.current) setCopiedKey((current) => (current === key ? null : current));
    }, 1800);
  };

  const runProbe = async (nextTarget: string) => {
    const cleaned = nextTarget.trim();
    if (!cleaned || !window.ember?.probeSshHost) return;
    setTarget(cleaned);
    setLabel((current) => current.trim() || cleaned);
    setProbing(true);
    setProbe(null);
    setTrustError('');
    setSetupStatus(null);
    try {
      const result = await window.ember.probeSshHost(cleaned);
      if (!mounted.current) return;
      setProbe(result);
      if (result.outcome === 'ok') {
        setLifetime(result.serviceManager === 'none' ? 'ephemeral' : 'service');
      }
    } catch {
      if (!mounted.current) return;
      setProbe({
        outcome: 'error',
        target: cleaned,
        message: `Ember couldn’t check ${cleaned} over SSH. Check your connection and try again.`,
      });
    } finally {
      if (mounted.current) setProbing(false);
    }
  };

  const handleTrustHost = async () => {
    if (!probe || probe.outcome !== 'host-key-unknown' || !window.ember?.trustSshHost) return;
    setTrusting(true);
    setTrustError('');
    try {
      const saved = await window.ember.trustSshHost(probe.keys.map((key) => key.knownHostsLine));
      if (!mounted.current) return;
      if (!saved.ok) {
        setTrustError(saved.message);
        return;
      }
      await runProbe(probe.target);
    } catch {
      if (mounted.current) {
        setTrustError('Ember couldn’t write to ~/.ssh/known_hosts. Check file permissions and try again.');
      }
    } finally {
      if (mounted.current) setTrusting(false);
    }
  };

  const runSetup = async (mode: SshSetupMode) => {
    if (!probe || probe.outcome !== 'ok' || !window.ember?.setupSshKiln) return;
    setInstalling(true);
    setSetupStatus(null);
    try {
      const result = await window.ember.setupSshKiln({
        target: probe.target,
        label: label.trim() || probe.target,
        lifetime,
        remotePort: probe.existingKiln?.port ?? 3002,
        mode,
        remoteHome: probe.existingKiln?.home,
        binaryPath: probe.existingKiln?.binaryPath,
      });
      if (!mounted.current) return;
      setSetupStatus(result);
      if (result.ok) {
        await onConnected(result.endpoint, result.message);
      }
    } catch {
      if (mounted.current) {
        setSetupStatus({
          ok: false,
          code: 'error',
          message: `Ember couldn’t finish setting up Kiln on ${probe.target}. Check the SSH connection and try again.`,
        });
      }
    } finally {
      if (mounted.current) setInstalling(false);
    }
  };

  if (!canUseSsh) {
    return (
      <p className="text-xs text-muted-foreground">
        Open Ember on the desktop to discover SSH hosts and install or connect Kiln over SSH.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-xs">
      <p className="text-muted-foreground">
        Pick a machine from <code className="rounded bg-muted px-1 py-0.5">~/.ssh/config</code> or enter{' '}
        <code className="rounded bg-muted px-1 py-0.5">user@host</code>. Ember never contacts any host until you choose
        one, installs verified Tinder on loopback (<code className="rounded bg-muted px-1 py-0.5">127.0.0.1</code>)
        only, and connects through a local SSH tunnel.
      </p>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">SSH hosts from ~/.ssh/config</span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={loadingHosts}
            onClick={() => void loadCandidates()}
          >
            <RefreshCw className={loadingHosts ? 'size-3 animate-spin' : 'size-3'} aria-hidden="true" />
            Refresh list
          </Button>
        </div>

        {hosts.length === 0 ? (
          <p className="text-muted-foreground">
            {loadingHosts
              ? 'Reading ~/.ssh/config…'
              : 'No named hosts found in ~/.ssh/config. Enter user@host below to connect directly.'}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Discovered SSH hosts">
            {hosts.map((host) => {
              const subtitle = candidateSubtitle(host);
              const selected = target === host.alias;
              return (
                <Button
                  key={host.alias}
                  type="button"
                  size="sm"
                  variant={selected ? 'secondary' : 'outline'}
                  disabled={probing || installing}
                  onClick={() => {
                    setLabel(host.alias);
                    void runProbe(host.alias);
                  }}
                  title={subtitle || host.alias}
                  className="h-auto flex-col items-start gap-0 px-2.5 py-1.5 text-left"
                >
                  <span className="font-medium">{host.alias}</span>
                  {subtitle ? <span className="text-[10.5px] font-normal text-muted-foreground">{subtitle}</span> : null}
                </Button>
              );
            })}
          </div>
        )}
      </div>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void runProbe(target);
        }}
      >
        <Input
          aria-label="SSH host or user@host"
          placeholder="alias or user@hostname"
          value={target}
          disabled={probing || installing}
          onChange={(event) => setTarget(event.target.value)}
          className="h-8 flex-1 text-xs"
        />
        <Button type="submit" size="sm" variant="outline" disabled={probing || installing || !target.trim()}>
          {probing ? (
            <>
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Checking host…
            </>
          ) : (
            'Check host'
          )}
        </Button>
      </form>

      {probe && probe.outcome === 'host-key-unknown' ? (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3" role="status">
          <div className="flex items-center gap-1.5 font-medium">
            <ShieldAlert className="size-3.5 text-highlight" aria-hidden="true" />
            Verify SSH host key for {probe.hostName}
            {probe.port !== 22 ? `:${probe.port}` : ''}
          </div>
          <p className="text-muted-foreground">{probe.message}</p>
          {probe.keys.length > 0 ? (
            <ul className="space-y-1 font-mono text-[11px]">
              {probe.keys.map((key) => (
                <li key={key.knownHostsLine} className="break-all rounded bg-background/80 px-2 py-1">
                  <span className="text-muted-foreground">{key.keyType}</span> {key.fingerprint}
                </li>
              ))}
            </ul>
          ) : null}
          {trustError ? <p role="alert" className="text-destructive">{trustError}</p> : null}
          <div className="flex flex-wrap gap-2">
            {probe.keys.length > 0 ? (
              <Button
                type="button"
                size="sm"
                disabled={trusting || probing}
                onClick={() => void handleTrustHost()}
              >
                {trusting ? 'Saving host key…' : 'Trust host key & continue'}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="outline" disabled={probing} onClick={() => void runProbe(probe.target)}>
              Check host again
            </Button>
          </div>
        </div>
      ) : null}

      {probe && probe.outcome === 'auth-required' ? (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3" role="status">
          <p>{probe.message}</p>
          <div className="flex items-center gap-2 rounded bg-background/80 px-2 py-1.5 font-mono text-[11px]">
            <Terminal className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
            <code className="min-w-0 flex-1 break-all">{probe.unlockCommand}</code>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => void handleCopy('unlock', probe.unlockCommand)}
            >
              {copiedKey === 'unlock' ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copiedKey === 'unlock' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <Button type="button" size="sm" variant="outline" disabled={probing} onClick={() => void runProbe(probe.target)}>
            Check host again
          </Button>
        </div>
      ) : null}

      {probe &&
      (probe.outcome === 'unreachable' ||
        probe.outcome === 'ssh-missing' ||
        probe.outcome === 'invalid-target' ||
        probe.outcome === 'error') ? (
        <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3" role="alert">
          <p>{probe.message}</p>
          {probe.outcome !== 'invalid-target' ? (
            <Button type="button" size="sm" variant="outline" disabled={probing} onClick={() => void runProbe(probe.target)}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      {probe && probe.outcome === 'ok' ? (
        <div className="space-y-3 rounded-lg border bg-card/50 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">{probe.target}</span>
            <span className="text-muted-foreground">
              {probe.rawOs} · {probe.rawArch}
              {probe.existingKiln?.running
                ? ` · Kiln ${probe.existingKiln.version ?? 'running'} detected`
                : probe.existingKiln?.binaryPath
                  ? ' · Tinder already installed'
                  : ' · Kiln not installed yet'}
            </span>
          </div>

          <div className="space-y-1">
            <label htmlFor="ssh-endpoint-label" className="block font-medium">
              Display name
            </label>
            <Input
              id="ssh-endpoint-label"
              value={label}
              disabled={installing}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={probe.target}
              className="h-8 text-xs"
            />
          </div>

          <div className="space-y-1.5">
            <span className="block font-medium">Remote lifetime</span>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Remote Kiln lifetime">
              <Button
                type="button"
                size="sm"
                variant={lifetime === 'service' ? 'secondary' : 'outline'}
                aria-pressed={lifetime === 'service'}
                disabled={installing || probe.serviceManager === 'none'}
                onClick={() => setLifetime('service')}
              >
                Background service (recommended)
              </Button>
              <Button
                type="button"
                size="sm"
                variant={lifetime === 'ephemeral' ? 'secondary' : 'outline'}
                aria-pressed={lifetime === 'ephemeral'}
                disabled={installing}
                onClick={() => setLifetime('ephemeral')}
              >
                This session only
              </Button>
            </div>
            <p className="text-muted-foreground">
              {lifetime === 'service'
                ? 'Installs a user service bound to 127.0.0.1 so bots keep running when this computer sleeps.'
                : 'Runs Kiln on 127.0.0.1 only while Ember’s SSH tunnel is open; closing Ember stops it.'}
            </p>
            {probe.serviceManager === 'none' ? (
              <p className="text-muted-foreground">
                No active user service manager (systemd --user or launchd) was found on {probe.target}, so Ember will
                run it for this session only.
              </p>
            ) : null}
          </div>

          {!probe.supported && !probe.existingKiln?.running ? (
            <p role="alert" className="text-destructive">
              {probe.target} runs {probe.rawOs} ({probe.rawArch}). Published Tinder binaries currently cover Linux x64
              and macOS ARM64.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-muted-foreground">
                {probe.existingKiln?.running
                  ? `Ember can connect directly to the Kiln already running on ${probe.target} over a loopback SSH tunnel without reinstalling.`
                  : `Ember will place SHA-256 verified Tinder at ${probe.existingKiln?.binaryPath ?? '~/.local/bin/tinder'}, bind Kiln to 127.0.0.1:${probe.existingKiln?.port ?? 3002}, and forward it locally over SSH.`}
              </p>
              <div className="flex flex-wrap gap-2">
                {probe.existingKiln?.running && probe.existingKiln.hasToken ? (
                  <>
                    <Button type="button" size="sm" disabled={installing} onClick={() => void runSetup('adopt')}>
                      {installing ? (
                        <>
                          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                          Connecting…
                        </>
                      ) : (
                        'Connect existing Kiln'
                      )}
                    </Button>
                    {probe.supported ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={installing}
                        onClick={() => void runSetup('update')}
                      >
                        Update & connect
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <Button type="button" size="sm" disabled={installing || !probe.supported} onClick={() => void runSetup('install')}>
                    {installing ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                        Installing & connecting…
                      </>
                    ) : (
                      'Install & connect'
                    )}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {setupStatus ? (
        <div
          role={setupStatus.ok ? 'status' : 'alert'}
          className={
            setupStatus.ok
              ? 'space-y-1.5 rounded-lg border bg-muted/30 p-3'
              : 'space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive'
          }
        >
          <p>{setupStatus.message}</p>
        </div>
      ) : null}
    </div>
  );
}
