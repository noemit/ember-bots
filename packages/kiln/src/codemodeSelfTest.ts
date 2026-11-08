import { createCodemodeSandbox } from "./codemodeSandbox";

/** Offline packaging diagnostic. No provider, server, user files or credentials are needed. */
export const selfTestCodemode = async (): Promise<void> => {
  let callbacks = 0;
  const sandbox = createCodemodeSandbox({
    tools: [{ name: "echo", execute: async (args) => { callbacks++; return args; } }],
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const first = await sandbox.execute('const result = await tools.echo({ answer: 42 }); text(result); return result.answer;');
    if (!first.ok || first.value !== 42 || callbacks !== 1 || first.output.length !== 1) {
      throw new Error(`Kiln's sandbox callback check failed: ${JSON.stringify(first)}. Rebuild the binary with its WASM and worker entrypoint.`);
    }
    let hostTicks = 0;
    timer = setInterval(() => hostTicks++, 10);
    const runaway = await sandbox.execute('while (true) {}', { timeoutMs: 500 });
    clearInterval(timer);
    timer = undefined;
    if (runaway.ok || runaway.error.kind !== "timeout" || hostTicks < 5) {
      throw new Error(`Kiln's sandbox timeout check failed (${hostTicks} host ticks). Check worker isolation before using this binary.`);
    }
    const recovery = await sandbox.execute('return await tools.echo(43);');
    if (!recovery.ok || recovery.value !== 43 || Number(callbacks) !== 2) {
      throw new Error("Kiln's sandbox did not recover after a timeout. Rebuild and rerun this check before using this binary.");
    }
    console.log(`Codemode self-test passed: callback, worker timeout (${hostTicks} host ticks), recovery.`);
  } finally {
    if (timer !== undefined) clearInterval(timer);
    await sandbox.close();
  }
};
