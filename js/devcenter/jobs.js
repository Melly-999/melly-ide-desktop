// MEGA-08 Agent Control Center job engine (schema v2). Job state is derived from the native
// broker's process lifecycle; nothing here can approve or start a run on its own. Approval
// tokens and raw output live in memory only; durable records hold metadata, a redacted summary
// and evidence references. Nothing is ever re-run automatically, after a restart or otherwise.
import { errorCode, errorText, follow } from './broker.js';
import { AgentStream, redactText } from './adapters.js';

export const JOBS_KEY = 'melly-agent-jobs-v2';
export const LEGACY_KEY = 'melly-agent-jobs-v1';
export const JOB_STATES_V2 = Object.freeze(['pending-approval', 'queued', 'starting', 'running', 'waiting-permission', 'cancelling', 'cancelled', 'completed', 'failed', 'interrupted', 'orphaned', 'unknown']);
export const ACTIVE_STATES = Object.freeze(['starting', 'running', 'waiting-permission', 'cancelling']);
export const FINAL_STATES = Object.freeze(['cancelled', 'completed', 'failed', 'interrupted', 'orphaned', 'unknown']);
export const PROVIDERS = Object.freeze([
  Object.freeze({id: 'claude', name: 'Claude Code', profiles: ['plan', 'edit'], writable: ['edit']}),
  Object.freeze({id: 'codex', name: 'Codex CLI', profiles: ['read-only', 'workspace-write'], writable: ['workspace-write']}),
]);
export const WRITABLE_GATED = 'Writable agent profiles are disabled until the owner accepts the writable-agent security contract. Use the read-only profile.';
export const isWritable = (provider, profile) => Boolean(PROVIDERS.find(p => p.id === provider)?.writable.includes(profile));
const TRANSITIONS = Object.freeze({
  'pending-approval': ['queued', 'cancelled'],
  queued: ['starting', 'pending-approval', 'cancelled'],
  starting: ['running', 'failed', 'queued', 'pending-approval', 'cancelled'],
  running: ['completed', 'failed', 'cancelling', 'cancelled', 'interrupted', 'orphaned', 'unknown', 'waiting-permission'],
  'waiting-permission': ['running', 'cancelling', 'cancelled', 'failed', 'completed', 'interrupted', 'unknown'],
  cancelling: ['cancelled', 'failed', 'completed', 'interrupted', 'unknown'],
  cancelled: [], completed: [], failed: [], interrupted: [], orphaned: ['interrupted'], unknown: ['interrupted'],
});
const REQUEUE = ['BUSY', 'WORKSPACE_LOCKED'];
const REAPPROVE = ['APPROVAL_INVALID', 'APPROVAL_EXPIRED', 'APPROVAL_REPLAY', 'SPEC_MISMATCH', 'STALE_WORKSPACE', 'IDENTITY_CHANGED', 'PROBE_REQUIRED', 'DISABLED'];
const MAX_JOBS = 200, MAX_EVENTS = 200, MAX_SUMMARY = 2048, MAX_LINES = 2000, MAX_TITLE = 120, MAX_TASK = 32 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const text = (value, max) => String(value ?? '').slice(0, max);

export class EngineError extends Error { constructor(code, message) { super(message); this.code = code; } }

/** v1 (MEGA-04/07 metadata-only queue) → v2. The v1 key is read, never written or deleted. */
export function migrateV1(raw, now) {
  const map = {pending: 'cancelled', running: 'interrupted', completed: 'completed', failed: 'failed', cancelled: 'cancelled'};
  const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
  return jobs.filter(j => j && typeof j.id === 'string' && map[j.state]).map(j => ({
    ...blank(), id: j.id, title: text(j.title, MAX_TITLE), task: text(j.instructions, MAX_TASK), provider: null, legacy: true, legacyAgent: text(j.agentId, 40),
    state: map[j.state], createdAt: j.createdAt || now, updatedAt: now,
    events: [...(Array.isArray(j.events) ? j.events.slice(-50) : []), {at: now, type: 'migrated', detail: `Migrated from schema v1 (metadata only; was ${j.state}). Legacy jobs never ran and cannot run; create a new job.`}],
  }));
}
function blank() {
  return {id: '', title: '', task: '', provider: null, profile: null, model: '', timeoutSecs: 1800, workspace: null, legacy: false, createdAt: null, updatedAt: null,
    queuedAt: null, startedAt: null, endedAt: null, elapsedMs: null, state: 'pending-approval', attempt: 1, approval: {state: 'none'}, cancelRequested: false,
    runId: null, pid: null, processCreated: null, exitCode: null, errorCategory: null, error: null, summary: '', progress: null, changes: null,
    evidence: [], attempts: [], tests: {state: 'not-run', summary: null, runId: null}, events: []};
}

