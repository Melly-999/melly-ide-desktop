import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { BrokerClient, parseArgs, errorCode, follow, EXEC_UNAVAILABLE } from '../js/devcenter/broker.js';
import { parseAgentLine, AgentStream, redactText } from '../js/devcenter/adapters.js';
import { AgentJobEngine, JOBS_KEY, LEGACY_KEY, migrateV1, isWritable, WRITABLE_GATED } from '../js/devcenter/jobs.js';
import { CommandRunner, HISTORY_KEY } from '../js/devcenter/runner.js';

// MOCK broker client: deterministic and in-memory. It stands in for the native broker so the
// renderer logic can be tested; it is not evidence of native behaviour (see the Rust tests).
function memory(seed = {}) { const m = new Map(Object.entries(seed)); return {getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m}; }
function mockClient({available = true} = {}) {
  const calls = [], runs = new Map(); let n = 0;
  const client = {available, calls, deny: false, startErrors: [], reconcileStatus: 'gone', nativeRuns: [],
    async capability() { calls.push(['capability']); return {enabled: client.enabled ?? true, reason: client.enabled === false ? 'Disabled.' : ''}; },
    async enable() { calls.push(['enable']); client.enabled = true; return {enabled: true}; },
    async disable() { calls.push(['disable']); client.enabled = false; return {enabled: false}; },
    async request(request, surface) { calls.push(['request', structuredClone(request), surface]); if (client.deny) throw 'DENIED: You declined this run in the native dialog. Nothing was started.'; n++; return {approvalId: `approval-${n}`, token: `token-${n}`, specHash: 'ab'.repeat(32), expiresInSecs: request.kind === 'agent' ? 900 : 60, normalized: {executable: 'C:\\MOCK\\cli.exe', args: ['-p'], cwd: ''}}; },
    async start(request, approval, surface) {
      calls.push(['start', structuredClone(request), approval.approvalId, approval.token, surface]);
      if (client.startErrors.length) throw client.startErrors.shift();
      const id = `run-${++n}`; runs.set(id, {state: 'running', chunks: [], exitCode: null, treeVerified: true, changes: null});
      return {id, pid: 4000 + n, processCreated: 1234, approvalId: approval.approvalId, specHash: approval.specHash, state: 'running'};
    },
    async poll(runId, cursor) {
      const r = runs.get(runId); if (!r) throw 'NOT_FOUND: No such run in this app session.';
      return {run: {id: runId, state: r.state, exitCode: r.exitCode, elapsedMs: 42, treeVerified: r.treeVerified, changes: r.changes, error: r.error || null, leftoverTerminated: 0, pid: 1, specHash: 'ab'.repeat(32), droppedBytes: 0},
        chunks: r.chunks.filter(c => c.seq >= cursor), nextCursor: r.chunks.length, missed: false};
    },
    async cancel(runId) { calls.push(['cancel', runId]); const r = runs.get(runId); r.state = 'cancelled'; r.exitCode = 1; return {id: runId, state: 'cancelled'}; },
    async runs() { return client.nativeRuns; },
    async reconcile(records) { calls.push(['reconcile', records]); return records.map(r => ({runId: r.runId, status: client.reconcileStatus, run: client.reconcileStatus === 'managed' ? {id: r.runId, pid: r.pid, processCreated: r.processCreated} : null})); },
    async setConcurrency(max) { calls.push(['concurrency', max]); },
    emit(runId, lines, stream = 'stdout') { const r = runs.get(runId); for (const line of lines) r.chunks.push({seq: r.chunks.length, stream, text: `${line}\n`}); },
    finish(runId, props) { Object.assign(runs.get(runId), {state: 'exited', exitCode: 0}, props); },
  };
  return client;
}
const tick = () => new Promise(r => setImmediate(r));
const engines = [];
test.after(() => { for (const e of engines) e.dispose(); });
test.afterEach(() => { for (const e of engines) e.dispose(); });
async function until(fn, label = 'condition') { for (let i = 0; i < 500; i++) { if (fn()) return; await tick(); } assert.fail(`timed out waiting for ${label}`); }
const READY = {claude: {state: 'ready', profiles: [{id: 'plan'}, {id: 'edit'}]}, codex: {state: 'ready', profiles: [{id: 'read-only'}, {id: 'workspace-write'}]}};
const WS = {sessionId: 'sess-1', key: 'k'.repeat(64), name: 'synthetic-repo'};
function engine({client = mockClient(), storage = memory(), workspace = WS, providers = READY, clock} = {}) {
  let t = Date.parse('2026-10-26T08:00:00.000Z'), ids = 0;
  const e = new AgentJobEngine({client, storage, workspace: () => workspace, providers: () => providers, sleep: tick, interval: 0, now: clock || (() => new Date(t += 1000).toISOString()), id: () => `job-${++ids}`});
  engines.push(e);
  return {e, client, storage};
}
const CLAUDE_OK = [
  JSON.stringify({type: 'system', subtype: 'init', model: 'MOCK'}),
  JSON.stringify({type: 'assistant', message: {content: [{type: 'text', text: 'MOCK reading'}, {type: 'tool_use', name: 'Read', input: {}}]}}),
  JSON.stringify({type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'MOCK done', permission_denials: [{tool_name: 'Bash'}]}),
];

