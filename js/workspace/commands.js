// MEGA-09 daily-driver navigation: command palette, Go to File, Find in Files, Go to Line, global
// shortcuts, persistent layout and the getting-started guide. Commands only drive existing UI:
// none of them starts a process, approves anything or writes a file by itself (Save uses the
// normal explicit save path; enabling execution still goes through the native dialog).
import { Picker, rankItems } from './picker.js';

export const LAYOUT_KEY = 'melly-layout-v1';
const WIDTH_MIN = 200, WIDTH_MAX = 560;
export const SHORTCUTS = Object.freeze([
  ['Ctrl+Shift+P / F1', 'Command palette'], ['Ctrl+P', 'Go to file'], ['Ctrl+Shift+F', 'Find in files'], ['Ctrl+G', 'Go to line'],
  ['Ctrl+S', 'Save the active disk file'], ['Ctrl+W', 'Close the active tab (desktop)'], ['Ctrl+B', 'Show or hide Files & projects'],
  ['Alt+1 … Alt+5', 'Dev Center tools'], ['Ctrl+Enter', 'Submit the runner or job form'], ['n / p', 'Next / previous hunk in a Git diff'], ['Esc', 'Close the open dialog']]);

export function readLayout(storage = globalThis.localStorage) {
  try { const v = JSON.parse(storage?.getItem(LAYOUT_KEY) || 'null'); return v?.version === 1 ? v : {version: 1}; } catch { return {version: 1}; }
}
export function writeLayout(patch, storage = globalThis.localStorage) {
  const next = {...readLayout(storage), ...patch, version: 1};
  try { storage?.setItem(LAYOUT_KEY, JSON.stringify(next)); } catch { /* layout memory is a convenience */ }
  return next;
}
export const clampWidth = value => Math.round(Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, Number(value) || 280)));
/** "120" or "120:4" → {line, column}; anything else → null. */
export function parseLine(text) {
  const m = /^\s*(\d{1,7})(?:\s*[:,]\s*(\d{1,6}))?\s*$/.exec(String(text || ''));
  return m ? {line: Math.max(1, Number(m[1])), column: Math.max(1, Number(m[2] || 1))} : null;
}

