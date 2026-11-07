// Progressive navigator.storage support. Every call is optional and guarded:
// unsupported or rejected APIs are reported honestly and never block editing or Save.

export async function readStorageState(storage = globalThis.navigator?.storage) {
  const state = {
    persistSupported: typeof storage?.persist === 'function',
    persistedSupported: typeof storage?.persisted === 'function',
    estimateSupported: typeof storage?.estimate === 'function',
    persisted: null, usage: null, quota: null, errors: []
  };
  if (state.persistedSupported) {
    try { state.persisted = (await storage.persisted()) === true; } catch { state.errors.push('persisted'); }
  }
  if (state.estimateSupported) {
    try {
      const estimate = await storage.estimate();
      if (Number.isFinite(estimate?.usage) && estimate.usage >= 0) state.usage = estimate.usage;
      if (Number.isFinite(estimate?.quota) && estimate.quota > 0) state.quota = estimate.quota;
    } catch { state.errors.push('estimate'); }
  }
  return state;
}

// Asks once per call. An existing grant is reported without asking again.
export async function requestPersistence(storage = globalThis.navigator?.storage) {
  const before = await readStorageState(storage);
  if (before.persisted === true) return { outcome: 'granted', state: before };
  if (!before.persistSupported) return { outcome: 'unsupported', state: before };
  let outcome;
  try { outcome = (await storage.persist()) === true ? 'granted' : 'denied'; } catch { outcome = 'error'; }
  const state = await readStorageState(storage);
  if (outcome === 'granted' && state.persisted === null) state.persisted = true;
  return { outcome, state };
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const OUTCOME_TEXT = {
  granted: 'The browser granted persistent storage for this site.',
  denied: 'The browser did not grant persistent storage. Editing and Save keep working; export backups regularly.',
  unsupported: 'This browser cannot request persistent storage. Editing and Save keep working; export backups regularly.',
  error: 'The persistent storage request failed. Editing and Save keep working; export backups regularly.'
};

export function describeStorage(state, outcome = null) {
  let persistence;
  if (state.persisted === true) persistence = 'Persistent storage: granted. The browser should not clear this data automatically to free space.';
  else if (state.persisted === false) persistence = 'Persistent storage: not granted. The browser may clear local data under storage pressure or after a long period without use.';
  else if (state.errors.includes('persisted')) persistence = 'Persistent storage: status could not be read.';
  else persistence = 'Persistent storage: status unavailable in this browser.';
  let usage;
  if (state.usage !== null && state.quota !== null) usage = `Approximate usage: ${formatBytes(state.usage)} of ${formatBytes(state.quota)} available to this site (browser estimate, includes the offline app cache).`;
  else if (state.usage !== null) usage = `Approximate usage: ${formatBytes(state.usage)} (quota not reported).`;
  else if (state.errors.includes('estimate')) usage = 'Usage estimate failed.';
  else usage = 'Usage estimate unavailable in this browser.';
  return {
    persistence, usage,
    outcome: outcome ? OUTCOME_TEXT[outcome] : '',
    canRequest: state.persistSupported && state.persisted !== true,
    risks: [
      'Save keeps files only in this browser or app on this device. Export saved projects v3 creates a file you control and is the recovery copy.',
      'Even with persistent storage, data is lost if site data is cleared, the Home Screen app or desktop app data is removed, or the device is reset. No platform guarantees retention.',
      'Safari and the Home Screen app keep separate data, and so do a Windows browser and the desktop app.'
    ]
  };
}

export class StorageStatusPanel {
  constructor(container, storage = globalThis.navigator?.storage) { this.container = container; this.storage = storage; this.outcome = null; }
  render() {
    this.container.innerHTML = `
      <h3>Storage on this device</h3>
      <p id="storagePersistence" role="status" aria-live="polite">Checking storage…</p>
      <p id="storageUsage"></p>
      <button id="storageRequest" type="button">Request persistent storage</button>
      <p id="storageOutcome"></p>
      <ul id="storageRisks"></ul>`;
    this.container.querySelector('#storageRequest').onclick = () => { void this.request(); };
  }
  show(state) {
    const text = describeStorage(state, this.outcome), q = s => this.container.querySelector(s);
    q('#storagePersistence').textContent = text.persistence;
    q('#storageUsage').textContent = text.usage;
    q('#storageOutcome').textContent = text.outcome;
    q('#storageRequest').disabled = !text.canRequest;
    q('#storageRisks').replaceChildren(...text.risks.map(risk => Object.assign(document.createElement('li'), { textContent: risk })));
    this.container.dataset.persisted = String(state.persisted);
  }
  async refresh() {
    if (!this.container.querySelector('#storagePersistence')) this.render();
    this.show(await readStorageState(this.storage));
  }
  async request() {
    const button = this.container.querySelector('#storageRequest');
    button.disabled = true;
    const { outcome, state } = await requestPersistence(this.storage);
    this.outcome = outcome;
    this.show(state);
  }
}
