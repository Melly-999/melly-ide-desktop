// Agent Control Center job queue. Metadata, execution authorization, executor output,
// test results and human review are separate fields; only an executor can append output.
export const JOB_STATES = Object.freeze(['pending', 'running', 'completed', 'failed', 'cancelled']);
const TRANSITIONS = Object.freeze({pending: ['running', 'cancelled'], running: ['completed', 'failed', 'cancelled'], completed: [], failed: [], cancelled: []});
export const STORAGE_KEY = 'melly-agent-jobs-v1';
const MAX_JOBS = 200, MAX_EVENTS = 200, MAX_STREAM = 64 * 1024, MAX_TITLE = 120, MAX_INSTRUCTIONS = 8000;

// Shipped executors are descriptors only. None is connected in this build.
export const EXECUTORS = Object.freeze([
  Object.freeze({id: 'claude-code', name: 'Claude Code', available: false, reason: 'Not connected. No Claude Code executor is integrated in this build.'}),
  Object.freeze({id: 'codex', name: 'Codex', available: false, reason: 'Not connected. No Codex executor is integrated in this build.'}),
  Object.freeze({id: 'local-metadata', name: 'Local queue (metadata only)', available: false, reason: 'Records jobs only. Nothing is executed.'})
]);

export class JobError extends Error { constructor(code, message) { super(message); this.code = code; } }
const clone = value => JSON.parse(JSON.stringify(value));
const text = (value, max) => String(value ?? '').slice(0, max);

