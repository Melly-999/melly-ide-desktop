import { SHELL_VERSION, shellURLs, validShellResponse } from './offline-shell.js';

const messages = {
  desktop: 'Packaged desktop assets. Browser offline cache is not used; file saves are separate.',
  preparing: 'Preparing offline access. File saves are separate.',
  ready: 'Available offline. File saves are separate.',
  update: 'Offline cache update available. Save your files, then close all Melly IDE tabs to use it.',
  failed: 'Offline setup failed. Reconnect and reload to retry; editor files were not changed.',
  'update-failed': 'Offline update failed. The current shell remains available offline; editor files were not changed.',
  unsupported: 'Offline access unsupported. Use HTTPS or localhost in a browser with Service Worker support.',
  mismatch: 'A different offline shell is active. Save your files and close all Melly IDE tabs before updating.'
};

export function isPackagedDesktop(env) {
  return !!env.__TAURI_INTERNALS__ && ['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'].includes(env.location?.origin);
}

export function supportsOffline(env) {
  return env.isSecureContext === true && typeof env.navigator?.serviceWorker?.register === 'function';
}

export function queryShell(worker, env = globalThis, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const channel = new env.MessageChannel();
    const finish = (error, value) => {
      env.clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      if (error) reject(error); else resolve(value);
    };
    const timer = env.setTimeout(() => finish(new Error('Offline cache confirmation timed out')), timeoutMs);
    channel.port1.onmessage = event => {
      if (event.data?.type === 'MELLY_SHELL_STATUS') finish(null, event.data);
    };
    try { worker.postMessage({ type: 'MELLY_SHELL_STATUS' }, [channel.port2]); }
    catch (error) { finish(error); }
  });
}

export class OfflineShellStatus {
  constructor(element, options = {}) {
    this.element = element;
    this.env = options.env || globalThis;
    this.baseURL = options.baseURL || new URL('../', import.meta.url).href;
    this.probe = options.probe || (worker => queryShell(worker, this.env));
    this.registration = null;
    this.sequence = 0;
    this.failedUpdate = false;
    this.timer = null;
    this.diagnostics = [];
    this.diagnosing = false;
  }

  show(state, ready = false, diagnostic = '') {
    if (!this.element) return;
    this.element.dataset.state = state;
    this.element.dataset.ready = String(ready);
    this.element.textContent = `Application shell: ${messages[state]}`;
    this.element.title = diagnostic || 'Application-shell cache only. Editor files use separate browser-local storage.';
  }

  async start() {
    // WebView2 virtual-host resources cannot be loaded by the module service worker.
    // Native assets are bundled; do not advertise an acknowledged browser cache.
    if (isPackagedDesktop(this.env)) { this.show('desktop', false); return; }
    if (!supportsOffline(this.env)) { this.show('unsupported'); return; }
    this.show('preparing');
    this.timer = this.env.setTimeout(() => {
      if (!this.registration?.active) this.show('failed', false, 'Offline installation did not activate within 15 seconds.');
    }, 15000);
    try {
      this.registration = await this.env.navigator.serviceWorker.register(new URL('sw.js', this.baseURL).href, {
        scope: this.baseURL, type: 'module', updateViaCache: 'none'
      });
      this.registration.addEventListener('updatefound', () => {
        this.failedUpdate = false;
        this.watch(this.registration.installing);
        void this.refresh();
      });
      this.watch(this.registration.installing);
      this.env.navigator.serviceWorker.addEventListener('controllerchange', () => { void this.refresh(); });
      for (const event of ['online', 'offline', 'focus']) this.env.addEventListener(event, () => { void this.refresh(); });
      await this.refresh();
    } catch (error) {
      this.env.clearTimeout(this.timer);
      this.show('failed', false, error.message);
      void this.diagnose();
    }
  }

  async diagnose() {
    if (this.diagnosing || typeof this.env.fetch !== 'function') return;
    this.diagnosing = true;
    try {
      // Read-only probes are exact allowlisted shell paths. Never probe credentials or user files.
      this.diagnostics = await diagnoseShell(this.baseURL, this.env.fetch.bind(this.env));
      const failures = this.diagnostics.filter(item => !item.valid);
      if (failures.length) this.element.title = failures.map(item => item.asset + ': ' + item.status + ' ' + item.type).join('\n');
    } finally { this.diagnosing = false; }
  }

  watch(worker) {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'redundant') { this.failedUpdate = true; void this.diagnose(); }
      void this.refresh();
    });
  }

  async refresh() {
    const sequence = ++this.sequence;
    const worker = this.env.navigator.serviceWorker.controller || this.registration?.active;
    if (!worker || worker.state !== 'activated') {
      this.show(this.failedUpdate ? 'failed' : 'preparing');
      return;
    }
    try {
      const status = await this.probe(worker);
      if (sequence !== this.sequence) return;
      this.env.clearTimeout(this.timer);
      if (!status.ready) { this.show('failed', false, 'Required cached shell resources are missing or invalid.'); return; }
      if (status.version !== SHELL_VERSION) { this.show('mismatch'); return; }
      const state = this.failedUpdate ? 'update-failed' : this.registration?.waiting ? 'update' : 'ready';
      this.show(state, true);
    } catch (error) {
      if (sequence === this.sequence) this.show('failed', false, error.message);
    }
  }
}

// Separate transport/resource failures from a device-specific installation failure.
export async function diagnoseShell(base, fetcher) {
  const results = [];
  for (const url of shellURLs(base)) {
    const asset = new URL(url).pathname.slice(new URL(base).pathname.length);
    try {
      const response = await fetcher(url, {method:'HEAD',cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(5000)});
      results.push({asset,status:response.status,type:response.headers.get('content-type') || '',valid:validShellResponse(response,url)});
    } catch { results.push({asset,status:'Network error',type:'unavailable',valid:false}); }
  }
  return results;
}
