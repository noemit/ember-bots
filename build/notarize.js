/**
 * Notarize the macOS build, as part of `electron-builder`'s `afterSign` hook.
 *
 * Signing and notarizing are two different things, and skipping the second is the difference between
 * "a developer can run it" and "it opens without a warning". Until now the notary step was a set of
 * commands a person had to paste from a release checklist, which meant it happened late, by hand, and
 * — the first time it was actually attempted — not at all, because the build above it had failed and
 * nothing said so in a way that stopped the release.
 *
 * So it runs here, from the same three environment variables the rest of the toolchain uses:
 *
 *   APPLE_ID          the Apple ID that owns the Developer ID certificate
 *   APPLE_PASSWORD    an app-specific password from appleid.apple.com (never the account password)
 *   APPLE_TEAM_ID     the team the certificate belongs to (CT5KSA99W8)
 *
 * With them set, `bun run dist:mac` produces a signed, notarized, **stapled** app: the ticket is
 * attached to the bundle so it validates offline, on a machine with no network, which is what a
 * stapler buys and what a bare notarization does not.
 *
 * Without them the build still succeeds, and says so plainly — a developer without credentials is
 * not in an error state, but a release quietly missing its notarization is. The exit is loud in the
 * log and the notice names what to set.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const redact = (value) => (value ? '***' : '(unset)');

/** Run a command, echoing it with the password already removed, and returning stdout. */
const run = (command, args, options = {}) => {
  const printable = [command, ...args].join(' ');
  console.log(`[notarize] $ ${printable.replace(/--password \S+/g, '--password ***')}`);
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
};

exports.default = async function notarizeApp(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin') return;

  const appId = packager?.appInfo?.productFilename ?? 'Ember';
  const appPath = path.join(appOutDir, `${appId}.app`);
  if (!fs.existsSync(appPath)) {
    console.warn(`[notarize] no app bundle at ${appPath}; skipping notarization.`);
    return;
  }

  const appleId = process.env.APPLE_ID?.trim();
  const applePassword = process.env.APPLE_PASSWORD?.trim();
  const teamId = process.env.APPLE_TEAM_ID?.trim();

  if (!appleId || !applePassword || !teamId) {
    const message =
      'notarization skipped: set APPLE_ID, APPLE_PASSWORD (an app-specific password from ' +
      'appleid.apple.com) and APPLE_TEAM_ID. The app is signed, but Gatekeeper will warn on any ' +
      'machine that has not seen it — so this is fine for a local build and wrong for a release.';
    // A release must not quietly ship an un-notarized build. A local build may.
    if (process.env.EMBER_RELEASE === '1') throw new Error(message);
    console.warn('[notarize] ' + message);
    return;
  }
  // A password with the wrong shape fails deep inside notarytool with a 401 that reads like bad
  // credentials; saying so here is the difference between a two-minute fix and an hour of guessing.
  if (!/^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/i.test(applePassword)) {
    console.warn(
      '[notarize] APPLE_PASSWORD does not look like an app-specific password (xxxx-xxxx-xxxx-xxxx). ' +
        'notarytool will very likely reject it with a 401.'
    );
  }
  console.log(`[notarize] APPLE_ID=${appleId} APPLE_PASSWORD=${redact(applePassword)} APPLE_TEAM_ID=${teamId}`);

  // The zip is what `notarytool` wants: it walks a bundle, and a bare .app directory is not a form it
  // accepts. Built outside the output tree so `electron-builder`'s own zip is not disturbed.
  const staging = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ember-notarize-'));
  const zipPath = path.join(staging, `${appId}.zip`);
  try {
    run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);

    const result = run('xcrun', [
      'notarytool',
      'submit',
      zipPath,
      '--apple-id',
      appleId,
      '--team-id',
      teamId,
      '--password',
      applePassword,
      '--wait',
      '--output-format',
      'json',
    ]);
    let outcome = null;
    try {
      outcome = JSON.parse(result);
    } catch {
      // Older notarytool prints human text even with --output-format; the exit code is the verdict.
    }
    if (outcome && outcome.status && outcome.status !== 'Accepted') {
      // A rejection is not something a build can shrug off: the artifact must not be published.
      throw new Error(
        `notarization was ${outcome.status}: ${outcome.message ?? 'see the notarytool log'} (id ${outcome.id ?? 'unknown'})`
      );
    }
    console.log(`[notarize] accepted${outcome?.id ? ` (id ${outcome.id})` : ''}`);

    // Staple the *app*, not the temporary zip: the ticket has to live inside the bundle that ships,
    // so a first launch with no network still validates.
    run('xcrun', ['stapler', 'staple', appPath]);
    run('xcrun', ['stapler', 'validate', appPath]);
    console.log('[notarize] stapled and validated the app bundle');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
};