export class JobQueue {
  constructor({storage = globalThis.localStorage, executors = EXECUTORS, now = () => new Date().toISOString(), id = () => crypto.randomUUID()} = {}) {
    this.storage = storage; this.now = now; this.makeId = id; this.jobs = []; this.listeners = new Set(); this.controllers = new Map();
    this.executors = new Map(executors.map(e => [e.id, e])); this.persistError = null;
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.save(); for (const fn of this.listeners) fn(this.snapshot()); }
  snapshot() { return clone(this.jobs); }
  executor(id) { const e = this.executors.get(id); return e ? {id: e.id, name: e.name, available: !!e.available && typeof e.run === 'function', reason: e.reason || ''} : {id, name: id, available: false, reason: 'Unknown executor.'}; }
  load() {
    let raw = null;
    try { raw = JSON.parse(this.storage?.getItem(STORAGE_KEY) || 'null'); } catch { raw = null; }
    const jobs = Array.isArray(raw?.jobs) ? raw.jobs.filter(j => j && typeof j.id === 'string' && JOB_STATES.includes(j.state)).slice(-MAX_JOBS) : [];
    this.jobs = jobs;
    let recovered = 0;
    for (const job of this.jobs) {
      if (job.state === 'running') {
        // The executor that owned this job cannot report back after a restart.
        this.move(job, job.cancelRequested ? 'cancelled' : 'failed', 'interrupted', 'Session ended before the executor reported a result. No result was recorded.'); recovered++;
      } else if (job.state === 'pending' && job.cancelRequested) { this.move(job, 'cancelled', 'cancelled', 'Cancellation completed during recovery.'); recovered++; }
    }
    if (recovered) this.save();
    return {jobs: this.jobs.length, recovered};
  }
  save() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify({version: 1, jobs: this.jobs})); this.persistError = null; }
    catch (error) { this.persistError = String(error?.message || error); }
  }
  find(id) { const job = this.jobs.find(j => j.id === id); if (!job) throw new JobError('not_found', 'Job not found.'); return job; }
  event(job, type, detail = '') { job.events.push({at: this.now(), type, detail: text(detail, 500)}); if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS); job.updatedAt = this.now(); }
  move(job, state, type, detail) {
    if (!TRANSITIONS[job.state].includes(state)) throw new JobError('invalid_transition', `Cannot move a ${job.state} job to ${state}.`);
    job.state = state; this.event(job, type, detail);
  }
  create({title, instructions = '', agentId = 'local-metadata'}) {
    title = text(title, MAX_TITLE + 1).trim();
    if (!title) throw new JobError('invalid', 'Give the job a title.');
    if (title.length > MAX_TITLE) throw new JobError('invalid', `Title is limited to ${MAX_TITLE} characters.`);
    if (String(instructions).length > MAX_INSTRUCTIONS) throw new JobError('invalid', `Instructions are limited to ${MAX_INSTRUCTIONS} characters.`);
    if (!this.executors.has(agentId)) throw new JobError('invalid', 'Choose a listed agent.');
    if (this.jobs.length >= MAX_JOBS) throw new JobError('full', `Queue holds at most ${MAX_JOBS} jobs. Remove finished jobs first.`);
    const job = {id: this.makeId(), title, instructions: String(instructions), agentId, state: 'pending', createdAt: this.now(), updatedAt: this.now(),
      authorization: {state: 'not-requested', by: null, at: null}, cancelRequested: false, stdout: '', stderr: '', truncated: false,
      result: null, tests: {state: 'not-run', summary: null}, review: {state: 'not-reviewed', at: null}, events: []};
    this.event(job, 'created', 'Metadata recorded. Not executed.');
    this.jobs.push(job); this.emit(); return clone(job);
  }
  authorize(id, decision, by = 'local-user') {
    const job = this.find(id);
    if (job.state !== 'pending') throw new JobError('invalid_transition', 'Only pending jobs can be authorized.');
    if (!['approved', 'denied'].includes(decision)) throw new JobError('invalid', 'Unknown authorization decision.');
    job.authorization = {state: decision, by: text(by, 80), at: this.now()};
    this.event(job, 'authorization', `Execution ${decision} by ${job.authorization.by}.`);
    if (decision === 'denied') this.move(job, 'cancelled', 'cancelled', 'Execution authorization denied.');
    this.emit(); return clone(job);
  }
  canRun(id) {
    const job = this.find(id), executor = this.executor(job.agentId);
    if (job.state !== 'pending') return {ok: false, reason: `Job is ${job.state}.`};
    if (!executor.available) return {ok: false, reason: executor.reason || 'Executor unavailable.'};
    if (job.authorization.state !== 'approved') return {ok: false, reason: 'Human execution authorization is required first.'};
    return {ok: true, reason: ''};
  }
  append(job, stream, chunk) {
    if (!['stdout', 'stderr'].includes(stream)) return;
    const next = job[stream] + String(chunk);
    if (next.length > MAX_STREAM) { job[stream] = next.slice(-MAX_STREAM); job.truncated = true; } else job[stream] = next;
  }
  async run(id) {
    const check = this.canRun(id);
    if (!check.ok) throw new JobError('not_runnable', check.reason);
    const job = this.find(id), executor = this.executors.get(job.agentId), controller = new AbortController();
    this.controllers.set(id, controller);
    this.move(job, 'running', 'started', `Executor ${executor.name} started.`); this.emit();
    let outcome;
    try {
      outcome = await executor.run(clone(job), {signal: controller.signal, write: (stream, chunk) => { if (job.state === 'running') { this.append(job, stream, chunk); this.emit(); } }});
    } catch (error) {
      outcome = controller.signal.aborted ? {cancelled: true} : {error: String(error?.message || error)};
    } finally { this.controllers.delete(id); }
    if (job.state !== 'running') return clone(job);
    if (outcome?.cancelled) this.move(job, 'cancelled', 'cancelled', 'Executor acknowledged cancellation.');
    else if (outcome?.error || !Number.isInteger(outcome?.exitCode)) this.move(job, 'failed', 'failed', outcome?.error || 'Executor returned no exit code.');
    else {
      job.result = {exitCode: outcome.exitCode};
      if (outcome.tests && ['passed', 'failed'].includes(outcome.tests.state)) job.tests = {state: outcome.tests.state, summary: text(outcome.tests.summary, 500)};
      this.move(job, outcome.exitCode === 0 ? 'completed' : 'failed', outcome.exitCode === 0 ? 'completed' : 'failed', `Executor exit code ${outcome.exitCode}.`);
    }
    this.emit(); return clone(job);
  }
  cancel(id) {
    const job = this.find(id);
    if (job.state === 'pending') this.move(job, 'cancelled', 'cancelled', 'Cancelled before execution.');
    else if (job.state === 'running') {
      if (!job.cancelRequested) { job.cancelRequested = true; this.event(job, 'cancel-requested', 'Cancellation requested. Waiting for the executor to stop.'); }
      this.controllers.get(id)?.abort();
    } else throw new JobError('invalid_transition', `A ${job.state} job cannot be cancelled.`);
    this.emit(); return clone(job);
  }
  review(id, decision) {
    const job = this.find(id);
    if (job.state !== 'completed') throw new JobError('invalid_transition', 'Only completed jobs with recorded executor output can be reviewed.');
    if (!['approved', 'rejected'].includes(decision)) throw new JobError('invalid', 'Unknown review decision.');
    job.review = {state: decision, at: this.now()}; this.event(job, 'review', `Human review: ${decision}.`); this.emit(); return clone(job);
  }
  remove(id) {
    const job = this.find(id);
    if (job.state === 'running') throw new JobError('invalid_transition', 'Cancel a running job before removing it.');
    this.jobs = this.jobs.filter(j => j !== job); this.emit();
  }
}
