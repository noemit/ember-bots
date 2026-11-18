import type { Instance, PiEndpoint } from '../types';
import { portableConnection } from './instanceAlignment';

export const SINGLE_KILN_SHARING_GUIDANCE =
  'Add another Kiln in Settings → Computers and Containers, then return here to share provider credentials between them.';

/** Metadata only: never add credential material to these review types. */
export type ConfigIdentity = { id: string; name: string; baseUrl: string; modelIds: string[] };
export type ProviderSelection = { providerId: string; type: 'api_key' | 'oauth'; experimental?: true; configIdentity?: ConfigIdentity; destinationConfigIdentity?: ConfigIdentity };
export type SharingProvider = {
  providerId: string;
  type: 'api_key' | 'oauth';
  shareable: boolean;
  hasCredential: boolean;
  source: 'stored' | 'environment' | 'missing';
  experimental?: boolean;
  configIdentity?: ConfigIdentity;
};
export type SharingHost = { endpoint: PiEndpoint; state: 'ready' | 'unsupported' | 'unavailable'; providers: SharingProvider[] };
export type ShareTarget = PiEndpoint & { providers: ProviderSelection[] };

/** Pick metadata fields explicitly; never retain arbitrary response fields or host diagnostics. */
export function parseSharingProviders(value: unknown): SharingProvider[] | null {
  if (!value || typeof value !== 'object' || !('providers' in value) || !Array.isArray(value.providers) || value.providers.length > 500) return null;
  const providers: SharingProvider[] = [];
  for (const item of value.providers) {
    if (!item || typeof item !== 'object' || typeof item.providerId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,119}$/.test(item.providerId) || !['api_key', 'oauth'].includes(item.type) || typeof item.shareable !== 'boolean' || typeof item.hasCredential !== 'boolean' || !['stored', 'environment', 'missing'].includes(item.source)) return null;
    let configIdentity: ConfigIdentity | undefined;
    if (item.configIdentity !== undefined) {
      const config = item.configIdentity;
      if (!config || typeof config !== 'object' || !['id', 'name', 'baseUrl'].every(key => typeof config[key] === 'string') || !Array.isArray(config.modelIds) || !config.modelIds.every((id: unknown) => typeof id === 'string')) return null;
      configIdentity = { id: config.id, name: config.name, baseUrl: config.baseUrl, modelIds: [...config.modelIds] };
    }
    if ((item.source === 'missing') === item.hasCredential || (item.source === 'environment' && item.shareable)) return null;
    if (providers.some(provider => provider.providerId === item.providerId)) return null;
    providers.push({ providerId: item.providerId, type: item.type, shareable: item.shareable,
      hasCredential: item.hasCredential,
      source: item.source,
      ...(item.experimental === true ? { experimental: true } : {}),
      ...(configIdentity ? { configIdentity } : {}),
    });
  }
  return providers;
}

export function sameConfig(a?: ConfigIdentity, b?: ConfigIdentity): boolean {
  if (!a || !b) return !a && !b;
  return a.id === b.id && a.name === b.name && a.baseUrl === b.baseUrl &&
    a.modelIds.length === b.modelIds.length && a.modelIds.every((id, index) => id === b.modelIds[index]);
}

/** Local IDs differ across hosts; the reviewed definition itself must match exactly. */
export function sameDefinition(a: ConfigIdentity, b: ConfigIdentity): boolean {
  return a.name === b.name && a.baseUrl === b.baseUrl && a.modelIds.length === b.modelIds.length && a.modelIds.every((id, index) => id === b.modelIds[index]);
}

export function destinationProviders(provider: SharingProvider, destination: SharingHost): SharingProvider[] {
  if (provider.configIdentity) return destination.providers.filter(row => row.configIdentity && sameDefinition(provider.configIdentity!, row.configIdentity));
  return destination.providers.filter(row => row.providerId === provider.providerId);
}

/** API keys are generic; only these two sign-ins may be explicitly opted in. */
export const experimentalSignIn = (provider: SharingProvider): boolean =>
  provider.type === 'oauth' && provider.experimental === true && ['openai-codex', 'antigravity'].includes(provider.providerId);

export function sharingBlock(provider: SharingProvider, destination: SharingHost, experimental: boolean): string | null {
  if (destination.state === 'unsupported') return `${destination.endpoint.label} needs a newer Kiln. Update it, then compare again.`;
  if (destination.state !== 'ready') return `${destination.endpoint.label} did not answer. Check its connection, then compare again.`;
  if (!portableConnection(destination.endpoint)) return 'This destination needs a private-network or HTTPS address and a saved connection token. Edit it in Computers and Containers, then compare again.';
  const matches = destinationProviders(provider, destination);
  if (provider.configIdentity && matches.length > 1) return `${destination.endpoint.label} has multiple matching custom provider definitions. Review those definitions until only one matches, then compare again. Sharing does not choose a local provider for you.`;
  const existing = matches[0];
  if (existing?.hasCredential) return 'Already available — the existing credential or environment key will be kept.';
  if (((provider.providerId.startsWith('custom-') || provider.providerId === 'orcarouter') && !provider.configIdentity) || (provider.configIdentity && !existing?.configIdentity)) return 'Custom provider configuration differs or is missing. Use the same provider definition on both Kilns, then compare again. Sharing does not install configuration.';
  if (!provider.hasCredential || !provider.shareable || provider.source === 'environment') return 'This credential cannot be exported. Add a key or sign in directly on the destination.';
  if (provider.type === 'oauth' && (!experimentalSignIn(provider) || !experimental)) return 'Sign in on the destination, or enable experimental sharing for a supported sign-in above.';
  return null;
}

