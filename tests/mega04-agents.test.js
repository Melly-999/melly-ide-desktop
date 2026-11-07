import test from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue, EXECUTORS, STORAGE_KEY, JOB_STATES } from '../js/devcenter/agents.js';

const memory = () => { const data = new Map(); return {getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), data}; };
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 25, 18, 0, tick++)).toISOString();
// Test-only executor. The shipped EXECUTORS list has none that can run.
function testExecutor(behaviour) {
  return {id: 'test-exec', name: 'Test executor (test only)', available: true, reason: '', run: behaviour};
}
const queueWith = (executors, storage = memory()) => { let n = 0; return new JobQueue({storage, executors, now: clock, id: () => `job-${++n}`}); };

test('shipped executors are descriptors only and cannot run anything', async () => {
  assert.ok(EXECUTORS.length >= 3);
  for (const e of EXECUTORS) { assert.equal(e.available, false); assert.equal(typeof e.run, 'undefined'); }
  const q = queueWith(EXECUTORS);
  const job = q.create({title: 'Refactor parser', instructions: 'synthetic', agentId: 'claude-code'});
  assert.equal(job.state, 'pending');
  assert.equal(job.events[0].type, 'created');
  assert.match(job.events[0].detail, /Not executed/);
  q.authorize(job.id, 'approved');
  assert.equal(q.canRun(job.id).ok, false);
  await assert.rejects(q.run(job.id), /Not connected/);
  const after = q.snapshot()[0];
  assert.equal(after.state, 'pending');
  assert.equal(after.stdout, ''); assert.equal(after.stderr, ''); assert.equal(after.result, null);
  assert.equal(after.tests.state, 'not-run'); assert.equal(after.review.state, 'not-reviewed');
  assert.throws(() => q.review(job.id, 'approved'), /Only completed/);
});

test('state machine: valid transitions only, authorization separate from execution', async () => {
  assert.deepEqual(JOB_STATES, ['pending', 'running', 'completed', 'failed', 'cancelled']);
  const q = queueWith([testExecutor(async (_job, {write}) => { write('stdout', 'real line\n'); write('stderr', 'warn\n'); return {exitCode: 0, tests: {state: 'passed', summary: '3/3'}}; })]);
  const job = q.create({title: 'Run', agentId: 'test-exec'});
  assert.equal(q.canRun(job.id).reason, 'Human execution authorization is required first.');
  await assert.rejects(q.run(job.id), /authorization/);
  q.authorize(job.id, 'approved', 'owner');
  const done = await q.run(job.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.stdout, 'real line\n'); assert.equal(done.stderr, 'warn\n');
  assert.deepEqual(done.result, {exitCode: 0}); assert.equal(done.tests.state, 'passed');
  assert.deepEqual(done.events.map(e => e.type), ['created', 'authorization', 'started', 'completed']);
  assert.ok(done.events.every(e => /^2026-10-25T18:00:\d\d\.000Z$/.test(e.at)));
  assert.throws(() => q.cancel(job.id), /cannot be cancelled/);
  assert.equal(q.review(job.id, 'approved').review.state, 'approved');
  const failing = queueWith([testExecutor(async () => ({exitCode: 2}))]);
  const f = failing.create({title: 'Fail', agentId: 'test-exec'}); failing.authorize(f.id, 'approved');
  assert.equal((await failing.run(f.id)).state, 'failed');
  const noCode = queueWith([testExecutor(async () => ({}))]);
  const n = noCode.create({title: 'No code', agentId: 'test-exec'}); noCode.authorize(n.id, 'approved');
  assert.match((await noCode.run(n.id)).events.at(-1).detail, /no exit code/);
  const thrown = queueWith([testExecutor(async () => { throw new Error('crashed'); })]);
  const t = thrown.create({title: 'Throw', agentId: 'test-exec'}); thrown.authorize(t.id, 'approved');
  const failed = await thrown.run(t.id);
  assert.equal(failed.state, 'failed'); assert.equal(failed.stdout, '');
  const denied = queueWith([testExecutor(async () => ({exitCode: 0}))]);
  const d = denied.create({title: 'Deny', agentId: 'test-exec'});
  assert.equal(denied.authorize(d.id, 'denied').state, 'cancelled');
  await assert.rejects(denied.run(d.id), /cancelled/);
});

test('cancellation: pending immediately, running only after the executor acknowledges', async () => {
  let release;
  const q = queueWith([testExecutor((_job, {signal}) => new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => setTimeout(() => reject(Object.assign(new Error('aborted'), {name: 'AbortError'})), 5)); }))]);
  const a = q.create({title: 'Pending', agentId: 'test-exec'});
  assert.equal(q.cancel(a.id).state, 'cancelled');
  const b = q.create({title: 'Running', agentId: 'test-exec'}); q.authorize(b.id, 'approved');
  const running = q.run(b.id);
  assert.equal(q.snapshot().find(j => j.id === b.id).state, 'running');
  const requested = q.cancel(b.id);
  assert.equal(requested.state, 'running'); assert.equal(requested.cancelRequested, true);
  assert.equal(requested.events.at(-1).type, 'cancel-requested');
  assert.throws(() => q.remove(b.id), /Cancel a running job/);
  const finished = await running;
  assert.equal(finished.state, 'cancelled'); assert.equal(finished.result, null);
  assert.ok(release);
});

test('persistence of metadata and recovery from an interrupted session', async () => {
  const storage = memory();
  const q = queueWith([testExecutor(() => new Promise(() => {}))], storage);
  const pending = q.create({title: 'Keep me', instructions: 'notes', agentId: 'test-exec'});
  const running = q.create({title: 'Interrupted', agentId: 'test-exec'}); q.authorize(running.id, 'approved');
  void q.run(running.id);
  const stored = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(stored.version, 1);
  assert.deepEqual(stored.jobs.map(j => [j.title, j.state]), [['Keep me', 'pending'], ['Interrupted', 'running']]);
  const restarted = queueWith([testExecutor(async () => ({exitCode: 0}))], storage);
  assert.deepEqual(restarted.load(), {jobs: 2, recovered: 1});
  const [p, r] = restarted.snapshot();
  assert.equal(p.state, 'pending'); assert.equal(p.instructions, 'notes'); assert.equal(p.id, pending.id);
  assert.equal(r.state, 'failed'); assert.equal(r.events.at(-1).type, 'interrupted');
  assert.match(r.events.at(-1).detail, /No result was recorded/); assert.equal(r.result, null);
  storage.setItem(STORAGE_KEY, '{not json');
  assert.deepEqual(queueWith(EXECUTORS, storage).load(), {jobs: 0, recovered: 0});
  const broken = {getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }};
  const qb = queueWith(EXECUTORS, broken);
  qb.create({title: 'Unsaved', agentId: 'local-metadata'});
  assert.match(qb.persistError, /Quota/);
});

test('validation limits', () => {
  const q = queueWith(EXECUTORS);
  assert.throws(() => q.create({title: '   ', agentId: 'local-metadata'}), /title/);
  assert.throws(() => q.create({title: 'x'.repeat(121), agentId: 'local-metadata'}), /120/);
  assert.throws(() => q.create({title: 'ok', instructions: 'x'.repeat(8001), agentId: 'local-metadata'}), /8000/);
  assert.throws(() => q.create({title: 'ok', agentId: 'made-up'}), /listed agent/);
  assert.throws(() => q.authorize('nope', 'approved'), /not found/);
});