export class AgentJobEngine {
  constructor({client, storage = globalThis.localStorage, now = () => new Date().toISOString(), id = () => crypto.randomUUID(), sleep, interval = 400, workspace = () => null, providers = () => ({})} = {}) {
    this.client = client; this.storage = storage; this.now = now; this.makeId = id; this.sleep = sleep; this.interval = interval;
    this.workspace = workspace; this.providers = providers; this.jobs = []; this.settings = {paused: false, concurrency: 1};
    this.listeners = new Set(); this.tokens = new Map(); this.streams = new Map(); this.lines = new Map(); this.inflight = new Set(); this.persistError = null; this.followers = new Set();
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  /** Stops watching runs (teardown). Runs keep going natively and are re-attached on next load. */
  dispose() { this.disposed = true; this.listeners.clear(); }
  emit() { this.save(); const jobs = this.snapshot(); for (const fn of this.listeners) { try { fn(jobs); } catch { /* a listener never breaks the engine */ } } }
  snapshot() { return clone(this.jobs); }
  get(id) { const job = this.jobs.find(j => j.id === id); if (!job) throw new EngineError('not_found', 'Job not found.'); return job; }
  output(id) { return [...(this.lines.get(id) || [])]; }
  save() {
    try { this.storage?.setItem(JOBS_KEY, JSON.stringify({version: 2, savedAt: this.now(), settings: this.settings, jobs: this.jobs})); this.persistError = null; }
    catch (error) { this.persistError = String(error?.message || error); }
  }
  event(job, type, detail = '') { job.events.push({at: this.now(), type, detail: text(redactText(detail), 500)}); if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS); job.updatedAt = this.now(); }
  move(job, state, type, detail) {
    if (!TRANSITIONS[job.state]?.includes(state)) throw new EngineError('invalid_transition', `Cannot move a ${job.state} job to ${state}.`);
    job.state = state; this.event(job, type, detail);
  }

  /** Loads v2 (or migrates v1 without touching it). Active jobs are marked for reconciliation. */
  load() {
    let raw = null, migrated = 0;
    try { raw = JSON.parse(this.storage?.getItem(JOBS_KEY) || 'null'); } catch { raw = null; }
    if (raw?.version === 2 && Array.isArray(raw.jobs)) {
      this.jobs = raw.jobs.filter(j => j && typeof j.id === 'string' && JOB_STATES_V2.includes(j.state)).slice(-MAX_JOBS).map(j => ({...blank(), ...j}));
      this.settings = {paused: !!raw.settings?.paused, concurrency: [1, 2].includes(raw.settings?.concurrency) ? raw.settings.concurrency : 1};
    } else {
      let legacy = null;
      try { legacy = JSON.parse(this.storage?.getItem(LEGACY_KEY) || 'null'); } catch { legacy = null; }
      this.jobs = migrateV1(legacy, this.now()); migrated = this.jobs.length;
    }
    let recovered = 0;
    for (const job of this.jobs) {
      if (job.state === 'queued') { job.state = 'pending-approval'; job.approval = {...job.approval, state: 'expired'}; this.event(job, 'approval-lost', 'Melly restarted or reloaded; approvals are never kept. Approve again to queue it.'); recovered++; }
      else if (ACTIVE_STATES.includes(job.state)) { job.needsReconcile = true; recovered++; }
    }
    if (recovered || migrated) this.save();
    return {jobs: this.jobs.length, recovered, migrated};
  }
  /** Re-attaches to runs the broker still holds; otherwise records what the OS evidence shows. */
  async reconcile() {
    const pending = this.jobs.filter(j => j.needsReconcile);
    const counts = {reattached: 0, interrupted: 0, orphaned: 0, unknown: 0};
    if (!pending.length) return counts;
    let results = [], native = [];
    if (this.client?.available) {
      try { native = await this.client.runs(); } catch { native = []; }
      try { results = await this.client.reconcile(pending.filter(j => j.runId).map(j => ({runId: j.runId, pid: j.pid || 0, processCreated: j.processCreated || 0}))); } catch { results = []; }
    }
    for (const job of pending) {
      delete job.needsReconcile;
      const byAttempt = native.find(r => r.jobId === job.id && r.attempt === job.attempt);
      const result = results.find(r => r.runId === job.runId);
      if (byAttempt || result?.status === 'managed') {
        const run = byAttempt || result.run; job.runId = run.id; job.pid = run.pid; job.processCreated = run.processCreated;
        if (job.state === 'starting') this.move(job, 'running', 'reattached', 'Melly reloaded; the native broker still holds this run.'); else this.event(job, 'reattached', 'Melly reloaded; the native broker still holds this run.');
        counts.reattached++; void this.watch(job);
      } else if (result?.status === 'alive-unmanaged') {
        job.state = 'orphaned'; this.event(job, 'orphaned', `A process with the recorded pid ${job.pid} and start time still exists but is not controlled by Melly. Melly does not kill it; check it in Task Manager.`); counts.orphaned++;
      } else if (this.client?.available) {
        job.state = 'interrupted';
        this.event(job, 'interrupted', job.runId ? 'Melly closed while this job was active. Its process tree was stopped with Melly (Job Object). No result was recorded; nothing is re-run automatically.' : 'The job was starting when Melly closed; any started process was stopped with Melly. No result was recorded.');
        counts.interrupted++;
      } else { job.state = 'unknown'; this.event(job, 'unknown', 'Process state cannot be verified in this environment.'); counts.unknown++; }
      job.updatedAt = this.now();
    }
    this.emit();
    return counts;
  }