export function selectedTargets(hosts: SharingHost[], source: string, selected: ReadonlySet<string>, experimental: boolean): ShareTarget[] {
  const providers = hosts.find(host => host.endpoint.id === source && host.state === 'ready')?.providers ?? [];
  return hosts.filter(host => host.endpoint.id !== source).flatMap(host => {
    const choices = providers.filter(provider => selected.has(selectionKey(host.endpoint.id, provider.providerId)) && !sharingBlock(provider, host, experimental));
    if (!choices.length) return [];
    return [{ ...host.endpoint, providers: choices.map(provider => ({
      providerId: provider.providerId,
      type: provider.type,
      ...(provider.type === 'oauth' ? { experimental: true as const } : {}),
      ...(provider.configIdentity ? { configIdentity: provider.configIdentity, destinationConfigIdentity: destinationProviders(provider, host)[0].configIdentity } : {}),
    })) }];
  });
}

export const selectionKey = (host: string, provider: string): string => JSON.stringify([host, provider]);

export function sharingHostMessage(host: SharingHost): string {
  if (host.state === 'unsupported') return `${host.endpoint.label} does not support reviewed provider sharing yet. Update Kiln there, then compare again.`;
  if (host.state === 'unavailable') return `${host.endpoint.label} did not answer. Check its connection in Computers and Containers, then compare again.`;
  return `${host.endpoint.label} answered. Provider metadata is ready to review.`;
}

export function sharingCandidates(endpoints: readonly PiEndpoint[], instances: readonly Instance[]): PiEndpoint[] {
  return [
    ...endpoints,
    ...instances
      .filter(instance => instance.kind === 'pi' && !endpoints.some(endpoint => endpoint.id === instance.id))
      .map(instance => ({ id: instance.id, label: instance.label, url: instance.url ?? '', token: '' })),
  ];
}

export function sharingSetupGuidance(candidates: readonly PiEndpoint[]): string | null {
  return candidates.length < 2 ? SINGLE_KILN_SHARING_GUIDANCE : null;
}

export type ShareResultRow = { id: string; ok: boolean; keys?: number };
export type ShareResponse = { ok: boolean; status?: number; data?: { results?: ShareResultRow[] } };
export type ShareWizardState = {
  hosts: SharingHost[] | null;
  step: number;
  source: string;
  destination: string;
  selected: Set<string>;
  experimental: boolean;
  notice: string;
};

export async function runProviderShare(options: {
  state: ShareWizardState;
  targets: ShareTarget[];
  send: (source: string, targets: ShareTarget[]) => Promise<ShareResponse>;
  onProviderChange?: (id: string) => void;
}): Promise<{ state: ShareWizardState; succeeded: boolean }> {
  const { state, targets, send, onProviderChange } = options;
  const sourceLabel = state.hosts?.find(host => host.endpoint.id === state.source)?.endpoint.label ?? 'The source Kiln';
  try {
    const response = await send(state.source, targets);
    if (!response.ok || !Array.isArray(response.data?.results)) {
      const notice = `${sourceLabel} could not finish sharing. Check its connection, then try again.`;
      return { state: { ...state, notice }, succeeded: false };
    }
    const results = response.data.results;
    let allSucceeded = true;
    const summaries = targets.map(target => {
      const result = results.find(row => row.id === target.id);
      if (result?.ok && typeof result.keys === 'number' && Number.isFinite(result.keys)) {
        onProviderChange?.(target.id);
        const added = Math.max(0, result.keys);
        return `${target.label}: ${added} ${added === 1 ? 'credential' : 'credentials'} added.`;
      }
      allSucceeded = false;
      return `${target.label} could not finish. Check its connection and update Kiln if needed, then try again.`;
    });
    if (allSucceeded) {
      const notice = `${summaries.join(' ')} Existing credentials and model defaults were kept. Compare again to see the current availability.`;
      return {
        state: {
          hosts: null,
          step: 0,
          source: '',
          destination: '',
          selected: new Set(),
          experimental: false,
          notice,
        },
        succeeded: true,
      };
    }
    const notice = `${summaries.join(' ')} Existing credentials and model defaults were kept.`;
    return { state: { ...state, notice }, succeeded: false };
  } catch {
    const notice = `${sourceLabel} did not answer. Check its connection, then try again.`;
    return { state: { ...state, notice }, succeeded: false };
  }
}
