import type { UpdateSnapshot } from '../types';

/** Quiet check results belong in Settings, not in an attention chip. */
export default function UpdateCheckSummary({ snapshot }: { snapshot: UpdateSnapshot | null }) {
  if (!snapshot) return <p className="text-xs text-muted-foreground">Ember is reading the desktop update status…</p>;
  const result = snapshot.lastCheckResult === 'failed' ? 'Ember could not check GitHub. Check your connection, then choose Check now.'
    : snapshot.lastCheckResult === 'available' ? 'A newer stable Ember release is available.'
    : snapshot.lastCheckResult === 'current' ? 'Ember is up to date with the stable GitHub release.' : 'Ember has not checked GitHub yet.';
  return <div className="space-y-1 text-xs text-muted-foreground">
    <p>Installed: Ember {snapshot.currentVersion || 'version unavailable'}</p>
    <p role="status">{result}</p>
    {snapshot.lastCheckedAt ? <p>Last check: <time dateTime={new Date(snapshot.lastCheckedAt).toISOString()}>{new Date(snapshot.lastCheckedAt).toLocaleString()}</time></p> : null}
  </div>;
}
