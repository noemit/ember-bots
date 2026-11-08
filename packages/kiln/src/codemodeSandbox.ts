import { CodemodeSandbox, loadQuickJSWasm, type CodemodeSandboxOptions } from "@earendil-works/pi-codemode";
import wasmPath from "quickjs-wasi/quickjs.wasm" with { type: "file" };

/** Both source Bun and compiled Kiln/Tinder use the same isolated worker sandbox.
 * The file import embeds WASM; the build lists our sibling worker as a second entrypoint.
 * Do not hoist loadQuickJSWasm: disabled code mode must not compile WASM at module import.
 */
export const createCodemodeSandbox = (options: Omit<CodemodeSandboxOptions, "wasm" | "workerUrl"> = {}): CodemodeSandbox =>
  new CodemodeSandbox({
    ...options,
    wasm: loadQuickJSWasm(wasmPath),
    workerUrl: new URL("./codemode-worker.ts", import.meta.url),
  });
