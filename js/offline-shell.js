// Bump this version whenever any shell asset changes. Publish the asset set together.
export const SHELL_VERSION = 'v27-20261107';
export const SHELL_ASSETS = Object.freeze([
  'js/workspace/picker.js', 'js/workspace/commands.js', 'styles/mega09.css',
  'js/local-folder.js', 'styles/local-folder.css', 'js/storage/disk-recovery.js', 'js/diagnostics.js',
  'js/devcenter/ui.js', 'js/devcenter/preview.js', 'js/devcenter/git.js', 'js/devcenter/terminal.js', 'js/devcenter/broker.js', 'js/devcenter/runner.js', 'js/devcenter/jobs.js', 'js/devcenter/adapters.js', 'styles/devcenter.css',
  'js/ai/contracts.js', 'js/ai/controller.js', 'js/ai/panel.js', 'styles/ai01.css',
  'js/auth/session.js', 'js/auth/config.js', 'js/auth/public-config.js', 'js/auth/provider.js', 'js/auth/account.js', 'styles/auth.css',
  'js/dashboard.js', 'js/assistant.js', 'styles/premium.css', 'styles/ux02.css',
  'images/melly-48.png', 'images/melly-180.png',
  'index.html', 'manifest.webmanifest', 'images/melly-192.png', 'images/melly-512.png', 'styles/workspace.css',
  'js/workspace/model.js', 'js/workspace/store.js', 'js/workspace/github.js', 'js/workspace/ui.js', 'js/workspace/backup-v3.js',
  'styles/main.css', 'styles/onboarding.css', 'styles/hub.css', 'styles/editor.css',
  'js/app.js', 'js/onboarding.js', 'js/hub.js', 'js/editor.js', 'js/chat.js',
  'js/dialog.js', 'js/ui-language.js', 'js/data/samples.js', 'js/storage/file-store.js', 'js/storage/durability.js',
  'js/modules/skills.js', 'js/modules/projects.js', 'js/modules/agents.js',
  'js/modules/commands.js', 'js/modules/automations.js', 'js/modules/mcp.js',
  'js/modules/screen-awareness.js', 'js/modules/simulation.js',
  'js/backup.js', 'js/backup-ui.js',
  'js/offline.js', 'js/offline-shell.js'
]);

export function cachePrefix(scope) {
  return `melly-ide-shell:${encodeURIComponent(new URL(scope).pathname)}:`;
}

export function shellCacheName(scope, version = SHELL_VERSION) {
  return cachePrefix(scope) + version;
}

export function shellURLs(scope) {
  return SHELL_ASSETS.map(asset => new URL(asset, scope).href);
}

export function isOwnedShellCache(name, scope) {
  const prefix = cachePrefix(scope);
  return name.startsWith(prefix) && /^v\d+-\d{8}$/.test(name.slice(prefix.length));
}

// Intercept only this application's entry navigation and exact static inventory.
export function shellRequestKey(request, scope) {
  if (request.method !== 'GET' || request.headers?.has('range')) return null;
  const url = new URL(request.url);
  const base = new URL(scope);
  if (url.origin !== base.origin) return null;
  if (request.mode === 'navigate') {
    if (url.pathname === base.pathname || url.pathname === new URL('index.html', base).pathname) {
      return new URL('index.html', base).href;
    }
    return null;
  }
  return shellURLs(scope).includes(url.href) ? url.href : null;
}

export function validShellResponse(response, url) {
  if (!response?.ok || response.redirected || response.type === 'opaque') return false;
  const type = response.headers.get('content-type') || '';
  const pathname = new URL(url).pathname;
  if (pathname.endsWith('.html')) return /text\/html/i.test(type);
  if (pathname.endsWith('.webmanifest')) return /application\/(?:manifest\+json|json)/i.test(type);
  if (pathname.endsWith('.png')) return /image\/png/i.test(type);
  if (pathname.endsWith('.css')) return /text\/css/i.test(type);
  return /(?:text|application)\/(?:javascript|ecmascript)/i.test(type);
}

export async function inspectShell(storage, scope, version = SHELL_VERSION) {
  const cacheName = shellCacheName(scope, version);
  const urls = shellURLs(scope);
  if (!(await storage.keys()).includes(cacheName)) {
    return { ready: false, version, cacheName, assetCount: urls.length, missing: urls };
  }
  const cache = await storage.open(cacheName);
  const missing = [];
  for (const url of urls) {
    if (!validShellResponse(await cache.match(url), url)) missing.push(url);
  }
  return { ready: missing.length === 0, version, cacheName, assetCount: urls.length, missing };
}
