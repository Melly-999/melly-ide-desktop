// MEGA-08 Approved Command Runner: one executable + argument array per run, each approved in a
// native Windows dialog. This is deliberately not an interactive shell: typed text never reaches
// a shell, and every run is new execution authority with its own approval.
import { errorCode, errorText, follow, parseArgs } from './broker.js';

export const RUNNER_STATES = Object.freeze(['checking', 'unavailable', 'disabled', 'ready', 'awaiting-approval', 'starting', 'running', 'cancelling', 'error']);
// MEGA-09: every outcome that is not a clean exit gets one plain-language category.
export const ERROR_CATEGORIES = Object.freeze({
  declined: 'Declined in the Windows dialog', policy: 'Refused by Melly’s execution policy', approval: 'Approval invalid, expired, replayed or changed',
  availability: 'Execution unavailable right now', start: 'Program could not be started', exit: 'Ran and exited with a non-zero code',
  timeout: 'Stopped by the timeout', cancelled: 'Cancelled', tree: 'Process tree not confirmed stopped', monitor: 'Melly lost contact with the run', other: 'Other error'});
const CODE_CATEGORY = {DENIED: 'declined', EXECUTABLE_REFUSED: 'policy', ARGS_REFUSED: 'policy', CWD_REFUSED: 'policy', AGENT_VIA_ADAPTER: 'policy', PROFILE_GATED: 'policy', PROFILE_REFUSED: 'policy', MODEL_REFUSED: 'policy', PROBE_REQUIRED: 'policy',
  APPROVAL_INVALID: 'approval', APPROVAL_EXPIRED: 'approval', APPROVAL_REPLAY: 'approval', SPEC_MISMATCH: 'approval', IDENTITY_CHANGED: 'approval',
  DISABLED: 'availability', STALE_WORKSPACE: 'availability', BUSY: 'availability', WORKSPACE_LOCKED: 'availability', DUPLICATE_ATTEMPT: 'availability', UNAVAILABLE: 'availability',
  SPAWN_FAILED: 'start', NOT_FOUND: 'start', TREE_UNCONFIRMED: 'tree'};
/** Category of a refused request (`code`) or of a finished run (`state`, `exitCode`, `treeVerified`); null for a clean exit. */
export function categorize(code, state, exitCode, treeVerified = true) {
  if (code) return CODE_CATEGORY[code] || 'other';
  if (treeVerified === false) return 'tree';
  if (state === 'timed-out') return 'timeout';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'failed') return 'start';
  if (state === 'exited') return exitCode === 0 ? null : 'exit';
  return state ? 'other' : null;
}
export const HISTORY_KEY = 'melly-command-history-v1';
const MAX_LINES = 4000, MAX_HISTORY = 50;

