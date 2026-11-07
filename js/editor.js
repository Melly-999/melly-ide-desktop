import { localizeControls, saveStateLabel } from './ui-language.js';
import { initialFiles } from './data/samples.js';
import { getRunResult, EXECUTION_UNAVAILABLE_MESSAGE, SIMULATED_LABEL } from './modules/simulation.js';
import { IndexedDbFileStore } from './storage/file-store.js';

const SAVE_STATE_LABELS = {
  default: 'LOCAL DEFAULT',
  edited: 'EDITED',
  saving: 'SAVING',
  saved: 'SAVED LOCALLY',
  failed: 'SAVE FAILED',
  unavailable: 'STORAGE UNAVAILABLE',
  recovery: 'RECOVERY NEEDED'
};

export function mergeTextareaInput(current, value) {
  // Textareas normalize CRLF/CR to LF. Preserve unchanged source bytes and edit only the changed span.
  const normalized = current.replace(/\r\n?/g, '\n');
  if (value === normalized) return current;
  let start = 0, end = 0;
  while (start < normalized.length && start < value.length && normalized[start] === value[start]) start++;
  while (end < normalized.length - start && end < value.length - start && normalized[normalized.length - 1 - end] === value[value.length - 1 - end]) end++;
  const rawOffset = offset => {
    let raw = 0;
    for (let logical = 0; logical < offset; logical++) raw += current[raw] === '\r' && current[raw + 1] === '\n' ? 2 : 1;
    return raw;
  };
  const newline = current.match(/\r\n|\r|\n/)?.[0] || '\n';
  const inserted = value.slice(start, value.length - end).replace(/\n/g, newline);
  return current.slice(0, rawOffset(start)) + inserted + current.slice(rawOffset(normalized.length - end));
}

export class MobileCodeEditor {
  constructor(containerId, options = {}) {
    this.readOnly = !!options.readOnly;
    this.container = document.getElementById(containerId);
    this.files = { ...(options.files || initialFiles) };
    this.workspaceId = options.workspaceId;
    this.workspaceToken = options.workspaceId ? crypto.randomUUID() : undefined;
    this.initialFiles = { ...this.files };
    this.persistedContents = { ...this.files };
    this.persistedVersions = Object.fromEntries(Object.keys(this.files).map(filename => [filename, 0]));
    this.hasPersistedRecord = Object.fromEntries(Object.keys(this.files).map(filename => [filename, false]));
    this.fileRevisions = Object.fromEntries(Object.keys(this.files).map(filename => [filename, 0]));
    this.saveStates = Object.fromEntries(Object.keys(this.files).map(filename => [filename, {
      status: 'default',
      message: 'Bundled sample is loaded. It has not been written to browser storage yet.'
    }]));
    this.activeFilename = Object.hasOwn(this.files, options.activeFilename) ? options.activeFilename : Object.keys(this.files)[0];
    this.fileStore = options.fileStore || new IndexedDbFileStore();
    this.autosaveDelay = options.autosaveDelay ?? 650;
    this.schedule = options.schedule || ((callback, delay) => setTimeout(callback, delay));
    this.cancelSchedule = options.cancelSchedule || (handle => clearTimeout(handle));
    this.autosaveTimers = {};
    this.saveQueues = {};
    this.latestRequestedRevision = {};
    this.nextPersistedVersions = Object.fromEntries(Object.keys(this.files).map(filename => [filename, 1]));
    this.recoveryRequired = Object.fromEntries(Object.keys(this.files).map(filename => [filename, false]));
    this.persistenceReady = false;
    this.persistenceUnavailable = false;
    this.initializationPromise = null;
    this.storageWarning = '';
    this.onSave = options.onSave || (() => {});
    this.onRun = options.onRun || (() => {});
  }

