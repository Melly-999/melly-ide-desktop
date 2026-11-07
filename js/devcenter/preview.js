// Live Preview runtime.
// Desktop: project files run in a separate, capability-free `preview` window served by the
// native melly-preview protocol (opaque sandbox, no network). The main window never embeds
// project content; diagnostics arrive through `preview_events`, not through messaging.
// Browser: a static HTML/CSS snapshot in a fully inert sandbox; project scripts never run.
export const STATIC_SANDBOX = '';
export const STATIC_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";
export const PREVIEW_SCOPE = 'Web preview only: HTML, CSS and browser JavaScript run in an isolated preview window without network, Node.js, Melly commands or filesystem access. It is not a full application runtime: no dev server, bundler, npm scripts or backend run.';
const hidden = path => path.split('/').some(part => part.startsWith('.'));

export function htmlEntries(paths) {
  return [...paths].filter(p => /\.html?$/i.test(p) && !hidden(p))
    .sort((a, b) => (b === 'index.html') - (a === 'index.html') || a.split('/').length - b.split('/').length || a.localeCompare(b));
}

function resolve(dir, ref) {
  if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return null;
  const parts = (ref.startsWith('/') ? [] : dir ? dir.split('/') : []);
  for (const part of ref.split(/[?#]/)[0].replace(/^\//, '').split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop(); } else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find(v => v !== undefined) ?? null;

export function buildStaticDocument(files, entry) {
  if (typeof files[entry] !== 'string') throw new Error(`Entry file ${entry} is not in the project.`);
  const dir = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '';
  const notes = [];
  let html = files[entry].replace(/<script\b[\s\S]*?<\/script\s*>/gi, () => { notes.push('script'); return '<!-- Melly: script not run in browser static preview -->'; });
  html = html.replace(/<link\b[^>]*>/gi, tag => {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) return '';
    const path = resolve(dir, attribute(tag, 'href'));
    if (path && !hidden(path) && typeof files[path] === 'string') return `<style>${files[path].replace(/<\/style/gi, '<\\/style')}</style>`;
    notes.push('stylesheet'); return '<!-- Melly: stylesheet unavailable in static preview -->';
  });
  html = html.replace(/<img\b[^>]*>/gi, tag => {
    const path = resolve(dir, attribute(tag, 'src'));
    if (!path || !/\.svg$/i.test(path) || hidden(path) || typeof files[path] !== 'string') return tag;
    return tag.replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, `src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(files[path])}"`);
  });
  const meta = `<meta http-equiv="Content-Security-Policy" content="${STATIC_CSP}">`;
  const head = html.match(/<head\b[^>]*>/i);
  html = head ? html.replace(head[0], head[0] + meta) : meta + html;
  return {html, scriptsRemoved: notes.filter(n => n === 'script').length, missingStyles: notes.filter(n => n === 'stylesheet').length};
}

const EVENT_KINDS = new Set(['ready', 'error', 'resource', 'blocked', 'missing', 'refused']);
// Native events are untrusted text written by previewed code; keep only the known shape.
export function cleanEvents(events) {
  return (Array.isArray(events) ? events : []).filter(e => e && EVENT_KINDS.has(e.kind) && typeof e.text === 'string').slice(-100).map(e => ({kind: e.kind, text: e.text.slice(0, 300)}));
}

export class PreviewRuntime {
  constructor({invoke = globalThis.__TAURI__?.core?.invoke} = {}) { this.invoke = invoke; this.mount = null; this.mode = invoke ? 'desktop-window' : 'browser-static'; }
  async capability() {
    if (!this.invoke) return {available: true, isolation: 'browser-static-inert-sandbox', sandbox: STATIC_SANDBOX, network: 'denied-by-csp', scripts: false};
    return {...await this.invoke('preview_capability'), scripts: true};
  }
  async open(width) { await this.invoke('preview_open', {token: this.mount.token, width: width || null}); }
  async startWorkspace(files, entry, width) {
    const text = Object.fromEntries(Object.entries(files).filter(([, v]) => typeof v === 'string'));
    if (!this.invoke) return {mode: 'static', entry, ...buildStaticDocument(text, entry)};
    this.mount = await this.invoke('preview_mount_files', {files: Object.entries(text).map(([path, content]) => ({path, content})), entry});
    await this.open(width);
    return {mode: 'window', ...this.mount};
  }
  async startFolder(sessionId, entry, width) {
    if (!this.invoke) throw new Error('Local Folder preview requires the Windows desktop app.');
    this.mount = {...await this.invoke('preview_mount_folder', {sessionId, entry}), sessionId};
    await this.open(width);
    return {mode: 'window', ...this.mount};
  }
  async resize(width) { if (this.invoke && this.mount) await this.invoke('preview_resize', {width}); }
  async events() { return this.invoke && this.mount ? cleanEvents(await this.invoke('preview_events', {token: this.mount.token})) : []; }
  async stop() {
    const mount = this.mount; this.mount = null;
    if (mount && this.invoke) { try { await this.invoke('preview_close'); } catch { /* The window may already be closed by the person. */ } }
  }
}