// ---------- broker client ----------

test('arguments are one per line with no shell parsing, quoting or expansion', () => {
  assert.deepEqual(parseArgs('test\n--grep "a b"\r\n\n$HOME && rm -rf x\n%PATH%'), ['test', '--grep "a b"', '$HOME && rm -rf x', '%PATH%']);
  assert.deepEqual(parseArgs(''), []);
  assert.equal(errorCode('SPEC_MISMATCH: changed'), 'SPEC_MISMATCH');
  assert.equal(errorCode(new Error('DENIED: no')), 'DENIED');
  assert.equal(errorCode('C:\\path: weird'), 'OTHER');
});

test('browser/PWA: the client has no execution path and never calls a bridge', async () => {
  const client = new BrokerClient(undefined);
  assert.equal(client.available, false);
  for (const call of [() => client.capability(), () => client.enable(), () => client.request({}, 'x'), () => client.start({}, {approvalId: 'a', token: 't'}, 'x'), () => client.detect()]) {
    await assert.rejects(call(), err => errorCode(err) === 'UNAVAILABLE' && err.message.includes(EXEC_UNAVAILABLE));
  }
});

test('client maps requests to the native commands with exact argument names', async () => {
  const seen = [];
  const client = new BrokerClient(async (cmd, args) => { seen.push([cmd, args]); return {}; });
  const request = {kind: 'command', sessionId: 's', program: 'npm', args: ['test']};
  await client.request(request, 'terminal');
  await client.start(request, {approvalId: 'a1', token: 't1', specHash: 'x'}, 'terminal');
  await client.poll('r1', 7); await client.cancel('r1'); await client.diffSummary('s', [{path: 'a', staged: false}]);
  assert.deepEqual(seen.map(s => s[0]), ['exec_request', 'exec_start', 'exec_poll', 'exec_cancel', 'git_diff_summary']);
  assert.deepEqual(seen[1][1], {request, approvalId: 'a1', token: 't1', surface: 'terminal'});
  assert.deepEqual(seen[2][1], {runId: 'r1', cursor: 7});
});

test('follow() polls until a final native state and drains the remaining output', async () => {
  const client = mockClient(); const run = await client.start({}, {approvalId: 'a', token: 't'}, 'x');
  const got = []; const done = follow(client, run.id, {sleep: tick, interval: 0, onChunks: c => got.push(...c.map(x => x.text))});
  client.emit(run.id, ['one']); await tick(); client.emit(run.id, ['two']); client.finish(run.id, {exitCode: 3});
  const final = await done;
  assert.equal(final.exitCode, 3); assert.deepEqual(got, ['one\n', 'two\n']);
});

