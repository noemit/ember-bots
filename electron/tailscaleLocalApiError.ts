export type LocalApiErrorKind = 'unsupported' | 'unavailable' | 'permission' | 'conflict' | 'invalid' | 'timeout';
/** Safe diagnostics only: never attach daemon response bodies, command output or local auth. */
export class LocalApiError extends Error {
  constructor(readonly kind: LocalApiErrorKind) { super(`Tailscale LocalAPI: ${kind}`); }
}
