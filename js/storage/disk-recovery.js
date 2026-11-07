// MEGA-07 recovery of unsaved disk-backed buffers.
// A record is a device-local copy of UNSAVED editor text for one file of one Local Folder
// project. It is never disk data: restoring only fills the editor buffer, writing to disk stays
// an explicit Save, and a record whose disk base changed is restored as a conflict.
// Records are separate from Backup v3 and are not part of any export format.
export const PREFIX = 'melly.disk-buffer.v2:';
export const LEGACY_PREFIX = 'melly.disk-buffer.v1:';
export const MAX_CONTENT = 1024 * 1024;
const VERSION = /^[a-f0-9]{64}$/;

// FNV-1a over UTF-16 code units plus the length: detects truncated or altered records.
// An integrity check against storage corruption, not a security control.
export function checksum(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `fnv1a32:${text.length}:${hash.toString(16).padStart(8, '0')}`;
}
const isQuota = error => error?.name === 'QuotaExceededError' || error?.code === 22 || error?.code === 1014 || /quota/i.test(String(error?.message || ''));

export class DiskRecovery {
  constructor({storage = globalThis.localStorage, now = () => new Date().toISOString(), session = globalThis.crypto?.randomUUID?.() || String(Date.now())} = {}) {
    this.storage = storage; this.now = now; this.session = session;
  }
  key(project, path) { return `${PREFIX}${project}:${path}`; }
  legacyKey(project, path) { return `${LEGACY_PREFIX}${project}:${path}`; }
  // Returns {ok:true} or {ok:false, code:'TOO_LARGE'|'QUOTA'|'UNAVAILABLE'|'INVALID'}.
  write(project, path, {baseVersion, content}) {
    if (!project || !path || !VERSION.test(baseVersion || '') || typeof content !== 'string') return {ok: false, code: 'INVALID'};
    if (content.length > MAX_CONTENT) return {ok: false, code: 'TOO_LARGE'};
    const record = {v: 2, project, path, baseVersion, content, checksum: checksum(content), savedAt: this.now(), session: this.session};
    try {
      this.storage.setItem(this.key(project, path), JSON.stringify(record));
      this.storage.removeItem(this.legacyKey(project, path));
      return {ok: true};
    } catch (error) { return {ok: false, code: isQuota(error) ? 'QUOTA' : 'UNAVAILABLE'}; }
  }
  remove(project, path) {
    try { this.storage.removeItem(this.key(project, path)); this.storage.removeItem(this.legacyKey(project, path)); return true; } catch { return false; }
  }
  // status: 'ok' | 'corrupt' | 'none'. Corrupt records are never restored.
  read(project, path) {
    let text = null, legacy = false;
    try { text = this.storage.getItem(this.key(project, path)); if (text == null) { text = this.storage.getItem(this.legacyKey(project, path)); legacy = text != null; } }
    catch { return {status: 'corrupt', reason: 'Recovery storage is unavailable.'}; }
    if (text == null) return {status: 'none'};
    return this.parse(text, project, path, legacy);
  }
  parse(text, project, path, legacy) {
    let value;
    try { value = JSON.parse(text); } catch { return {status: 'corrupt', path, legacy, reason: 'Recovery metadata is not valid JSON.'}; }
    if (!value || typeof value !== 'object') return {status: 'corrupt', path, legacy, reason: 'Recovery metadata has an unknown shape.'};
    if (legacy) {
      if (value.path !== path || typeof value.content !== 'string' || value.content.length > MAX_CONTENT || !VERSION.test(value.version || '')) return {status: 'corrupt', path, legacy, reason: 'Legacy recovery record is incomplete.'};
      return {status: 'ok', legacy, record: {v: 1, project, path, baseVersion: value.version, content: value.content, savedAt: null, session: null}};
    }
    if (value.v !== 2) return {status: 'corrupt', path, legacy, reason: 'Unknown recovery record version.'};
    if (value.project !== project) return {status: 'corrupt', path, legacy, reason: 'Record belongs to a different project.'};
    if (value.path !== path) return {status: 'corrupt', path, legacy, reason: 'Record path does not match its key.'};
    if (typeof value.content !== 'string' || value.content.length > MAX_CONTENT || !VERSION.test(value.baseVersion || '')) return {status: 'corrupt', path, legacy, reason: 'Recovery record is incomplete.'};
    if (value.checksum !== checksum(value.content)) return {status: 'corrupt', path, legacy, reason: 'Recovered text failed its integrity check.'};
    return {status: 'ok', legacy, record: value};
  }
  // Every record of one project, including corrupt ones so they can be discarded explicitly.
  list(project) {
    const found = new Map();
    let keys = [];
    try { keys = Array.from({length: this.storage.length}, (_, i) => this.storage.key(i)).filter(Boolean); } catch { return []; }
    for (const [prefix, legacy] of [[PREFIX, false], [LEGACY_PREFIX, true]]) {
      const head = `${prefix}${project}:`;
      for (const key of keys) {
        if (!key.startsWith(head)) continue;
        const path = key.slice(head.length);
        if (!path || (legacy && found.has(path))) continue;
        let text = null; try { text = this.storage.getItem(key); } catch { /* listed as corrupt below */ }
        const parsed = text == null ? {status: 'corrupt', reason: 'Recovery storage is unavailable.'} : this.parse(text, project, path, legacy);
        found.set(path, {path, key, legacy, status: parsed.status, reason: parsed.reason || '', savedAt: parsed.record?.savedAt || null,
          baseVersion: parsed.record?.baseVersion || null, chars: parsed.record?.content.length ?? 0, previousSession: parsed.record ? parsed.record.session !== this.session : true});
      }
    }
    return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  }
  discard(entry) { try { this.storage.removeItem(entry.key); return true; } catch { return false; } }
}

// How a recovered buffer relates to the file on disk now.
export function relation(record, disk) {
  if (!disk || disk.exists === false) return 'missing';
  return disk.version === record.baseVersion ? 'current' : 'stale';
}