  query(selector) {
    const scoped = this.readOnly ? selector.replace(/#([\w-]+)/g, '[data-editor-id="$1"]') : selector;
    return this.container?.querySelector(scoped);
  }

  init() {
    if (this.container) {
      this.render();
      this.attachEvents();
    }
    return this.initializePersistence();
  }

  getActiveContent() {
    return this.files[this.activeFilename] || '';
  }

  getActiveFilename() {
    return this.activeFilename;
  }

  updateFileContent(filename, content, options = {}) {
    if (this.readOnly) return false;
    if (!Object.prototype.hasOwnProperty.call(this.files, filename) || typeof content !== 'string') {
      return false;
    }
    if (this.files[filename] === content) return false;

    this.files[filename] = content;
    this.fileRevisions[filename] = (this.fileRevisions[filename] || 0) + 1;
    if (!options.skipAutosave) this.markEditedAndSchedule(filename);
    return true;
  }

  captureLiveEditorContent() {
    if (this.readOnly) return;
    const textarea = this.query('.editor-textarea');
    if (textarea) this.updateFileContent(this.activeFilename, mergeTextareaInput(this.files[this.activeFilename], textarea.value));
  }

  isFileDirty(filename) {
    return Object.prototype.hasOwnProperty.call(this.files, filename)
      && this.files[filename] !== this.persistedContents[filename];
  }

  getFileSnapshot(filename = this.activeFilename) {
    if (this.readOnly) return null; // Disk source must never enter AI/review snapshots.
    // DOM input events normally keep the buffer current, but a snapshot is a
    // security boundary: read the live textarea once more before reviewing.
    this.captureLiveEditorContent();
    if (!Object.prototype.hasOwnProperty.call(this.files, filename)) return null;

    return {
      filename,
      ...(this.workspaceId ? {workspaceId: this.workspaceId, workspaceToken: this.workspaceToken} : {}),
      content: this.files[filename],
      revision: this.fileRevisions[filename] || 0,
      dirty: this.isFileDirty(filename)
    };
  }

  initializePersistence() {
    if (this.readOnly) { this.persistenceReady = true; return Promise.resolve({ok: true}); }
    if (!this.initializationPromise) {
      this.initializationPromise = this.performPersistenceInitialization();
    }
    return this.initializationPromise;
  }

  async performPersistenceInitialization() {
    const startupFiles = { ...this.files };
    const startupRevisions = { ...this.fileRevisions };
    let initialized;
    try {
      initialized = await this.fileStore.init();
    } catch (error) {
      return this.setStorageUnavailable({
        ok: false,
        code: 'storage_unavailable',
        message: 'Browser-local storage could not be initialized. Keep this page open to preserve in-memory edits.',
        error
      });
    }
    if (!initialized.ok) {
      return this.setStorageUnavailable(initialized);
    }

    let loaded;
    try {
      loaded = await this.fileStore.loadFiles(Object.keys(this.files));
    } catch (error) {
      return this.setStorageUnavailable({
        ok: false,
        code: 'storage_unavailable',
        message: 'Browser-local files could not be read. Keep this page open to preserve in-memory edits.',
        error
      });
    }
    if (!loaded.ok) {
      return this.setStorageUnavailable(loaded);
    }

    const lateEdits = [];
    for (const [filename, record] of Object.entries(loaded.files || {})) {
      if (!Object.prototype.hasOwnProperty.call(this.files, filename)) continue;

      this.persistedContents[filename] = record.content;
      this.persistedVersions[filename] = record.revision;
      this.nextPersistedVersions[filename] = record.revision + 1;
      this.hasPersistedRecord[filename] = true;

      const unchangedSinceStartup = this.fileRevisions[filename] === startupRevisions[filename]
        && this.files[filename] === startupFiles[filename];
      if (unchangedSinceStartup) {
        this.files[filename] = record.content;
        this.fileRevisions[filename] = record.revision;
        this.saveStates[filename] = {
          status: 'saved',
          message: `Restored ${filename} from browser-local storage.`
        };
      } else {
        this.saveStates[filename] = {
          status: 'edited',
          message: 'A newer in-memory edit was preserved while local storage initialized.'
        };
        lateEdits.push(filename);
      }
    }

    const issues = loaded.issues || [];
    if (issues.length > 0) {
      this.storageWarning = issues.map(issue => issue.message).join(' ');
      for (const issue of issues) {
        if (issue.filename && Object.prototype.hasOwnProperty.call(this.saveStates, issue.filename)) {
          this.recoveryRequired[issue.filename] = true;
          this.saveStates[issue.filename] = {
            status: 'recovery',
            message: `${issue.message} The existing stored record was not changed. Use explicit Save to replace it with the current buffer.`
          };
        }
      }
    }

    this.persistenceReady = true;
    this.refreshEditorAfterStorageChange();
    for (const filename of lateEdits) this.scheduleAutosave(filename);
    return { ok: true, files: loaded.files || {}, issues };
  }

  setStorageUnavailable(result) {
    this.persistenceUnavailable = true;
    this.storageWarning = result.message;
    for (const filename of Object.keys(this.files)) {
      this.saveStates[filename] = { status: 'unavailable', message: result.message };
    }
    this.updateSaveStatus();
    this.updateDirtyIndicators();
    return result;
  }

  markEditedAndSchedule(filename) {
    if (!this.isFileDirty(filename)) {
      this.cancelAutosave(filename);
      this.saveStates[filename] = this.hasPersistedRecord[filename]
        ? { status: 'saved', message: `${filename} matches the latest browser-local version.` }
        : { status: 'default', message: 'Bundled sample is loaded. It has not been written to browser storage yet.' };
    } else if (this.persistenceUnavailable) {
      this.saveStates[filename] = {
        status: 'unavailable',
        message: this.storageWarning || 'Browser-local storage is unavailable. The edit remains in memory.'
      };
    } else if (this.recoveryRequired[filename]) {
      this.saveStates[filename] = {
        status: 'recovery',
        message: 'Stored data needs recovery. Autosave is paused; use explicit Save to replace the incompatible record.'
      };
    } else {
      this.saveStates[filename] = {
        status: 'edited',
        message: 'In-memory changes are waiting for browser-local persistence.'
      };
      if (this.persistenceReady) this.scheduleAutosave(filename);
    }
    this.updateSaveStatus();
  }

  scheduleAutosave(filename) {
    if (this.readOnly) return;
    if (this.recoveryRequired[filename]) return;
    this.cancelAutosave(filename);
    this.autosaveTimers[filename] = this.schedule(() => {
      delete this.autosaveTimers[filename];
      this.queueSave(filename, 'autosave');
    }, this.autosaveDelay);
  }

  cancelAutosave(filename) {
    if (this.autosaveTimers[filename] === undefined) return;
    this.cancelSchedule(this.autosaveTimers[filename]);
    delete this.autosaveTimers[filename];
  }

  async saveFile(filename = this.activeFilename, reason = 'explicit') {
    if (this.readOnly) return {ok: false, code: 'read_only', message: 'Local file — read-only preview. Disk editing arrives in M1.2.'};
    if (reason === 'explicit' && filename === this.activeFilename) {
      this.captureLiveEditorContent();
    }
    this.cancelAutosave(filename);

    if (!Object.prototype.hasOwnProperty.call(this.files, filename)) {
      return { ok: false, code: 'unknown_file', message: 'The selected editor file does not exist.' };
    }
    if (this.persistenceUnavailable) {
      const result = {
        ok: false,
        code: 'storage_unavailable',
        message: this.storageWarning || 'Browser-local storage is unavailable. The edit remains in memory.'
      };
      this.saveStates[filename] = { status: 'unavailable', message: result.message };
      this.updateSaveStatus();
      return result;
    }
    if (!this.persistenceReady) {
      const initialized = await this.initializePersistence();
      if (!initialized.ok) return initialized;
    }
    this.cancelAutosave(filename);
    if (!this.isFileDirty(filename) && this.hasPersistedRecord[filename]) {
      this.saveStates[filename] = {
        status: 'saved',
        message: `${filename} already matches the latest browser-local version.`
      };
      this.updateSaveStatus();
      return { ok: true, skipped: true, filename };
    }

    return this.queueSave(filename, reason);
  }

  queueSave(filename, reason) {
    if (this.readOnly) return Promise.resolve({ok: false, code: 'read_only'});
    if (reason === 'autosave' && this.recoveryRequired[filename]) {
      return Promise.resolve({
        ok: false,
        code: 'recovery_confirmation_required',
        message: 'Autosave is paused to avoid overwriting incompatible stored data. Use explicit Save to replace it.'
      });
    }
    const request = {
      filename,
      content: this.files[filename],
      editorRevision: this.fileRevisions[filename],
      revision: this.nextPersistedVersions[filename]++,
      reason
    };
    this.latestRequestedRevision[filename] = request.editorRevision;
    this.saveStates[filename] = {
      status: 'saving',
      message: `Writing ${filename} to browser-local storage…`
    };
    this.updateSaveStatus();

    const previous = this.saveQueues[filename] || Promise.resolve();
    const queued = previous
      .catch(() => {})
      .then(() => this.performSave(request));
    this.saveQueues[filename] = queued;
    return queued;
  }

  async performSave(request) {
    if (this.readOnly) return {ok: false, code: 'read_only'};
    let result;
    try {
      result = await this.fileStore.saveFile({
        filename: request.filename,
        content: request.content,
        revision: request.revision
      });
    } catch (error) {
      result = {
        ok: false,
        code: 'storage_error',
        message: 'Browser-local storage failed. Your in-memory edit is still available; retry Save.',
        error
      };
    }
    const isLatestRequest = this.latestRequestedRevision[request.filename] === request.editorRevision;

    if (!result.ok) {
      if (isLatestRequest) {
        this.saveStates[request.filename] = {
          status: result.code === 'storage_unavailable' ? 'unavailable' : 'failed',
          message: result.message
        };
      }
      this.storageWarning = result.message;
      this.updateSaveStatus();
      this.updateDirtyIndicators();
      return result;
    }

    this.persistedContents[request.filename] = request.content;
    this.persistedVersions[request.filename] = request.revision;
    this.hasPersistedRecord[request.filename] = true;
    if (request.reason === 'explicit') this.recoveryRequired[request.filename] = false;
    const currentMatches = this.fileRevisions[request.filename] === request.editorRevision
      && this.files[request.filename] === request.content;

    if (currentMatches && isLatestRequest) {
      this.saveStates[request.filename] = {
        status: 'saved',
        message: `${request.filename} is saved in this browser only. It is not committed or synchronized to GitHub.`
      };
      this.storageWarning = '';
      this.onSave(request.filename, request.content, result.record);
    } else if (isLatestRequest) {
      this.saveStates[request.filename] = {
        status: 'edited',
        message: 'A newer in-memory revision still needs to be saved.'
      };
      this.scheduleAutosave(request.filename);
    }

    this.updateSaveStatus();
    this.updateDirtyIndicators();
    return { ...result, acknowledged: currentMatches && isLatestRequest };
  }

  waitForPendingSaves(filename) {
    return this.saveQueues[filename] || Promise.resolve();
  }

  getSaveState(filename = this.activeFilename) {
    return { ...this.saveStates[filename] };
  }

  refreshEditorAfterStorageChange() {
    if (!this.container) return;
    const textarea = this.query('.editor-textarea');
    if (textarea && textarea.value !== this.getActiveContent()) {
      const hadFocus = document.activeElement === textarea;
      const selectionStart = textarea.selectionStart;
      const selectionEnd = textarea.selectionEnd;
      const scrollTop = textarea.scrollTop;
      const scrollLeft = textarea.scrollLeft;
      textarea.value = this.getActiveContent();
      const maxOffset = textarea.value.length;
      textarea.selectionStart = Math.min(selectionStart, maxOffset);
      textarea.selectionEnd = Math.min(selectionEnd, maxOffset);
      textarea.scrollTop = scrollTop;
      textarea.scrollLeft = scrollLeft;
      if (hadFocus) textarea.focus();
    }
    this.updateLineNumbers();
    this.updateDirtyIndicators();
    this.updateSaveStatus();
    localizeControls(this.container);
  }

  updateSaveStatus() {
    if (this.readOnly) {
      if (!this.container) return;
      this.container.querySelectorAll('[data-editor-id="editorSaveBtn"], [data-editor-id="editorRunBtn"], .accessory-btn[data-insert], [data-editor-id="accUndo"], [data-editor-id="accRedo"], .callout-item:not([data-action="copy"])').forEach(button => button.disabled = true);
      const textarea = this.query('.editor-textarea');
      if (textarea) textarea.readOnly = true;
      const status = this.query('#editorSaveStatus');
      if (status) status.textContent = 'READ-ONLY';
      const detail = this.query('#editorSaveDetail');
      if (detail) detail.textContent = 'Local file — read-only preview. Disk editing arrives in M1.2.';
      const scope = this.query('.editor-save-scope');
      if (scope) scope.textContent = 'Local Folder · ' + this.activeFilename;
      return;
    }
    if (!this.container) return;
    const state = this.saveStates[this.activeFilename] || this.saveStates.main;
    const status = this.query('#editorSaveStatus');
    const detail = this.query('#editorSaveDetail');
    const warning = this.query('#editorStorageWarning');
    const statusGroup = this.query('.editor-save-state');
    const saveButton = this.query('#editorSaveBtn');

    if (status) { status.textContent = saveStateLabel(state.status, SAVE_STATE_LABELS[state.status]); status.lang = document.documentElement?.lang || 'en'; }
    if (detail) detail.textContent = state.message;
    if (statusGroup) statusGroup.dataset.state = state.status;
    if (saveButton) saveButton.setAttribute('aria-busy', state.status === 'saving' ? 'true' : 'false');
    if (warning) {
      warning.textContent = this.storageWarning;
      warning.hidden = !this.storageWarning;
    }
  }

  applyReviewedChange(review) {
    if (this.readOnly) return {applied: false, reason: 'read_only'};
    this.captureLiveEditorContent();
    if (!review || typeof review !== 'object'
      || typeof review.targetFilename !== 'string'
      || typeof review.baseContent !== 'string'
      || typeof review.proposedContent !== 'string'
      || !Number.isInteger(review.baseRevision)) {
      return { applied: false, reason: 'invalid_review' };
    }

    if ((review.workspaceId || 'legacy') !== (this.workspaceId || 'legacy') || (this.workspaceId && review.workspaceToken !== this.workspaceToken)) return {applied: false, reason: 'stale_review'};
    const current = this.getFileSnapshot(review.targetFilename);
    if (!current) return { applied: false, reason: 'unknown_target' };
    if (current.revision !== review.baseRevision || current.content !== review.baseContent) {
      return { applied: false, reason: 'stale_review', current };
    }

    const isActiveTarget = this.activeFilename === review.targetFilename;
    const textarea = isActiveTarget ? this.query('.editor-textarea') : null;
    const editorState = textarea ? {
      hadFocus: document.activeElement === textarea,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
      scrollTop: textarea.scrollTop,
      scrollLeft: textarea.scrollLeft
    } : null;

    this.updateFileContent(review.targetFilename, review.proposedContent);

    if (textarea && editorState) {
      textarea.value = review.proposedContent;
      const maxOffset = review.proposedContent.length;
      textarea.selectionStart = Math.min(editorState.selectionStart, maxOffset);
      textarea.selectionEnd = Math.min(editorState.selectionEnd, maxOffset);
      textarea.scrollTop = editorState.scrollTop;
      textarea.scrollLeft = editorState.scrollLeft;
      if (editorState.hadFocus) textarea.focus();
      this.updateLineNumbers();
      this.updateDirtyIndicators();
    }

    this.updateDirtyIndicators();
    this.updateSaveStatus();

    return {
      applied: true,
      reason: 'applied',
      snapshot: this.getFileSnapshot(review.targetFilename)
    };
  }

  setFile(filename) {
    if (this.files[filename] !== undefined) {
      this.captureLiveEditorContent();
      this.activeFilename = filename;
      this.render();
      this.attachEvents();
    }
  }

  insertText(text) {
    if (this.readOnly) return;
    const textarea = this.query('.editor-textarea');
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const current = textarea.value;
    const updated = current.substring(0, start) + text + current.substring(end);
    textarea.value = updated;
    this.updateFileContent(this.activeFilename, mergeTextareaInput(this.files[this.activeFilename], updated));
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.focus();
    this.updateLineNumbers();
    this.updateDirtyIndicators();
  }

  updateLineNumbers() {
    const textarea = this.query('.editor-textarea');
    const gutter = this.query('.editor-gutter');
    if (!textarea || !gutter) return;
    // MEGA-09: count newlines without allocating, and rebuild the gutter only when the count changes
    // (a 1 MiB disk file otherwise re-rendered up to 10 000 spans on every keystroke).
    const value = textarea.value;
    let counted = 1;
    for (let i = value.indexOf('\n'); i !== -1; i = value.indexOf('\n', i + 1)) counted++;
    const lines = this.readOnly ? Math.min(counted, 10000) : counted;
    if (gutter.childElementCount === Math.max(lines, 20)) return;
    let gutterHtml = '';
    for (let i = 1; i <= Math.max(lines, 20); i++) {
      gutterHtml += `<span>${i}</span>`;
    }
    gutter.innerHTML = gutterHtml;
  }

  updateDirtyIndicators() {
    this.container?.querySelectorAll('.tab-btn').forEach(btn => {
      const dirty = this.isFileDirty(btn.dataset.file);
      btn.classList.toggle('dirty', dirty);
      btn.setAttribute('aria-label', `${btn.dataset.file}${dirty ? ' (unsaved changes)' : ''}`);
      const marker = btn.querySelector('.tab-dirty-marker');
      if (marker) marker.hidden = !dirty;
    });
  }

  render() {
    const code = this.getActiveContent();
    const saveState = this.saveStates[this.activeFilename];

    this.container.innerHTML = `
      <div class="mobile-editor-shell">
        <!-- Editor header -->
        <div class="editor-header">
          <div class="editor-header-left">
            <button class="editor-icon-btn close-btn" title="Closing the fixed editor is unavailable" id="editorCloseBtn" disabled>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
            <div class="editor-tab-switcher">
              ${Object.keys(this.files).map(filename => `<button class="tab-btn ${this.activeFilename === filename ? 'active' : ''}" data-file="${escapeHtml(filename)}">${escapeHtml(filename)} <span class="tab-dirty-marker" ${this.isFileDirty(filename) ? '' : 'hidden'} aria-hidden="true">•</span></button>`).join('')}
            </div>
          </div>
          <div class="editor-header-right">
            <button class="btn-run-code btn-unavailable" id="editorRunBtn" title="${EXECUTION_UNAVAILABLE_MESSAGE}" aria-label="Run (${EXECUTION_UNAVAILABLE_MESSAGE})">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              <span>Run</span>
            </button>
            <button class="btn-save-code" id="editorSaveBtn" title="Save this file to browser-local storage">Save</button>
          </div>
        </div>

        <div class="editor-save-state" data-state="${saveState.status}" role="status" aria-live="polite">
          <div class="editor-save-summary">
            <span class="editor-save-dot" aria-hidden="true"></span>
            <strong id="editorSaveStatus">${SAVE_STATE_LABELS[saveState.status]}</strong>
            <span class="editor-save-scope">Browser only · not GitHub</span>
          </div>
          <span class="editor-save-detail" id="editorSaveDetail">${escapeHtml(saveState.message)}</span>
        </div>
        <div class="editor-storage-warning" id="editorStorageWarning" role="alert" ${this.storageWarning ? '' : 'hidden'}>${escapeHtml(this.storageWarning)}</div>

        <!-- Floating context callout: Cut | Copy | AutoFill | Look Up -->
        <div class="editor-floating-callout" id="editorCallout">
          <button class="callout-item" data-action="cut">Cut</button>
          <span class="callout-divider">|</span>
          <button class="callout-item" data-action="copy">Copy</button>
          <span class="callout-divider">|</span>
          <button class="callout-item" data-action="autofill">AutoFill</button>
          <span class="callout-divider">|</span>
          <button class="callout-item" data-action="lookup">Look Up</button>
          <span class="callout-divider">›</span>
        </div>

        <!-- Main Code Container with line numbers -->
        <div class="editor-body">
          <div class="editor-gutter" id="editorGutter"></div>
          <textarea class="editor-textarea" id="editorTextarea" aria-label="Code editor" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
        </div>

        <!-- Execution / Output drawer -->
        <div class="editor-console" id="editorConsole" style="display: none;">
          <div class="console-header">
            <span>Terminal Output</span>
            <button class="console-close" id="consoleClose" aria-label="Close execution status">✕</button>
          </div>
          <pre class="console-output" id="consoleOutput"></pre>
        </div>

        <!-- Mobile accessory bar: ⇥ { } ( ) ↩ ↪ 🔍 ⌨ -->
        <div class="mobile-accessory-bar">
          <button class="accessory-btn" data-insert="  " title="Tab Indent">⇥</button>
          <button class="accessory-btn" data-insert="{" title="Left Brace">{</button>
          <button class="accessory-btn" data-insert="}" title="Right Brace">}</button>
          <button class="accessory-btn" data-insert="(" title="Left Parenthesis">(</button>
          <button class="accessory-btn" data-insert=")" title="Right Parenthesis">)</button>
          <button class="accessory-btn" id="accUndo" title="Undo">↶</button>
          <button class="accessory-btn" id="accRedo" title="Redo">↷</button>
          <button class="accessory-btn" id="accSearch" title="Search">🔍</button>
          <button class="accessory-btn" id="accKeyboard" title="Dismiss Keyboard">⌨</button>
        </div>
      </div>
    `;

    // Two editor instances share the component, but must never share DOM IDs.
    if (this.readOnly) this.container.querySelectorAll('[id]').forEach(element => {
      element.dataset.editorId = element.id;
      element.id = this.container.id + '-' + element.id;
    });
    // The HTML parser strips an initial newline and replaces NULs inside textarea text.
    const textarea = this.query('.editor-textarea');
    if (textarea) textarea.value = code;
    this.updateLineNumbers();
    this.updateDirtyIndicators();
    this.updateSaveStatus();
    localizeControls(this.container);
  }

  attachEvents() {
    const textarea = this.query('.editor-textarea');
    const gutter = this.query('.editor-gutter');
    const callout = this.query('#editorCallout');
    const saveBtn = this.query('#editorSaveBtn');
    const runBtn = this.query('#editorRunBtn');
    const tabBtns = this.container.querySelectorAll('.tab-btn');
    const accButtons = this.container.querySelectorAll('.accessory-btn[data-insert]');
    const undoBtn = this.query('#accUndo');
    const redoBtn = this.query('#accRedo');
    const searchBtn = this.query('#accSearch');
    const consoleClose = this.query('#consoleClose');
    const keyboardDismiss = this.query('#accKeyboard');
    keyboardDismiss?.addEventListener('click', () => textarea?.blur());

    if (textarea) {
      textarea.addEventListener('input', () => {
        this.captureLiveEditorContent();
        this.updateLineNumbers();
        this.updateDirtyIndicators();
      });

      // Synchronize scrolling between gutter and textarea
      textarea.addEventListener('scroll', () => {
        if (gutter) gutter.scrollTop = textarea.scrollTop;
      });

      // Selection popup
      textarea.addEventListener('select', () => {
        if (textarea.selectionStart !== textarea.selectionEnd) {
          if (callout) {
            callout.style.top = `${this.query('.editor-body').offsetTop + 8}px`;
            callout.style.display = 'flex';
          }
        } else {
          if (callout) callout.style.display = 'none';
        }
      });
    }

    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        this.setFile(btn.dataset.file);
      });
    });

    accButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        this.insertText(btn.dataset.insert);
      });
    });

    if (undoBtn) {
      undoBtn.addEventListener('click', () => {
        document.execCommand('undo');
      });
    }

    if (redoBtn) {
      redoBtn.addEventListener('click', () => {
        document.execCommand('redo');
      });
    }

    if (searchBtn && textarea) {
      searchBtn.addEventListener('click', () => {
        const query = prompt('Search code in ' + this.activeFilename + ':');
        if (query) {
          const idx = textarea.value.indexOf(query);
          if (idx !== -1) {
            textarea.selectionStart = idx;
            textarea.selectionEnd = idx + query.length;
            textarea.focus();
          } else {
            alert('Phrase not found: ' + query);
          }
        }
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        await this.saveFile(this.activeFilename, 'explicit');
      });
    }

    if (runBtn) {
      runBtn.addEventListener('click', () => {
        this.runCurrentCode();
      });
    }

    if (consoleClose) {
      consoleClose.addEventListener('click', () => {
        const c = this.query('#editorConsole');
        if (c) c.style.display = 'none';
      });
    }

    // Selection actions stay below the header, including at enlarged zoom.
    const dismissCallout = event => {
      if (event.key === 'Escape' && callout?.style.display === 'flex') {
        callout.style.display = 'none';
        textarea?.focus();
        event.preventDefault();
      }
    };
    textarea?.addEventListener('keydown', dismissCallout);
    // Callout actions
    if (callout) {
      callout.addEventListener('keydown', dismissCallout);
      callout.querySelectorAll('.callout-item').forEach(item => {
        item.addEventListener('click', (e) => {
          const action = e.currentTarget.dataset.action;
          if (!textarea) return;
          const sel = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);

          if (action === 'copy' && sel) {
            navigator.clipboard?.writeText(sel);
            callout.style.display = 'none';
          } else if (action === 'cut' && sel) {
            navigator.clipboard?.writeText(sel);
            this.insertText('');
            callout.style.display = 'none';
          } else if (action === 'autofill') {
            // Placeholder only: no AI provider is configured, so nothing is verified.
            this.insertText(`/* [${SIMULATED_LABEL}] AutoFill placeholder - no AI provider configured */\n`);
            callout.style.display = 'none';
          } else if (action === 'lookup') {
            window.dispatchEvent(new CustomEvent('ai-lookup-request', { detail: { text: sel || this.activeFilename } }));
            callout.style.display = 'none';
          }
        });
      });
    }
  }

  // Code is intentionally NOT executed. The previous implementation passed the
  // buffer to the Function constructor, i.e. arbitrary code ran in the app's
  // own page context with access to the DOM, localStorage and the network.
  // Until a genuinely isolated sandbox exists, Run only reports that
  // execution is unavailable (see modules/simulation.js).
  runCurrentCode() {
    if (this.readOnly) return;
    const consoleBox = this.query('#editorConsole');
    const outputBox = this.query('#consoleOutput');
    if (!consoleBox || !outputBox) return;

    consoleBox.style.display = 'block';
    outputBox.innerText = getRunResult(this.activeFilename).output;
  }
}

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
