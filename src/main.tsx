import * as React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { RemoteAppStatus } from './components/RemoteAppStatus';
import { RemoteAppBoundary } from './components/RemoteAppBoundary';
import './styles.css';

const boot = async () => {
  const remote = !window.ember && !import.meta.env.DEV;
  if (!window.ember) {
    if (import.meta.env.DEV) await import('./dev/mockBridge');
    else await import('./remoteBridge');
  }
  const container = document.getElementById('root');
  if (container) {
    createRoot(container).render(
      <React.StrictMode>
        {remote && <RemoteAppStatus />}
        <RemoteAppBoundary remote={remote}><App /></RemoteAppBoundary>
      </React.StrictMode>
    );
  }
};

void boot();
