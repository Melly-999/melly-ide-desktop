import { PreviewRuntime, htmlEntries, STATIC_SANDBOX, PREVIEW_SCOPE } from './preview.js';
import { GitClient, GIT_UNAVAILABLE, describeEntry, groupEntries, unifiedDiff, headLabel } from './git.js';
import { TerminalRuntime, NativeTerminalBackend } from './terminal.js';
import { BrokerClient, EXEC_UNAVAILABLE, errorText, parseArgs as parseArgsText } from './broker.js';
import { CommandRunner, ERROR_CATEGORIES } from './runner.js';
import { AgentJobEngine, PROVIDERS, ACTIVE_STATES, isWritable } from './jobs.js';
import { BUILD, CATEGORIES, sanitize } from '../diagnostics.js';
import { readLayout, writeLayout } from '../workspace/commands.js';
// MEGA-09: diffs are rendered up to this many lines; the rest is reported, never silently dropped.
export const MAX_DIFF_LINES = 5000;
// Effective permissions shown next to the profile picker (MEGA-08.2 verified facts).
export const PROFILE_HELP = Object.freeze({
  plan: 'Claude Code plan mode with an explicit Read, Glob and Grep tool list: it can read and propose, but cannot edit files, run commands or use web tools. Melly does not confine reads outside the folder.',
  'read-only': 'Codex read-only sandbox: Codex denies writes. Codex runs its own sandboxed commands without asking again, and reads and loopback network are not confined (verified in MEGA-08.2).',
  edit: 'Disabled (PROFILE_GATED): editing profiles stay off until the owner accepts the writable-agent security contract.',
  'workspace-write': 'Disabled (PROFILE_GATED): workspace-write stays off until the owner accepts the writable-agent security contract.'});
