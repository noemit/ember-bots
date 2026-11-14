/** Only public build assets live here; clear every shell version on logout and confirmed expiry. */
export async function clearRemoteShell() {
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
    for (const registration of registrations) {
      for (const worker of [registration.active, registration.waiting, registration.installing]) {
        worker?.postMessage('CLEAR_SHELL');
      }
    }
  }
  if ('caches' in window) {
    for (const key of await caches.keys()) {
      if (key.startsWith('ember-shell-')) await caches.delete(key);
    }
  }
}
