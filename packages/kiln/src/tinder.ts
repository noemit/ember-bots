#!/usr/bin/env bun
/** Compiled Tinder carries the same backend as Ember's bundled Kiln. */
import { parseArgs, runCli } from '../../../cli/ember';

const main = async (): Promise<void> => {
  if (process.argv.includes('--self-test-codemode')) {
    const { selfTestCodemode } = await import('./codemodeSelfTest');
    await selfTestCodemode();
    return;
  }
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'serve') {
    if (flags.harnessDir) throw new Error('Tinder includes Kiln. Omit --harness-dir to start it, or use the source CLI for a custom checkout.');
    process.env.HEARTH_AUTORELOAD = '0';
    process.env.HEARTH_HOME = flags.home;
    process.env.EMBER_HOME = flags.home;
    process.env.HEARTH_PORT = String(flags.port);
    process.env.HEARTH_WORKSPACE = flags.workspace;
    const { runKiln } = await import('./index');
    await runKiln();
    return;
  }
  const result = await runCli();
  if (result.output) (result.exitCode === 0 ? console.log : console.error)(result.output);
  process.exitCode = result.exitCode;
};
void main().catch((error: unknown) => {
  console.error('Tinder could not start Kiln:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
