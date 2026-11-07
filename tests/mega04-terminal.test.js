import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalRuntime, NativeTerminalBackend, UNAVAILABLE_BROWSER } from '../js/devcenter/terminal.js';

// Mock backend for lifecycle tests only. It is labelled SIMULATED and never runs a process.
function mockBackend(capability) {
  const calls = {capability: 0, start: [], stop: 0};
  return {calls, kind: 'mock', async capability() { calls.capability++; return capability; },
    async start(request, write) { calls.start.push(request); write('stdout', 'SIMULATED output — no process'); return {id: 'sim-1'}; },
    async stop() { calls.stop++; return {stopped: true}; }};
}
const disabled = {available: false, execution: 'disabled', approvalRequired: true, reason: 'Native terminal execution is not authorized in this build.'};

test('browser: no native bridge means unavailable and nothing can start', async () => {
  const runtime = new TerminalRuntime({backend: new NativeTerminalBackend(undefined)});
  assert.equal(await runtime.refresh(), 'unavailable');
  assert.equal(runtime.capability.reason, UNAVAILABLE_BROWSER);
  const result = await runtime.start({cwdLabel: 'x', approved: true});
  assert.equal(result.started, false);
  assert.match(runtime.lines.at(-1).text, /No process was started/);
});

test('native gate disabled: backend start is never called, even with approval', async () => {
  const backend = mockBackend(disabled);
  const runtime = new TerminalRuntime({backend});
  assert.equal(await runtime.refresh(), 'disabled');
  for (const approved of [true, false, undefined]) assert.equal((await runtime.start({cwdLabel: 'repo', approved})).started, false);
  assert.equal(backend.calls.start.length, 0);
  assert.equal(runtime.state, 'disabled');
  assert.ok(runtime.lines.every(l => l.source === 'system'));
});

test('native backend maps commands to the gated Tauri API', async () => {
  const seen = [];
  const backend = new NativeTerminalBackend(async (cmd, args) => { seen.push([cmd, args]); if (cmd === 'terminal_capability') return disabled; throw 'Native terminal execution is not authorized in this build.'; });
  assert.deepEqual(await backend.capability(), disabled);
  await assert.rejects(backend.start({cwdLabel: 'x', approvedByUser: true}));
  assert.deepEqual(seen.map(s => s[0]), ['terminal_capability', 'terminal_start']);
  assert.deepEqual(seen[1][1], {request: {cwdLabel: 'x', approvedByUser: true}});
});

test('explicit approval is required per start; lifecycle with a SIMULATED mock', async () => {
  const backend = mockBackend({available: true, execution: 'authorized', approvalRequired: true, reason: ''});
  const runtime = new TerminalRuntime({backend});
  assert.equal(await runtime.refresh(), 'ready');
  assert.equal((await runtime.start({cwdLabel: 'repo', approved: false})).started, false);
  assert.equal(backend.calls.start.length, 0);
  assert.equal((await runtime.start({cwdLabel: 'repo', approved: true})).started, true);
  assert.equal(runtime.state, 'running');
  assert.deepEqual(backend.calls.start, [{cwdLabel: 'repo', approvedByUser: true}]);
  assert.ok(runtime.lines.some(l => l.source === 'stdout' && l.text.startsWith('SIMULATED')));
  assert.equal((await runtime.stop()).stopped, true);
  assert.equal(runtime.state, 'stopped');
  await runtime.start({cwdLabel: 'repo', approved: true});
  await runtime.dispose();
  assert.equal(runtime.state, 'stopped'); assert.equal(backend.calls.stop, 2);
});

test('start failure is reported as an error, not as running', async () => {
  const backend = mockBackend({available: true, execution: 'authorized'});
  backend.start = async () => { throw new Error('spawn refused'); };
  const runtime = new TerminalRuntime({backend});
  await runtime.refresh();
  const result = await runtime.start({cwdLabel: 'repo', approved: true});
  assert.equal(result.started, false); assert.equal(runtime.state, 'error'); assert.match(runtime.error, /spawn refused/);
});
