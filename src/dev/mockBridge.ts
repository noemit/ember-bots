/**
 * Dev bridge installer: the **pi mock** is the default (Hearth semantics, `piRequest`,
 * `pi:<event>` hints — the transition target), and `?legacy` loads the OpenCode/OpenChamber
 * mock the older end-to-end suite still drives. Loaded from main.tsx only when
 * `window.ember` is absent.
 */
export {};

const legacy = new URLSearchParams(window.location.search).has('legacy');
const installed = legacy ? await import('./mockLegacy') : await import('./mockPi');
window.ember = installed.bridge;