const WRITE_TOOL = /^(Edit|Write|MultiEdit|NotebookEdit|Bash|apply_patch|shell|exec)/i;
/** Read-only limitation shown when an agent asked for actions its profile does not allow. */
export function deniedActions(job) {
  const denials = job?.progress?.result?.denials || [];
  return {all: [...new Set(denials)], writes: [...new Set(denials.filter(d => WRITE_TOOL.test(String(d))))]};
}
/** Side-by-side rows from native hunks: deleted/added runs are paired line by line. */
export function splitRows(hunks, max = MAX_DIFF_LINES) {
  const rows = [];
  for (const h of hunks) {
    rows.push({kind: 'hunk', text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`});
    let o = h.oldStart, n = h.newStart, i = 0;
    while (i < h.lines.length) {
      if (rows.length >= max) return {rows, truncated: true};
      const line = h.lines[i];
      if (line.kind !== 'add' && line.kind !== 'del') { rows.push({kind: 'ctx', oldNo: o++, oldText: line.text, newNo: n++, newText: line.text}); i++; continue; }
      const dels = [], adds = [];
      while (i < h.lines.length && h.lines[i].kind === 'del') dels.push(h.lines[i++].text);
      while (i < h.lines.length && h.lines[i].kind === 'add') adds.push(h.lines[i++].text);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        if (rows.length >= max) return {rows, truncated: true};
        rows.push({kind: 'change', oldNo: k < dels.length ? o++ : null, oldText: dels[k] ?? null, newNo: k < adds.length ? n++ : null, newText: adds[k] ?? null});
      }
    }
  }
  return {rows, truncated: false};
}
// Dev Center presentation. Each tool reports only what its runtime actually did.
const TABS = [['preview', 'Preview'], ['git', 'Git'], ['terminal', 'Terminal'], ['agents', 'Agents'], ['diagnostics', 'Diagnostics']];
const WIDTHS = [['fill', 'Fill'], ['1280', 'Desktop 1280'], ['768', 'Tablet 768'], ['390', 'Phone 390']];
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value); else if (key === 'text') el.textContent = value; else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter(c => c != null));
  return el;
}
const time = iso => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };

export class DevCenter {
  constructor(app, invoke = globalThis.__TAURI__?.core?.invoke) {
    this.app = app; this.invoke = invoke; this.tab = TABS.some(t => t[0] === readLayout().devTab) ? readLayout().devTab : 'preview';
    this.diffMode = 'unified'; this.jobFilter = 'all';
    this.preview = new PreviewRuntime({invoke}); this.git = new GitClient(invoke);
    this.terminal = new TerminalRuntime({backend: new NativeTerminalBackend(invoke)});
    // MEGA-08: every execution request goes to the native broker; the UI never authorizes.
    this.client = new BrokerClient(invoke); this.runner = new CommandRunner({client: this.client}); this.providers = {};
    this.jobs = new AgentJobEngine({client: this.client, workspace: () => this.workspaceRef(), providers: () => this.providers});
    this.queue = this.jobs; this.selectedJob = null; this.gitState = null; this.diagnostics = []; this.reviewJob = null; this.verifyJob = null;
  }
  workspaceRef() { const s = this.folder; return s?.sessionId ? {sessionId: s.sessionId, key: s.recoveryKey || `session:${s.sessionId}`, name: s.name} : null; }
  // Local diagnostics only (see js/diagnostics.js): codes and counts, never paths or content.
  diag(category, code, detail) { try { this.app.diagnostics?.record(category, code, detail); } catch { /* never blocks a tool */ } }
  init() {
    const recovery = this.jobs.load();
    this.view = h('section', {id: 'viewDevCenter', class: 'view-screen premium-page devcenter', lang: 'en', hidden: true});
    this.view.append(
      h('div', {class: 'section-heading'}, h('div', {}, h('h1', {tabindex: '-1', text: 'Dev Center'}), h('p', {text: 'Live Preview, local Git, terminal and agent jobs for local projects.'})),
        h('span', {class: 'connection-pill', id: 'devCenterRuntime', text: this.invoke ? 'WINDOWS DESKTOP · NATIVE' : 'BROWSER · LIMITED'})),
      this.statusStrip = h('ul', {class: 'dev-status', id: 'devStatus', 'aria-label': 'Execution, agent, workspace and Git status'}),
      this.tablist = h('div', {class: 'devcenter-tabs', role: 'tablist', 'aria-label': 'Dev Center tools'},
        TABS.map(([id, label]) => h('button', {role: 'tab', id: `devTab-${id}`, 'aria-controls': `devPanel-${id}`, 'aria-selected': String(id === this.tab), tabindex: id === this.tab ? '0' : '-1', onclick: () => this.select(id), text: label}))),
      ...TABS.map(([id]) => h('section', {role: 'tabpanel', id: `devPanel-${id}`, 'aria-labelledby': `devTab-${id}`, class: 'devcenter-panel', hidden: id !== this.tab})));
    document.getElementById('appWrapper').append(this.view);
    this.tablist.addEventListener('keydown', event => {
      const ids = TABS.map(t => t[0]), index = ids.indexOf(this.tab);
      const next = {ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: ids.length - 1}[event.key];
      if (next === undefined) return;
      event.preventDefault(); this.select(ids[(next + ids.length) % ids.length]); document.getElementById(`devTab-${this.tab}`).focus();
    });
    document.querySelector('.primary-navigation')?.append(h('button', {'data-route': 'devcenter'}, h('span', {'aria-hidden': 'true', text: '⌬'}), h('span', {'data-label': 'devcenter', text: 'Dev'})));
    this.buildPreview(); this.buildGit(); this.buildTerminal(); this.buildAgents(recovery); this.buildDiagnostics();
    // Local Folder owns its session. Follow its Close button without modifying it.
    document.addEventListener('click', event => { if (event.target.closest?.('#localFolderClose')) setTimeout(() => this.folderChanged(), 0); }, true);
    document.addEventListener('melly:folder-closed', () => this.folderChanged());
    // MEGA-09: keep an inspected Git view current after a save or when the window regains focus.
    document.addEventListener('melly:disk-saved', () => this.gitAutoRefresh('save'));
    window.addEventListener('focus', () => this.gitAutoRefresh('focus'));
    this.jobStates = new Map(this.jobs.snapshot().map(j => [j.id, j.state]));
    if (recovery?.recovered) this.diag('agents', 'RECOVERED_INTERRUPTED', {count: recovery.recovered});
    if (recovery?.migrated) this.diag('agents', 'MIGRATED_V1', {count: recovery.migrated});
    this.jobs.subscribe(jobs => { this.trackJobs(jobs); this.renderAgents(); this.renderStatus(); });
    this.jobs.onFinished = job => this.jobFinished(job);
    this.terminal.subscribe(() => this.renderTerminal());
    this.runner.subscribe(() => { this.renderRunner(); this.renderStatus(); });
    void this.terminal.refresh();
    void this.runner.refresh().then(() => this.refreshProviders()).catch(() => {});
    void this.jobs.reconcile().then(counts => { if (counts.reattached || counts.interrupted || counts.orphaned) this.diag('agents', 'RECONCILED', counts); }).catch(() => {});
    this.view.addEventListener('keydown', event => this.shortcut(event));
    this.renderStatus();
  }
  /** Alt+1…5 switch Dev Center tools; Ctrl+Enter submits the focused runner or job form. */
  shortcut(event) {
    if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-5]$/.test(event.key)) { event.preventDefault(); this.select(TABS[Number(event.key) - 1][0]); document.getElementById(`devTab-${this.tab}`).focus(); return; }
    if (event.ctrlKey && event.key === 'Enter') {
      const form = event.target.closest?.('#runnerForm, #jobForm');
      if (form) { event.preventDefault(); form.requestSubmit(); }
    }
  }
  renderStatus() {
    if (!this.statusStrip) return;
    const cap = this.runner.capability, jobs = this.jobs.snapshot();
    const running = jobs.filter(j => ACTIVE_STATES.includes(j.state)), pending = jobs.filter(j => j.state === 'pending-approval' && !j.legacy).length;
    const last = jobs.filter(j => j.endedAt).sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))[0];
    const cli = PROVIDERS.map(p => `${p.name}: ${this.providers[p.id]?.state || (this.client.available ? 'not detected' : 'unavailable')}`).join(' · ');
    const git = !this.gitState ? 'not inspected' : !this.gitState.status.repository ? 'not a repository' : (() => { const c = this.gitState.status.counts; const n = c.staged + c.unstaged + c.untracked + c.conflicted; return n ? `dirty · ${n} change(s)` : 'clean'; })();
    const item = (key, label, value, state) => h('li', {'data-status': key, 'data-state': state}, h('strong', {text: `${label} `}), value);
    this.statusStrip.replaceChildren(
      item('exec', 'Execution', !this.client.available ? 'unavailable in browser' : cap?.enabled ? 'enabled this session' : 'disabled', !this.client.available ? 'off' : cap?.enabled ? 'on' : 'off'),
      item('cli', 'Agent CLIs', cli, PROVIDERS.some(p => this.providers[p.id]?.state === 'ready') ? 'on' : 'off'),
      item('running', 'Running', running.length ? running.map(j => `${j.title} (${j.state})`).join(', ') : this.runner.current ? `command ${this.runner.current.label}` : 'nothing', running.length || this.runner.current ? 'busy' : 'idle'),
      item('approval', 'Approval required', String(pending), pending ? 'attention' : 'idle'),
      item('lock', 'Workspace lock', running.length ? `${running[0].workspace?.name || 'folder'} · agent run is exclusive` : 'free', running.length ? 'busy' : 'idle'),
      item('git', 'Git', git, git.startsWith('dirty') ? 'attention' : 'idle'),
      item('last', 'Last job', last ? `${last.title} · ${last.state}` : 'none', last?.state === 'completed' ? 'on' : last ? 'attention' : 'idle'));
  }
  get folder() { return this.app.localFolder?.session || null; }
  open(tab = this.tab) { this.app.switchView('devcenter'); this.select(tab); }
  activated() { this.refreshSources(); if (this.tab === 'git' && this.folder && !this.gitState) void this.refreshGit(); if (this.tab === 'diagnostics') void this.refreshDiagnostics(); this.renderTerminal(); }
  select(tab) {
    if (!TABS.some(t => t[0] === tab)) return;
    this.tab = tab; writeLayout({devTab: tab});
    for (const [id] of TABS) {
      const button = document.getElementById(`devTab-${id}`), panel = document.getElementById(`devPanel-${id}`);
      button.setAttribute('aria-selected', String(id === tab)); button.tabIndex = id === tab ? 0 : -1; panel.hidden = id !== tab;
    }
    this.activated();
  }
  folderChanged() {
    if (this.folder) return;
    if (this.preview.mount?.sessionId) { void this.stopPreview('Local Folder closed. Folder preview stopped.'); }
    this.gitState = null; this.renderGit(); this.refreshSources(); this.renderTerminal();
  }

  // ---------- Preview ----------
  buildPreview() {
    const panel = document.getElementById('devPanel-preview');
    this.previewSource = h('select', {id: 'previewSource', 'aria-label': 'Preview source', onchange: () => this.refreshSources()},
      h('option', {value: 'workspace', text: 'Local Workspace project (editor content)'}), h('option', {value: 'folder', text: 'Local Folder (files on disk)'}));
    this.previewEntry = h('select', {id: 'previewEntry', 'aria-label': 'Entry HTML file'});
    this.previewWidth = h('select', {id: 'previewWidth', 'aria-label': 'Preview width', onchange: () => this.applyWidth()}, WIDTHS.map(([v, t]) => h('option', {value: v, text: t})));
    this.previewCustom = h('input', {id: 'previewCustomWidth', type: 'number', min: '240', max: '3840', step: '10', placeholder: 'px', 'aria-label': 'Custom preview width in pixels', oninput: () => this.applyWidth()});
    this.previewStatus = h('p', {id: 'previewStatus', class: 'devcenter-status', role: 'status', 'aria-live': 'polite'});
    this.previewDiagnostics = h('ul', {id: 'previewDiagnostics', class: 'devcenter-diagnostics', 'aria-label': 'Preview diagnostics'});
    this.previewStage = h('div', {class: 'preview-stage', id: 'previewStage'}, h('p', {class: 'empty-copy', text: 'No preview running. Choose a source and entry, then Start preview.'}));
    this.previewHome = h('div', {class: 'preview-home'}, this.previewStage);
    this.dock = h('aside', {class: 'preview-dock', id: 'previewDock', 'aria-label': 'Live Preview panel', hidden: true},
      h('div', {class: 'preview-dock-bar'}, h('strong', {text: 'Live Preview'}), h('button', {class: 'quiet-button', id: 'previewUndock', onclick: () => this.dockPreview(false), text: 'Return to Dev Center'})));
    document.body.append(this.dock);
    panel.append(
      h('div', {class: 'surface devcenter-card'},
        h('div', {class: 'devcenter-row'}, h('label', {}, 'Source ', this.previewSource), h('label', {}, 'Entry ', this.previewEntry), h('label', {}, 'Width ', this.previewWidth), this.previewCustom),
        h('div', {class: 'devcenter-actions'},
          h('button', {class: 'primary-button', id: 'previewStart', onclick: () => void this.startPreview(), text: 'Start preview'}),
          h('button', {class: 'quiet-button', id: 'previewReload', onclick: () => void this.startPreview(true), disabled: true, text: 'Reload'}),
          h('button', {class: 'quiet-button', id: 'previewStop', onclick: () => void this.stopPreview(), disabled: true, text: 'Stop'}),
          h('button', {class: 'quiet-button', id: 'previewDockToggle', onclick: () => this.dockPreview(true), disabled: true, text: this.invoke ? 'Show preview window' : 'Open in side panel'})),
        this.previewStatus, h('p', {class: 'fine-print', id: 'previewScope', text: PREVIEW_SCOPE})),
      this.previewHome, this.previewDiagnostics);
    void this.preview.capability().then(c => { this.capability = c; this.previewMessage(c.scripts ? 'Ready · previews open in a separate isolated window with scripts, network blocked.' : 'Browser mode · static HTML/CSS snapshot only. JavaScript runs only in the Windows desktop isolated preview.'); }).catch(e => { this.diag('preview', 'CAPABILITY_UNAVAILABLE'); this.previewMessage(`Preview unavailable: ${e?.message || e}`, true); });
    this.refreshSources();
  }
  previewMessage(text, error = false) { this.previewStatus.textContent = text; this.previewStatus.dataset.error = String(error); }
  workspaceFiles() { this.app.editor?.captureLiveEditorContent?.(); return {...(this.app.editor?.files || {})}; }
  refreshSources() {
    if (!this.previewSource) return;
    const folderOption = this.previewSource.querySelector('option[value="folder"]');
    folderOption.disabled = !this.folder || !this.invoke;
    if (folderOption.disabled && this.previewSource.value === 'folder') this.previewSource.value = 'workspace';
    const previous = this.previewEntry.value;
    const paths = this.previewSource.value === 'folder'
      ? (this.app.localFolder?.directories?.get('') || []).filter(e => e.kind === 'file').map(e => e.path)
      : Object.keys(this.workspaceFiles());
    const entries = htmlEntries(paths);
    this.previewEntry.replaceChildren(...(entries.length ? entries : ['']).map(p => h('option', {value: p, text: p || 'No .html file found'})));
    if (entries.includes(previous)) this.previewEntry.value = previous;
    document.getElementById('previewStart').disabled = !entries.length;
  }
  frame() { return this.previewStage.querySelector('iframe'); }
  width() {
    const custom = Number(this.previewCustom.value), preset = this.previewWidth.value;
    return custom >= 240 && custom <= 3840 ? custom : preset === 'fill' ? null : Number(preset);
  }
  async startPreview(reload = false) {
    const entry = this.previewEntry.value, source = this.previewSource.value;
    if (!entry) { this.previewMessage('Add an .html file to preview.', true); return; }
    const generation = this.previewGeneration = (this.previewGeneration || 0) + 1;
    clearTimeout(this.eventTimer);
    this.diagnostics = []; this.renderDiagnostics(); this.previewMessage(`${reload ? 'Reloading' : 'Starting'} ${entry}…`);
    try {
      const width = this.width();
      const result = source === 'folder' ? await this.preview.startFolder(this.folder?.sessionId, entry, width) : await this.preview.startWorkspace(this.workspaceFiles(), entry, width);
      if (generation !== this.previewGeneration) return;
      this.running = {source, entry, mode: result.mode}; this.diag('preview', 'STARTED', {source, kind: result.mode});
      if (result.mode === 'window') {
        // Project code never runs inside the main window; it runs in the capability-free preview window.
        this.previewStage.replaceChildren(h('p', {class: 'empty-copy', id: 'previewWindowNote', text: `${entry} is running in the separate “Melly Live Preview” window · ${result.source === 'local-folder' ? 'Local Folder (disk)' : 'Local Workspace (editor content)'} · ${result.origin} · no Melly commands, files, Git or network.`}));
        this.previewMessage(`Opened ${entry} in the isolated preview window.`);
        this.pollEvents(generation);
      } else {
        const frame = h('iframe', {id: 'previewFrame', title: `Live Preview of ${entry}`, sandbox: STATIC_SANDBOX, referrerpolicy: 'no-referrer', allow: '', loading: 'eager'});
        frame.addEventListener('load', () => { if (generation === this.previewGeneration) this.previewMessage(`Static snapshot of ${entry} · ${result.scriptsRemoved} script(s) not run${result.missingStyles ? ` · ${result.missingStyles} stylesheet(s) unavailable` : ''}.`); });
        frame.srcdoc = result.html;
        this.previewStage.replaceChildren(frame); this.applyWidth();
        this.previewMessage(`Preparing static snapshot of ${entry}…`);
      }
      for (const id of ['previewReload', 'previewStop', 'previewDockToggle']) document.getElementById(id).disabled = false;
    } catch (error) {
      if (generation === this.previewGeneration) { this.diag('preview', 'START_FAILED', {source}); this.previewMessage(`Preview failed: ${error?.message || error}`, true); }
    }
  }
  pollEvents(generation) {
    const tick = async () => {
      if (generation !== this.previewGeneration || !this.preview.mount) return;
      try {
        const events = await this.preview.events();
        if (generation !== this.previewGeneration) return;
        const ready = events.filter(e => e.kind === 'ready').at(-1);
        if (ready) this.previewMessage(`Preview loaded${ready.text ? `: ${ready.text}` : ''} · isolated window · network blocked.`);
        const issues = events.filter(e => e.kind !== 'ready');
        for (const kind of new Set(issues.slice(this.diagnostics.length).map(e => e.kind))) this.diag('preview', `EVENT_${kind.toUpperCase()}`, {count: issues.filter(e => e.kind === kind).length});
        this.diagnostics = issues; this.renderDiagnostics();
      } catch { /* The preview window may have been closed by the person. */ }
      this.eventTimer = setTimeout(tick, 1000);
    };
    void tick();
  }
  async stopPreview(message = 'Preview stopped. The isolated mount was released.') {
    this.previewGeneration = (this.previewGeneration || 0) + 1; this.running = null; clearTimeout(this.eventTimer);
    await this.preview.stop(); this.dockPreview(false);
    this.previewStage.replaceChildren(h('p', {class: 'empty-copy', text: 'No preview running.'}));
    for (const id of ['previewReload', 'previewStop', 'previewDockToggle']) document.getElementById(id).disabled = true;
    this.previewMessage(message);
  }
  applyWidth() {
    const width = this.width();
    if (this.running?.mode === 'window') { if (width) void this.preview.resize(width).catch(e => this.previewMessage(`Resize failed: ${e?.message || e}`, true)); return; }
    const frame = this.frame(); if (!frame) return;
    frame.style.width = width ? `${width}px` : '100%'; frame.dataset.width = width ? String(width) : 'fill';
  }
  dockPreview(open) {
    if (this.running?.mode === 'window') { if (open) void this.preview.open(this.width()).catch(e => this.previewMessage(`Preview window unavailable: ${e?.message || e}`, true)); return; }
    this.dock.hidden = !open; document.body.classList.toggle('preview-docked', open);
    (open ? this.dock : this.previewHome).append(this.previewStage);
    if (!this.invoke) document.getElementById('previewDockToggle').textContent = open ? 'Docked in side panel' : 'Open in side panel';
  }
  renderDiagnostics() {
    const labels = {blocked: 'Blocked', resource: 'Failed resource', missing: 'Missing file', refused: 'Refused', error: 'Error'};
    this.previewDiagnostics.replaceChildren(...this.diagnostics.map(d => h('li', {'data-kind': d.kind}, h('strong', {text: labels[d.kind] || 'Note'}), ` ${d.text}`)));
  }

  // ---------- Git ----------
  buildGit() {
    const panel = document.getElementById('devPanel-git');
    this.gitStatus = h('p', {id: 'gitStatusLine', class: 'devcenter-status', role: 'status', 'aria-live': 'polite'});
    this.gitBody = h('div', {id: 'gitBody'});
    this.gitDiff = h('pre', {id: 'gitDiff', class: 'git-diff', tabindex: '0', 'aria-label': 'Selected Git diff', hidden: true});
    this.gitHunkLabel = h('span', {id: 'gitHunkLabel', class: 'fine-print', role: 'status'});
    this.gitSplit = h('div', {id: 'gitSplit', class: 'git-split', tabindex: '0', role: 'region', 'aria-label': 'Side-by-side diff', hidden: true});
    this.gitDiffNote = h('p', {id: 'gitDiffNote', class: 'fine-print', hidden: true});
    this.gitModeToggle = h('button', {class: 'quiet-button', id: 'gitDiffMode', 'aria-pressed': 'false', onclick: () => { this.diffMode = this.diffMode === 'split' ? 'unified' : 'split'; this.renderDiff(true); }, text: 'Side-by-side view'});
    this.gitDiffNav = h('div', {class: 'devcenter-actions', id: 'gitDiffNav', hidden: true},
      h('button', {class: 'quiet-button', id: 'gitPrevHunk', onclick: () => this.hunk(-1), text: 'Previous hunk'}),
      h('button', {class: 'quiet-button', id: 'gitNextHunk', onclick: () => this.hunk(1), text: 'Next hunk'}), this.gitModeToggle, this.gitHunkLabel);
    this.gitFilter = h('input', {type: 'search', id: 'gitFilter', placeholder: 'Filter changed files', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Filter changed files by path', oninput: () => this.applyGitFilter()});
    panel.append(h('div', {class: 'surface devcenter-card'},
      h('div', {class: 'devcenter-actions'}, h('button', {class: 'primary-button', id: 'gitRefresh', onclick: () => void this.refreshGit(), text: 'Refresh Git status'}),
        h('span', {class: 'connection-pill', text: 'READ-ONLY · NATIVE · NO HOOKS'}), this.gitFilter),
      this.gitStatus, h('p', {class: 'fine-print', text: 'Melly reads .git directly. It never runs git, hooks, filters, fsmonitor or diff tools, and never stages, commits, checks out, resets, stashes, pulls or pushes. Changes are refreshed after a save and when you return to the window.'})),
      this.gitBody, this.gitDiffNav, this.gitDiffNote, this.gitDiff, this.gitSplit);
    this.renderGit();
  }
  /** Refreshes an already-inspected repository after a save, or on focus while the Git tool is visible. */
  gitAutoRefresh(reason) {
    if (!this.folder || !this.gitState || this.gitState.sessionId !== this.folder.sessionId) return;
    if (reason === 'focus' && (this.app.currentView !== 'devcenter' || this.tab !== 'git')) return;
    clearTimeout(this.gitTimer);
    // A save always refreshes; focus events are rate-limited so tabbing between windows stays cheap.
    this.gitTimer = setTimeout(() => { if (reason === 'save' || Date.now() - Date.parse(this.gitState?.at || 0) > 1500) void this.refreshGit({auto: true}); }, 400);
  }
  applyGitFilter() {
    const query = (this.gitFilter?.value || '').trim().toLowerCase();
    let shown = 0, total = 0;
    for (const li of this.gitBody.querySelectorAll('.git-entries li[data-path]')) { total++; const hit = !query || li.dataset.path.toLowerCase().includes(query); li.hidden = !hit; if (hit) shown++; }
    this.gitBody.dataset.filtered = String(!!query);
    const note = this.gitBody.querySelector('#gitFilterNote');
    if (note) note.textContent = query ? `Showing ${shown} of ${total} entries matching “${query}”.` : '';
  }
  /** Moves between hunks of the open diff (n / p keys inside the diff do the same). */
  hunk(step) {
    const hunks = [...(this.diffMode === 'split' ? this.gitSplit : this.gitDiff).querySelectorAll('.hunk')];
    if (!hunks.length) return;
    this.hunkIndex = Math.max(0, Math.min(hunks.length - 1, (this.hunkIndex ?? -1) + step));
    hunks.forEach((el, i) => el.toggleAttribute('data-current', i === this.hunkIndex));
    hunks[this.hunkIndex].scrollIntoView({block: 'nearest'});
    this.gitHunkLabel.textContent = `Hunk ${this.hunkIndex + 1} of ${hunks.length}`;
  }
  /** Read-only per-file line counts (bounded to 200 files) for the change list. */
  async loadNumstat(state) {
    const items = state.status.entries.filter(e => e.kind !== 'nested-repository' && e.x !== 'U' && e.y !== 'U')
      .flatMap(e => e.x === '?' ? [{path: e.path, staged: false}] : [...(e.x !== ' ' ? [{path: e.path, staged: true}] : []), ...(e.y !== ' ' ? [{path: e.path, staged: false}] : [])]).slice(0, 200);
    if (!items.length || !this.client.available) return;
    try {
      const rows = await this.client.diffSummary(state.sessionId, items);
      if (this.gitState !== state) return;
      state.numstat = new Map(rows.map(r => [`${r.staged ? 'S' : 'W'}:${r.path}`, r])); this.renderGit();
    } catch { /* counts are optional; the list stays usable */ }
  }
  async refreshGit({auto = false} = {}) {
    if (!this.git.available) { this.gitState = null; this.renderGit(); return; }
    const session = this.folder;
    if (!session) { this.gitState = null; this.renderGit(); return; }
    const request = this.gitRequest = Symbol(), started = Date.now();
    this.gitStatus.textContent = `Inspecting ${session.name}…`; this.gitStatus.dataset.error = 'false'; this.gitStatus.dataset.state = 'loading';
    this.gitBody.setAttribute('aria-busy', 'true');
    document.getElementById('gitRefresh').disabled = true;
    try {
      const status = await this.git.status(session.sessionId);
      if (request !== this.gitRequest) return;
      this.gitState = {sessionId: session.sessionId, status, at: new Date().toISOString()}; this.renderGit(); this.renderStatus();
      if (status.repository) void this.loadNumstat(this.gitState);
      // An open diff stays open across refreshes when its file is still changed.
      const open = this.openDiff;
      if (open && status.repository && status.entries.some(e => e.path === open.path)) void this.showDiff(open.path, open.staged, {focus: !auto});
      else this.openDiff = null;
      this.diag('git', status.repository ? 'STATUS_OK' : 'NOT_REPOSITORY', {count: status.entries?.length || 0, ms: Date.now() - started});
    } catch (error) {
      if (request === this.gitRequest) { this.gitState = null; this.renderGit(); this.gitStatus.textContent = `Git inspection failed: ${error?.message || error}`; this.gitStatus.dataset.error = 'true'; this.diag('git', 'STATUS_FAILED', {ms: Date.now() - started}); }
    } finally { document.getElementById('gitRefresh').disabled = false; this.gitBody.removeAttribute('aria-busy'); delete this.gitStatus.dataset.state; }
  }
  renderGit() {
    if (!this.gitBody) return;
    this.gitDiff.hidden = true; this.gitDiff.replaceChildren(); this.gitDiffNav.hidden = true;
    this.gitSplit.hidden = true; this.gitSplit.replaceChildren(); this.gitDiffNote.hidden = true;
    const empty = text => { this.gitBody.replaceChildren(h('p', {class: 'empty-copy', text})); };
    this.gitStatus.dataset.error = 'false';
    if (!this.git.available) { this.gitStatus.textContent = GIT_UNAVAILABLE; return empty('Local Workspace projects stay in browser storage and have no Git repository.'); }
    if (!this.folder) { this.gitStatus.textContent = 'No Local Folder open.'; return empty('Open a Local Folder in Code → Files & projects, then refresh Git status.'); }
    const state = this.gitState;
    if (!state || state.sessionId !== this.folder.sessionId) { this.gitStatus.textContent = `${this.folder.name} · not inspected yet.`; return empty('Select Refresh Git status to inspect this folder.'); }
    const s = state.status;
    if (!s.repository) { this.gitStatus.textContent = `${s.rootName} · not a Git repository.`; return empty(s.reason); }
    const head = s.head;
    this.gitStatus.textContent = `${s.rootName} · ${headLabel(head)} · inspected ${time(state.at)}`;
    const groups = groupEntries(s.entries);
    const counts = (path, staged) => {
      const row = state.numstat?.get(`${staged ? 'S' : 'W'}:${path}`);
      if (!row) return ''; if (row.error) return ' · counts unavailable'; if (row.binary) return ' · binary';
      return ` · +${row.additions} −${row.deletions}${row.approximate ? ' (approximate)' : ''}`;
    };
    const review = this.reviewJob ? this.jobs.snapshot().find(j => j.id === this.reviewJob) : null;
    const jobChanged = review?.changes ? new Set([...review.changes.added, ...review.changes.modified, ...review.changes.removed]) : null;
    const renames = (s.renames || []).length ? h('section', {class: 'surface devcenter-card git-group', 'aria-label': 'Renames', id: 'gitRenames'},
      h('h2', {text: `Renames (${s.renames.length})`}), h('p', {class: 'fine-print', text: 'Detected by identical content. The entries below keep their deleted / added / untracked status.'}),
      h('ul', {class: 'git-entries'}, s.renames.map(r => h('li', {}, h('span', {class: 'git-path', text: `${r.from} → ${r.to}`}), h('small', {text: `${r.staged ? 'staged' : 'not staged'} · exact content`}))))) : null;
    const reviewCard = review ? h('section', {class: 'surface devcenter-card', id: 'gitJobReview', 'aria-label': 'Job change review'},
      h('h2', {text: `Changes during job “${review.title}” (attempt ${review.attempt})`}),
      review.changes ? h('p', {text: `${review.changes.total} file(s) changed in the folder while the job ran · attribution: ${review.changes.attribution === 'exclusive-melly-window' ? 'no other Melly activity in this window' : 'uncertain'}`}) : h('p', {text: 'No native change summary is recorded for this job.'}),
      review.changes ? h('ul', {class: 'devcenter-notices'}, review.changes.notes.map(n => h('li', {text: n}))) : null,
      review.changes ? h('ul', {class: 'git-entries'}, [...review.changes.added.map(p => [p, 'added']), ...review.changes.modified.map(p => [p, 'modified']), ...review.changes.removed.map(p => [p, 'removed'])].map(([p, k]) => h('li', {}, h('span', {class: 'git-path', text: p}), h('small', {text: k}),
        h('span', {class: 'git-entry-actions'}, h('button', {class: 'quiet-button', onclick: () => void this.showDiff(p, false), text: 'Diff'}))))) : null,
      h('button', {class: 'quiet-button', onclick: () => { this.reviewJob = null; this.renderGit(); }, text: 'Close job review'})) : null;
    const card = h('div', {class: 'surface devcenter-card git-head'},
      h('dl', {class: 'devcenter-facts'},
        h('div', {}, h('dt', {text: 'Branch'}), h('dd', {text: head.detached ? 'Detached HEAD' : head.branch || '—'})),
        h('div', {}, h('dt', {text: 'HEAD'}), h('dd', {text: head.oid || 'No commits yet'})),
        h('div', {}, h('dt', {text: 'Last commit'}), h('dd', {text: head.summary ? `${head.summary}${head.author ? ` · ${head.author}` : ''}${head.time ? ` · ${new Date(head.time * 1000).toLocaleString()}` : ''}` : '—'})),
        h('div', {}, h('dt', {text: 'Changes'}), h('dd', {text: `${s.counts.staged} staged · ${s.counts.unstaged} not staged · ${s.counts.untracked} untracked${s.counts.conflicted ? ` · ${s.counts.conflicted} conflicted` : ''}`}))),
      s.notices.length ? h('ul', {class: 'devcenter-notices', 'aria-label': 'Repository notices'}, s.notices.map(n => h('li', {text: n}))) : null,
      s.truncated ? h('p', {class: 'fine-print', text: 'Results are partial (size limits). See notices.'}) : null);
    const totals = (entries, staged) => {
      const rows = entries.map(e => state.numstat?.get(`${staged ? 'S' : 'W'}:${e.path}`)).filter(r => r && !r.error && !r.binary);
      return rows.length ? ` · +${rows.reduce((s, r) => s + r.additions, 0)} −${rows.reduce((s, r) => s + r.deletions, 0)}` : '';
    };
    const section = (title, entries, staged) => entries.length ? h('section', {class: 'surface devcenter-card git-group', 'aria-label': title},
      h('h2', {text: `${title} (${entries.length})${title === 'Untracked' ? '' : totals(entries, staged)}`}),
      h('ul', {class: 'git-entries'}, entries.map(entry => h('li', {'data-path': entry.path, 'data-job-changed': String(!!jobChanged?.has(entry.path))},
        h('span', {class: 'git-path', title: entry.path, text: entry.path}), h('small', {text: `${describeEntry(entry)}${counts(entry.path, staged)}${jobChanged?.has(entry.path) ? ' · changed during the reviewed job' : ''}`}),
        h('span', {class: 'git-entry-actions'},
          entry.kind === 'nested-repository' ? null : h('button', {class: 'quiet-button', 'data-git-diff': entry.path, 'aria-label': `Show ${staged ? 'staged' : 'unstaged'} diff for ${entry.path}`, onclick: () => void this.showDiff(entry.path, staged), text: 'Diff'}),
          (entry.kind === 'nested-repository' || (staged ? entry.x : entry.y) === 'D') ? null : h('button', {class: 'quiet-button', 'aria-label': `Open ${entry.path} read-only`, onclick: () => void this.openSource(entry.path), text: 'Open file'})))))) : null;
    const lists = [section('Staged', groups.staged, true), section('Not staged', groups.unstaged, false), section('Untracked', groups.untracked, false), section('Conflicted', groups.conflicted, false)].filter(Boolean);
    const filterNote = h('p', {id: 'gitFilterNote', class: 'fine-print', role: 'status', 'aria-live': 'polite'});
    this.gitBody.replaceChildren(card, ...[reviewCard, renames].filter(Boolean), filterNote, ...(lists.length ? lists : [h('p', {class: 'empty-copy', text: 'Working tree clean. No staged, unstaged or untracked changes.'})]));
    this.applyGitFilter();
  }
  async showDiff(path, staged, {focus = true} = {}) {
    const state = this.gitState; if (!state) return;
    this.openDiff = {path, staged};
    this.gitDiffNote.hidden = true; this.gitSplit.hidden = true;
    this.gitDiff.hidden = false; this.gitDiff.textContent = `Loading ${staged ? 'staged' : 'unstaged'} diff for ${path}…`;
    try {
      const diff = await this.git.diff(state.sessionId, path, staged);
      if (this.openDiff?.path !== path || this.openDiff?.staged !== staged) return; // a newer diff was requested
      this.lastDiff = {diff, path, staged};
      this.renderDiff(focus);
    } catch (error) { this.gitDiff.textContent = `Diff failed: ${error?.message || error}`; this.diag('git', 'DIFF_FAILED'); }
  }
  /** Unified or side-by-side rendering, capped at MAX_DIFF_LINES with an explicit note. */
  renderDiff(focus = true) {
    const last = this.lastDiff; if (!last) return;
    const {diff, path, staged} = last, split = this.diffMode === 'split' && !diff.binary && diff.hunks.length > 0;
    this.gitModeToggle.setAttribute('aria-pressed', String(this.diffMode === 'split'));
    this.gitModeToggle.textContent = this.diffMode === 'split' ? 'Unified view' : 'Side-by-side view';
    let truncated = false, total = 0;
    if (split) {
      const {rows, truncated: cut} = splitRows(diff.hunks); truncated = cut; total = diff.hunks.reduce((s, x) => s + x.lines.length, 0);
      const cell = (no, text, side, kind) => [h('td', {class: 'git-no', text: no == null ? '' : String(no)}), h('td', {class: `git-code ${kind === 'change' && text != null ? side : ''}`, text: text == null ? '' : text.replace(/\r$/, '')})];
      const table = h('table', {class: 'git-split-table'},
        h('colgroup', {}, h('col', {class: 'git-no-col'}), h('col', {}), h('col', {class: 'git-no-col'}), h('col', {})),
        h('thead', {}, h('tr', {}, h('th', {scope: 'col', colspan: '2', text: `Before · ${diff.oldLabel}`}), h('th', {scope: 'col', colspan: '2', text: `After · ${diff.newLabel}`}))),
        h('tbody', {}, rows.map(r => r.kind === 'hunk' ? h('tr', {class: 'hunk'}, h('td', {colspan: '4', text: r.text})) : h('tr', {'data-kind': r.kind}, ...cell(r.oldNo, r.oldText, 'del', r.kind), ...cell(r.newNo, r.newText, 'add', r.kind)))));
      this.gitSplit.replaceChildren(table); this.gitSplit.hidden = false; this.gitDiff.hidden = true;
    } else {
      const lines = unifiedDiff(diff).split('\n'); total = lines.length; truncated = lines.length > MAX_DIFF_LINES;
      this.gitDiff.replaceChildren(...lines.slice(0, MAX_DIFF_LINES).map(line => h('span', {class: line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}, line + '\n')));
      this.gitDiff.hidden = false; this.gitSplit.hidden = true;
    }
    const target = split ? this.gitSplit : this.gitDiff;
    target.setAttribute('aria-label', `${staged ? 'Staged' : 'Unstaged'} diff for ${path}: ${diff.additions} additions, ${diff.deletions} deletions${split ? ', side by side' : ''}`);
    const notes = [];
    if (diff.binary) notes.push('Binary file: Melly shows no line diff for binary content.');
    if (diff.approximate) notes.push(diff.hunks.length ? 'Large change: shown as a full replacement because a minimal line diff would be too expensive.' : 'File is larger than 4 MiB: no line diff is computed.');
    if (truncated) notes.push(`Large diff: only the first ${MAX_DIFF_LINES} of ${total} lines are rendered to keep the window responsive. Hunk navigation covers the rendered part.`);
    this.gitDiffNote.textContent = notes.join(' '); this.gitDiffNote.hidden = !notes.length;
    const hunks = target.querySelectorAll('.hunk').length;
    this.hunkIndex = -1; this.gitDiffNav.hidden = hunks < 1 && !diff.hunks.length;
    this.gitHunkLabel.textContent = hunks ? `${hunks} hunk(s) · +${diff.additions} −${diff.deletions} · ${diff.oldLabel} → ${diff.newLabel}${diff.lossy ? ' · not valid UTF-8, shown lossily' : ''}` : '';
    for (const el of [this.gitDiff, this.gitSplit]) if (!el.dataset.keys) { el.dataset.keys = '1'; el.addEventListener('keydown', e => { if (e.key === 'n' || e.key === 'p') { e.preventDefault(); this.hunk(e.key === 'n' ? 1 : -1); } }); }
    if (focus) target.focus();
  }
  async openSource(path) {
    this.app.switchView('code'); this.app.shell?.toggleExplorer?.(true);
    await this.app.localFolder.openFile(path);
  }

  // ---------- Terminal ----------
  buildTerminal() {
    const panel = document.getElementById('devPanel-terminal');
    this.terminalBadge = h('span', {class: 'connection-pill', id: 'terminalCapability'});
    this.terminalCwd = h('p', {id: 'terminalCwd'});
    this.terminalState = h('p', {id: 'terminalState', class: 'devcenter-status', role: 'status', 'aria-live': 'polite'});
    this.terminalOutput = h('pre', {id: 'terminalOutput', class: 'terminal-output', role: 'log', 'aria-label': 'Terminal output', tabindex: '0'});
    this.terminalApproval = h('dialog', {id: 'terminalApproval', 'aria-labelledby': 'terminalApprovalTitle'},
      h('h2', {id: 'terminalApprovalTitle', text: 'Approve process start?'}), h('p', {id: 'terminalApprovalText'}),
      h('div', {class: 'devcenter-actions'}, h('button', {class: 'quiet-button', id: 'terminalApprove', onclick: () => this.terminalApproval.close('approve'), text: 'Approve this start'}), h('button', {class: 'quiet-button', onclick: () => this.terminalApproval.close('cancel'), text: 'Cancel'})));
    panel.append(h('div', {class: 'surface devcenter-card'},
      h('div', {class: 'devcenter-actions'}, h('strong', {text: 'Interactive terminal (shell)'}), this.terminalBadge),
      this.terminalCwd, this.terminalState,
      h('div', {class: 'devcenter-actions'},
        h('button', {class: 'primary-button', id: 'terminalStart', onclick: () => void this.requestTerminalStart(), text: 'Start terminal'}),
        h('button', {class: 'quiet-button', id: 'terminalStop', onclick: () => void this.terminal.stop(), text: 'Stop'})),
      h('p', {class: 'fine-print', text: 'An interactive shell would turn every typed line into new execution authority that no single approval can cover, so it is not compiled into this build and stays disabled. Use the Approved Command Runner below: one command at a time, each approved in a Windows dialog.'})),
      this.terminalOutput, this.terminalApproval);
    this.buildRunner(panel);
    this.renderTerminal();
  }
  // ---------- MEGA-08 Approved Command Runner ----------
  buildRunner(panel) {
    const field = (label, control) => h('label', {}, label, control);
    this.runnerBadge = h('span', {class: 'connection-pill', id: 'runnerCapability', text: 'CHECKING'});
    this.runnerProgram = h('input', {id: 'runnerProgram', autocomplete: 'off', spellcheck: 'false', placeholder: 'npm', 'aria-describedby': 'runnerHelp'});
    this.runnerArgs = h('textarea', {id: 'runnerArgs', rows: '3', spellcheck: 'false', placeholder: 'test', 'aria-describedby': 'runnerHelp'});
    this.runnerCwd = h('input', {id: 'runnerCwd', autocomplete: 'off', spellcheck: 'false', placeholder: '(folder root)'});
    this.runnerEnv = h('select', {id: 'runnerEnv'}, h('option', {value: 'inherit', text: 'Inherit my environment'}), h('option', {value: 'minimal', text: 'Minimal system variables'}));
    this.runnerTimeout = h('input', {id: 'runnerTimeout', type: 'number', min: '1', max: '3600', value: '600'});
    this.runnerState = h('p', {id: 'runnerState', class: 'devcenter-status', role: 'status', 'aria-live': 'polite'});
    this.runnerOutput = h('pre', {id: 'runnerOutput', class: 'terminal-output', role: 'log', 'aria-label': 'Command output', tabindex: '0'});
    this.runnerHistory = h('ol', {id: 'runnerHistory', class: 'job-events'});
    // MEGA-09: the exact argument array is shown before the native dialog, one entry per line.
    this.runnerPreview = h('ol', {id: 'runnerPreview', class: 'runner-preview', 'aria-label': 'Exact program and arguments that will be sent for approval'});
    this.runnerStream = h('select', {id: 'runnerStream', 'aria-label': 'Show output streams', onchange: () => this.renderRunner()},
      [['all', 'All output'], ['stdout', 'stdout only'], ['stderr', 'stderr only'], ['system', 'Melly messages only']].map(([v, t]) => h('option', {value: v, text: t})));
    this.runnerLast = h('dl', {id: 'runnerLast', class: 'devcenter-facts', hidden: true, 'aria-label': 'Last run evidence'});
    for (const el of [this.runnerProgram, this.runnerArgs, this.runnerCwd]) el.addEventListener('input', () => this.renderRunnerPreview());
    this.runnerAttach = h('button', {class: 'quiet-button', id: 'runnerAttach', hidden: true, onclick: () => this.attachVerification(), text: 'Attach result to job'});
    panel.append(h('section', {class: 'surface devcenter-card', id: 'runnerCard', 'aria-label': 'Approved command runner'},
      h('div', {class: 'devcenter-actions'}, h('h2', {text: 'Approved command runner'}), this.runnerBadge),
      h('p', {class: 'fine-print', id: 'runnerHelp', text: 'Not a shell: one program and its arguments (one argument per line, no quoting or expansion) run once in the open Local Folder, after you approve that exact specification in a Windows dialog. Runs have your Windows permissions and are not sandboxed; Melly stops the whole process tree on cancel, timeout or exit. Claude Code and Codex run from Agents.'}),
      h('div', {class: 'devcenter-actions'},
        h('button', {class: 'quiet-button', id: 'runnerEnable', onclick: () => void this.runner.enable().then(() => this.refreshProviders()), text: 'Enable execution for this session…'}),
        h('button', {class: 'quiet-button', id: 'runnerDisable', onclick: () => void this.runner.disable(), text: 'Disable execution'})),
      h('form', {id: 'runnerForm', class: 'runner-form', onsubmit: event => { event.preventDefault(); void this.runCommand(); }},
        h('div', {class: 'devcenter-row'}, field('Program', this.runnerProgram), field('Working directory (inside the folder)', this.runnerCwd), field('Environment', this.runnerEnv), field('Timeout (s)', this.runnerTimeout)),
        field('Arguments (one per line)', this.runnerArgs),
        h('div', {class: 'runner-review'}, h('strong', {text: 'Will be sent for native approval'}), this.runnerPreview,
          h('p', {class: 'fine-print', id: 'runnerScope'})),
        h('div', {class: 'devcenter-actions'},
          h('button', {class: 'primary-button', type: 'submit', id: 'runnerRun', text: 'Request approval and run'}),
          h('button', {class: 'quiet-button', type: 'button', id: 'runnerCancel', onclick: () => void this.runner.cancel(), text: 'Cancel run'}),
          h('button', {class: 'quiet-button', type: 'button', id: 'runnerExample', onclick: () => this.loadRunnerExample(), text: 'Load example (node --version)'}),
          h('button', {class: 'quiet-button', type: 'button', id: 'runnerClear', onclick: () => this.runner.clear(), text: 'Clear output'}), this.runnerAttach)),
      this.runnerState, this.runnerLast, h('div', {class: 'devcenter-actions'}, h('label', {}, 'Show ', this.runnerStream)), this.runnerOutput,
      h('details', {}, h('summary', {text: 'Execution history (this device; arguments and output are not stored)'}), this.runnerHistory)));
    this.renderRunner(); this.renderRunnerPreview();
  }
  /** Fills a harmless example. It never runs: the person still requests and confirms approval. */
  loadRunnerExample() {
    this.runnerProgram.value = 'node'; this.runnerArgs.value = '--version'; this.runnerCwd.value = '';
    this.renderRunnerPreview(); this.runnerState.textContent = 'Example loaded: node --version. Nothing runs until you request approval and confirm the Windows dialog.'; this.runnerProgram.focus();
  }
  renderRunnerPreview() {
    if (!this.runnerPreview) return;
    const program = this.runnerProgram.value.trim(), args = parseArgsText(this.runnerArgs.value);
    this.runnerPreview.replaceChildren(...(program ? [h('li', {}, h('span', {class: 'runner-tag', text: 'program'}), h('code', {text: program})), ...args.map((a, i) => h('li', {}, h('span', {class: 'runner-tag', text: `arg ${i + 1}`}), h('code', {text: a})))] : [h('li', {class: 'empty-copy', text: 'Type a program name (for example npm, node, cargo).'})]));
    const scope = document.getElementById('runnerScope');
    if (scope) scope.textContent = `Folder: ${this.folder ? this.folder.name : 'none — open a Local Folder'}${this.runnerCwd.value.trim() ? ` › ${this.runnerCwd.value.trim()}` : ' (root)'} · environment ${this.runnerEnv.value} · timeout ${Number(this.runnerTimeout.value) || 600} s · ${args.length} argument(s), passed as-is (no shell, quoting or expansion). The Windows dialog shows the resolved executable path.`;
  }
  /** Reuses a history entry's program and folder only; arguments are never stored. */
  reuseHistory(entry) {
    this.runnerProgram.value = entry.program || ''; this.runnerCwd.value = entry.cwd || ''; this.runnerArgs.value = '';
    this.renderRunnerPreview(); this.runnerState.textContent = `Program restored from history. Its ${entry.argCount} argument(s) were not stored: type them again, then request approval.`; this.runnerArgs.focus();
  }
  async runCommand() {
    const result = await this.runner.run({sessionId: this.folder?.sessionId, program: this.runnerProgram.value, argsText: this.runnerArgs.value, cwd: this.runnerCwd.value, envScope: this.runnerEnv.value, timeoutSecs: Number(this.runnerTimeout.value)});
    this.diag('capability', result.started ? 'COMMAND_RUN' : 'COMMAND_NOT_STARTED', {state: result.final?.state || result.code || 'refused'});
    if (result.final?.changes?.total && this.gitState) void this.refreshGit();
  }
  attachVerification() {
    const last = this.runner.last;
    try { this.jobs.attachTests(this.verifyJob, last); this.runnerState.textContent = 'Result attached to the job as test evidence.'; this.verifyJob = null; this.renderRunner(); }
    catch (error) { this.runnerState.textContent = error.message; }
  }
  renderRunner() {
    if (!this.runnerBadge) return;
    const r = this.runner, c = r.capability;
    this.runnerBadge.textContent = {checking: 'CHECKING', unavailable: 'UNAVAILABLE · DESKTOP ONLY', disabled: 'DISABLED THIS SESSION', ready: 'ENABLED · EACH RUN NEEDS APPROVAL', 'awaiting-approval': 'WAITING FOR YOUR APPROVAL', starting: 'STARTING', running: 'RUNNING', cancelling: 'CANCELLING', error: 'ERROR'}[r.state];
    const labels = {checking: 'Checking the native broker…', unavailable: EXEC_UNAVAILABLE, disabled: c?.reason || 'Disabled.', ready: `Ready in ${this.folder ? this.folder.name : '— open a Local Folder first'}.`,
      'awaiting-approval': 'A Windows approval dialog is open. Review the exact program, arguments and folder there.', starting: 'Starting…', running: `Running ${r.current?.label || ''} · ${((r.current?.run?.elapsedMs || 0) / 1000).toFixed(0)} s`, cancelling: 'Cancelling…', error: `Error: ${r.error}`};
    this.runnerState.textContent = labels[r.state];
    const ready = r.state === 'ready';
    document.getElementById('runnerRun').disabled = !ready || !this.folder;
    document.getElementById('runnerCancel').disabled = !['running', 'cancelling'].includes(r.state);
    document.getElementById('runnerEnable').disabled = !this.client.available || c?.enabled || r.busy;
    document.getElementById('runnerDisable').disabled = !this.client.available || !c?.enabled;
    this.runnerAttach.hidden = !(this.verifyJob && r.last && Number.isInteger(r.last.exitCode));
    if (r.state === 'error' && r.lastFailure?.category) this.runnerState.textContent += ` · ${ERROR_CATEGORIES[r.lastFailure.category]}`;
    // Streams are kept apart (stdout plain, stderr marked, Melly messages prefixed) and can be filtered.
    const filter = this.runnerStream?.value || 'all', lines = r.lines.filter(l => filter === 'all' || l.stream === filter);
    const atBottom = this.runnerOutput.scrollHeight - this.runnerOutput.scrollTop - this.runnerOutput.clientHeight < 40;
    this.runnerOutput.replaceChildren(...(lines.length ? lines.map(l => h('span', {class: `stream-${l.stream}`, text: `${l.stream === 'system' ? '— ' : l.stream === 'stderr' ? 'stderr │ ' : ''}${l.text}\n`})) : [r.lines.length ? `No ${filter} output.` : 'No command has run in this session.']));
    if (atBottom) this.runnerOutput.scrollTop = this.runnerOutput.scrollHeight;
    const last = r.last;
    this.runnerLast.hidden = !last;
    if (last) {
      const fact = (t, v) => h('div', {}, h('dt', {text: t}), h('dd', {text: v}));
      this.runnerLast.replaceChildren(fact('Last run', last.label), fact('Outcome', `${last.state}${Number.isInteger(last.exitCode) ? ` · exit code ${last.exitCode}` : ''}${last.category ? ` · ${ERROR_CATEGORIES[last.category]}` : ' · clean exit'}`),
        fact('Process tree', `${last.treeVerified ? 'confirmed stopped (Windows Job Object empty)' : 'NOT confirmed stopped'}${last.leftoverTerminated ? ` · ${last.leftoverTerminated} leftover process(es) terminated` : ''}`),
        fact('Duration', last.elapsedMs != null ? `${(last.elapsedMs / 1000).toFixed(1)} s of ${last.timeoutSecs || '—'} s timeout` : '—'),
        fact('Folder changes during run', last.changes ? `${last.changes.total} · attribution ${last.changes.attribution === 'exclusive-melly-window' ? 'no other Melly activity' : 'uncertain'}` : 'none recorded'));
    }
    this.runnerHistory.replaceChildren(...(r.history.length ? [...r.history].reverse().map(e => h('li', {}, h('time', {datetime: e.at, text: time(e.at)}),
      ` ${e.program} (${e.argCount} arg${e.argCount === 1 ? '' : 's'})${e.cwd ? ` in ${e.cwd}` : ''} · ${e.state}${Number.isInteger(e.exitCode) ? ` · exit ${e.exitCode}` : ''}${e.elapsedMs != null ? ` · ${(e.elapsedMs / 1000).toFixed(1)} s` : ''}${e.code ? ` · ${e.code}` : ''}${e.category ? ` · ${ERROR_CATEGORIES[e.category] || e.category}` : ''}${e.treeVerified === false ? ' · tree NOT confirmed' : ''} `,
      h('button', {type: 'button', class: 'quiet-button runner-reuse', 'aria-label': `Reuse program ${e.program} (arguments are not stored)`, onclick: () => this.reuseHistory(e), text: 'Reuse program'}))) : [h('li', {text: 'No runs recorded.'})]));
    this.renderRunnerPreview();
  }
  async requestTerminalStart() {
    if (!['ready', 'stopped'].includes(this.terminal.state)) { await this.terminal.start({cwdLabel: this.folder?.name, approved: false}); return; }
    document.getElementById('terminalApprovalText').textContent = `Start a process in ${this.folder?.name || 'no selected folder'}? It runs with your Windows account permissions.`;
    this.terminalApproval.showModal();
    this.terminalApproval.addEventListener('close', () => void this.terminal.start({cwdLabel: this.folder?.name, approved: this.terminalApproval.returnValue === 'approve'}), {once: true});
  }
  renderTerminal() {
    if (!this.terminalBadge) return;
    const t = this.terminal, c = t.capability;
    if (t.state !== 'checking' && !this.terminalNoted) { this.terminalNoted = true; this.diag('capability', c?.available ? 'TERMINAL_AUTHORIZED' : 'TERMINAL_DISABLED', {state: t.state}); }
    this.terminalBadge.textContent = t.state === 'checking' ? 'CHECKING' : c?.available ? 'EXECUTION AUTHORIZED' : c?.execution === 'disabled' ? 'EXECUTION DISABLED · NOT AUTHORIZED' : 'UNAVAILABLE';
    this.terminalCwd.textContent = `Working directory: ${this.folder ? `${this.folder.name} (Local Folder)` : 'none — open a Local Folder'}`;
    const labels = {checking: 'Checking native capability…', unavailable: c?.reason || 'Unavailable.', disabled: `Disabled. ${c?.reason || ''}`, ready: 'Ready. A start requires your approval.', starting: 'Starting…', running: 'Running.', stopping: 'Stopping…', stopped: 'Stopped.', error: `Error: ${t.error}`};
    this.terminalState.textContent = `Session: ${labels[t.state]}${t.error && t.state !== 'error' ? ` Last action: ${t.error}` : ''}`;
    document.getElementById('terminalStart').disabled = !['ready', 'stopped'].includes(t.state);
    document.getElementById('terminalStop').disabled = t.state !== 'running';
    this.terminalOutput.textContent = t.lines.length ? t.lines.map(l => `[${time(l.at)}] ${l.source}: ${l.text}`).join('\n') : 'No process has been started. No output.';
    this.renderRunner?.();
  }

  // ---------- Agents (MEGA-08 job engine) ----------
  async refreshProviders() {
    if (!this.client.available) { this.providers = {}; this.renderAgents(); this.renderStatus(); return; }
    try { for (const p of await this.client.detect()) this.providers[p.id] = p; this.agentStatus = ''; }
    catch (error) { this.agentStatus = `Agent detection failed: ${errorText(error)}`; }
    this.syncProfiles(); this.renderAgents(); this.renderStatus();
  }
  async probeProvider(id) {
    this.agentStatus = `Checking ${id}: running only its fixed --version and help commands…`; this.renderAgents();
    try {
      const p = await this.client.probe(id); this.providers[id] = p;
      this.agentStatus = `${p.name}: ${p.state}${p.version ? ` ${p.version}` : ''}${p.error ? ` · ${p.error}` : ''}${p.missing?.length ? ` · missing flags: ${p.missing.join(', ')}` : ''}`;
      this.diag('agents', 'PROBE', {state: p.state});
    } catch (error) { this.agentStatus = `Check failed: ${errorText(error)}`; }
    this.syncProfiles(); this.renderAgents(); this.renderStatus();
  }
  buildAgents(recovery) {
    const panel = document.getElementById('devPanel-agents');
    const field = (label, control, hint) => h('label', {}, label, control, hint ? h('small', {class: 'fine-print', text: hint}) : null);
    this.agentProviders = h('ul', {class: 'agent-list', id: 'agentProviders'});
    this.agentStatusLine = h('p', {class: 'devcenter-status', id: 'agentStatus', role: 'status', 'aria-live': 'polite'});
    this.jobTitle = h('input', {id: 'jobTitle', maxlength: '120', 'aria-required': 'true', autocomplete: 'off'});
    this.jobAgent = h('select', {id: 'jobAgent', onchange: () => this.syncProfiles()}, PROVIDERS.map(p => h('option', {value: p.id, text: p.name})));
    this.jobProfile = h('select', {id: 'jobProfile', 'aria-describedby': 'jobProfileHelp', onchange: () => this.updateProfileHelp()});
    this.jobProfileHelp = h('p', {id: 'jobProfileHelp', class: 'fine-print profile-help', 'aria-live': 'polite'});
    this.jobModel = h('input', {id: 'jobModel', maxlength: '80', autocomplete: 'off', spellcheck: 'false', placeholder: 'CLI default'});
    this.jobTimeout = h('input', {id: 'jobTimeout', type: 'number', min: '1', max: '120', value: '30'});
    this.jobInstructions = h('textarea', {id: 'jobInstructions', rows: '4', maxlength: '32768', 'aria-required': 'true'});
    this.jobFormStatus = h('p', {id: 'jobFormStatus', class: 'devcenter-status', role: 'status', 'aria-live': 'polite'});
    this.jobList = h('div', {id: 'jobList'}); this.jobDetail = h('section', {id: 'jobDetail', class: 'surface devcenter-card', 'aria-label': 'Job detail', hidden: true});
    panel.append(
      h('section', {class: 'surface devcenter-card', 'aria-label': 'Agents'},
        h('div', {class: 'devcenter-actions'}, h('h2', {text: 'Agents'}), h('button', {class: 'quiet-button', id: 'agentDetect', onclick: () => void this.refreshProviders(), text: 'Detect CLIs'})),
        this.agentProviders, this.agentStatusLine,
        h('p', {class: 'fine-print', text: 'Melly runs the official Claude Code and Codex CLIs you installed, with their own sign-in and configuration. Detect only locates the program; Check CLI runs its fixed --version and help commands and needs execution enabled. A job runs only after you approve it in a Windows dialog that lists the exact program, arguments, folder and permissions. No permission-bypass mode is ever used. The CLI runs with your Windows permissions; it is not OS-sandboxed.'})),
      h('form', {class: 'surface devcenter-card', id: 'jobForm', 'aria-label': 'Create job', onsubmit: event => { event.preventDefault(); this.createJob(); }},
        h('h2', {text: 'Create job'}),
        field('Title', this.jobTitle), field('Agent', this.jobAgent), field('Permission profile', this.jobProfile), this.jobProfileHelp,
        field('Model (optional)', this.jobModel, 'Passed to the CLI’s model option only when the installed CLI supports it. Empty uses your CLI configuration.'),
        field('Timeout (minutes)', this.jobTimeout),
        field('Task (sent to the agent on standard input; stored on this device)', this.jobInstructions),
        h('button', {class: 'primary-button', type: 'submit', id: 'jobCreate', text: 'Add to queue'}), this.jobFormStatus),
      this.jobList, this.jobDetail);
    this.syncProfiles();
    const notes = [];
    if (recovery?.recovered) notes.push(`${recovery.recovered} job(s) from an earlier session were reconciled: approvals are never kept and nothing is re-run automatically.`);
    if (recovery?.migrated) notes.push(`${recovery.migrated} legacy metadata-only job(s) were migrated read-only from schema v1.`);
    this.jobFormStatus.textContent = notes.join(' ');
    this.ticker = setInterval(() => this.tick(), 1000);
    this.renderAgents();
  }
  syncProfiles() {
    if (!this.jobProfile) return;
    const id = this.jobAgent.value, provider = this.providers[id], previous = this.jobProfile.value;
    const labels = {plan: 'Read-only plan (no edits)', edit: 'Edit files in this folder (code-running tools removed)', 'read-only': 'Read-only sandbox', 'workspace-write': 'Workspace-write sandbox (edits and sandboxed commands)'};
    const ids = PROVIDERS.find(p => p.id === id).profiles;
    const gated = p => isWritable(id, p) && provider?.writableEnabled !== true;
    this.jobProfile.replaceChildren(...ids.map(p => h('option', {value: p, disabled: gated(p) ? '' : null, text: `${labels[p]}${gated(p) ? ' · disabled until the writable-agent contract is accepted' : provider?.state === 'ready' && !provider.profiles.some(x => x.id === p) ? ' · not supported by the installed CLI' : ''}`})));
    if (ids.includes(previous) && !gated(previous)) this.jobProfile.value = previous;
    this.updateProfileHelp();
  }
  updateProfileHelp() {
    if (!this.jobProfileHelp) return;
    const p = this.providers[this.jobAgent.value], profile = this.jobProfile.value;
    this.jobProfileHelp.textContent = `${PROFILE_HELP[profile] || ''}${p?.state === 'ready' ? '' : ' The selected CLI has not been checked in this session yet.'} Approving a job approves the whole agent session; later tool actions are not approved one by one.`;
  }
  /** Truthful getting-started checklist for the empty Agent Control Center. */
  agentChecklist(execOn) {
    const ready = PROVIDERS.some(p => this.providers[p.id]?.state === 'ready');
    const steps = [
      ['Use the Windows desktop app', this.client.available, 'Browsers and the PWA never run agents.'],
      ['Open a Local Folder (Code → Files & projects)', !!this.folder, 'Use a disposable copy for your first test.'],
      ['Enable execution for this session (Terminal tab)', execOn, 'A Windows dialog asks; it is off again after a restart.'],
      ['Check the CLI (shows READY with its version)', ready, 'Runs only --version and help; no model request.'],
      ['Create a job with a read-only profile', false, 'Plan (Claude Code) or read-only sandbox (Codex).'],
      ['Approve and queue it, then confirm the exact command in the Windows dialog', false, 'Real tasks use your own CLI sign-in and plan.']];
    return h('section', {class: 'surface devcenter-card', id: 'agentChecklist', 'aria-labelledby': 'agentChecklistTitle'},
      h('h2', {id: 'agentChecklistTitle', text: 'Get started with agents'}),
      h('ol', {class: 'agent-checklist'}, steps.map(([text, done, hint]) => h('li', {'data-done': String(!!done)}, h('span', {class: 'check-mark', 'aria-hidden': 'true', text: done ? '✓' : '○'}), h('strong', {text}), h('small', {text: ` ${done ? 'Done.' : 'Not yet.'} ${hint}`})))));
  }
  createJob() {
    try {
      const job = this.jobs.create({title: this.jobTitle.value, task: this.jobInstructions.value, provider: this.jobAgent.value, profile: this.jobProfile.value, model: this.jobModel.value.trim(), timeoutSecs: Math.round(Number(this.jobTimeout.value) * 60)});
      this.jobTitle.value = ''; this.jobInstructions.value = ''; this.selectedJob = job.id;
      this.jobFormStatus.textContent = 'Job recorded as pending approval. Not executed. Select “Approve and queue…” to review it in a Windows dialog.'; this.renderAgents();
    } catch (error) { this.jobFormStatus.textContent = error.message; (/task/i.test(error.message) ? this.jobInstructions : this.jobTitle).focus(); }
  }
  async act(fn) { try { await fn(); } catch (error) { this.jobFormStatus.textContent = error.message; } this.renderAgents(); }
  verify(job) {
    this.verifyJob = job.id; this.select('terminal');
    if (!this.runnerProgram.value) { this.runnerProgram.value = 'npm'; this.runnerArgs.value = 'test'; }
    this.renderRunner(); this.runnerState.textContent = `Verification for “${job.title}”: review the command, run it, then Attach result to job records its real exit code as test evidence.`;
    this.runnerProgram.focus();
  }
  review(job) { this.reviewJob = job.id; this.select('git'); void this.refreshGit(); }
  jobFinished(job) {
    this.diag('agents', 'FINISHED', {state: job.state, exit: job.exitCode ?? 'none'});
    if (this.folder && this.gitState) void this.refreshGit();
  }
  tick() {
    const el = document.getElementById('jobElapsed'), job = this.selectedJob && this.jobs.jobs.find(j => j.id === this.selectedJob);
    if (el && job?.startedAt && ACTIVE_STATES.includes(job.state)) el.textContent = `${Math.max(0, Math.round((Date.now() - Date.parse(job.startedAt)) / 1000))} s (running)`;
    if (this.runner.state === 'running' && this.runnerState) this.runnerState.textContent = `Running ${this.runner.current?.label || ''} · ${((this.runner.current?.run?.elapsedMs || 0) / 1000).toFixed(0)} s`;
  }
  renderAgents() {
    if (!this.jobList) return;
    const focusId = document.activeElement?.id;
    const providerLabel = id => PROVIDERS.find(p => p.id === id)?.name || 'Legacy (metadata only)';
    const execOn = !!this.runner.capability?.enabled;
    const stateLabels = {'not-installed': 'NOT INSTALLED', installed: 'INSTALLED · NOT CHECKED', ready: 'READY', unsupported: 'UNSUPPORTED VERSION', error: 'ERROR'};
    this.agentProviders.replaceChildren(...PROVIDERS.map(spec => {
      const p = this.providers[spec.id];
      const state = !this.client.available ? 'UNAVAILABLE · DESKTOP ONLY' : !p ? 'NOT DETECTED' : stateLabels[p.state] || String(p.state).toUpperCase();
      return h('li', {'data-provider': spec.id}, h('strong', {text: spec.name}), h('span', {class: 'connection-pill', text: state}),
        h('small', {text: !this.client.available ? EXEC_UNAVAILABLE : p?.executable ? `${p.executable}${p.version ? ` · version ${p.version}` : ''}${p.profiles?.length ? ` · profiles: ${p.profiles.map(x => x.label).join(', ')}` : ''}${p.missing?.length ? ` · missing: ${p.missing.join(', ')}` : ''}${p.error ? ` · ${p.error}` : ''}` : 'Not found on PATH.'}),
        p?.executable ? h('button', {class: 'quiet-button', id: `agentProbe-${spec.id}`, disabled: !execOn, title: execOn ? '' : 'Enable execution for this session first (Terminal tab).', onclick: () => void this.probeProvider(spec.id), text: 'Check CLI'}) : null,
        p?.notes?.length ? h('details', {}, h('summary', {text: 'Permission policy'}), h('ul', {}, p.notes.map(n => h('li', {text: n})))) : null);
    }));
    this.agentStatusLine.textContent = this.agentStatus || (this.client.available ? (execOn ? 'Execution is enabled for this session.' : 'Execution is disabled. Enable it in the Terminal tab to check CLIs and run jobs.') : 'Browser mode: jobs can be reviewed here but are never executed. Running Claude Code or Codex needs the Windows desktop app.');
    const jobs = this.jobs.snapshot();
    const group = {pending: s => s === 'pending-approval', queued: s => s === 'queued', active: s => ACTIVE_STATES.includes(s), completed: s => s === 'completed', failed: s => s === 'failed', cancelled: s => s === 'cancelled', attention: s => ['interrupted', 'orphaned', 'unknown'].includes(s)};
    const counts = Object.entries(group).map(([k, f]) => `${jobs.filter(j => f(j.state)).length} ${k}`).join(' · ');
    const filters = {all: () => true, attention: s => group.pending(s) || group.attention(s) || group.failed(s), active: s => group.queued(s) || group.active(s), finished: s => group.completed(s) || group.cancelled(s) || group.failed(s)};
    const shown = jobs.filter(j => (filters[this.jobFilter] || filters.all)(j.state));
    this.jobList.replaceChildren(...(jobs.length ? [] : [this.agentChecklist(execOn)]), h('section', {class: 'surface devcenter-card', 'aria-label': 'Job queue'},
      h('div', {class: 'devcenter-actions'}, h('h2', {text: 'Queue'}),
        h('label', {}, 'Show ', h('select', {id: 'jobFilter', onchange: e => { this.jobFilter = e.target.value; this.renderAgents(); }},
          [['all', 'All jobs'], ['attention', 'Needs attention'], ['active', 'Queued or running'], ['finished', 'Finished']].map(([v, t]) => h('option', {value: v, selected: this.jobFilter === v, text: t})))),
        h('button', {class: 'quiet-button', id: 'jobPause', onclick: () => { if (this.jobs.settings.paused) this.jobs.resume(); else this.jobs.pause(); }, text: this.jobs.settings.paused ? 'Resume queue' : 'Pause queue'}),
        h('label', {}, 'Concurrent jobs ', h('select', {id: 'jobConcurrency', onchange: e => void this.act(() => this.jobs.setConcurrency(Number(e.target.value)))}, [1, 2].map(n => h('option', {value: String(n), selected: this.jobs.settings.concurrency === n, text: String(n)}))))),
      h('p', {class: 'fine-print', id: 'jobCounts', text: `${counts}${this.jobs.settings.paused ? ' · queue paused' : ''} · first approved, first started; one agent job per folder at a time`}),
      this.jobs.persistError ? h('p', {class: 'devcenter-status', 'data-error': 'true', text: `Queue could not be saved on this device: ${this.jobs.persistError}`}) : null,
      jobs.length && !shown.length ? h('p', {class: 'empty-copy', text: 'No job matches this filter.'}) : null,
      shown.length ? h('ul', {class: 'job-list'}, [...shown].reverse().map(job => h('li', {},
        h('button', {class: 'job-row', 'data-job': job.id, 'aria-pressed': String(job.id === this.selectedJob), onclick: () => { this.selectedJob = job.id; this.renderAgents(); document.getElementById('jobDetail').focus(); }},
          h('strong', {text: job.title}), h('span', {class: 'job-state', 'data-state': job.state, text: job.state}),
          h('small', {text: `${providerLabel(job.provider)}${job.profile ? ` · ${job.profile}` : ''} · attempt ${job.attempt} · ${time(job.createdAt)}`}))))) : jobs.length ? null : h('p', {class: 'empty-copy', text: 'No jobs yet. Follow the steps above to create your first read-only job.'})));
    const job = jobs.find(j => j.id === this.selectedJob);
    this.jobDetail.hidden = !job; this.jobDetail.tabIndex = -1;
    if (!job) return;
    const check = this.jobs.canApprove(job.id), p = job.progress, c = job.changes;
    const block = (title, value, id) => h('div', {}, h('dt', {text: title}), h('dd', {id, text: value}));
    const approvals = {none: 'Not requested', approved: `Approved in the native dialog ${time(job.approval.at)} · single use · expires ${time(job.approval.expiresAt)}`, consumed: `Approved ${time(job.approval.at)} · used for this attempt`, denied: 'Declined in the native dialog', refused: `Refused: ${job.approval.code}`, expired: 'Expired or lost (never kept across restarts)', invalidated: `Invalidated (${job.approval.code})`, withdrawn: 'Withdrawn'};
    const lines = this.jobs.output(job.id), denied = deniedActions(job);
    // A read-only agent that wanted to write is told so plainly; Melly never elevates on its own.
    const limitation = denied.all.length ? h('div', {class: 'job-limitation', role: 'note', id: 'jobLimitation'},
      h('strong', {text: denied.writes.length ? 'Read-only profile: the agent wanted to change files or run commands' : 'The agent asked for actions this profile does not allow'}),
      h('p', {text: `Denied: ${denied.all.join(', ')}. Melly did not grant them and never raises permissions during a run; approving this job approved only its ${job.profile || 'read-only'} profile. Review the agent’s proposal, then make and save any edits yourself (or wait for the writable-agent contract).`})) : null;
    this.jobDetail.replaceChildren(h('h2', {text: job.title}), limitation,
      h('dl', {class: 'devcenter-facts'},
        block('State', job.state + (job.cancelRequested && ACTIVE_STATES.includes(job.state) ? ' · cancellation requested' : '')),
        block('Agent', `${providerLabel(job.provider)}${job.profile ? ` · ${job.profile}` : ''} · model ${job.model || 'CLI default'}`),
        block('Workspace', job.workspace?.name || '—'), block('Attempt', String(job.attempt)), block('Approval', approvals[job.approval.state] || job.approval.state),
        block('Native run', job.runId ? `${job.runId.slice(0, 12)}… · pid ${job.pid}` : 'None'),
        block('Elapsed', job.elapsedMs != null ? `${(job.elapsedMs / 1000).toFixed(1)} s` : '—', 'jobElapsed'),
        block('Exit code', job.exitCode != null ? String(job.exitCode) : 'None recorded'),
        block('Current stage', p?.stage || '—'), block('Last meaningful output', p?.lastMessage || '—'),
        block('Tool activity observed', p ? `${p.toolUses} use(s)${p.toolNames.length ? `: ${p.toolNames.join(', ')}` : ''}` : 'None observed'),
        block('Agent-reported result', p?.result ? `${p.result.ok ? 'success' : 'error'} (${p.result.subtype})${p.result.turns != null ? ` · ${p.result.turns} turn(s)` : ''}` : 'Not reported'),
        block('Permission denials', p?.result?.denials?.length ? p.result.denials.join(', ') : 'None reported'),
        block('Output parsing', p ? `${p.malformed} malformed · ${p.rawLines} non-JSON line(s)` : '—'),
        block('Files changed during job', c ? `${c.total} (${c.added.length} added, ${c.modified.length} modified, ${c.removed.length} removed) · attribution ${c.attribution === 'exclusive-melly-window' ? 'no other Melly activity' : 'uncertain'}` : '—'),
        block('Tests', job.tests.state === 'not-run' ? 'Not run' : `${job.tests.state} · ${job.tests.summary}`),
        block('Error category', job.errorCategory || '—'),
        block('Created', time(job.createdAt)), block('Started', job.startedAt ? time(job.startedAt) : '—'), block('Ended', job.endedAt ? time(job.endedAt) : '—')),
      job.task ? h('details', {}, h('summary', {text: 'Task'}), h('pre', {text: job.task})) : null,
      job.approval.args ? h('details', {}, h('summary', {text: 'Approved native specification'}), h('pre', {text: `${job.approval.executable}\n${job.approval.args.map((a, i) => `  [${i + 1}] ${a}`).join('\n')}\nspec SHA-256 ${job.approval.specHash}`})) : null,
      h('div', {class: 'devcenter-actions'},
        h('button', {class: 'primary-button', id: 'jobRun', disabled: !check.ok, title: check.reason, onclick: () => void this.act(() => this.jobs.approve(job.id)), text: 'Approve and queue…'}),
        h('button', {class: 'quiet-button', id: 'jobCancel', disabled: !['pending-approval', 'queued', 'starting', 'running', 'waiting-permission'].includes(job.state), onclick: () => void this.act(() => this.jobs.cancel(job.id)), text: ACTIVE_STATES.includes(job.state) ? 'Request cancellation' : 'Cancel'}),
        h('button', {class: 'quiet-button', id: 'jobRetry', disabled: job.legacy || !['failed', 'cancelled', 'interrupted', 'unknown', 'orphaned'].includes(job.state), onclick: () => void this.act(() => this.jobs.retry(job.id)), text: 'Retry as new attempt'}),
        h('button', {class: 'quiet-button', id: 'jobReview', disabled: !job.changes || !this.folder, onclick: () => this.review(job), text: 'Review changes in Git'}),
        h('button', {class: 'quiet-button', id: 'jobVerify', disabled: !this.client.available || !this.folder || job.legacy, onclick: () => this.verify(job), text: 'Run verification command…'}),
        h('button', {class: 'quiet-button', id: 'jobRemove', disabled: ACTIVE_STATES.includes(job.state), onclick: () => void this.act(() => { this.jobs.remove(job.id); this.selectedJob = null; }), text: 'Remove'})),
      check.ok || job.state !== 'pending-approval' ? null : h('p', {class: 'fine-print', id: 'jobRunReason', text: `Run unavailable: ${check.reason}`}),
      h('h3', {text: 'Executor output'}),
      lines.length ? h('pre', {class: 'terminal-output', id: 'jobOutput', text: lines.map(l => l.stream === 'stderr' ? `stderr │ ${l.text}` : l.text).join('').slice(-64 * 1024)}) : h('p', {class: 'empty-copy', text: 'No executor output recorded.'}),
      h('p', {class: 'fine-print', text: 'Live output stays in memory only (redacted natively). After a restart only the summary and evidence below remain.'}),
      job.summary ? h('details', {open: true}, h('summary', {text: 'Sanitized summary'}), h('pre', {text: job.summary})) : null,
      job.evidence.length ? h('details', {}, h('summary', {text: `Evidence (${job.evidence.length})`}), h('ol', {class: 'job-events'}, job.evidence.map(e => h('li', {text: `${time(e.at)} ${e.type}${e.runId ? ` run ${e.runId.slice(0, 12)}…` : ''}${e.specHash ? ` spec ${e.specHash.slice(0, 12)}…` : ''}${e.exitCode != null ? ` exit ${e.exitCode}` : ''}${e.treeVerified != null ? ` tree ${e.treeVerified ? 'stopped' : 'unconfirmed'}` : ''}`})))) : null,
      h('h3', {text: 'Events'}),
      h('ol', {class: 'job-events'}, job.events.map(e => h('li', {}, h('time', {datetime: e.at, text: time(e.at)}), ` ${e.type}: ${e.detail}`))));
    if (focusId && document.activeElement?.id !== focusId) document.getElementById(focusId)?.focus({preventScroll: true});
  }
  trackJobs(jobs) {
    for (const job of jobs) {
      const previous = this.jobStates.get(job.id);
      if (previous === undefined) this.diag('agents', 'CREATED', {state: job.state});
      else if (previous !== job.state) this.diag('agents', 'TRANSITION', {from: previous, to: job.state});
      this.jobStates.set(job.id, job.state);
    }
    for (const id of [...this.jobStates.keys()]) if (!jobs.some(j => j.id === id)) { this.jobStates.delete(id); this.diag('agents', 'REMOVED'); }
  }

  // ---------- Diagnostics ----------
  buildDiagnostics() {
    const panel = document.getElementById('devPanel-diagnostics');
    this.diagFilter = h('select', {id: 'diagFilter', 'aria-label': 'Event category', onchange: () => this.renderDiagnosticsPanel()}, h('option', {value: '', text: 'All categories'}), CATEGORIES.map(c => h('option', {value: c, text: c})));
    this.diagIdentity = h('dl', {class: 'devcenter-facts', id: 'diagIdentity'});
    this.diagEvents = h('ol', {class: 'job-events diag-events', id: 'diagEvents', 'aria-label': 'Recent diagnostic events'});
    this.diagStatus = h('p', {class: 'devcenter-status', id: 'diagStatus', role: 'status', 'aria-live': 'polite'});
    panel.append(
      h('div', {class: 'surface devcenter-card'},
        h('div', {class: 'devcenter-actions'}, h('strong', {text: 'Local diagnostics'}), h('span', {class: 'connection-pill', text: 'ON THIS DEVICE · NOT SENT'})),
        h('p', {class: 'fine-print', text: 'Melly records error codes, state transitions and counts for troubleshooting. It never records source text, file contents, file or folder names, paths, credentials or tokens, and nothing is uploaded. Export creates a file you can choose to share.'}),
        this.diagIdentity,
        h('div', {class: 'devcenter-actions'},
          h('button', {class: 'primary-button', id: 'diagRefresh', onclick: () => void this.refreshDiagnostics(), text: 'Refresh'}),
          h('button', {class: 'quiet-button', id: 'diagExport', onclick: () => this.exportDiagnostics(), text: 'Export report (JSON)'}),
          h('button', {class: 'quiet-button', id: 'diagClear', onclick: () => { if (window.confirm('Clear the local diagnostic events on this device?')) { this.app.diagnostics?.clear(); this.renderDiagnosticsPanel(); } }, text: 'Clear events'})),
        this.diagStatus),
      h('section', {class: 'surface devcenter-card', 'aria-label': 'Diagnostic events'}, h('div', {class: 'devcenter-actions'}, h('h2', {text: 'Recent events'}), h('label', {}, 'Category ', this.diagFilter)), this.diagEvents));
    this.app.diagnostics?.subscribe(() => { if (this.tab === 'diagnostics') this.renderDiagnosticsPanel(); });
    this.renderDiagnosticsPanel();
  }
  async refreshDiagnostics() {
    if (this.invoke && this.app.diagnostics) {
      try { this.app.diagnostics.setNative(await this.invoke('app_diagnostics')); this.diagStatus.dataset.error = 'false'; this.diagStatus.textContent = `Native report loaded · ${new Date().toLocaleTimeString()}`; }
      catch (error) { this.diagStatus.dataset.error = 'true'; this.diagStatus.textContent = `Native report unavailable: ${error?.message || error}`; this.diag('capability', 'NATIVE_DIAGNOSTICS_UNAVAILABLE'); }
    } else if (this.diagStatus) this.diagStatus.textContent = 'Browser mode · native report unavailable; showing local events only.';
    this.renderDiagnosticsPanel();
  }
  renderDiagnosticsPanel() {
    const d = this.app.diagnostics; if (!this.diagEvents || !d) return;
    const n = d.native, fact = (title, value) => h('div', {}, h('dt', {text: title}), h('dd', {text: value || '—'}));
    this.diagIdentity.replaceChildren(
      fact('Build', `${BUILD.product} ${BUILD.version} · ${BUILD.channel} · ${BUILD.milestone}`),
      fact('Runtime', n ? `${n.product} ${n.version} · ${n.build} · ${n.os}/${n.arch} · Tauri ${n.tauri} · WebView2 ${n.webview2}` : this.invoke ? 'Native report not loaded yet' : 'Browser (no native runtime)'),
      fact('Run id', `${d.runId}${n?.runId ? ` · native ${n.runId}` : ''}`),
      fact('Capabilities', n ? Object.entries(n.capabilities || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') : 'Native capabilities appear after Refresh in the desktop app.'),
      fact('Native save results', n ? `${n.savesOk ?? 0} saved · failures ${Object.entries(n.saveFailures || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}` : '—'),
      fact('Blocked non-main IPC at dispatcher', n ? Object.entries(n.dispatcherRejections || {}).map(([k, v]) => `${k} ${v}`).join(', ') || '0' : '—'),
      ...Object.entries(this.sessionFacts()).map(([k, v]) => fact(k, v)),
      d.persistError ? fact('Storage', d.persistError) : null);
    const filter = this.diagFilter.value, events = d.events.filter(e => !filter || e.category === filter).slice(-100).reverse();
    this.diagEvents.replaceChildren(...(events.length ? events.map(e => h('li', {'data-category': e.category}, h('time', {datetime: e.at, text: time(e.at)}), ` ${e.category} · ${e.code}`, Object.keys(e.detail).length ? h('small', {text: ` ${Object.entries(e.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`}) : null)) : [h('li', {text: 'No events recorded.'})]));
  }
  /**
   * MEGA-09 session summary for Diagnostics and its export: states, codes, counts and short random
   * or hashed identifiers only. No folder names, paths, task text, arguments or output.
   */
  sessionSummary() {
    const cap = this.runner.capability, jobs = this.jobs.snapshot(), key = this.folder?.recoveryKey;
    const count = states => jobs.filter(j => states.includes(j.state)).length;
    const failed = jobs.filter(j => j.errorCategory && j.endedAt).sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))[0];
    let unsaved = 0; try { unsaved = key ? this.app.localFolder.recovery.list(key).length : 0; } catch { unsaved = 0; }
    return {
      execution: !this.client.available ? 'unavailable' : cap?.enabled ? 'enabled' : 'disabled',
      agentClis: Object.fromEntries(PROVIDERS.map(p => [p.id, {state: this.providers[p.id]?.state || 'not-detected', version: sanitize(this.providers[p.id]?.version || '', 24)}])),
      workspace: key ? {open: true, id: String(key).slice(0, 8)} : {open: false},
      lastFailure: failed ? {source: 'agent-job', category: failed.errorCategory, job: String(failed.id).slice(0, 8)} : this.runner.lastFailure ? {source: 'command', category: this.runner.lastFailure.category, code: sanitize(this.runner.lastFailure.code, 32)} : null,
      jobs: {total: jobs.length, pending: count(['pending-approval']), active: count([...ACTIVE_STATES, 'queued']), completed: count(['completed']), failed: count(['failed']), cancelled: count(['cancelled']),
        recent: jobs.slice(-5).map(j => ({id: String(j.id).slice(0, 8), state: j.state, provider: j.provider, profile: j.profile, attempt: j.attempt, errorCategory: j.errorCategory || null}))},
      recovery: {interruptedJobs: count(['interrupted', 'orphaned', 'unknown']), unsavedBuffers: unsaved, autoResume: false},
    };
  }
  sessionFacts() {
    const s = this.sessionSummary();
    return {
      'Execution broker': {enabled: 'enabled for this session (native dialog)', disabled: 'disabled (default at every start)', unavailable: 'unavailable (browser / PWA)'}[s.execution],
      'Agent CLIs': Object.entries(s.agentClis).map(([id, c]) => `${id}: ${c.state}${c.version ? ` ${c.version}` : ''}`).join(' · '),
      'Workspace': s.workspace.open ? `Local Folder open · id ${s.workspace.id} (hash, not the path)` : 'no Local Folder open',
      'Last failure': s.lastFailure ? `${s.lastFailure.source} · ${s.lastFailure.category}${s.lastFailure.job ? ` · job ${s.lastFailure.job}` : ''}${s.lastFailure.code ? ` · ${s.lastFailure.code}` : ''}` : 'none recorded',
      'Jobs': `${s.jobs.total} total · ${s.jobs.pending} pending approval · ${s.jobs.active} queued/running · ${s.jobs.completed} completed · ${s.jobs.failed} failed · ${s.jobs.cancelled} cancelled${s.jobs.recent.length ? ` · recent ${s.jobs.recent.map(j => `${j.id} ${j.state}`).join(', ')}` : ''}`,
      'Crash / interruption recovery': `${s.recovery.interruptedJobs} interrupted or unknown job(s) · ${s.recovery.unsavedBuffers} unsaved buffer(s) for this folder · jobs are never resumed automatically`,
    };
  }
  exportDiagnostics() {
    const d = this.app.diagnostics; if (!d) return;
    const blob = new Blob([JSON.stringify({...d.report(), session: this.sessionSummary()}, null, 2)], {type: 'application/json'});
    const link = h('a', {href: URL.createObjectURL(blob), download: `melly-diagnostics-${d.runId.slice(0, 12)}.json`});
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    this.diagStatus.dataset.error = 'false'; this.diagStatus.textContent = 'Report exported. It contains codes and counts only; review it before sharing.';
    this.diag('app', 'DIAGNOSTICS_EXPORTED', {count: d.events.length});
  }
}