export class CommandRunner {
  constructor({client, storage = globalThis.localStorage, now = () => new Date().toISOString(), sleep, interval = 250} = {}) {
    this.client = client; this.storage = storage; this.now = now; this.sleep = sleep; this.interval = interval;
    this.state = 'checking'; this.capability = null; this.error = null; this.lines = []; this.current = null; this.last = null; this.listeners = new Set();
    try { const saved = JSON.parse(storage?.getItem(HISTORY_KEY) || '[]'); this.history = Array.isArray(saved) ? saved.slice(-MAX_HISTORY) : []; } catch { this.history = []; }
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  set(state, error = this.error) { this.state = state; this.error = error; for (const fn of this.listeners) { try { fn(this); } catch { /* ignore */ } } }
  log(stream, text) { this.lines.push({at: this.now(), stream, text: String(text)}); if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES); }
  remember(entry) {
    this.history.push(entry); if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    try { this.storage?.setItem(HISTORY_KEY, JSON.stringify(this.history)); } catch { /* history is a convenience */ }
  }
  get busy() { return ['awaiting-approval', 'starting', 'running', 'cancelling'].includes(this.state); }
  /** `settle` ends a finished or refused run's busy state; otherwise a busy state is kept. */
  async refresh(settle = false) {
    if (!this.client?.available) { this.capability = null; this.set('unavailable', null); return this.state; }
    try { this.capability = await this.client.capability(); if (!this.busy || settle) this.set(this.capability.enabled ? 'ready' : 'disabled', null); }
    catch (error) { this.capability = null; this.set('error', errorText(error)); }
    return this.state;
  }
  /** Shows the native "enable for this session" dialog. The renderer cannot enable silently. */
  async enable() {
    try { this.capability = await this.client.enable(); this.log('system', this.capability.enabled ? 'Execution enabled for this app session (native dialog). Each run still needs its own approval.' : 'Execution stays disabled: the native dialog was declined.'); }
    catch (error) { this.log('system', `Enable failed: ${errorText(error)}`); }
    return this.refresh();
  }
  async disable() {
    try { this.capability = await this.client.disable(); this.log('system', 'Execution disabled for this session.'); } catch (error) { this.log('system', `Disable failed: ${errorText(error)}`); }
    return this.refresh();
  }
  /** Request native approval for exactly this specification, then start and follow it. */
  async run({sessionId, program, argsText = '', args, cwd = '', envScope = 'inherit', timeoutSecs = 600}) {
    if (this.state !== 'ready') { const reason = this.capability?.reason || 'Execution is not available.'; this.log('system', `Not started: ${reason}`); this.set(this.state); return {started: false, reason}; }
    if (!sessionId) { const reason = 'Open a Local Folder first; commands run only inside it.'; this.log('system', `Not started: ${reason}`); this.set(this.state); return {started: false, reason}; }
    const request = {kind: 'command', sessionId, program: String(program || '').trim(), args: args ?? parseArgs(argsText), cwd: String(cwd || ''), envScope, timeoutSecs: Number(timeoutSecs)};
    const label = [request.program, ...request.args].join(' ');
    this.set('awaiting-approval', null); this.log('system', `Requesting native approval for: ${label}`);
    let approval;
    try { approval = await this.client.request(request, 'terminal'); }
    catch (error) {
      const code = errorCode(error), reason = code === 'DENIED' ? 'You declined this run in the native dialog. Nothing was started.' : errorText(error);
      this.log('system', `Not started: ${reason}`);
      this.lastFailure = {code, category: categorize(code)};
      this.remember({at: this.now(), program: request.program, argCount: request.args.length, cwd: request.cwd, envScope, state: code === 'DENIED' ? 'denied' : 'refused', code, category: categorize(code)});
      await this.refresh(true); return {started: false, reason, code};
    }
    this.set('starting');
    let run;
    try { run = await this.client.start(request, approval, 'terminal'); }
    catch (error) {
      this.log('system', `Not started: ${errorText(error)}`);
      this.lastFailure = {code: errorCode(error), category: categorize(errorCode(error))};
      this.remember({at: this.now(), program: request.program, argCount: request.args.length, cwd: request.cwd, envScope, state: 'refused', code: errorCode(error), category: categorize(errorCode(error))});
      await this.refresh(true); return {started: false, reason: errorText(error), code: errorCode(error)};
    }
    this.current = {run, label, request};
    this.log('system', `Started ${approval.normalized.executable} (pid ${run.pid}) in ${approval.normalized.cwd || 'the folder root'} · approval ${approval.approvalId.slice(0, 8)}… · spec ${approval.specHash.slice(0, 12)}…`);
    this.set('running');
    let final;
    try {
      final = await follow(this.client, run.id, {sleep: this.sleep, interval: this.interval,
        onChunks: chunks => { for (const c of chunks) this.log(c.stream, c.text.replace(/\n$/, '')); this.set(this.state); },
        onRun: view => { this.current.run = view; }});
    } catch (error) { this.log('system', `Lost contact with the run: ${errorText(error)}. Its state is unknown.`); this.lastFailure = {code: errorCode(error), category: 'monitor'}; this.current = null; this.set('error', errorText(error)); return {started: true, final: null}; }
    const seconds = (final.elapsedMs / 1000).toFixed(1);
    const outcome = final.state === 'exited' ? `exit code ${final.exitCode}` : final.state === 'timed-out' ? 'stopped by timeout' : final.state === 'cancelled' ? 'cancelled' : `failed${final.error ? `: ${final.error}` : ''}`;
    const tree = final.treeVerified ? 'process tree confirmed stopped' : 'process tree NOT confirmed stopped';
    this.log('system', `Finished: ${outcome} · ${seconds} s · ${tree}${final.leftoverTerminated ? ` · ${final.leftoverTerminated} leftover process(es) terminated` : ''}${final.droppedBytes ? ` · ${final.droppedBytes} bytes of early output dropped` : ''}.`);
    if (final.changes?.total) this.log('system', `Files changed in the folder during the run: ${final.changes.total} (attribution ${final.changes.attribution}).`);
    const category = categorize(null, final.state, final.exitCode, final.treeVerified);
    this.last = {runId: final.id, exitCode: final.exitCode, state: final.state, label, treeVerified: final.treeVerified, changes: final.changes, category, elapsedMs: final.elapsedMs, leftoverTerminated: final.leftoverTerminated || 0, timeoutSecs: request.timeoutSecs};
    if (category) this.lastFailure = {code: final.state, category};
    this.remember({at: this.now(), program: request.program, argCount: request.args.length, cwd: request.cwd, envScope, state: final.state, exitCode: final.exitCode, elapsedMs: final.elapsedMs, pid: final.pid, specHash: final.specHash.slice(0, 12), runId: final.id, treeVerified: final.treeVerified, category});
    this.current = null; await this.refresh(true);
    return {started: true, final};
  }
  async cancel() {
    if (!this.current || !['running', 'cancelling'].includes(this.state)) return {cancelled: false};
    this.set('cancelling'); this.log('system', 'Cancel requested. Waiting for the native broker to confirm the process tree stopped…');
    try { const view = await this.client.cancel(this.current.run.id); return {cancelled: view.state === 'cancelled', view}; }
    catch (error) { this.log('system', `Cancel failed: ${errorText(error)}`); return {cancelled: false}; }
  }
  clear() { this.lines = []; this.set(this.state); }
}