  create({title, task, provider, profile, model = '', timeoutSecs = 1800}) {
    title = text(title, MAX_TITLE + 1).trim();
    if (!title) throw new EngineError('invalid', 'Give the job a title.');
    if (title.length > MAX_TITLE) throw new EngineError('invalid', `Title is limited to ${MAX_TITLE} characters.`);
    if (!String(task ?? '').trim()) throw new EngineError('invalid', 'Describe the coding task for the agent.');
    if (String(task).length > MAX_TASK) throw new EngineError('invalid', `The task is limited to ${MAX_TASK} characters.`);
    const spec = PROVIDERS.find(p => p.id === provider);
    if (!spec) throw new EngineError('invalid', 'Choose Claude Code or Codex.');
    if (!spec.profiles.includes(profile)) throw new EngineError('invalid', 'Choose a permission profile for this agent.');
    if (model && !/^[A-Za-z0-9._:/\-[\]]{1,80}$/.test(model)) throw new EngineError('invalid', 'Model names may contain letters, digits and . _ : / - [ ] only.');
    if (!Number.isInteger(timeoutSecs) || timeoutSecs < 60 || timeoutSecs > 7200) throw new EngineError('invalid', 'Timeout must be 60–7200 seconds.');
    const workspace = this.workspace();
    if (!workspace) throw new EngineError('invalid', 'Open a Local Folder first; the agent works in that folder only.');
    const duplicate = this.jobs.find(j => j.title === title && j.task === task && j.provider === provider && j.profile === profile && Date.parse(this.now()) - Date.parse(j.createdAt) < 10000);
    if (duplicate) throw new EngineError('duplicate', 'An identical job was just created. It was not added twice.');
    if (this.jobs.length >= MAX_JOBS) throw new EngineError('full', `The queue holds at most ${MAX_JOBS} jobs. Remove finished jobs first.`);
    const job = {...blank(), id: this.makeId(), title, task: String(task), provider, profile, model: String(model || ''), timeoutSecs, workspace: {key: workspace.key, name: workspace.name}, createdAt: this.now(), updatedAt: this.now()};
    this.event(job, 'created', 'Metadata recorded. Not executed. Native approval is required before it can run.');
    this.jobs.push(job); this.emit(); return clone(job);
  }
  request(job, sessionId) {
    return {kind: 'agent', sessionId, provider: job.provider, profile: job.profile, model: job.model || '', task: job.task, cwd: '', timeoutSecs: job.timeoutSecs, jobId: job.id, attempt: job.attempt};
  }
  canApprove(id) {
    const job = this.get(id);
    if (job.legacy) return {ok: false, reason: 'Legacy metadata-only job from an earlier version. Create a new job to run it.'};
    if (job.state !== 'pending-approval') return {ok: false, reason: `Job is ${job.state}.`};
    if (!this.client?.available) return {ok: false, reason: 'Not connected: agent jobs require the Windows desktop app. Browsers and the iPhone/PWA shell never start local processes.'};
    const workspace = this.workspace();
    if (!workspace) return {ok: false, reason: 'Open the job’s Local Folder first.'};
    if (workspace.key !== job.workspace?.key) return {ok: false, reason: `This job belongs to the folder “${job.workspace?.name}”. Open that folder to run it.`};
    const provider = this.providers()[job.provider];
    if (provider?.state !== 'ready') return {ok: false, reason: `${job.provider === 'codex' ? 'Codex CLI' : 'Claude Code'} is not checked yet. Enable execution and select Check CLI.`};
    if (!provider.profiles?.some(p => p.id === job.profile)) return {ok: false, reason: 'The installed CLI does not support this permission profile.'};
    // MEGA-08.2: the native broker refuses writable profiles (PROFILE_GATED) until the owner accepts the contract.
    if (isWritable(job.provider, job.profile) && provider.writableEnabled !== true) return {ok: false, reason: WRITABLE_GATED};
    if (this.inflight.has(id)) return {ok: false, reason: 'An approval dialog for this job is already open.'};
    return {ok: true, reason: ''};
  }
  /** Opens the native approval dialog. Only a Yes there yields a token; it is kept in memory. */
  async approve(id) {
    const check = this.canApprove(id);
    if (!check.ok) throw new EngineError('not_approvable', check.reason);
    const job = this.get(id), workspace = this.workspace();
    this.inflight.add(id);
    try {
      const approved = await this.client.request(this.request(job, workspace.sessionId), 'agents');
      if (job.state !== 'pending-approval') return clone(job);
      this.tokens.set(id, approved);
      job.approval = {state: 'approved', at: this.now(), approvalId: approved.approvalId, specHash: approved.specHash, sessionId: workspace.sessionId, expiresAt: new Date(Date.parse(this.now()) + approved.expiresInSecs * 1000).toISOString(), executable: approved.normalized?.executable, args: approved.normalized?.args};
      job.queuedAt = this.now();
      this.move(job, 'queued', 'approved', `Approved in the native dialog (spec ${approved.specHash.slice(0, 12)}…, single use, expires in ${Math.round(approved.expiresInSecs / 60)} min). Queued.`);
      this.emit(); void this.schedule(); return clone(job);
    } catch (error) {
      if (error instanceof EngineError) throw error;
      const code = errorCode(error);
      job.approval = {state: code === 'DENIED' ? 'denied' : 'refused', at: this.now(), code};
      this.event(job, code === 'DENIED' ? 'approval-denied' : 'approval-refused', code === 'DENIED' ? 'Declined in the native dialog. Nothing was queued.' : errorText(error));
      this.emit(); throw new EngineError(code, errorText(error));
    } finally { this.inflight.delete(id); }
  }
  pause() { this.settings.paused = true; this.emit(); }
  resume() { this.settings.paused = false; this.emit(); void this.schedule(); }
  async setConcurrency(n) {
    if (![1, 2].includes(n)) throw new EngineError('invalid', 'Concurrency must be 1 or 2.');
    if (this.client?.available) await this.client.setConcurrency(n);
    this.settings.concurrency = n; this.emit(); void this.schedule();
  }
  active() { return this.jobs.filter(j => ACTIVE_STATES.includes(j.state)); }
  /** FIFO by approval time; one active agent job per workspace; never more than `concurrency`. */
  async schedule() {
    if (this.scheduling) { this.rescheduled = true; return; }
    this.scheduling = true;
    try {
      do {
        this.rescheduled = false;
        if (this.settings.paused || !this.client?.available || this.disposed) return;
        while (this.active().length < this.settings.concurrency) {
          const locked = new Set(this.active().map(j => j.workspace?.key));
          const next = this.jobs.filter(j => j.state === 'queued' && !locked.has(j.workspace?.key) && !j.waiting).sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt))[0];
          if (!next) break;
          await this.startJob(next);
        }
      } while (this.rescheduled);
    } finally { this.scheduling = false; }
  }
  async startJob(job) {
    const token = this.tokens.get(job.id);
    if (!token || Date.parse(job.approval.expiresAt) <= Date.parse(this.now())) {
      this.tokens.delete(job.id); job.approval = {...job.approval, state: 'expired'};
      this.move(job, 'pending-approval', 'approval-expired', 'The approval expired before the job reached the front of the queue. Approve again.'); this.emit(); return;
    }
    this.move(job, 'starting', 'starting', 'Starting through the native broker.'); this.emit();
    let run;
    try { run = await this.client.start(this.request(job, job.approval.sessionId), token, 'agents'); }
    catch (error) {
      const code = errorCode(error);
      if (REQUEUE.includes(code)) {
        job.waiting = true; this.move(job, 'queued', 'waiting', `${errorText(error)} It stays queued.`); this.emit();
        setTimeout(() => { delete job.waiting; void this.schedule(); }, 1500); return;
      }
      this.tokens.delete(job.id);
      if (REAPPROVE.includes(code)) { job.approval = {...job.approval, state: 'invalidated', code}; this.move(job, 'pending-approval', 'start-refused', `${errorText(error)} Approve again.`); }
      else { job.errorCategory = code === 'DUPLICATE_ATTEMPT' ? 'duplicate-attempt' : 'start-failed'; job.error = errorText(error); this.move(job, 'failed', 'start-failed', errorText(error)); }
      this.emit(); return;
    }
    this.tokens.delete(job.id); job.approval = {...job.approval, state: 'consumed'};
    job.runId = run.id; job.pid = run.pid; job.processCreated = run.processCreated; job.startedAt = this.now();
    job.evidence.push({at: this.now(), type: 'native-run', runId: run.id, approvalId: run.approvalId, specHash: run.specHash, pid: run.pid, attempt: job.attempt});
    this.move(job, 'running', 'started', `Native run ${run.id.slice(0, 12)}… started (pid ${run.pid}, attempt ${job.attempt}).`); this.emit();
    if (job.cancelRequested) await this.cancel(job.id);
    void this.watch(job);
  }
  async watch(job) {
    if (!job.runId || this.followers.has(job.runId)) return;
    const runId = job.runId; this.followers.add(runId);
    const stream = new AgentStream(job.provider); this.streams.set(job.id, stream);
    const lines = this.lines.get(job.id) || []; this.lines.set(job.id, lines);
    try {
      const final = await follow(this.client, runId, {sleep: this.sleep, interval: this.interval, isStopped: () => this.disposed,
        onChunks: chunks => {
          for (const c of chunks) lines.push({stream: c.stream, text: c.text});
          if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
          stream.push(chunks); job.progress = stream.summary(); job.updatedAt = this.now(); this.emit();
        },
        onRun: run => { job.elapsedMs = run.elapsedMs; }});
      if (this.disposed) return;
      stream.end(); this.finalize(job, final);
    } catch (error) {
      if (ACTIVE_STATES.includes(job.state)) { job.error = errorText(error); job.errorCategory = 'monitor-lost'; this.move(job, 'unknown', 'monitor-lost', `Melly lost contact with the run: ${errorText(error)}`); this.emit(); }
    } finally { this.followers.delete(runId); void this.schedule(); }
  }
  finalize(job, run) {
    if (!ACTIVE_STATES.includes(job.state)) return;
    const stream = this.streams.get(job.id); const progress = stream ? stream.summary() : job.progress;
    job.progress = progress; job.exitCode = run.exitCode ?? null; job.endedAt = this.now(); job.elapsedMs = run.elapsedMs; job.changes = run.changes || null;
    job.summary = text(redactText([progress?.result?.text, progress?.lastMessage].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n')), MAX_SUMMARY);
    job.evidence.push({at: this.now(), type: 'native-exit', runId: run.id, state: run.state, exitCode: run.exitCode ?? null, treeVerified: !!run.treeVerified, leftoverTerminated: run.leftoverTerminated || 0});
    const reported = progress?.result ? (progress.result.ok ? 'the agent reported success' : `the agent reported an error (${progress.result.subtype})`) : 'the agent reported no result event';
    if (!run.treeVerified) { job.errorCategory = 'tree-unconfirmed'; this.move(job, 'unknown', 'unconfirmed', `${run.error || 'The process tree could not be confirmed stopped.'} Exit code ${run.exitCode ?? 'none'}.`); }
    else if (run.state === 'cancelled') this.move(job, 'cancelled', 'cancelled', `Cancelled; the native broker confirmed the process tree stopped${run.exitCode != null ? ` (exit code ${run.exitCode})` : ''}.`);
    else if (run.state === 'timed-out') { job.errorCategory = 'timeout'; this.move(job, 'failed', 'timed-out', `Stopped after the ${job.timeoutSecs} s timeout; process tree confirmed stopped.`); }
    else if (run.state === 'exited' && run.exitCode === 0) this.move(job, 'completed', 'completed', `Process exited with code 0; ${reported}. Exit code 0 does not prove that every tool action succeeded.`);
    else if (run.state === 'exited') { job.errorCategory = 'exit-nonzero'; this.move(job, 'failed', 'failed', `Process exited with code ${run.exitCode}; ${reported}.`); }
    else { job.errorCategory = 'run-failed'; job.error = run.error || null; this.move(job, 'failed', 'failed', run.error || 'The native run failed.'); }
    this.emit(); this.onFinished?.(clone(job));
  }
  async cancel(id) {
    const job = this.get(id);
    if (['pending-approval', 'queued'].includes(job.state)) { this.tokens.delete(id); job.approval = {...job.approval, state: job.approval.state === 'approved' ? 'withdrawn' : job.approval.state}; this.move(job, 'cancelled', 'cancelled', 'Cancelled before execution. Nothing was started.'); this.emit(); return clone(job); }
    if (job.state === 'starting') { job.cancelRequested = true; this.event(job, 'cancel-requested', 'Cancellation requested; it applies as soon as the start completes.'); this.emit(); return clone(job); }
    if (['running', 'waiting-permission'].includes(job.state)) {
      job.cancelRequested = true; this.move(job, 'cancelling', 'cancel-requested', 'Cancellation requested. Waiting for the native broker to confirm the process tree stopped.'); this.emit();
      try { await this.client.cancel(job.runId); } catch (error) { this.event(job, 'cancel-error', errorText(error)); this.emit(); }
      return clone(job);
    }
    throw new EngineError('invalid_transition', `A ${job.state} job cannot be cancelled.`);
  }
  async retry(id) {
    const job = this.get(id);
    if (job.legacy) throw new EngineError('invalid', 'Legacy jobs cannot be retried. Create a new job.');
    if (job.state === 'orphaned') {
      const [result] = this.client?.available ? await this.client.reconcile([{runId: job.runId, pid: job.pid || 0, processCreated: job.processCreated || 0}]) : [{status: 'unknown'}];
      if (result?.status !== 'gone') throw new EngineError('orphan_alive', 'The earlier process may still be running. Retry is refused until it has ended, to avoid duplicate edits.');
      this.move(job, 'interrupted', 'orphan-ended', 'The earlier process has ended.');
    }
    if (!['failed', 'cancelled', 'interrupted', 'unknown'].includes(job.state)) throw new EngineError('invalid_transition', `A ${job.state} job cannot be retried.`);
    job.attempts.push({attempt: job.attempt, state: job.state, exitCode: job.exitCode, runId: job.runId, endedAt: job.endedAt, errorCategory: job.errorCategory});
    Object.assign(job, {attempt: job.attempt + 1, state: 'pending-approval', approval: {state: 'none'}, cancelRequested: false, runId: null, pid: null, processCreated: null, exitCode: null, errorCategory: null, error: null, summary: '', progress: null, changes: null, startedAt: null, endedAt: null, elapsedMs: null, queuedAt: null});
    this.lines.delete(id); this.streams.delete(id);
    this.event(job, 'retry', `Attempt ${job.attempt} created. It needs a new native approval; nothing runs automatically.`); this.emit(); return clone(job);
  }
  remove(id) {
    const job = this.get(id);
    if (ACTIVE_STATES.includes(job.state)) throw new EngineError('invalid_transition', 'Cancel an active job before removing it.');
    this.tokens.delete(id); this.lines.delete(id); this.streams.delete(id);
    this.jobs = this.jobs.filter(j => j !== job); this.emit();
  }
  /** Links a verification command run (from the Command Runner) as the job's test evidence. */
  attachTests(id, run) {
    const job = this.get(id);
    if (!run?.runId || !Number.isInteger(run.exitCode)) throw new EngineError('invalid', 'Only a finished command run with an exit code can be attached as test evidence.');
    job.tests = {state: run.exitCode === 0 ? 'passed' : 'failed', summary: text(`${run.label} · exit code ${run.exitCode}`, 300), runId: run.runId};
    job.evidence.push({at: this.now(), type: 'verification-run', runId: run.runId, exitCode: run.exitCode});
    this.event(job, 'tests', `Verification command ${run.exitCode === 0 ? 'passed' : 'failed'} (exit code ${run.exitCode}). Recorded from an actual run.`); this.emit(); return clone(job);
  }
}
