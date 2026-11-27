#!/usr/bin/env bun
/** Compiled Tinder carries the same backend as Ember's bundled Kiln. */
import "./systemCa";
import { buildServeEnv, parseArgs, runCli, type CliFlags } from '../../../cli/ember';

/** Effective environment applied by compiled `tinder serve` before booting Kiln. */
export const tinderServeEnv = (
  flags: Pick<CliFlags, 'home' | 'port' | 'workspace' | 'bind'>,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => ({
  ...buildServeEnv(flags, baseEnv),
  HEARTH_AUTORELOAD: '0',
});

const main = async (): Promise<void> => {
  if (process.argv.includes('--self-test-codemode')) {
    const { selfTestCodemode } = await import('./codemodeSelfTest');
    await selfTestCodemode();
    return;
  }
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'serve') {
    if (flags.harnessDir) throw new Error('Tinder includes Kiln. Omit --harness-dir to start it, or use the source CLI for a custom checkout.');
    Object.assign(process.env, tinderServeEnv(flags, process.env));
    const { runKiln } = await import('./index');
    await runKiln();
    return;
  }
  const result = await runCli();
  if (result.output) (result.exitCode === 0 ? console.log : console.error)(result.output);
  process.exitCode = result.exitCode;
};
if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error('Tinder could not start Kiln:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
