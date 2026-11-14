import * as React from 'react';
import { isRemoteExpired } from '../lib/remoteLifecycle';

/** Unmount authenticated portals as well as the workspace when the remote session ends.
 * Composer drafts live in module memory, outside this boundary, until explicit navigation.
 */
export function RemoteAppBoundary({ remote, children }: { remote: boolean; children: React.ReactNode }) {
  const [expired, setExpired] = React.useState(remote && isRemoteExpired());
  React.useEffect(() => {
    if (!remote) return;
    const expire = () => setExpired(true);
    const connection = (event: Event) => {
      if ((event as CustomEvent<{ state: string }>).detail.state === 'expired') expire();
    };
    window.addEventListener('ember:session-expired', expire);
    window.addEventListener('ember:remote-connection', connection);
    // Auth may have failed before effects installed. The bridge's state is authoritative.
    if (isRemoteExpired()) expire();
    return () => {
      window.removeEventListener('ember:session-expired', expire);
      window.removeEventListener('ember:remote-connection', connection);
    };
  }, [remote]);
  return expired ? null : <div className="ember-app-root">{children}</div>;
}
