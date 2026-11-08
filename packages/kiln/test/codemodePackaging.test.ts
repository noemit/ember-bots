import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

// A fresh process avoids the upstream WASM cache and other tests' sandbox instances.
test("importing code mode and disabling it never compiles WASM", () => {
  const moduleUrl = new URL("../src/codemode.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--eval", `
    let compilations = 0;
    WebAssembly.compile = async () => { compilations++; throw new Error('WASM must stay lazy'); };
    const { hearthCodemodeExtensions } = await import(${JSON.stringify(moduleUrl)});
    for (const value of ['off', '0', 'false']) {
      const { extensions, close } = hearthCodemodeExtensions({ env: { HEARTH_CODEMODE: value } });
      if (extensions.length !== 1) throw new Error('Disabled code mode must retain only scratchpad');
      close();
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    if (compilations !== 0) throw new Error('Disabled code mode compiled WASM');
  `], { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