test('only broker.js names native execution commands; no UI path can approve or enable silently', () => {
  const dir = new URL('../js/devcenter/', import.meta.url);
  for (const name of readdirSync(dir)) {
    const text = readFileSync(new URL(name, dir), 'utf8');
    if (name !== 'broker.js') assert.ok(!/['"](exec_(capability|enable|disable|set_concurrency|request|start|poll|cancel|runs|audit|reconcile)|agent_(detect|probe))['"]/.test(text), `${name} must call the broker client, not raw commands`);
    assert.ok(!/approvedByUser\s*:\s*true/.test(text) || name === 'terminal.js', `${name} must not fabricate approval`);
    assert.ok(!/dangerously|skip-permissions|bypassPermissions|danger-full-access/.test(text), `${name} must never produce bypass flags`);
  }
  const ui = readFileSync(new URL('ui.js', dir), 'utf8');
  assert.ok(!ui.includes('Authorize execution'), 'UI clicks never stand in for native approval');
});

// ---------- adapters ----------

test('Claude stream-json lines become observed events, never percentages', () => {
  const s = new AgentStream('claude');
  s.push(CLAUDE_OK.map((line, seq) => ({seq, stream: 'stdout', text: `${line}\n`})));
  s.push([{seq: 9, stream: 'stderr', text: '{"type":"result","subtype":"success"}\n'}]);
  const sum = s.summary();
  assert.equal(sum.toolUses, 1); assert.deepEqual(sum.toolNames, ['Read']);
  assert.deepEqual(sum.result, {ok: true, subtype: 'success', text: 'MOCK done', denials: ['Bash'], turns: 2});
  assert.equal(sum.lastMessage, 'MOCK done');
  assert.ok(!JSON.stringify(sum).includes('percent'));
  assert.equal(s.events.filter(e => e.kind === 'result').length, 1, 'stderr is never parsed as events');
});

test('Codex JSONL, malformed and non-JSON lines are tolerated and counted', () => {
  assert.deepEqual(parseAgentLine('codex', JSON.stringify({type: 'item.completed', item: {type: 'command_execution', command: 'ls', exit_code: 0}})).tools, ['command']);
  assert.equal(parseAgentLine('codex', JSON.stringify({type: 'turn.failed', error: {message: 'MOCK'}})).ok, false);
  assert.equal(parseAgentLine('claude', '{"type":').kind, 'malformed');
  assert.equal(parseAgentLine('claude', '[1,2]').kind, 'raw');
  assert.equal(parseAgentLine('claude', '{"a":[1]').kind, 'malformed');
  assert.equal(parseAgentLine('claude', 'plain text').kind, 'raw');
  assert.equal(parseAgentLine('claude', '   '), null);
  const s = new AgentStream('codex'); s.push([{seq: 0, stream: 'stdout', text: 'MOCK not json\n{"broken\n{"type":"turn.completed"}\n'}]);
  assert.deepEqual([s.summary().rawLines, s.summary().malformed, s.summary().result.ok], [1, 1, true]);
});

test('renderer redaction backs up native redaction', () => {
  assert.equal(redactText('key sk-ant-api03-ABCDEFGHIJKLMNOPQRST and ghp_ABCDEFGHIJKLMNOPQRSTUV1234'), 'key [REDACTED] and [REDACTED]');
  assert.equal(redactText('Authorization: Bearer abcdefghijklmnop12345'), 'Authorization: Bearer [REDACTED]');
  assert.equal(redactText('password=hunter2-hunter2'), 'password=[REDACTED]');
  assert.equal(redactText('tokens: 5 · commit 0123456789abcdef0123456789abcdef01234567'), 'tokens: 5 · commit 0123456789abcdef0123456789abcdef01234567');
});

// ---------- job engine ----------

test('create validates input, needs a folder and refuses duplicate submissions', () => {
  const {e} = engine();
  assert.throws(() => e.create({title: '', task: 'x', provider: 'claude', profile: 'plan'}), /title/);
  assert.throws(() => e.create({title: 't', task: ' ', provider: 'claude', profile: 'plan'}), /task/);
  assert.throws(() => e.create({title: 't', task: 'x', provider: 'gemini', profile: 'plan'}), /Claude Code or Codex/);
  assert.throws(() => e.create({title: 't', task: 'x', provider: 'claude', profile: 'bypassPermissions'}), /profile/);
  assert.throws(() => e.create({title: 't', task: 'x', provider: 'codex', profile: 'plan'}), /profile/);
  assert.throws(() => e.create({title: 't', task: 'x', provider: 'claude', profile: 'plan', model: 'a b'}), /Model/);
  const job = e.create({title: 'Fix test', task: 'MOCK task', provider: 'claude', profile: 'plan'});
  assert.equal(job.state, 'pending-approval'); assert.equal(job.attempt, 1); assert.deepEqual(job.workspace, {key: WS.key, name: WS.name});
  assert.throws(() => e.create({title: 'Fix test', task: 'MOCK task', provider: 'claude', profile: 'plan'}), err => err.code === 'duplicate');
  assert.throws(() => engine({workspace: null}).e.create({title: 't', task: 'x', provider: 'claude', profile: 'plan'}), /Local Folder/);
});

test('approval is gated on desktop, folder, checked CLI and profile; nothing runs without it', async () => {
  const browser = engine({client: mockClient({available: false})});
  const j1 = browser.e.create({title: 'a', task: 'x', provider: 'claude', profile: 'plan'});
  assert.match(browser.e.canApprove(j1.id).reason, /Not connected/);
  const unchecked = engine({providers: {claude: {state: 'installed', profiles: []}}});
  const j2 = unchecked.e.create({title: 'a', task: 'x', provider: 'claude', profile: 'plan'});
  assert.match(unchecked.e.canApprove(j2.id).reason, /not checked/);
  await assert.rejects(unchecked.e.approve(j2.id));
  assert.equal(unchecked.client.calls.filter(c => c[0] === 'request' || c[0] === 'start').length, 0);
  const other = engine(); const j3 = other.e.create({title: 'a', task: 'x', provider: 'claude', profile: 'plan'});
  other.e.workspace = () => ({...WS, key: 'other', name: 'other-folder'});
  assert.match(other.e.canApprove(j3.id).reason, /synthetic-repo/);
});

test('denied native approval keeps the job pending and starts nothing', async () => {
  const {e, client} = engine(); client.deny = true;
  const job = e.create({title: 'a', task: 'x', provider: 'claude', profile: 'plan'});
  await assert.rejects(e.approve(job.id), err => err.code === 'DENIED');
  assert.equal(e.get(job.id).state, 'pending-approval'); assert.equal(e.get(job.id).approval.state, 'denied');
  assert.equal(client.calls.filter(c => c[0] === 'start').length, 0);
});

test('approved job runs through the broker with the exact approved request and completes from real exit evidence', async () => {
  const {e, client, storage} = engine();
  const job = e.create({title: 'Plan', task: 'MOCK summarize', provider: 'claude', profile: 'plan', model: 'sonnet'});
  await e.approve(job.id);
  await until(() => e.get(job.id).state === 'running', 'running');
  const [, requested] = client.calls.find(c => c[0] === 'request'), [, started, approvalId, token] = client.calls.find(c => c[0] === 'start');
  assert.deepEqual(requested, {kind: 'agent', sessionId: 'sess-1', provider: 'claude', profile: 'plan', model: 'sonnet', task: 'MOCK summarize', cwd: '', timeoutSecs: 1800, jobId: job.id, attempt: 1});
  assert.deepEqual(started, requested, 'start presents the identical request');
  assert.equal(approvalId, 'approval-1'); assert.equal(token, 'token-1');
  assert.ok(!storage.getItem(JOBS_KEY).includes('token-1'), 'tokens are never persisted');
  const runId = e.get(job.id).runId;
  client.emit(runId, CLAUDE_OK); client.finish(runId, {exitCode: 0, changes: {added: ['a.txt'], modified: [], removed: [], total: 1, attribution: 'exclusive-melly-window', notes: []}});
  await until(() => e.get(job.id).state === 'completed', 'completed');
  const done = e.get(job.id);
  assert.equal(done.exitCode, 0); assert.equal(done.progress.result.ok, true); assert.deepEqual(done.progress.toolNames, ['Read']);
  assert.match(done.events.at(-1).detail, /does not prove that every tool action succeeded/);
  assert.equal(done.changes.total, 1); assert.equal(done.approval.state, 'consumed');
  assert.deepEqual(done.evidence.map(x => x.type), ['native-run', 'native-exit']);
  assert.ok(e.output(job.id).length >= 3);
  assert.ok(!storage.getItem(JOBS_KEY).includes('MOCK reading'), 'raw transient output is not persisted');
});

test('nonzero exit, timeout and unconfirmed process trees are never reported as success', async () => {
  for (const [props, state, category] of [[{exitCode: 2}, 'failed', 'exit-nonzero'], [{state: 'timed-out', exitCode: 1}, 'failed', 'timeout'], [{exitCode: 0, treeVerified: false, error: 'TREE_UNCONFIRMED: x'}, 'unknown', 'tree-unconfirmed']]) {
    const {e, client} = engine();
    const job = e.create({title: 'a', task: 'x', provider: 'codex', profile: 'read-only'});
    await e.approve(job.id); await until(() => e.get(job.id).state === 'running');
    client.finish(e.get(job.id).runId, props);
    await until(() => e.get(job.id).state === state, state);
    assert.equal(e.get(job.id).errorCategory, category);
    assert.equal(client.calls.filter(c => c[0] === 'start').length, 1, 'no automatic retry');
  }
});

test('queue: FIFO by approval, concurrency 1, one agent job per folder, pause/resume', async () => {
  const {e, client} = engine();
  const a = e.create({title: 'a', task: '1', provider: 'claude', profile: 'plan'});
  const b = e.create({title: 'b', task: '2', provider: 'codex', profile: 'read-only'});
  const c = e.create({title: 'c', task: '3', provider: 'claude', profile: 'plan'});
  e.pause();
  await e.approve(b.id); await e.approve(a.id); await e.approve(c.id);
  assert.deepEqual([b, a, c].map(j => e.get(j.id).state), ['queued', 'queued', 'queued'], 'paused queue starts nothing');
  assert.equal(client.calls.filter(x => x[0] === 'start').length, 0);
  e.resume();
  await until(() => e.get(b.id).state === 'running', 'b running');
  assert.equal(e.get(a.id).state, 'queued'); assert.equal(e.get(c.id).state, 'queued');
  await e.setConcurrency(2); await tick();
  assert.equal(e.get(a.id).state, 'queued', 'same folder stays exclusive even with concurrency 2');
  assert.deepEqual(client.calls.find(x => x[0] === 'concurrency'), ['concurrency', 2]);
  client.finish(e.get(b.id).runId, {exitCode: 0});
  await until(() => e.get(a.id).state === 'running', 'a running');
  client.finish(e.get(a.id).runId, {exitCode: 0});
  await until(() => e.get(c.id).state === 'running', 'c running');
  assert.deepEqual(client.calls.filter(x => x[0] === 'start').map(x => x[1].jobId), [b.id, a.id, c.id]);
});

test('MEGA-08.2: writable profiles cannot be approved until the provider reports the owner contract', async () => {
  const {e, client} = engine();
  for (const [provider, profile] of [['claude', 'edit'], ['codex', 'workspace-write']]) {
    assert.equal(isWritable(provider, profile), true);
    const job = e.create({title: `w-${profile}`, task: 'MOCK', provider, profile});
    assert.deepEqual(e.canApprove(job.id), {ok: false, reason: WRITABLE_GATED});
    await assert.rejects(e.approve(job.id), err => err.code === 'not_approvable');
    assert.equal(e.get(job.id).state, 'pending-approval');
  }
  assert.equal(isWritable('claude', 'plan') || isWritable('codex', 'read-only'), false);
  assert.equal(client.calls.filter(x => x[0] === 'request').length, 0, 'no native dialog is opened for a gated profile');
  const enabled = {claude: {...READY.claude, writableEnabled: true}, codex: READY.codex};
  const {e: open} = engine({providers: enabled});
  assert.equal(open.canApprove(open.create({title: 'w', task: 'MOCK', provider: 'claude', profile: 'edit'}).id).ok, true);
});

test('cancel: queued jobs never start; running jobs wait for the broker to confirm', async () => {
  const {e, client} = engine();
  const a = e.create({title: 'a', task: '1', provider: 'claude', profile: 'plan'});
  const b = e.create({title: 'b', task: '2', provider: 'claude', profile: 'plan'});
  await e.approve(a.id); await e.approve(b.id);
  await until(() => e.get(a.id).state === 'running');
  await e.cancel(b.id);
  assert.equal(e.get(b.id).state, 'cancelled'); assert.equal(e.get(b.id).approval.state, 'withdrawn');
  await e.cancel(a.id);
  assert.ok(['cancelling', 'cancelled'].includes(e.get(a.id).state));
  await until(() => e.get(a.id).state === 'cancelled', 'cancelled');
  assert.deepEqual(client.calls.filter(x => x[0] === 'cancel').map(x => x[1]), [e.get(a.id).runId]);
  assert.equal(client.calls.filter(x => x[0] === 'start').length, 1);
  await assert.rejects(e.cancel(a.id), /cannot be cancelled/);
});

test('busy broker keeps the approval and the queue position; invalid approvals need re-approval', async () => {
  const {e, client} = engine();
  client.startErrors.push('WORKSPACE_LOCKED: An agent run is exclusive in its workspace; another run is active there.');
  const job = e.create({title: 'a', task: '1', provider: 'claude', profile: 'plan'});
  await e.approve(job.id); await until(() => e.get(job.id).state === 'queued' && e.get(job.id).events.some(x => x.type === 'waiting'));
  assert.equal(client.calls.filter(c => c[0] === 'request').length, 1, 'no second native dialog for a busy broker');
  const second = engine(); second.client.startErrors.push('SPEC_MISMATCH: The request differs from what was approved.');
  const j2 = second.e.create({title: 'a', task: '1', provider: 'claude', profile: 'plan'});
  await second.e.approve(j2.id); await until(() => second.e.get(j2.id).state === 'pending-approval' && second.e.get(j2.id).approval.state === 'invalidated');
  const third = engine(); third.client.startErrors.push('DUPLICATE_ATTEMPT: This job attempt was already started.');
  const j3 = third.e.create({title: 'a', task: '1', provider: 'claude', profile: 'plan'});
  await third.e.approve(j3.id); await until(() => third.e.get(j3.id).state === 'failed');
  assert.equal(third.e.get(j3.id).errorCategory, 'duplicate-attempt');
});

test('expired approval returns the job to pending approval instead of starting it', async () => {
  let t = Date.parse('2026-10-26T08:00:00.000Z');
  const {e, client} = engine({clock: () => new Date(t).toISOString()});
  const job = e.create({title: 'a', task: '1', provider: 'claude', profile: 'plan'});
  e.pause(); await e.approve(job.id);
  t += 16 * 60 * 1000; e.resume();
  await until(() => e.get(job.id).state === 'pending-approval');
  assert.equal(e.get(job.id).approval.state, 'expired');
  assert.equal(client.calls.filter(c => c[0] === 'start').length, 0);
});

test('restart: approvals are not kept and active jobs reconcile with OS evidence, never re-run', async () => {
  const {e, client, storage} = engine();
  const running = e.create({title: 'run', task: '1', provider: 'claude', profile: 'plan'});
  const queued = e.create({title: 'queued', task: '2', provider: 'claude', profile: 'plan'});
  await e.approve(running.id); await until(() => e.get(running.id).state === 'running');
  await e.approve(queued.id);
  const saved = JSON.parse(storage.getItem(JOBS_KEY));
  assert.equal(saved.version, 2);
  for (const [status, expected] of [['gone', 'interrupted'], ['alive-unmanaged', 'orphaned'], ['managed', 'running']]) {
    const fresh = mockClient(); fresh.reconcileStatus = status;
    const next = new AgentJobEngine({client: fresh, storage: memory({[JOBS_KEY]: JSON.stringify(saved)}), workspace: () => WS, providers: () => READY, sleep: tick, interval: 0});
    engines.push(next);
    const loaded = next.load();
    assert.equal(loaded.recovered, 2);
    assert.equal(next.get(queued.id).state, 'pending-approval', 'queued approval is lost on restart');
    await next.reconcile();
    assert.equal(next.get(running.id).state, expected, status);
    assert.equal(fresh.calls.filter(c => c[0] === 'start' || c[0] === 'request').length, 0, 'nothing re-runs automatically');
    if (expected === 'orphaned') await assert.rejects(next.retry(running.id), err => err.code === 'orphan_alive');
  }
  const browser = new AgentJobEngine({client: mockClient({available: false}), storage: memory({[JOBS_KEY]: JSON.stringify(saved)}), workspace: () => WS});
  browser.load(); await browser.reconcile();
  assert.equal(browser.get(running.id).state, 'unknown');
  assert.equal(client.calls.filter(c => c[0] === 'start').length, 1);
});

test('retry is a new attempt that needs a new native approval', async () => {
  const {e, client} = engine();
  const job = e.create({title: 'a', task: '1', provider: 'claude', profile: 'plan'});
  await e.approve(job.id); await until(() => e.get(job.id).state === 'running');
  client.finish(e.get(job.id).runId, {exitCode: 1}); await until(() => e.get(job.id).state === 'failed');
  await e.retry(job.id);
  const retried = e.get(job.id);
  assert.deepEqual([retried.state, retried.attempt, retried.approval.state, retried.runId], ['pending-approval', 2, 'none', null]);
  assert.equal(retried.attempts[0].exitCode, 1);
  await e.approve(job.id); await until(() => e.get(job.id).state === 'running');
  assert.deepEqual(client.calls.filter(c => c[0] === 'request').map(c => c[1].attempt), [1, 2]);
  await assert.rejects(e.retry(job.id), /cannot be retried/);
});

test('v1 migration is read-only, legacy jobs can never run, and tests need a real run', () => {
  const v1 = JSON.stringify({version: 1, jobs: [{id: 'old', title: 'Old', instructions: 'i', agentId: 'claude-code', state: 'pending', createdAt: '2026-10-01T00:00:00.000Z', events: []}, {id: 'run', title: 'R', state: 'running'}, {bad: true}]});
  const storage = memory({[LEGACY_KEY]: v1});
  const e = new AgentJobEngine({client: mockClient(), storage, workspace: () => WS, providers: () => READY});
  assert.deepEqual(e.load(), {jobs: 2, recovered: 0, migrated: 2});
  assert.equal(storage.getItem(LEGACY_KEY), v1);
  assert.deepEqual(e.snapshot().map(j => [j.id, j.state, j.legacy]), [['old', 'cancelled', true], ['run', 'interrupted', true]]);
  assert.match(e.canApprove('old').reason, /Legacy/);
  assert.equal(migrateV1(null, 'x').length, 0);
  const {e: fresh} = engine(); const job = fresh.create({title: 'a', task: '1', provider: 'claude', profile: 'plan'});
  assert.throws(() => fresh.attachTests(job.id, {runId: 'r', exitCode: null, label: 'npm test'}), /finished command run/);
  assert.equal(fresh.attachTests(job.id, {runId: 'r', exitCode: 0, label: 'npm test'}).tests.state, 'passed');
});

test('corrupt or quota-limited storage is reported, not fatal', () => {
  const e = new AgentJobEngine({client: mockClient(), storage: {getItem: () => '{not json', setItem: () => { throw new Error('QuotaExceededError'); }}, workspace: () => WS, providers: () => READY});
  assert.deepEqual(e.load(), {jobs: 0, recovered: 0, migrated: 0});
  e.create({title: 'a', task: '1', provider: 'claude', profile: 'plan'});
  assert.match(e.persistError, /Quota/);
});

// ---------- command runner ----------

test('runner: unavailable in browsers and disabled until the native enable dialog', async () => {
  const browser = new CommandRunner({client: new BrokerClient(undefined), storage: memory()});
  assert.equal(await browser.refresh(), 'unavailable');
  const client = mockClient(); client.enabled = false;
  const r = new CommandRunner({client, storage: memory(), sleep: tick, interval: 0});
  assert.equal(await r.refresh(), 'disabled');
  assert.equal((await r.run({sessionId: 's', program: 'npm', argsText: 'test'})).started, false);
  assert.equal(client.calls.filter(c => c[0] === 'request').length, 0, 'disabled runner never asks for approval');
  await r.enable();
  assert.equal(r.state, 'ready');
});

test('runner: denial starts nothing; history never stores argument values or output', async () => {
  const client = mockClient(); const storage = memory();
  const r = new CommandRunner({client, storage, sleep: tick, interval: 0}); await r.refresh();
  client.deny = true;
  const denied = await r.run({sessionId: 's', program: 'node', argsText: 'secret-arg-value\n--flag'});
  assert.deepEqual([denied.started, denied.code], [false, 'DENIED']);
  assert.equal(client.calls.filter(c => c[0] === 'start').length, 0);
  assert.equal(r.state, 'ready');
  const history = storage.getItem(HISTORY_KEY);
  assert.ok(history.includes('"argCount":2') && !history.includes('secret-arg-value'));
});

test('runner: approved run presents the identical request, streams output and records the exit', async () => {
  const client = mockClient(); const r = new CommandRunner({client, storage: memory(), sleep: tick, interval: 0}); await r.refresh();
  const done = r.run({sessionId: 's', program: 'npm', argsText: 'test', cwd: 'sub', envScope: 'minimal', timeoutSecs: 30});
  await until(() => r.state === 'running');
  const runId = r.current.run.id;
  client.emit(runId, ['MOCK out']); client.emit(runId, ['MOCK err'], 'stderr'); client.finish(runId, {exitCode: 0});
  const result = await done;
  const request = client.calls.find(c => c[0] === 'request')[1];
  assert.deepEqual(request, {kind: 'command', sessionId: 's', program: 'npm', args: ['test'], cwd: 'sub', envScope: 'minimal', timeoutSecs: 30});
  assert.deepEqual(client.calls.find(c => c[0] === 'start')[1], request);
  assert.equal(result.final.exitCode, 0);
  assert.ok(r.lines.some(l => l.stream === 'stderr' && l.text === 'MOCK err'));
  assert.match(r.lines.at(-1).text, /Finished: exit code 0 .* process tree confirmed stopped/);
  assert.deepEqual([r.last.exitCode, r.history.at(-1).state], [0, 'exited']);
});

test('runner: cancel goes to the broker and the outcome comes from the broker', async () => {
  const client = mockClient(); const r = new CommandRunner({client, storage: memory(), sleep: tick, interval: 0}); await r.refresh();
  const done = r.run({sessionId: 's', program: 'node', argsText: 'x'});
  await until(() => r.state === 'running');
  const cancelled = await r.cancel();
  assert.equal(cancelled.cancelled, true);
  assert.equal((await done).final.state, 'cancelled');
  assert.match(r.lines.at(-1).text, /cancelled/);
});
