import test from 'node:test';
import assert from 'node:assert/strict';
import { readStorageState, requestPersistence, describeStorage, formatBytes } from '../js/storage/durability.js';

const fake = (overrides = {}) => {
  const calls = [];
  const storage = {
    persisted: async () => { calls.push('persisted'); return false; },
    persist: async () => { calls.push('persist'); return true; },
    estimate: async () => { calls.push('estimate'); return { usage: 1536, quota: 2 * 1024 ** 3 }; },
    ...overrides
  };
  return { storage, calls };
};

test('storage state: missing navigator.storage is reported as unsupported, not as a failure', async () => {
  for (const storage of [undefined, null, {}]) {
    const state = await readStorageState(storage);
    assert.deepEqual(state, { persistSupported: false, persistedSupported: false, estimateSupported: false, persisted: null, usage: null, quota: null, errors: [] });
    const text = describeStorage(state);
    assert.match(text.persistence, /unavailable/); assert.match(text.usage, /unavailable/); assert.equal(text.canRequest, false);
    assert.deepEqual(await requestPersistence(storage).then(r => r.outcome), 'unsupported');
  }
});

test('storage state: rejected persisted() and estimate() never throw and are labelled as failures', async () => {
  const { storage } = fake({ persisted: async () => { throw new Error('denied'); }, estimate: async () => { throw new DOMException('x', 'SecurityError'); } });
  const state = await readStorageState(storage);
  assert.equal(state.persisted, null); assert.equal(state.usage, null); assert.deepEqual(state.errors, ['persisted', 'estimate']);
  const text = describeStorage(state);
  assert.match(text.persistence, /could not be read/); assert.match(text.usage, /failed/); assert.equal(text.canRequest, true);
});

test('storage state: invalid estimate values are ignored instead of shown', async () => {
  for (const estimate of [{ usage: NaN, quota: Infinity }, { usage: -1, quota: 0 }, {}, null]) {
    const state = await readStorageState(fake({ estimate: async () => estimate }).storage);
    assert.equal(state.usage, null); assert.equal(state.quota, null); assert.deepEqual(state.errors, []);
  }
  const usageOnly = await readStorageState(fake({ estimate: async () => ({ usage: 2048 }) }).storage);
  assert.match(describeStorage(usageOnly).usage, /2\.0 KB \(quota not reported\)/);
});

test('persistence request: an existing grant is reported without asking again', async () => {
  const { storage, calls } = fake({ persisted: async () => true });
  const result = await requestPersistence(storage);
  assert.equal(result.outcome, 'granted'); assert.equal(calls.includes('persist'), false);
  assert.equal(describeStorage(result.state).canRequest, false);
});

test('persistence request: granted, denied and rejected outcomes are distinct and honest', async () => {
  let granted = false;
  const grant = fake({ persisted: async () => granted, persist: async () => { granted = true; return true; } });
  const g = await requestPersistence(grant.storage);
  assert.equal(g.outcome, 'granted'); assert.equal(g.state.persisted, true); assert.match(describeStorage(g.state, g.outcome).persistence, /granted/);

  const d = await requestPersistence(fake({ persist: async () => false }).storage);
  assert.equal(d.outcome, 'denied'); assert.equal(d.state.persisted, false);
  assert.match(describeStorage(d.state, d.outcome).outcome, /did not grant.*Save keep working/);

  const e = await requestPersistence(fake({ persist: async () => { throw new Error('blocked'); } }).storage);
  assert.equal(e.outcome, 'error'); assert.match(describeStorage(e.state, e.outcome).outcome, /failed.*export backups/);

  // persist() without persisted(): trust only an explicit true.
  const noRead = await requestPersistence({ persist: async () => true });
  assert.equal(noRead.outcome, 'granted'); assert.equal(noRead.state.persisted, true);
});

test('storage text never promises retention and always explains Save versus exported backup', () => {
  for (const persisted of [true, false, null]) {
    const text = describeStorage({ persistSupported: true, persistedSupported: true, estimateSupported: true, persisted, usage: 10, quota: 100, errors: [] });
    const all = [text.persistence, ...text.risks].join(' ');
    assert.doesNotMatch(all, /guaranteed|never lost|always kept/i);
    assert.match(all, /No platform guarantees retention/);
    assert.match(all, /Export saved projects v3/);
    assert.match(all, /Safari and the Home Screen app keep separate data/);
  }
});

test('formatBytes uses binary units and rejects invalid input', () => {
  assert.equal(formatBytes(0), '0 B'); assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1536), '1.5 KB'); assert.equal(formatBytes(2 * 1024 ** 3), '2.0 GB');
  assert.equal(formatBytes(300 * 1024 ** 2), '300 MB');
  assert.equal(formatBytes(-1), 'unknown'); assert.equal(formatBytes(NaN), 'unknown');
});
