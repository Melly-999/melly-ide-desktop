import { MobileCodeEditor, mergeTextareaInput } from './editor.js';
import { DiskRecovery, relation } from './storage/disk-recovery.js';
const MAX_TABS = 16, MAX_TEXT = 4 * 1024 * 1024, POLL_MS = 4000;
export const FOLDER_UNAVAILABLE = 'Open Folder requires the Windows desktop app. Local Workspace remains available in this browser.';
const ARTIFACT = /(^|\/)\.[^/]+\.melly-(save-[0-9a-f]{12}\.tmp|backup-[0-9a-f]{12})$/;
// Native save errors start with a stable code ("LOCKED: …"); anything else is OTHER.
export function errorCode(message) { const code = String(message).split(':')[0]; return /^[A-Z][A-Z_]{1,30}$/.test(code) ? code : 'OTHER'; }
export const SAVE_STATUS = Object.freeze({CONFLICT: 'DISK CONFLICT', MISSING: 'DELETED ON DISK', LOCKED: 'SAVE FAILED · FILE LOCKED', ACCESS_DENIED: 'SAVE FAILED · ACCESS DENIED', READ_ONLY: 'SAVE FAILED · READ-ONLY', DISK_FULL: 'SAVE FAILED · DISK FULL', INTERRUPTED: 'SAVE INTERRUPTED', ROLLBACK_FAILED: 'SAVE FAILED · CHECK DISK'});
// Line summary for the conflict dialog: common prefix/suffix trimmed, middle shown both ways.
export function conflictSummary(mine, disk, limit = 12) {
  const a = mine.split(/\r\n|\r|\n/), b = disk.split(/\r\n|\r|\n/);
  let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0; while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const mineOnly = a.slice(start, a.length - end), diskOnly = b.slice(start, b.length - end);
  return {firstLine: start + 1, mineLines: a.length, diskLines: b.length, mine: mineOnly.slice(0, limit), disk: diskOnly.slice(0, limit), more: Math.max(mineOnly.length, diskOnly.length) > limit};
}
// MEGA-09: open tabs are remembered per project (relative paths only, never content; unsaved
// content stays in the separate recovery store) so resuming a folder restores the layout.
export const TABS_KEY = 'melly-folder-tabs-v1';
const LARGE_TEXT = 256 * 1024, MAX_PROJECTS = 16;
export function rememberTabs(store, key, paths, active, at = new Date().toISOString()) {
  const projects = {...(store?.version === 1 && store.projects && typeof store.projects === 'object' ? store.projects : {})};
  if (!/^[0-9a-f]{64}$/.test(String(key))) return {version: 1, projects};
  const kept = [...new Set(paths.filter(p => typeof p === 'string' && p && p.length <= 2048))].slice(0, MAX_TABS);
  projects[key] = {paths: kept, active: kept.includes(active) ? active : kept[0] || null, at};
  const newest = Object.entries(projects).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, MAX_PROJECTS);
  return {version: 1, projects: Object.fromEntries(newest)};
}
/** Short tab labels: the file name, plus its parent folder when two open files share a name. */
export function tabLabels(paths) {
  const base = p => p.slice(p.lastIndexOf('/') + 1), counts = new Map();
  for (const p of paths) counts.set(base(p), (counts.get(base(p)) || 0) + 1);
  return new Map(paths.map(p => { const parts = p.split('/'); return [p, counts.get(base(p)) > 1 && parts.length > 1 ? `${base(p)} — ${parts.at(-2)}` : base(p)]; }));
}
/** Character offset of a 1-based line and column (clamped to the text). */
export function lineOffset(text, line = 1, column = 1) {
  let offset = 0;
  for (let n = 1; n < line; n++) { const next = text.indexOf('\n', offset); if (next < 0) return text.length; offset = next + 1; }
  const end = text.indexOf('\n', offset);
  return Math.min(offset + Math.max(0, column - 1), end < 0 ? text.length : end);
}
export class LocalFolder {
  constructor(app, invoke = globalThis.__TAURI__?.core?.invoke) {
    this.app = app; this.invoke = invoke; this.session = null; this.generation = 0;
    this.directories = new Map(); this.expanded = new Set(); this.tabs = new Map(); this.activePath = null;
    this.pending = new Set(); this.preview = null; this.busy = false;
    this.diskFiles = new Map(); this.saving = false; this.recovery = new DiskRecovery(); this.recoveryError = null;
  }
  diag(category, code, detail) { try { this.app.diagnostics?.record(category, code, detail); } catch { /* diagnostics never block editing */ } }
  init() {
    const toolbar = document.querySelector('.workbench-toolbar');
    const controls = document.createElement('div'); controls.className = 'local-folder-controls';
    controls.innerHTML = '<button id="localFolderOpen">Open Folder</button><button id="localFolderClose" hidden>Close Folder</button><button id="localWorkspaceReturn" hidden>Local Workspace</button>';
    toolbar.append(controls);
    this.panel = document.createElement('section'); this.panel.className = 'local-folder'; this.panel.setAttribute('aria-label', 'Local Folder');
    this.panel.innerHTML = '<h2>Local Folder <small>DISK FILES · EXPLICIT SAVE</small></h2><p id="localFolderName"></p><p id="localFolderStatus" role="status" aria-live="polite"></p><button id="localFolderRefresh" hidden>Refresh folder</button><button id="localFileReload" hidden>Reload file from disk</button><button id="localBufferRestore" hidden>Restore unsaved buffer</button><button id="localConflictReview" hidden>Review disk conflict</button>'
      + '<section id="localRecent" class="local-recent" aria-label="Recent folders" hidden></section>'
      + '<div id="localFolderNav" class="local-folder-nav" hidden><button type="button" id="localQuickOpen">Go to file… <kbd>Ctrl+P</kbd></button><button type="button" id="localFindInFiles">Find in files… <kbd>Ctrl+Shift+F</kbd></button></div>'
      + '<section id="localRecoveryPanel" class="local-recovery" aria-label="Unsaved buffers from earlier sessions" hidden></section>'
      + '<section id="localInterrupted" class="local-recovery" aria-label="Interrupted save" role="alert" hidden></section>'
      + '<div id="localFolderTree" role="tree" aria-label="Local Folder files"></div>';
    this.app.workspace.root.prepend(this.panel);
    this.previewHost = document.createElement('div'); this.previewHost.id = 'folderPreviewEditor'; this.previewHost.hidden = true;
    document.getElementById('editorContainer').after(this.previewHost);
    this.dialog = document.createElement('dialog'); this.dialog.id = 'diskConflictDialog'; this.dialog.className = 'disk-conflict'; this.dialog.setAttribute('aria-labelledby', 'diskConflictTitle');
    document.body.append(this.dialog);
    // Escape closes only this dialog (keeping the buffer), not the explorer behind it.
    this.dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    // MEGA-09: closing a tab with unsaved edits always asks; nothing is discarded silently.
    this.closeDialog = document.createElement('dialog'); this.closeDialog.id = 'closeTabDialog'; this.closeDialog.className = 'disk-conflict'; this.closeDialog.setAttribute('aria-labelledby', 'closeTabTitle');
    this.closeDialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    document.body.append(this.closeDialog);
    document.getElementById('localFolderOpen').addEventListener('click', () => void this.open());
    document.getElementById('localFolderClose').addEventListener('click', () => void this.close());
    document.getElementById('localWorkspaceReturn').addEventListener('click', () => this.showWorkspace());
    this.panel.querySelector('#localFolderRefresh').addEventListener('click', () => { this.directories.clear(); this.expanded.clear(); this.index = null; this.renderTree(); void this.load(''); });
    this.panel.querySelector('#localFileReload').addEventListener('click', () => { if (this.activePath) void this.openFile(this.activePath, true); });
    this.panel.querySelector('#localBufferRestore').addEventListener('click', () => this.restoreBuffer());
    this.panel.querySelector('#localConflictReview').addEventListener('click', () => void this.showConflict());
    this.previewHost.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); void this.save(); } });
    window.addEventListener('focus', () => void this.checkExternal());
    window.addEventListener('beforeunload', event => { if (this.hasUnsaved()) { event.preventDefault(); event.returnValue = ''; } });
    this.panel.addEventListener('keydown', event => {
      const rows = [...this.panel.querySelectorAll('[role="treeitem"]')]; const index = rows.indexOf(event.target);
      if (index < 0) return;
      if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length-1 : Math.max(0, Math.min(rows.length-1, index + (event.key === 'ArrowDown' ? 1 : -1))); rows[next]?.focus();
      } else if (['ArrowRight','ArrowLeft'].includes(event.key) && event.target.dataset.kind === 'folder') {
        event.preventDefault(); const open = this.expanded.has(event.target.dataset.path);
        if ((event.key === 'ArrowRight' && !open) || (event.key === 'ArrowLeft' && open)) event.target.click();
      }
    });
    if (!this.invoke) document.getElementById('localFolderOpen').title = FOLDER_UNAVAILABLE;
    this.message(this.invoke ? 'Select a folder. Disk changes require explicit Save; unsaved buffers stay on this device.' : FOLDER_UNAVAILABLE);
    void this.refreshRecent();
  }
  emit(name) { document.dispatchEvent(new Event(name)); }
  // ---------- MEGA-09 recent folders (paths stay native; the WebView sees key, name, time) ----------
  async refreshRecent() {
    const host = this.panel?.querySelector('#localRecent'); if (!host) return;
    let list = [];
    if (this.invoke && !this.session) { try { list = await this.invoke('folder_recent'); } catch { list = []; } }
    this.recentList = Array.isArray(list) ? list : [];
    if (this.session || !this.recentList.length) { host.hidden = true; host.replaceChildren(); return; }
    const h = (tag, attrs = {}, text = '') => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text) el.textContent = text; return el; };
    const ul = h('ul');
    for (const entry of this.recentList) {
      const li = h('li', {'data-recent': entry.key});
      const when = entry.lastOpened ? new Date(entry.lastOpened * 1000).toLocaleString() : 'unknown time';
      li.append(h('strong', {}, entry.name), h('small', {}, ` · last opened ${when}${entry.available ? '' : ' · not found on this device'}`));
      const resume = h('button', {type: 'button', 'data-recent-action': 'resume'}, 'Resume…'); resume.disabled = !entry.available || this.busy;
      resume.setAttribute('aria-label', `Resume ${entry.name} (opens the Windows folder dialog at this folder)`);
      resume.addEventListener('click', () => void this.resume(entry.key));
      const forget = h('button', {type: 'button', class: 'quiet-button', 'data-recent-action': 'forget'}, 'Forget');
      forget.setAttribute('aria-label', `Remove ${entry.name} from recent folders (files are not touched)`);
      forget.addEventListener('click', () => void this.forget(entry.key));
      li.append(resume, forget); ul.append(li);
    }
    host.replaceChildren(h('h3', {}, 'Recent folders'), h('p', {class: 'fine-print'}, 'Resume opens the Windows folder dialog at that folder; press Select Folder to confirm. Melly never reopens a folder on its own.'), ul);
    host.hidden = false;
  }
  async forget(key) {
    try { await this.invoke('folder_forget', {key}); this.message('Removed from recent folders. No files were touched.'); } catch (error) { this.message(String(error?.message || error), true); }
    await this.refreshRecent();
  }
  resume(key) { return this.openWith(() => this.invoke('folder_resume', {key}), 'Confirm the folder in the Windows dialog (it opens at the recent folder)…'); }
  message(text, error = false) { const el = this.panel?.querySelector('#localFolderStatus'); if (el) { el.textContent = text; el.dataset.error = String(error); } }
  open() { return this.openWith(() => this.invoke('folder_open'), 'Choose an existing local folder in the Windows dialog…'); }
  async openWith(call, prompt) {
    if (!this.invoke) { this.message(FOLDER_UNAVAILABLE); this.app.shell.toggleExplorer(true); return; }
    if (this.busy || this.session) { this.message('Close the current Local Folder before selecting another.'); return; }
    this.busy = true; document.getElementById('localFolderOpen').disabled = true;
    this.message(prompt);
    try {
      const session = await call();
      if (!session) { this.message('Folder selection canceled. Local Workspace is unchanged.'); return; }
      this.session = session; ++this.generation; this.index = null;
      this.panel.querySelector('#localFolderName').textContent = session.name;
      document.getElementById('localFolderClose').hidden = false;
      document.getElementById('localWorkspaceReturn').hidden = false;
      this.panel.querySelector('#localFolderRefresh').hidden = false;
      this.panel.querySelector('#localFolderNav').hidden = false;
      this.app.shell.toggleExplorer(true);
      await this.load('');
      void this.renderRecoveryPanel();
      this.startPolling();
      this.emit('melly:folder-opened');
      await this.restoreTabs();
    } catch (error) { this.message(String(error?.message || error), true); }
    finally { this.busy = false; document.getElementById('localFolderOpen').disabled = !!this.session; void this.refreshRecent(); }
  }
  // ---------- MEGA-09 tab memory, closing tabs, navigation ----------
  readTabs() { try { const s = JSON.parse(globalThis.localStorage?.getItem(TABS_KEY) || 'null'); return s?.version === 1 ? s : {version: 1, projects: {}}; } catch { return {version: 1, projects: {}}; } }
  persistTabs() {
    const key = this.session?.recoveryKey; if (!key || this.restoring) return;
    try { globalThis.localStorage?.setItem(TABS_KEY, JSON.stringify(rememberTabs(this.readTabs(), key, [...this.tabs.keys()], this.activePath))); } catch { /* tab memory is a convenience */ }
  }
  async restoreTabs() {
    const saved = this.readTabs().projects[this.session?.recoveryKey];
    if (!saved?.paths?.length) return;
    const generation = this.generation; let failed = 0, opened = 0;
    this.restoring = true;
    try {
      for (const path of saved.paths) {
        if (generation !== this.generation) return;
        if (await this.openFile(path)) opened++; else failed++;
      }
    } finally { this.restoring = false; }
    if (generation !== this.generation) return;
    if (saved.active && this.tabs.has(saved.active) && this.activePath !== saved.active) { this.activePath = saved.active; this.renderPreview(); this.renderTree(); }
    this.persistTabs();
    this.message(`Restored ${opened} tab(s) from your last session${failed ? ` · ${failed} could not be reopened (moved, deleted, too large or unreadable)` : ''}. Unsaved buffers, if any, are listed above.`, failed > 0);
  }
  confirmClose(path) {
    const d = this.closeDialog, h = (tag, attrs = {}, text = '') => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text) el.textContent = text; return el; };
    return new Promise(resolve => {
      const actions = h('div', {class: 'disk-conflict-actions'});
      const add = (id, text, value, primary = false) => { const b = h('button', {type: 'button', id, class: primary ? 'primary-button' : 'quiet-button'}, text); b.addEventListener('click', () => d.close(value)); actions.append(b); return b; };
      d.replaceChildren(h('h2', {id: 'closeTabTitle'}, `${path} has unsaved changes`),
        h('p', {}, 'Save writes your buffer to disk now. Keep closes the tab and leaves the buffer in this device’s recovery list, where you can restore it later. Nothing is discarded.'));
      const save = add('closeTabSave', 'Save and close', 'save', true); add('closeTabKeep', 'Close, keep unsaved buffer in recovery', 'keep'); add('closeTabCancel', 'Cancel', 'cancel');
      const file = this.diskFiles.get(path);
      if (file?.conflict || file?.missing) { save.disabled = true; save.title = 'Saving is blocked by a disk conflict; review it first.'; }
      d.append(actions);
      d.returnValue = 'cancel';
      d.addEventListener('close', () => resolve(d.returnValue || 'cancel'), {once: true});
      d.showModal(); (save.disabled ? d.querySelector('#closeTabCancel') : save).focus();
    });
  }
  async closeTab(path = this.activePath) {
    if (!path || !this.tabs.has(path) || this.saving || this.closing) return false;
    this.closing = true;
    try {
      if (this.isDirty(path)) {
        const choice = await this.confirmClose(path);
        if (choice === 'cancel' || !this.tabs.has(path)) { this.preview?.query('.editor-textarea')?.focus(); return false; }
        if (choice === 'save') {
          this.activePath = path; await this.save();
          if (this.isDirty(path)) { this.message(`${path} was not saved, so its tab stays open.`, true); return false; }
        } else this.persistBuffer(path);
      }
      const order = [...this.tabs.keys()], index = order.indexOf(path);
      this.tabs.delete(path); this.diskFiles.delete(path);
      if (this.activePath === path) this.activePath = order[index + 1] ?? order[index - 1] ?? null;
      if (this.tabs.size) this.renderPreview(); else this.renderEmptyEditor();
      this.renderTree(); this.persistTabs(); void this.renderRecoveryPanel();
      this.message(`Closed ${path}.${this.recovered(path) ? ' Its unsaved buffer is kept in recovery on this device.' : ''}`);
      (this.previewHost.querySelector('.tab-btn.active') || this.previewHost.querySelector('.folder-empty-editor h2'))?.focus?.();
      return true;
    } finally { this.closing = false; }
  }
  renderEmptyEditor() {
    this.preview = null; this.activePath = null; this.panel.querySelector('#localFileReload').hidden = true;
    const box = document.createElement('div'); box.className = 'folder-empty-editor';
    const title = document.createElement('h2'); title.tabIndex = -1; title.textContent = 'No file open';
    const text = document.createElement('p'); text.textContent = 'Choose a file in the tree, press Ctrl+P to go to a file, or Ctrl+Shift+F to search the folder. Ctrl+Shift+P lists every command.';
    box.append(title, text); this.previewHost.replaceChildren(box);
  }
  /** Shows the file name in each tab (full path in the tooltip and path bar) and adds close buttons. */
  decorate() {
    const host = this.previewHost, switcher = host.querySelector('.editor-tab-switcher'); if (!switcher) return;
    const labels = tabLabels([...this.tabs.keys()]);
    for (const tab of [...switcher.querySelectorAll('.tab-btn')]) {
      const path = tab.dataset.file, marker = tab.querySelector('.tab-dirty-marker');
      tab.textContent = labels.get(path) || path; tab.title = path; if (marker) tab.append(' ', marker);
      if (path === this.activePath) tab.setAttribute('aria-current', 'true'); else tab.removeAttribute('aria-current');
      const close = document.createElement('button'); close.type = 'button'; close.className = 'tab-close'; close.dataset.closeTab = path;
      close.setAttribute('aria-label', `Close ${path}`); close.title = `Close ${path} (Ctrl+W)`; close.textContent = '×';
      close.addEventListener('click', event => { event.stopPropagation(); void this.closeTab(path); });
      tab.after(close);
    }
    let bar = host.querySelector('.editor-pathbar');
    if (!bar) { bar = document.createElement('p'); bar.className = 'editor-pathbar'; bar.id = 'folderEditorPath'; host.querySelector('.editor-header')?.after(bar); }
    const text = this.tabs.get(this.activePath) || '', large = text.length > LARGE_TEXT;
    bar.textContent = `${this.session?.name || 'Local Folder'} › ${(this.activePath || '').split('/').join(' › ')}${large ? ` · large file (${Math.round(text.length / 1024)} KiB): line numbers stop at 10 000` : ''}`;
    bar.title = this.activePath || ''; bar.dataset.large = String(large);
  }
  /** Opens `path` and places the caret at a 1-based line/column (used by Find in Files and Go to Line). */
  async reveal(path, line = 1, column = 1) {
    if (!(await this.openFile(path))) return false;
    const textarea = this.preview?.query('.editor-textarea'); if (!textarea) return false;
    const offset = lineOffset(textarea.value, line, column);
    textarea.focus({preventScroll: true}); textarea.setSelectionRange(offset, offset);
    const height = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
    textarea.scrollTop = Math.max(0, (line - 3) * height);
    this.message(`${path} · line ${line}${column > 1 ? `, column ${column}` : ''}`);
    return true;
  }
  /** Bounded native file list for Go to File, cached per session. Older bridges fall back to loaded folders. */
  async fileIndex(refresh = false) {
    if (!this.session) throw Error('Open a Local Folder first.');
    if (!refresh && this.index?.generation === this.generation) return this.index;
    const generation = this.generation; let result;
    try { result = await this.invoke('folder_index', {sessionId: this.session.sessionId}); }
    catch (error) {
      if (!/not allowed|unknown command|not found/i.test(String(error?.message || error))) throw error;
      result = {files: [...this.directories.values()].flat().filter(e => e.kind === 'file').map(e => e.path), skipped: [], blocked: 0, truncated: 'loaded-folders-only'};
    }
    if (generation !== this.generation) throw Error('The folder changed while it was being indexed.');
    this.index = {...result, generation};
    return this.index;
  }
  searchText(query, caseSensitive = false) {
    if (!this.session) return Promise.reject(Error('Open a Local Folder first.'));
    return this.invoke('folder_search', {sessionId: this.session.sessionId, query, caseSensitive});
  }
  async load(path) {
    if (!this.session || this.pending.has(path)) return;
    const generation = this.generation; this.pending.add(path); this.renderTree();
    this.message(`Loading ${path || this.session.name}…`);
    try {
      const result = await this.invoke('folder_list', {sessionId: this.session.sessionId, path});
      if (generation !== this.generation) return;
      const cached = [...this.directories.values()].reduce((sum, entries) => sum + entries.length, 0);
      if (!this.directories.has(path) && (this.directories.size >= 64 || cached + result.entries.length > 10000)) throw Error('Directory cache limit reached. Refresh folder to release cached entries.');
      this.directories.set(path, result.entries); this.message('Local Folder · disk files. Save explicitly; external changes are checked automatically.');
    } catch (error) { if (generation === this.generation) { this.directories.delete(path); this.message(String(error?.message || error), true); } }
    finally { if (generation === this.generation) { this.pending.delete(path); this.renderTree(); } }
  }
  renderTree() {
    const tree = this.panel.querySelector('#localFolderTree'); const focused = document.activeElement?.dataset.path; tree.replaceChildren();
    let visible = 0;
    const append = (path, depth) => {
      if (this.pending.has(path)) { const p = document.createElement('p'); p.textContent = 'Loading…'; tree.append(p); }
      const entries = this.directories.get(path); if (!entries) return;
      if (!entries.length) { const p = document.createElement('p'); p.textContent = 'Empty directory'; p.style.paddingLeft = `${depth * 16}px`; tree.append(p); }
      for (const entry of entries) {
        if (++visible > 2000) { this.message('Visible tree limit (2000 items) reached. Collapse folders to continue.'); return; }
        const row = document.createElement('button'); row.type = 'button'; row.className = 'local-folder-row';
        row.dataset.path = entry.path; row.dataset.kind = entry.kind; row.setAttribute('role','treeitem'); row.setAttribute('aria-level',String(depth+1));
        row.style.paddingLeft = `${8 + depth * 16}px`; row.title = entry.path;
        const expanded = this.expanded.has(entry.path), artifact = entry.kind === 'file' && ARTIFACT.test(entry.path);
        row.textContent = `${entry.kind === 'folder' ? (expanded ? '▾ 📂 ' : '▸ 📁 ') : entry.kind === 'blocked' ? '⊘ ' : artifact ? '⚠ ' : '◇ '}${entry.name}`;
        row.setAttribute('aria-label',`${artifact ? 'interrupted-save artifact' : entry.kind}: ${entry.path}`);
        if (entry.kind === 'folder') row.setAttribute('aria-expanded',String(expanded));
        else row.setAttribute('aria-selected',String(entry.path === this.activePath));
        row.disabled = entry.kind === 'blocked';
        row.addEventListener('click', () => {
          if (entry.kind === 'folder') {
            if (this.expanded.has(entry.path)) this.expanded.delete(entry.path); else { this.expanded.add(entry.path); if (!this.directories.has(entry.path)) void this.load(entry.path); }
            this.renderTree();
          } else void this.openFile(entry.path);
        });
        tree.append(row);
        if (entry.kind === 'folder' && expanded) append(entry.path,depth+1);
      }
    };
    append('',0);
    if (focused) [...tree.querySelectorAll('[data-path]')].find(row => row.dataset.path === focused)?.focus();
  }
  async openFile(path, reload = false) {
    if (!this.session || this.saving) return false;
    if (!reload && this.tabs.has(path)) { this.activePath = path; this.renderPreview(); this.renderTree(); this.persistTabs(); return true; }
    if (reload && this.isDirty(path) && !window.confirm('Reload disk content and replace this unsaved buffer? Your buffer remains in local recovery until a successful save.')) return false;
    const generation = this.generation; const request = this.readRequest = Symbol(); this.message(`Reading ${path}…`);
    try {
      const file = await this.invoke('folder_read',{sessionId:this.session.sessionId,path});
      if (generation !== this.generation || request !== this.readRequest) return false;
      if (!this.tabs.has(path) && this.tabs.size >= MAX_TABS) throw Error('Preview limit (16 tabs) reached. Close Folder to release previews.');
      const total = [...this.tabs].reduce((sum,[key,text]) => sum + (key === path ? 0 : text.length),0) + file.content.length;
      if (total > MAX_TEXT) throw Error('Preview memory limit (4 MiB of text) reached. Close Folder to release previews.');
      this.tabs.set(path,file.content); this.diskFiles.set(path,{...file, base:file.content, conflict:false, missing:false, status:null}); this.activePath = path; this.renderPreview(); this.renderTree();
      this.panel.querySelector('#localFileReload').hidden = false; this.persistTabs();
      this.message(`${path} · ${file.bytes} bytes · ${ARTIFACT.test(path) ? 'interrupted-save artifact · read-only' : 'disk file'}${file.content.length > LARGE_TEXT ? ' · large file: line numbers are limited' : ''}. External changes are checked automatically.`);
      this.renderInterrupted(path, file.interrupted || [], true);
      return true;
    } catch (error) {
      if (generation === this.generation && request === this.readRequest) {
        this.message(String(error?.message || error),true);
        if (/^Missing/.test(String(error?.message || error))) void this.checkInterrupted(path);
      }
      return false;
    }
  }
  renderPreview() {
    this.preview = new MobileCodeEditor('folderPreviewEditor',{files:Object.fromEntries(this.tabs),activeFilename:this.activePath,readOnly:true});
    const setFile = this.preview.setFile.bind(this.preview);
    this.preview.setFile = path => { this.activePath = path; setFile(path); this.configureDiskEditor(); this.decorate(); this.renderTree(); this.persistTabs(); this.message(`${path} · disk file. Save explicitly.`); void this.checkExternal(); };
    void this.preview.init();
    document.getElementById('editorContainer').hidden = true; this.previewHost.hidden = false;
    document.getElementById('viewStudio').classList.add('local-folder-preview');
    this.configureDiskEditor();
    this.decorate();
  }
  isDirty(path) { return this.diskFiles.has(path) && this.tabs.get(path) !== this.diskFiles.get(path).base; }
  hasUnsaved() { return [...this.tabs.keys()].some(path => this.isDirty(path)); }
  // Kept for compatibility with earlier QA harnesses; records are now v2 (see disk-recovery.js).
  recoveryKey(path) { return this.session?.recoveryKey ? this.recovery.key(this.session.recoveryKey, path) : null; }
  recovered(path) {
    if (!this.session?.recoveryKey) return null;
    const found = this.recovery.read(this.session.recoveryKey, path);
    return found.status === 'ok' ? {...found.record, version: found.record.baseVersion} : null;
  }
  persistBuffer(path) {
    const file=this.diskFiles.get(path), project=this.session?.recoveryKey; if (!project || !file?.version || ARTIFACT.test(path)) return;
    if (!this.isDirty(path)) { this.recovery.remove(project, path); return; }
    const result = this.recovery.write(project, path, {baseVersion: file.version, content: this.tabs.get(path)});
    if (result.ok) { if (this.recoveryError) { this.recoveryError = null; this.diag('recovery', 'STORAGE_OK'); } return; }
    if (this.recoveryError !== result.code) this.diag('recovery', `WRITE_${result.code}`, {chars: this.tabs.get(path).length});
    this.recoveryError = result.code;
    this.message(result.code === 'QUOTA' ? 'Recovery storage is full. This unsaved buffer is NOT protected against a restart: Save it, or discard old recovery buffers below.' : result.code === 'TOO_LARGE' ? 'Buffer exceeds the 1 MiB recovery limit and is not protected against a restart. Save explicitly.' : 'Recovery storage unavailable. Keep this window open and save explicitly.', true);
  }
  restoreBuffer(path = this.activePath) {
    const recovered=this.recovered(path); if (!recovered || this.saving) return false;
    const file=this.diskFiles.get(path); if (!file) return false;
    file.conflict=file.version!==recovered.baseVersion; if (file.conflict) file.diskVersion=file.version; file.version=recovered.baseVersion;
    this.tabs.set(path,recovered.content); this.activePath=path; this.renderPreview();
    this.diag('recovery', file.conflict ? 'RESTORED_STALE' : 'RESTORED', {chars: recovered.content.length});
    this.message(file.conflict ? 'Recovered buffer conflicts with disk. Save is refused until you reload and reconcile.' : 'Unsaved buffer restored. Review and Save explicitly.', file.conflict);
    void this.renderRecoveryPanel();
    return true;
  }
  // Lists every recovery record of this project after the folder opens (or after a restart).
  async renderRecoveryPanel() {
    const host = this.panel.querySelector('#localRecoveryPanel'), project = this.session?.recoveryKey, generation = this.generation;
    if (!project) { host.hidden = true; host.replaceChildren(); return; }
    const entries = this.recovery.list(project).filter(e => !this.isDirty(e.path));
    if (!entries.length) { host.hidden = true; host.replaceChildren(); return; }
    const relations = await Promise.all(entries.map(e => e.status === 'ok' ? this.diskVersion(e.path).then(d => relation(e, d)).catch(() => 'unknown') : 'corrupt'));
    if (generation !== this.generation) return;
    this.diag('recovery', 'LISTED', {records: entries.length, count: entries.filter(e => e.status !== 'ok').length});
    const labels = {current: 'disk unchanged since the buffer was recorded', stale: 'STALE · the disk file changed since; restoring opens a conflict', missing: 'the file no longer exists on disk', unknown: 'disk state unknown', corrupt: 'CORRUPTED · cannot be restored'};
    const h = (tag, attrs = {}, text = '') => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text) el.textContent = text; return el; };
    const list = h('ul');
    entries.forEach((entry, i) => {
      const li = h('li', {'data-recovery-path': entry.path, 'data-relation': relations[i]});
      li.append(h('strong', {}, entry.path), h('small', {}, ` · ${entry.chars} characters · ${entry.savedAt ? new Date(entry.savedAt).toLocaleString() : 'earlier version of Melly'} · ${labels[relations[i]]}${entry.reason ? ` · ${entry.reason}` : ''}`));
      if (entry.status === 'ok' && relations[i] !== 'missing') { const b = h('button', {type: 'button', 'data-recovery-action': 'restore'}, 'Open and restore'); b.addEventListener('click', () => void this.restoreFromPanel(entry.path)); li.append(b); }
      const d = h('button', {type: 'button', 'data-recovery-action': 'discard', class: 'quiet-button'}, 'Discard'); d.addEventListener('click', () => this.discardRecovery(entry)); li.append(d);
      list.append(li);
    });
    host.replaceChildren(h('h3', {}, `Unsaved buffers on this device (${entries.length})`), h('p', {class: 'fine-print'}, 'These are local copies of edits that were never saved to disk. Restoring fills the editor only; nothing is written until you Save.'), list);
    host.hidden = false;
  }
  async restoreFromPanel(path) {
    if (!this.tabs.has(path) && !(await this.openFile(path))) return;
    this.activePath = path; this.restoreBuffer(path);
  }
  discardRecovery(entry) {
    if (!window.confirm(`Discard the unsaved buffer for ${entry.path}? This removes only the local recovery copy; the disk file is not touched.`)) return;
    this.recovery.discard(entry); this.diag('recovery', 'DISCARDED'); void this.renderRecoveryPanel(); this.updateDiskStatus();
  }
  // Native folder_version is cheap (hash only). Older or mock bridges fall back to folder_read.
  async diskVersion(path) {
    const sessionId = this.session.sessionId;
    try { const v = await this.invoke('folder_version', {sessionId, path}); if (v && typeof v.exists === 'boolean') return v; } catch (error) { if (errorCode(error?.message || error) !== 'OTHER' || !/not allowed|unknown command|not found/i.test(String(error?.message || error))) throw error; }
    try { const f = await this.invoke('folder_read', {sessionId, path}); return {exists: true, version: f.version, bytes: f.bytes, content: f.content, interrupted: f.interrupted || []}; }
    catch (error) { if (/^Missing/.test(String(error?.message || error))) return {exists: false, version: '', bytes: 0, interrupted: []}; throw error; }
  }
  configureDiskEditor() {
    const file=this.diskFiles.get(this.activePath), editable=/^[a-f0-9]{64}$/.test(file?.version || '') && !ARTIFACT.test(this.activePath || '');
    if (!editable) return; // An older native bridge, and interrupted-save artifacts, stay read-only.
    const textarea=this.preview.query('.editor-textarea'), save=this.preview.query('#editorSaveBtn');
    textarea.readOnly=false;
    if (!textarea.dataset.diskBound) { textarea.dataset.diskBound='true'; textarea.addEventListener('input',()=>{
      const path=this.activePath, content=mergeTextareaInput(this.tabs.get(path),textarea.value);
      this.tabs.set(path,content); this.preview.files[path]=content; this.persistBuffer(path); this.updateDiskStatus();
    }); save.addEventListener('click',()=>void this.save()); }
    save.title='Save this existing file to the selected disk folder';
    this.preview.query('#editorSaveDetail').textContent='UTF-8 disk file · explicit atomic Save · conflicts refuse overwrite · separate local recovery buffer.';
    this.updateDiskStatus();
  }
  updateDiskStatus() {
    const path=this.activePath, file=this.diskFiles.get(path); if (!file?.version || !this.preview) return;
    const status = this.saving ? 'SAVING TO DISK' : file.missing ? SAVE_STATUS.MISSING : file.conflict ? SAVE_STATUS.CONFLICT : file.status && this.isDirty(path) ? SAVE_STATUS[file.status] || 'SAVE FAILED' : this.isDirty(path) ? 'UNSAVED · DISK FILE' : 'SAVED ON DISK';
    const label = this.preview.query('#editorSaveStatus'); label.textContent = status; label.dataset.state = this.saving ? 'saving' : file.missing || file.conflict ? 'conflict' : file.status ? 'error' : this.isDirty(path) ? 'dirty' : 'saved';
    this.preview.query('#editorSaveBtn').disabled=this.saving || file.conflict || file.missing || !this.isDirty(path);
    const recovery=this.panel.querySelector('#localBufferRestore'); recovery.hidden=!this.recovered(path) || this.isDirty(path);
    this.panel.querySelector('#localConflictReview').hidden=!(file.conflict || file.missing);
    for (const tab of this.previewHost.querySelectorAll('.tab-btn')) { const dirty=this.isDirty(tab.dataset.file); tab.querySelector('.tab-dirty-marker').hidden=!dirty; tab.setAttribute('aria-label',`${tab.dataset.file}${dirty?' · unsaved':''}`); }
  }
  startPolling() {
    clearInterval(this.poll);
    this.poll = setInterval(() => { if (!document.hidden) void this.checkExternal(); }, POLL_MS);
  }
  async checkExternal() {
    const path=this.activePath, file=this.diskFiles.get(path), generation=this.generation;
    if (!this.session || !file?.version || this.saving || this.checking || ARTIFACT.test(path || '')) return;
    this.checking = true;
    try { const current=await this.diskVersion(path);
      if (generation!==this.generation || file!==this.diskFiles.get(path) || this.saving) return;
      if (!current.exists) {
        if (!file.missing) { file.missing=true; this.diag('save', 'EXTERNAL_DELETE'); this.message(`${path} was deleted or renamed on disk. Your buffer is preserved; Save is disabled for a missing file. Select Review disk conflict for options.`,true); }
      } else if (current.version!==(file.diskVersion || file.version)) {
        if (!this.isDirty(path) && !file.conflict) {
          // No unsaved edits: show the new disk content instead of a stale snapshot. Disk is not written.
          const text = current.content ?? (await this.invoke('folder_read',{sessionId:this.session.sessionId,path})).content;
          if (generation!==this.generation || file!==this.diskFiles.get(path) || this.isDirty(path)) return;
          Object.assign(file,{version:current.version,base:text,content:text,missing:false,diskVersion:null}); this.tabs.set(path,text); this.renderPreview();
          this.diag('save', 'EXTERNAL_RELOAD'); this.message(`${path} changed on disk and was reloaded (this buffer had no unsaved edits).`);
        } else if (!file.conflict || file.diskVersion !== current.version) {
          file.conflict=true; file.missing=false; file.diskVersion=current.version; this.diag('save', 'EXTERNAL_CHANGE');
          this.message('File changed on disk. Your buffer is preserved. Select Review disk conflict before saving.',true);
        }
      } else if (file.missing) { file.missing=false; this.message(`${path} is back on disk with the version your buffer is based on.`); }
      this.renderInterrupted(path, current.interrupted || []);
      if(path===this.activePath)this.updateDiskStatus();
    } catch(error) { if(generation===this.generation) { this.message(String(error?.message || error),true); } }
    finally { this.checking = false; }
  }
  async checkInterrupted(path) {
    try { const v = await this.diskVersion(path); this.renderInterrupted(path, v.interrupted || [], true); } catch { /* reported by the read that failed */ }
  }
  renderInterrupted(path, artifacts, announce = false) {
    const host = this.panel.querySelector('#localInterrupted');
    if (!artifacts.length) { if (host.dataset.path === path) { host.hidden = true; host.replaceChildren(); delete host.dataset.path; } return; }
    if (announce) this.diag('save', 'INTERRUPTED_FOUND', {count: artifacts.length});
    host.dataset.path = path; host.replaceChildren();
    const title = document.createElement('h3'); title.textContent = `Interrupted save detected for ${path}`;
    const note = document.createElement('p'); note.className = 'fine-print'; note.textContent = 'A previous save did not finish. Melly changed nothing automatically. Open a copy read-only to compare; restore it only if the file is missing.';
    const list = document.createElement('ul');
    for (const artifact of artifacts) {
      const li = document.createElement('li'); li.dataset.artifact = artifact.path;
      const label = document.createElement('span'); label.textContent = `${artifact.kind === 'original' ? 'Previous version' : 'Unfinished new version'} · ${artifact.bytes} bytes`;
      const view = document.createElement('button'); view.type = 'button'; view.textContent = 'Open read-only'; view.addEventListener('click', () => void this.openFile(artifact.path));
      li.append(label, view);
      if (artifact.version) {
        const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = 'Restore as file'; restore.dataset.action = 'restore'; restore.addEventListener('click', () => void this.resolveInterrupted(path, artifact, 'restore'));
        const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'quiet-button'; discard.textContent = 'Discard copy'; discard.dataset.action = 'discard'; discard.addEventListener('click', () => void this.resolveInterrupted(path, artifact, 'discard'));
        li.append(restore, discard);
      }
      list.append(li);
    }
    host.append(title, note, list); host.hidden = false;
  }
  async resolveInterrupted(path, artifact, action) {
    if (!this.session) return;
    const question = action === 'restore' ? `Restore this copy as ${path}? Only allowed while ${path} is missing; nothing is overwritten.` : `Delete this interrupted-save copy (${artifact.bytes} bytes) from disk? The file ${path} itself is not touched.`;
    if (!window.confirm(question)) return;
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    try {
      const args = {sessionId: this.session.sessionId, path, artifact: artifact.path, expectedVersion: artifact.version};
      if (action === 'restore') {
        const restored = await this.invoke('folder_restore_interrupted', args);
        this.diag('save', 'INTERRUPTED_RESTORED');
        const file = this.diskFiles.get(path);
        if (file) { file.missing = false; file.diskVersion = null; if (this.isDirty(path)) { file.conflict = restored.version !== file.version; if (file.conflict) file.diskVersion = restored.version; } else Object.assign(file, {version: restored.version, base: restored.content, content: restored.content}); }
        this.message(`${path} restored from the interrupted-save copy. Review before saving.`);
        this.renderInterrupted(path, restored.interrupted || []);
      } else {
        const left = await this.invoke('folder_discard_interrupted', args);
        this.diag('save', 'INTERRUPTED_DISCARDED'); this.message('Interrupted-save copy discarded.'); this.renderInterrupted(path, left || []);
      }
      this.directories.delete(parent); void this.load(parent);
      this.updateDiskStatus();
    } catch (error) { this.diag('save', `INTERRUPTED_${errorCode(error?.message || error)}`); this.message(String(error?.message || error), true); }
  }
  // Conflict review: the person decides; nothing is overwritten automatically.
  async showConflict(path = this.activePath) {
    const file = this.diskFiles.get(path); if (!file || !this.dialog || this.dialog.open || this.reviewing) return;
    this.reviewing = true;
    let disk = null;
    try { if (!file.missing) disk = await this.invoke('folder_read', {sessionId: this.session.sessionId, path}); } catch { disk = null; } finally { this.reviewing = false; }
    if (!this.session || this.dialog.open) return;
    const mine = this.tabs.get(path) ?? '', summary = disk ? conflictSummary(mine, disk.content) : null;
    const h = (tag, attrs = {}, text = '') => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text) el.textContent = text; return el; };
    const actions = h('div', {class: 'disk-conflict-actions'});
    const button = (id, text, fn, primary = false) => { const b = h('button', {type: 'button', id, class: primary ? 'primary-button' : 'quiet-button'}, text); b.addEventListener('click', fn); actions.append(b); return b; };
    this.dialog.replaceChildren(h('h2', {id: 'diskConflictTitle'}, file.missing ? `${path} was deleted on disk` : `${path} changed on disk`),
      h('p', {}, file.missing ? 'Your unsaved buffer is preserved. Saving is disabled because the file no longer exists; Melly never creates or overwrites files automatically.' : 'Your buffer and the disk file differ. Nothing has been overwritten. Choose how to continue.'));
    if (summary) {
      const grid = h('div', {class: 'disk-conflict-compare'});
      const column = (title, lines) => { const c = h('section', {'aria-label': title}); c.append(h('h3', {}, title), h('pre', {tabindex: '0'}, lines.length ? lines.join('\n') : '(no lines)')); return c; };
      grid.append(column(`Your buffer (from line ${summary.firstLine}, ${summary.mineLines} lines)`, summary.mine), column(`Disk now (from line ${summary.firstLine}, ${summary.diskLines} lines)`, summary.disk));
      this.dialog.append(grid); if (summary.more) this.dialog.append(h('p', {class: 'fine-print'}, 'Only the first differing lines are shown.'));
    }
    const close = () => this.dialog.close();
    button('diskConflictKeep', 'Keep my buffer (decide later)', close, true);
    button('diskConflictCopy', 'Copy my buffer', async () => { try { await navigator.clipboard.writeText(mine); this.message('Your buffer was copied to the clipboard.'); } catch { this.message('Clipboard unavailable. Select the text in the editor and copy it manually.', true); } });
    if (disk) {
      button('diskConflictReload', 'Replace my buffer with the disk version', () => {
        if (!window.confirm('Replace your unsaved buffer with the disk version? Copy your buffer first if you still need it.')) return;
        Object.assign(file, {version: disk.version, base: disk.content, content: disk.content, conflict: false, missing: false, diskVersion: null, status: null});
        this.tabs.set(path, disk.content); this.persistBuffer(path); close(); this.renderPreview(); this.diag('save', 'CONFLICT_RELOADED'); this.message(`${path} reloaded from disk.`);
      });
      button('diskConflictRebase', 'Keep my buffer and allow overwriting the disk version on Save', () => {
        if (!window.confirm('Your next explicit Save will replace the current disk content with your buffer. Continue?')) return;
        Object.assign(file, {version: disk.version, conflict: false, missing: false, diskVersion: null, status: null}); this.persistBuffer(path); close(); this.updateDiskStatus();
        this.diag('save', 'CONFLICT_REBASED'); this.message('Conflict resolved by you: the buffer now targets the current disk version. Press Save to write it.');
      });
    }
    this.dialog.append(actions);
    this.dialog.showModal(); this.dialog.querySelector('#diskConflictKeep')?.focus();
  }
  async save() {
    const path=this.activePath, file=this.diskFiles.get(path); if(!this.session || !file?.version || this.saving || !this.isDirty(path) || ARTIFACT.test(path))return;
    if(file.missing){this.message(`${path} no longer exists on disk. Save is disabled; your buffer is preserved.`,true);return;}
    if(file.conflict){this.message('CONFLICT: Reload and reconcile disk changes first. Buffer preserved.',true);void this.showConflict(path);return;}
    const content=this.tabs.get(path), generation=this.generation, started=Date.now(); this.saving=true; this.updateDiskStatus();
    try { const saved=await this.invoke('folder_save',{sessionId:this.session.sessionId,path,content,expectedVersion:file.version});
      if(generation!==this.generation)return; file.base=content;file.version=saved.version;file.conflict=false;file.status=null;file.diskVersion=null;
      this.persistBuffer(path);this.diag('save', saved.warning ? 'SAVED_WITH_WARNING' : 'SAVED', {bytes: saved.bytes, ms: Date.now()-started});
      this.message(saved.warning ? `${path} · saved to disk (${saved.bytes} bytes). ${saved.warning}` : `${path} · saved to disk (${saved.bytes} bytes).`, !!saved.warning);
      if (saved.warning) void this.checkInterrupted(path);
      this.emit('melly:disk-saved');
    } catch(error) { if(generation===this.generation){const message=String(error?.message || error), code=errorCode(message);
        this.diag('save', `FAILED_${code}`, {ms: Date.now()-started});
        if(code==='CONFLICT' || message.includes('CONFLICT'))file.conflict=true;
        else if(code==='MISSING')file.missing=true;
        else file.status=SAVE_STATUS[code] ? code : 'OTHER';
        if(['INTERRUPTED','ROLLBACK_FAILED'].includes(code)) void this.checkInterrupted(path);
        this.message(message,true);} }
    finally {this.saving=false;if(generation===this.generation && this.preview)this.updateDiskStatus();}
  }
  showWorkspace() {
    document.getElementById('editorContainer').hidden = false; this.previewHost.hidden = true;
    document.getElementById('viewStudio').classList.remove('local-folder-preview');
  }
  async close() {
    if (!this.session || this.busy || this.saving) return;
    this.busy = true;
    try {
      await this.invoke('folder_close',{sessionId:this.session.sessionId});
      clearInterval(this.poll); this.poll = null; if (this.dialog?.open) this.dialog.close();
      ++this.generation; this.session = null; this.index = null; this.pending.clear(); this.directories.clear(); this.expanded.clear(); this.tabs.clear(); this.preview = null; this.activePath = null;
      this.panel.querySelector('#localFolderNav').hidden = true;
      this.diskFiles.clear(); this.panel.querySelector('#localBufferRestore').hidden=true; this.panel.querySelector('#localConflictReview').hidden=true;
      for (const id of ['#localRecoveryPanel', '#localInterrupted']) { const el = this.panel.querySelector(id); el.hidden = true; el.replaceChildren(); }
      document.dispatchEvent(new Event('melly:folder-closed'));
      this.showWorkspace(); this.previewHost.replaceChildren(); this.panel.querySelector('#localFolderTree').replaceChildren();
      this.panel.querySelector('#localFolderName').textContent = '';
      for (const id of ['localFolderClose','localWorkspaceReturn','localFolderRefresh','localFileReload']) document.getElementById(id).hidden = true;
      document.getElementById('localFolderOpen').disabled = false; this.message('Local Folder closed. Unsaved recovery buffers remain on this device. Browser Local Workspace is unchanged.');
      void this.refreshRecent();
    } catch (error) { this.message(`Could not close the native session: ${String(error?.message || error)}. Retry Close Folder.`,true); }
    finally { this.busy = false; }
  }
}
