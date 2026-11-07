// MEGA-07 local diagnostics. A bounded ring of structured events kept on this device only.
// Events carry a category, a stable code and a few allow-listed scalar fields. They never hold
// source text, file contents, file or folder names, absolute paths, credentials or tokens, and
// nothing is transmitted: an export is a file the person saves and shares deliberately.
// Front-end build identity; the native runtime reports its own via app_diagnostics.
export const BUILD = Object.freeze({product: 'Melly IDE', version: '0.7.0-alpha.3', channel: 'Public Alpha', milestone: 'v0.7.0-alpha.3'});
export const DIAGNOSTICS_KEY = 'melly.diagnostics.v1';
export const MAX_EVENTS = 300;
export const CATEGORIES = Object.freeze(['app', 'capability', 'save', 'recovery', 'preview', 'git', 'agents', 'storage']);
const DETAIL_FIELDS = new Set(['bytes', 'chars', 'count', 'state', 'from', 'to', 'kind', 'ms', 'relation', 'stage', 'source', 'records']);
const CODE = /^[A-Z][A-Z0-9_]{1,40}$/;

// Removes anything that could identify a person, a machine path or a secret.
export function sanitize(value, max = 160) {
  return String(value ?? '')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|]*/g, '<path>')
    .replace(/\\\\[^\s"'<>|]+/g, '<path>')
    .replace(/(?:^|\s)\/(?:Users|home|mnt|var|tmp|private)\/[^\s"'<>|]*/g, ' <path>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/\bBearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{8,}/g, '<redacted>')
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '<redacted>')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, max);
}
function cleanDetail(detail) {
  const out = {};
  for (const [key, value] of Object.entries(detail || {})) {
    if (!DETAIL_FIELDS.has(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = sanitize(value, 60);
  }
  return out;
}
const newRunId = () => globalThis.crypto?.randomUUID?.().replace(/-/g, '') || `run${Date.now().toString(16)}`;

export class Diagnostics {
  constructor({storage = globalThis.localStorage, now = () => new Date().toISOString(), runId = newRunId(), build = {}} = {}) {
    this.storage = storage; this.now = now; this.runId = runId; this.build = build; this.native = null;
    this.events = []; this.listeners = new Set(); this.persistError = null;
    try { const saved = JSON.parse(storage?.getItem(DIAGNOSTICS_KEY) || 'null'); if (Array.isArray(saved?.events)) this.events = saved.events.filter(e => e && CATEGORIES.includes(e.category) && CODE.test(e.code)).slice(-MAX_EVENTS); }
    catch { this.events = []; this.persistError = 'Earlier diagnostics were unreadable and were not loaded.'; }
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  record(category, code, detail = {}) {
    if (!CATEGORIES.includes(category)) category = 'app';
    code = CODE.test(code) ? code : 'OTHER';
    const event = {at: this.now(), run: this.runId, category, code, detail: cleanDetail(detail)};
    this.events.push(event); if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.persist(); for (const fn of this.listeners) fn(event);
    return event;
  }
  persist() {
    try { this.storage?.setItem(DIAGNOSTICS_KEY, JSON.stringify({version: 1, events: this.events})); this.persistError = null; }
    catch (error) { this.persistError = /quota/i.test(String(error?.name || error?.message)) ? 'Diagnostics storage is full; events are kept for this session only.' : 'Diagnostics storage is unavailable; events are kept for this session only.'; }
  }
  setNative(report) {
    // Keep only the documented shape of the native report.
    const r = report || {}, pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined).map(k => [k, typeof o[k] === 'object' ? o[k] : sanitize(o[k], 80)]));
    this.native = pick(r, ['product', 'identifier', 'version', 'build', 'os', 'arch', 'tauri', 'webview2', 'runId', 'savesOk']);
    this.native.capabilities = pick(r.capabilities || {}, ['localFolder', 'git', 'preview', 'terminal', 'agents', 'updater', 'telemetry']);
    this.native.saveFailures = Object.fromEntries(Object.entries(r.saveFailures || {}).filter(([k, v]) => CODE.test(k) && Number.isFinite(v)));
    this.native.dispatcherRejections = Object.fromEntries(Object.entries(r.dispatcherRejections || {}).filter(([k, v]) => ['preview', 'other'].includes(k) && Number.isFinite(v)));
    for (const fn of this.listeners) fn(null);
  }
  clear() { this.events = []; this.persist(); for (const fn of this.listeners) fn(null); }
  counts() { const c = {}; for (const e of this.events) c[`${e.category}.${e.code}`] = (c[`${e.category}.${e.code}`] || 0) + 1; return c; }
  report() {
    return {schema: 'melly-diagnostics/1', exportedAt: this.now(), runId: this.runId, build: {...this.build}, native: this.native,
      privacy: 'Local diagnostics only. No source text, file contents, file names, paths, credentials or tokens are recorded. Nothing was transmitted.',
      counts: this.counts(), events: this.events.map(e => ({...e, detail: {...e.detail}}))};
  }
}
