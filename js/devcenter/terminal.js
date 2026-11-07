// Controlled terminal runtime. A process may start only when the backend reports an
// authorized execution capability AND the person explicitly approves this start.
// MEGA-04 ships no executing backend: the native gate reports execution "disabled".
export const TERMINAL_STATES = Object.freeze(['checking', 'unavailable', 'disabled', 'ready', 'starting', 'running', 'stopping', 'stopped', 'error']);
export const UNAVAILABLE_BROWSER = 'Terminal requires the Windows desktop app. Browsers cannot start local processes.';
const MAX_LINES = 2000;

export class NativeTerminalBackend {
  constructor(invoke = globalThis.__TAURI__?.core?.invoke) { this.invoke = invoke; this.kind = 'native'; }
  async capability() {
    if (!this.invoke) return {available: false, execution: 'unavailable', approvalRequired: true, reason: UNAVAILABLE_BROWSER};
    return this.invoke('terminal_capability');
  }
  async start(request) { return this.invoke('terminal_start', {request}); }
  async stop() { return {stopped: true}; }
}

export class TerminalRuntime {
  constructor({backend, now = () => new Date().toISOString()}) {
    this.backend = backend; this.now = now; this.state = 'checking'; this.capability = null; this.lines = []; this.listeners = new Set();
    this.session = null; this.cwdLabel = null; this.error = null;
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  set(state, error = null) { this.state = state; this.error = error; for (const fn of this.listeners) fn(this); }
  log(source, text) { this.lines.push({at: this.now(), source, text: String(text)}); if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES); }
  async refresh() {
    try {
      this.capability = await this.backend.capability();
      this.set(this.capability.available ? 'ready' : this.capability.execution === 'disabled' ? 'disabled' : 'unavailable');
    } catch (error) { this.capability = null; this.set('error', String(error?.message || error)); }
    return this.state;
  }
  /** Never calls the backend unless capability and explicit per-start approval are both present. */
  async start({cwdLabel, approved}) {
    if (this.state !== 'ready' && this.state !== 'stopped') {
      const reason = this.capability?.reason || 'Terminal execution is not available.';
      this.log('system', `Start refused: ${reason} No process was started.`); this.set(this.state, reason);
      return {started: false, reason};
    }
    if (approved !== true) {
      const reason = 'Explicit approval is required for every process start. No process was started.';
      this.log('system', reason); this.set(this.state, reason); return {started: false, reason};
    }
    this.cwdLabel = String(cwdLabel || ''); this.set('starting'); this.log('system', `Starting in ${this.cwdLabel || 'unknown directory'} after explicit approval.`);
    try {
      this.session = await this.backend.start({cwdLabel: this.cwdLabel, approvedByUser: true}, (source, text) => { this.log(source, text); this.set(this.state); });
      this.set('running'); return {started: true};
    } catch (error) {
      const reason = String(error?.message || error); this.log('system', `Start failed: ${reason}`); this.session = null; this.set('error', reason);
      return {started: false, reason};
    }
  }
  async stop() {
    if (this.state !== 'running') return {stopped: false};
    this.set('stopping');
    try { await this.backend.stop(this.session); this.log('system', 'Process stopped.'); this.session = null; this.set('stopped'); return {stopped: true}; }
    catch (error) { this.set('error', String(error?.message || error)); return {stopped: false}; }
  }
  /** Session cleanup on panel teardown or folder change. */
  async dispose() { if (this.state === 'running') await this.stop(); this.listeners.clear(); }
}
