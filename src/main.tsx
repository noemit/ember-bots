import * as React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DocumentPopoutView } from './components/DocumentPreviewDialog';
import { RemoteAppStatus } from './components/RemoteAppStatus';
import { RemoteAppBoundary } from './components/RemoteAppBoundary';
import { TooltipProvider } from '@/components/ui/tooltip';
import './styles.css';

const boot = async () => {
  const remote = !window.ember && !import.meta.env.DEV;
  if (!window.ember) {
    if (import.meta.env.DEV) await import('./dev/mockBridge');
    else await import('./remoteBridge');
  }
  const isDocPopout = new URLSearchParams(window.location.search).get('docPopout') === '1';
  const container = document.getElementById('root');
  if (container) {
    createRoot(container).render(
      <React.StrictMode>
        {remote && <RemoteAppStatus />}
        <RemoteAppBoundary remote={remote}>
          {isDocPopout ? (
            <TooltipProvider delayDuration={300}>
              <DocumentPopoutView />
            </TooltipProvider>
          ) : (
            <App />
          )}
        </RemoteAppBoundary>
      </React.StrictMode>
    );
  }
};

void boot();