export class WorkspaceCommands {
  constructor(app) { this.app = app; this.native = typeof app.localFolder?.invoke === 'function'; }
  get folder() { return this.app.localFolder; }
  init() {
    this.palette = new Picker({label: 'Command palette', placeholder: 'Type a command', empty: 'No matching command', load: query => this.paletteRows(query), pick: row => this.run(row.key)});
    this.quickOpen = new Picker({label: 'Go to file', placeholder: 'Type part of a file name or path', empty: 'No matching file', load: query => this.fileRows(query), pick: row => void this.folder.openFile(row.key).then(ok => { if (ok) this.focusEditor(); })});
    this.goLine = new Picker({label: 'Go to line', placeholder: 'Line number, or line:column', empty: 'Type a line number', load: query => this.lineRows(query), pick: row => void this.folder.reveal(this.folder.activePath, row.line, row.column)});
    for (const p of [this.palette, this.quickOpen, this.goLine]) p.dialog.addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation(); });
    this.buildFind(); this.buildGuide(); this.buildSplitter();
    document.addEventListener('keydown', event => this.shortcut(event));
    document.getElementById('localQuickOpen')?.addEventListener('click', () => this.run('file.quickOpen'));
    document.getElementById('localFindInFiles')?.addEventListener('click', () => this.run('file.find'));
    document.getElementById('explorerToggle')?.addEventListener('click', () => writeLayout({explorerOpen: document.getElementById('explorerToggle').getAttribute('aria-expanded') === 'true'}));
    const help = document.createElement('button'); help.type = 'button'; help.id = 'commandPaletteOpen'; help.className = 'quiet-button';
    help.textContent = 'Commands'; help.title = 'Command palette (Ctrl+Shift+P)'; help.setAttribute('aria-keyshortcuts', 'Control+Shift+P');
    help.addEventListener('click', () => this.run('app.palette'));
    document.querySelector('.workbench-toolbar > div:last-child')?.prepend(help);
    this.renderWelcome();
  }
  /** First-run card (non-modal, dismissible): never blocks the page or steals focus. */
  renderWelcome() {
    const host = this.app.localFolder?.panel; if (!host || readLayout().guideSeen) return;
    const card = document.createElement('section'); card.id = 'gettingStartedCard'; card.className = 'getting-started-card'; card.setAttribute('aria-labelledby', 'gettingStartedCardTitle');
    const title = document.createElement('h3'); title.id = 'gettingStartedCardTitle'; title.textContent = 'New to Melly IDE?';
    const text = document.createElement('p'); text.textContent = this.native ? 'Open a folder, edit with explicit Save, review Git changes and run read-only agents — every command is approved in a Windows dialog.' : 'This browser keeps projects locally. Disk folders, Git, commands and agents need the Windows desktop app.';
    const open = document.createElement('button'); open.type = 'button'; open.id = 'gettingStartedOpen'; open.textContent = 'Read the 2-minute guide';
    open.addEventListener('click', () => this.openGuide());
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'quiet-button'; dismiss.id = 'gettingStartedDismiss'; dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => { writeLayout({guideSeen: true}); card.remove(); document.getElementById('localFolderOpen')?.focus(); });
    card.append(title, text, open, dismiss);
    host.prepend(card);
  }
  // ---------- registry ----------
  commands() {
    const f = this.folder, session = !!f?.session, file = !!f?.activePath && f.tabs?.has(f.activePath);
    const state = file ? f.diskFiles.get(f.activePath) : null, dirty = file && f.isDirty(f.activePath), conflict = !!(state?.conflict || state?.missing);
    const desktop = 'needs the Windows desktop app', needFolder = session ? true : 'open a Local Folder first', needFile = file ? true : 'open a disk file first';
    const dev = this.app.devCenter, exec = dev?.runner?.capability?.enabled;
    return [
      {id: 'app.palette', title: 'Show all commands', keys: 'Ctrl+Shift+P', group: 'Help', hidden: true, run: () => void this.palette.open()},
      {id: 'folder.open', title: 'Open Local Folder…', group: 'Folder', when: () => !this.native ? desktop : session ? 'close the current folder first' : true, run: () => void f.open()},
      ...(f?.recentList || []).map(r => ({id: `folder.resume:${r.key}`, title: `Resume recent folder: ${r.name}`, group: 'Folder', detail: 'Opens the Windows folder dialog at that folder', when: () => session ? 'close the current folder first' : r.available ? true : 'not found on this device', run: () => void f.resume(r.key)})),
      {id: 'folder.close', title: 'Close Local Folder', group: 'Folder', when: () => needFolder, run: () => void f.close()},
      {id: 'folder.refresh', title: 'Refresh folder tree and file index', group: 'Folder', when: () => needFolder, run: () => document.getElementById('localFolderRefresh')?.click()},
      {id: 'file.quickOpen', title: 'Go to file…', keys: 'Ctrl+P', group: 'File', when: () => this.native ? needFolder : desktop, run: () => { this.app.switchView('code'); void this.quickOpen.open(); }},
      {id: 'file.find', title: 'Find in files…', keys: 'Ctrl+Shift+F', group: 'File', when: () => this.native ? needFolder : desktop, run: () => { this.app.switchView('code'); this.openFind(); }},
      {id: 'file.goToLine', title: 'Go to line…', keys: 'Ctrl+G', group: 'File', when: () => needFile, run: () => void this.goLine.open()},
      {id: 'file.save', title: 'Save file to disk', keys: 'Ctrl+S', group: 'File', when: () => !file ? 'open a disk file first' : conflict ? 'resolve the disk conflict first' : dirty ? true : 'no unsaved changes', run: () => void f.save()},
      {id: 'file.close', title: 'Close editor tab', keys: this.native ? 'Ctrl+W' : '', group: 'File', when: () => needFile, run: () => void f.closeTab()},
      {id: 'file.reload', title: 'Reload file from disk', group: 'File', when: () => needFile, run: () => void f.openFile(f.activePath, true)},
      {id: 'file.conflict', title: 'Review disk conflict', group: 'File', when: () => conflict ? true : 'no conflict for the active file', run: () => void f.showConflict()},
      {id: 'view.code', title: 'Go to Code', group: 'View', run: () => this.app.switchView('code')},
      {id: 'view.explorer', title: 'Show or hide Files & projects', keys: 'Ctrl+B', group: 'View', run: () => { this.app.switchView('code'); this.app.shell?.toggleExplorer?.(); writeLayout({explorerOpen: document.getElementById('explorerToggle')?.getAttribute('aria-expanded') === 'true'}); }},
      {id: 'view.resetLayout', title: 'Reset layout (panel width, remembered tool)', group: 'View', run: () => this.resetLayout()},
      ...[['git', 'Git changes'], ['agents', 'Agent Control Center'], ['terminal', 'Command runner'], ['preview', 'Live Preview'], ['diagnostics', 'Diagnostics']].map(([tab, title]) => ({id: `dev.${tab}`, title: `Open ${title}`, group: 'Dev Center', run: () => dev?.open(tab)})),
      {id: 'git.refresh', title: 'Refresh Git status', group: 'Dev Center', when: () => this.native ? needFolder : desktop, run: () => { dev?.open('git'); void dev?.refreshGit(); }},
      {id: 'exec.enable', title: 'Enable execution for this session… (Windows dialog)', group: 'Dev Center', when: () => !this.native ? desktop : exec ? 'already enabled for this session' : true, run: () => { dev?.open('terminal'); void dev?.runner.enable().then(() => dev.refreshProviders()); }},
      {id: 'exec.disable', title: 'Disable execution', group: 'Dev Center', when: () => exec ? true : 'execution is already disabled', run: () => void dev?.runner.disable()},
      {id: 'help.guide', title: 'Getting started guide', group: 'Help', run: () => this.openGuide()},
      {id: 'help.shortcuts', title: 'Keyboard shortcuts', group: 'Help', run: () => this.openGuide(false, 'shortcuts')},
    ];
  }
  availability(command) { const v = command.when ? command.when() : true; return v === true ? null : String(v || 'unavailable'); }
  run(id) {
    const command = this.commands().find(c => c.id === id);
    if (!command) return false;
    const reason = this.availability(command);
    if (reason) { this.app.localFolder?.message?.(`${command.title} ${reason}.`, true); return false; }
    command.run(); return true;
  }
  paletteRows(query) {
    const visible = this.commands().filter(c => !c.hidden);
    return {rows: rankItems(query, visible, c => `${c.group}: ${c.title}`, 80).map(({item, positions}) => ({key: item.id, label: `${item.group}: ${item.title}`, positions, keys: item.keys, detail: item.detail, disabled: this.availability(item)}))};
  }
  async fileRows(query) {
    if (!this.folder?.session) return {rows: [], note: this.native ? 'Open a Local Folder first' : 'Go to file needs the Windows desktop app'};
    const index = await this.folder.fileIndex();
    const notes = [`${index.files.length} files indexed`];
    if (index.skipped?.length) notes.push(`skipped ${index.skipped.slice(0, 4).join(', ')}${index.skipped.length > 4 ? '…' : ''}`);
    if (index.blocked) notes.push(`${index.blocked} blocked item(s)`);
    if (index.truncated) notes.push(index.truncated === 'loaded-folders-only' ? 'only folders already expanded are listed' : `partial index (${index.truncated} limit)`);
    return {rows: rankItems(query, index.files, p => p, 60).map(({item, positions}) => ({key: item, label: item, positions, detail: this.folder.tabs.has(item) ? 'open' : ''})), note: notes.join(' · ')};
  }
  lineRows(query) {
    const target = parseLine(query), text = this.folder?.tabs?.get(this.folder.activePath) || '';
    const total = text ? text.split('\n').length : 0;
    if (!target) return {rows: [], note: total ? `${this.folder.activePath} has ${total} line(s)` : ''};
    const line = Math.min(target.line, Math.max(1, total));
    return {rows: [{key: `line:${line}`, line, column: target.column, label: `Go to line ${line}${target.column > 1 ? `, column ${target.column}` : ''}`, detail: target.line > total ? `the file has ${total} line(s)` : ''}]};
  }
  focusEditor() { this.folder?.preview?.query('.editor-textarea')?.focus(); }
  // ---------- shortcuts ----------
  shortcut(event) {
    const mod = event.ctrlKey || event.metaKey, key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const ours = [this.palette, this.quickOpen, this.goLine].some(p => p?.isOpen) || this.find?.open || this.guide?.open;
    if (!ours && document.querySelector('dialog[open]')) return; // another dialog (conflict, approval) owns the keyboard
    let id = null;
    if ((mod && event.shiftKey && key === 'p') || (event.key === 'F1' && !mod)) id = 'app.palette';
    else if (mod && event.shiftKey && key === 'f') id = 'file.find';
    else if (mod && !event.shiftKey && !event.altKey && key === 'p') id = 'file.quickOpen';
    else if (mod && !event.shiftKey && key === 'g') id = 'file.goToLine';
    else if (mod && !event.shiftKey && key === 'b') id = 'view.explorer';
    else if (mod && !event.shiftKey && key === 'w' && this.native && this.folder?.activePath && this.app.currentView === 'studio') id = 'file.close';
    if (!id) return;
    event.preventDefault(); event.stopPropagation();
    for (const p of [this.palette, this.quickOpen, this.goLine]) if (p?.isOpen) p.close();
    if (this.find?.open && id !== 'file.find') this.find.close();
    if (this.guide?.open) this.guide.close();
    this.run(id);
  }
  // ---------- Find in Files ----------
  buildFind() {
    const h = (tag, attrs = {}, text = '') => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text) el.textContent = text; return el; };
    this.find = h('dialog', {id: 'findInFiles', class: 'picker find-dialog', 'aria-labelledby': 'findInFilesTitle'});
    this.findQuery = h('input', {type: 'search', id: 'findQuery', autocomplete: 'off', spellcheck: 'false', maxlength: '200', 'aria-describedby': 'findStatus'});
    this.findCase = h('input', {type: 'checkbox', id: 'findCase'});
    const form = h('form', {class: 'find-form', role: 'search'});
    const caseLabel = h('label', {class: 'find-case'}); caseLabel.append(this.findCase, ' Match case');
    const queryLabel = h('label', {for: 'findQuery', class: 'visually-hidden'}, 'Text to find');
    form.append(queryLabel, this.findQuery, caseLabel, h('button', {type: 'submit', class: 'primary-button', id: 'findRun'}, 'Search'));
    this.findStatus = h('p', {id: 'findStatus', class: 'picker-status', role: 'status', 'aria-live': 'polite'}, 'Literal text search in the open folder · read-only · files up to 512 KiB.');
    this.findResults = h('div', {id: 'findResults', class: 'find-results', 'aria-label': 'Search results'});
    this.find.append(h('h2', {id: 'findInFilesTitle', class: 'picker-title'}, 'Find in files'), form, this.findStatus, this.findResults, h('p', {class: 'picker-hint'}, 'Enter to search · ↓ to move into results · Esc to close'));
    form.addEventListener('submit', event => { event.preventDefault(); void this.runFind(); });
    this.find.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); return; }
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const buttons = [...this.findResults.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
      if (event.target === this.findQuery && event.key === 'ArrowDown' && buttons.length) { event.preventDefault(); buttons[0].focus(); }
      else if (index >= 0) { event.preventDefault(); (buttons[index + (event.key === 'ArrowDown' ? 1 : -1)] || (event.key === 'ArrowUp' ? this.findQuery : buttons[index])).focus(); }
    });
    this.find.addEventListener('close', () => { if (!this.findHandedOff) this.findRestore?.focus?.({preventScroll: true}); this.findHandedOff = false; });
    document.body.append(this.find);
  }
  openFind() {
    if (this.find.open) { this.findQuery.select(); return; }
    this.findRestore = document.activeElement;
    const area = this.folder?.preview?.query('.editor-textarea');
    const selected = area && area.selectionStart !== area.selectionEnd ? area.value.slice(area.selectionStart, area.selectionEnd) : '';
    if (selected && !selected.includes('\n') && selected.length <= 200) this.findQuery.value = selected;
    this.find.showModal(); this.findQuery.focus(); this.findQuery.select();
  }
  async runFind() {
    const query = this.findQuery.value, request = this.findRequest = Symbol();
    if (!query.trim()) { this.findStatus.textContent = 'Type the text to find.'; return; }
    this.findStatus.textContent = `Searching for “${query}”…`; this.findResults.setAttribute('aria-busy', 'true');
    const started = Date.now();
    try {
      const result = await this.folder.searchText(query, this.findCase.checked);
      if (request !== this.findRequest) return;
      this.renderFind(result, query, Date.now() - started);
      this.app.diagnostics?.record('app', 'FIND_IN_FILES', {count: result.matches.length, ms: Date.now() - started});
    } catch (error) {
      if (request !== this.findRequest) return;
      this.findResults.replaceChildren(); this.findStatus.textContent = `Search failed: ${String(error?.message || error)}`;
    } finally { this.findResults.removeAttribute('aria-busy'); }
  }
  renderFind(result, query, ms) {
    const h = (tag, attrs = {}, text = '') => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text) el.textContent = text; return el; };
    const byFile = new Map();
    for (const m of result.matches) { if (!byFile.has(m.path)) byFile.set(m.path, []); byFile.get(m.path).push(m); }
    this.findResults.replaceChildren(...[...byFile].map(([path, matches]) => {
      const section = h('section', {class: 'find-file', 'aria-label': `${path}, ${matches.length} match(es)`});
      section.append(h('h3', {title: path}, `${path} (${matches.length})`));
      const ul = h('ul');
      for (const m of matches) {
        const b = h('button', {type: 'button', class: 'find-hit', 'data-path': m.path, 'data-line': String(m.line)});
        b.append(h('span', {class: 'find-line'}, `${m.line}:${m.column}`), h('span', {class: 'find-preview'}, m.preview));
        b.setAttribute('aria-label', `${m.path} line ${m.line}: ${m.preview}`);
        b.addEventListener('click', () => { this.findHandedOff = true; this.find.close(); void this.folder.reveal(m.path, m.line, m.column); });
        const li = h('li'); li.append(b); ul.append(li);
      }
      section.append(ul); return section;
    }));
    const notes = [`${result.matches.length} match(es) in ${byFile.size} file(s)`, `${result.filesScanned} file(s) searched in ${ms} ms`];
    if (result.filesSkipped) notes.push(`${result.filesSkipped} skipped (binary, not UTF-8 or over 512 KiB)`);
    if (result.skipped?.length) notes.push(`folders not searched: ${result.skipped.slice(0, 4).join(', ')}${result.skipped.length > 4 ? '…' : ''}`);
    if (result.truncated) notes.push(`stopped early (${result.truncated} limit) — results are partial`);
    this.findStatus.textContent = result.matches.length ? notes.join(' · ') : `No matches for “${query}” · ${notes.slice(1).join(' · ')}`;
  }
  // ---------- layout ----------
  buildSplitter() {
    const studio = document.getElementById('viewStudio'), root = this.app.workspace?.root || document.querySelector('.real-workspace');
    if (!studio || !root) return;
    const layout = readLayout();
    this.splitter = document.createElement('div');
    Object.entries({class: 'explorer-splitter', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize Files & projects', 'aria-valuemin': String(WIDTH_MIN), 'aria-valuemax': String(WIDTH_MAX), 'aria-valuenow': '280', tabindex: '0', title: 'Drag or use ← → to resize · Home resets'}).forEach(([k, v]) => this.splitter.setAttribute(k, v));
    const apply = width => { const w = clampWidth(width); studio.style.setProperty('--explorer-width', `${w}px`); studio.dataset.explorerWidth = String(w); this.splitter.setAttribute('aria-valuenow', String(w)); this.splitter.setAttribute('aria-valuetext', `${w} pixels`); return w; };
    root.append(this.splitter);
    if (layout.explorerWidth) apply(layout.explorerWidth);
    this.splitter.addEventListener('keydown', event => {
      const current = Number(studio.dataset.explorerWidth) || root.getBoundingClientRect().width || 280;
      const next = {ArrowLeft: current - 16, ArrowRight: current + 16, Home: null}[event.key];
      if (next === undefined) return;
      event.preventDefault();
      if (next === null) { this.resetLayout(); return; }
      writeLayout({explorerWidth: apply(next)});
    });
    this.splitter.addEventListener('pointerdown', event => {
      event.preventDefault(); this.splitter.setPointerCapture?.(event.pointerId);
      const left = root.getBoundingClientRect().left;
      const move = e => apply(e.clientX - left);
      const up = e => { this.splitter.removeEventListener('pointermove', move); this.splitter.removeEventListener('pointerup', up); this.splitter.releasePointerCapture?.(e.pointerId); writeLayout({explorerWidth: clampWidth(e.clientX - left)}); };
      this.splitter.addEventListener('pointermove', move); this.splitter.addEventListener('pointerup', up);
    });
  }
  resetLayout() {
    const studio = document.getElementById('viewStudio');
    studio?.style.removeProperty('--explorer-width'); if (studio) delete studio.dataset.explorerWidth;
    this.splitter?.setAttribute('aria-valuenow', '280'); this.splitter?.removeAttribute('aria-valuetext');
    const {guideSeen} = readLayout(); try { globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify({version: 1, guideSeen})); } catch { /* ignore */ }
    this.app.localFolder?.message?.('Layout reset: default panel width, Dev Center opens on Preview.');
  }
  // ---------- getting started ----------
  buildGuide() {
    const h = (tag, attrs = {}, text = '') => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text) el.textContent = text; return el; };
    this.guide = h('dialog', {id: 'gettingStarted', class: 'picker guide-dialog', 'aria-labelledby': 'guideTitle'});
    const mode = this.native
      ? 'You are in the Windows desktop app. Local folders, explicit disk saves, read-only Git review, the approved command runner and Claude Code / Codex jobs are available here.'
      : 'You are in a browser or the installed web app. Projects stay in this browser’s storage. Opening disk folders, Git review, commands and agent jobs need the Windows desktop app and are never routed to a cloud service.';
    const steps = [
      ['Open a folder', 'Code → Files & projects → Open Folder. You pick the folder in a Windows dialog; Melly can read and save only inside it. Recent folders can be resumed later with one confirmation.'],
      ['Find and edit files', 'Ctrl+P goes to a file, Ctrl+Shift+F searches the folder. Edits stay in memory and in a recovery copy on this device until you press Save; a file changed on disk is never overwritten silently.'],
      ['Review Git changes', 'Dev Center → Git reads the repository directly. It never runs git, hooks or diff tools and never stages, commits, resets or pushes.'],
      ['Agents are read-only', 'Claude Code (plan) and Codex (read-only sandbox) can read and propose. Profiles that edit files are disabled until the owner accepts a separate security contract; Melly never raises permissions on its own.'],
      ['Every run is approved natively', 'Execution starts disabled each session. Enabling it and every single command or agent job is confirmed in a Windows dialog that shows the exact program, arguments and folder. An approval is single-use and cannot be replayed. Runs are not sandboxed: they have your Windows permissions.'],
      ['Harmless first try', 'In Dev Center → Terminal, “Load example” fills the runner with node --version. Nothing runs until you request approval and confirm the Windows dialog.'],
      ['Recovery', 'Unsaved buffers survive a restart and are listed when you reopen the folder. Agent job history is kept, but interrupted jobs are never resumed automatically.'],
    ];
    const list = h('ol', {class: 'guide-steps'});
    for (const [title, text] of steps) { const li = h('li'); li.append(h('strong', {}, title), h('p', {}, text)); list.append(li); }
    const keys = h('table', {class: 'guide-keys', id: 'guideShortcuts'});
    keys.append(h('caption', {}, 'Keyboard shortcuts'));
    for (const [k, v] of SHORTCUTS) { const tr = h('tr'); tr.append(h('th', {scope: 'row'}, k), h('td', {}, v)); keys.append(tr); }
    const close = h('button', {type: 'button', class: 'primary-button', id: 'guideClose'}, 'Got it');
    close.addEventListener('click', () => this.guide.close());
    this.guide.append(h('h2', {id: 'guideTitle', class: 'picker-title', tabindex: '-1'}, 'Getting started with Melly IDE'), h('p', {class: 'guide-mode'}, mode), list, keys,
      h('p', {class: 'fine-print'}, 'Privacy: diagnostics stay on this device and contain codes and counts only. Nothing is uploaded automatically.'), close);
    this.guide.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    this.guide.addEventListener('close', () => { writeLayout({guideSeen: true}); document.getElementById('gettingStartedCard')?.remove(); if (this.guideRestore?.isConnected) this.guideRestore.focus({preventScroll: true}); else document.getElementById('localFolderOpen')?.focus(); });
    document.body.append(this.guide);
  }
  openGuide(first = false, section = '') {
    if (this.guide.open || (first && document.querySelector('dialog[open]'))) return;
    this.guideRestore = document.activeElement;
    this.guide.showModal();
    if (section === 'shortcuts') document.getElementById('guideShortcuts')?.scrollIntoView?.({block: 'start'});
    (section ? document.getElementById('guideClose') : document.getElementById('guideTitle'))?.focus();
  }
}
