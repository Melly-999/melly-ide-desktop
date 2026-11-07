import {
  SHELL_VERSION, shellURLs, shellCacheName, isOwnedShellCache,
  inspectShell, shellRequestKey
} from './js/offline-shell.js';

// Must equal SHELL_VERSION (enforced by tests/shell-release.test.js). Keeping the release in this
// file changes the worker's own bytes on every shell release, so a browser that only compares the
// top-level script, not its module imports, still detects the update.
export const SW_RELEASE = 'v27-20261107';

export async function installShell(storage, scope) {
  // An existing complete version is immutable, including on a same-version retry.
  if ((await inspectShell(storage, scope)).ready) return;
  const name = shellCacheName(scope);
  try {
    const cache = await storage.open(name);
    // addAll commits the batch together. No cookies or HTTP-cache reuse are needed.
    await cache.addAll(shellURLs(scope).map(url => new Request(url, {
      cache: 'reload', credentials: 'omit', redirect: 'error'
    })));
    if (!(await inspectShell(storage, scope)).ready) throw new Error('Incomplete or invalid application shell');
  } catch (error) {
    await storage.delete(name);
    throw error;
  }
}

export async function activateShell(storage, scope) {
  if (!(await inspectShell(storage, scope)).ready) throw new Error('Application shell is incomplete');
  const current = shellCacheName(scope);
  for (const name of await storage.keys()) {
    if (name !== current && isOwnedShellCache(name, scope)) await storage.delete(name);
  }
}

export async function serveShell(request, storage, scope) {
  const key = shellRequestKey(request, scope);
  if (!key) return null;
  const cache = await storage.open(shellCacheName(scope));
  const response = await cache.match(key);
  // Never combine cached HTML with a different generation of network modules.
  return response || new Response(
    'Melly IDE offline shell is incomplete. Reconnect and check the application installation. Browser-local files were not deleted.',
    { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
  );
}

if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
  const scope = self.registration.scope;
  self.addEventListener('install', event => event.waitUntil(installShell(caches, scope)));
  self.addEventListener('activate', event => event.waitUntil(activateShell(caches, scope)));
  // No skipWaiting, client claim, reload messages or editor/storage access.
  // A waiting update activates only after all old controlled tabs have closed.
  self.addEventListener('fetch', event => {
    if (shellRequestKey(event.request, scope)) event.respondWith(serveShell(event.request, caches, scope));
  });
  self.addEventListener('message', event => {
    if (event.data?.type !== 'MELLY_SHELL_STATUS' || !event.ports[0]) return;
    event.waitUntil((async () => {
      try {
        event.ports[0].postMessage({ type: 'MELLY_SHELL_STATUS', ...await inspectShell(caches, scope) });
      } catch {
        event.ports[0].postMessage({ type: 'MELLY_SHELL_STATUS', ready: false, version: SHELL_VERSION });
      }
    })());
  });
}
