// MEGA-08 client for the native execution broker (src-tauri/src/exec_broker.rs). The renderer
// only *requests*: validation, the approval dialog, tokens, limits and process control are all
// native. Nothing here can approve a run, and browsers/PWA have no execution path at all.
export const EXEC_UNAVAILABLE = 'Command and agent execution requires the Windows desktop app. Browsers and the iPhone/PWA shell cannot start local processes, and Melly never routes them to a cloud service.';
export const FINAL_RUN_STATES = Object.freeze(['exited', 'cancelled', 'timed-out', 'failed']);

/** Stable error code prefix of a native error ("SPEC_MISMATCH: …" → "SPEC_MISMATCH"). */
export function errorCode(error) {
  const text = String(error?.message ?? error ?? '');
  const match = /^([A-Z][A-Z_]+):/.exec(text);
  return match ? match[1] : 'OTHER';
}
export const errorText = error => String(error?.message ?? error ?? 'Unknown error');

/** One argument per line; no shell parsing, quoting or expansion of any kind. */
export function parseArgs(text) {
  return String(text ?? '').split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.length > 0);
}

export class BrokerClient {
  constructor(invoke = globalThis.__TAURI__?.core?.invoke) { this.invoke = invoke; }
  get available() { return typeof this.invoke === 'function'; }
  call(cmd, args) {
    if (!this.available) return Promise.reject(new Error(`UNAVAILABLE: ${EXEC_UNAVAILABLE}`));
    return this.invoke(cmd, args);
  }
  capability() { return this.call('exec_capability'); }
  enable() { return this.call('exec_enable'); }
  disable() { return this.call('exec_disable'); }
  setConcurrency(max) { return this.call('exec_set_concurrency', {max}); }
  /** Opens the native approval dialog; resolves with a single-use approval only on Yes. */
  request(request, surface) { return this.call('exec_request', {request, surface}); }
  start(request, approval, surface) { return this.call('exec_start', {request, approvalId: approval.approvalId, token: approval.token, surface}); }
  poll(runId, cursor) { return this.call('exec_poll', {runId, cursor}); }
  cancel(runId) { return this.call('exec_cancel', {runId}); }
  runs() { return this.call('exec_runs'); }
  audit() { return this.call('exec_audit'); }
  reconcile(records) { return this.call('exec_reconcile', {records}); }
  detect() { return this.call('agent_detect'); }
  probe(provider) { return this.call('agent_probe', {provider}); }
  diffSummary(sessionId, items) { return this.call('git_diff_summary', {sessionId, items}); }
}

/** Polls a native run until it reaches a final state. `onChunks` receives redacted chunks. */
export async function follow(client, runId, {onChunks = () => {}, onRun = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), interval = 300, cursor = 0, isStopped = () => false} = {}) {
  for (;;) {
    const poll = await client.poll(runId, cursor);
    if (poll.missed) onChunks([{seq: -1, stream: 'system', text: '[Earlier output was dropped: the run exceeded the 256 KiB output buffer.]\n'}]);
    if (poll.chunks.length) onChunks(poll.chunks);
    cursor = poll.nextCursor;
    onRun(poll.run, cursor);
    if (FINAL_RUN_STATES.includes(poll.run.state)) {
      const rest = await client.poll(runId, cursor);
      if (rest.chunks.length) onChunks(rest.chunks);
      onRun(rest.run, rest.nextCursor);
      return rest.run;
    }
    if (isStopped()) return poll.run;
    await sleep(interval);
  }
}
