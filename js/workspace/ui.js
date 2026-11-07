import { MobileCodeEditor } from '../editor.js';
import { WorkspaceStore } from './store.js';
import { clone, emptyWorkspace, createProject, addEntry, renameEntry, deleteEntry, lineDiff, validateWorkspace, recoveryWorkspace } from './model.js';
import { BACKUP_V3_LIMIT, captureRecovery, createWorkspaceBackup, parseWorkspaceBackup } from './backup-v3.js';
import { PublicGitHub } from './github.js';
import { StorageStatusPanel } from '../storage/durability.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
export class RealWorkspace {
  constructor(app, options = {}) {
    this.app = app; this.legacy = app.editor; this.store = options.store || new WorkspaceStore(); this.github = options.github || new PublicGitHub();
    this.state = emptyWorkspace(); this.queue = Promise.resolve(); this.editors = new Map([['legacy', this.legacy]]); this.ready = false; this.busy = false;
  }
  async init() {
    this.root = document.createElement('section'); this.root.className = 'real-workspace'; this.root.setAttribute('aria-label', 'Projects and public GitHub');
    document.getElementById('viewStudio').prepend(this.root);
    this.render();
    // Storage reporting is informational; failures never block the workspace.
    this.storage = new StorageStatusPanel(this.root.querySelector('#workspaceStorage'));
    void this.storage.refresh().catch(() => {});
    try { await this.legacy.initializePersistence(); this.state = await this.store.load(); this.ready = true; await this.activate(this.state.activeProjectId, false); this.message('Local workspace ready. Cloud disconnected.'); }
    catch (error) { this.message(error.message, true); }
    this.renderProjects();
  }
  project(id = this.state.activeProjectId) { return this.state.projects.find(p => p.id === id); }
  message(text, error = false) { const el = this.root.querySelector('#workspaceStatus'); el.textContent = text; el.dataset.error = String(error); }
  mutate(change) {
    const action = this.queue.catch(() => {}).then(async () => {
      if (!this.ready) throw new Error('Workspace unavailable. Existing legacy editing and backup remain available.');
      const next = clone(this.state); change(next);
      this.state = await this.store.save(next, this.state.generation);
      this.renderProjects(); return this.state;
    });
    this.queue = action; return action;
  }
  async flush() {
    const editor = this.app.editor; editor.captureLiveEditorContent();
    const results = await Promise.all(Object.keys(editor.files).filter(name => editor.isFileDirty?.(name)).map(name => editor.saveFile(name)));
    await Promise.all(Object.keys(editor.files).map(name => editor.waitForPendingSaves?.(name)));
    if (results.some(r => !r.ok)) throw new Error('Save failed. Export your in-memory copy before switching projects.');
    // A rejected, already-finished mutation did not commit. It must not poison a later explicit retry.
    await this.queue.catch(() => {});
  }
  async activate(id, persist = true) {
    if (persist && (this.app.editor !== this.legacy || id !== 'legacy')) await this.flush();
    const project = this.project(id);
    if (id !== 'legacy' && !project) throw new Error('Project no longer exists.');
    if (persist) await this.mutate(next => { next.activeProjectId = id; });
    const previous = this.app.editor;
    if (previous.container) previous.captureLiveEditorContent();
    if (id === 'legacy') {
      this.app.editor = this.legacy; this.legacy.render(); this.legacy.attachEvents();
    } else {
      // Every project gets its own editor/save queues. A late save cannot target another project.
      const files = Object.fromEntries(project.entries.filter(e => e.kind === 'file').map(e => [e.path, e.content]));
      if (!Object.keys(files).length) { this.app.editor = this.emptyEditor(id); }
      else {
        const fileStore = {
          init: async () => ({ok: true}),
          loadFiles: async () => ({ok: true, files: Object.fromEntries(this.project(id).entries.filter(e => e.kind === 'file').map(e => [e.path, {filename: e.path, content: e.content, revision: e.revision}]))}),
          saveFile: async record => {
            try {
              await this.mutate(next => {
                const entry = next.projects.find(p => p.id === id)?.entries.find(e => e.path === record.filename && e.kind === 'file');
                if (!entry) throw new Error('File changed or was removed. Save canceled.');
                entry.content = record.content; entry.revision = record.revision;
              });
              return {ok: true, record};
            } catch (error) { return {ok: false, code: 'workspace_conflict', message: error.message}; }
          }
        };
        const editor = new MobileCodeEditor('editorContainer', {files, activeFilename: project.activePath, workspaceId: id, fileStore});
        const originalSetFile = editor.setFile.bind(editor);
        editor.setFile = path => { originalSetFile(path); void this.mutate(next => { next.projects.find(p => p.id === id).activePath = path; }).catch(e => this.message(e.message, true)); };
        this.app.editor = editor; this.editors.set(id, editor); await editor.init();
      }
    }
    this.state.activeProjectId = id;
    this.renderProjects();
  }
  emptyEditor(id) {
    document.getElementById('editorContainer').innerHTML = '<p class="workspace-empty">This project is empty. Create a source file above.</p>';
    return {files: {}, workspaceId: id, captureLiveEditorContent() {}, getFileSnapshot() { return null; }, applyReviewedChange() { return {applied: false, reason: 'unknown_target'}; }, updateSaveStatus() {}, saveFile: async () => ({ok: true})};
  }
  render() {
    this.root.innerHTML = `
      <h2>Local Workspace</h2>
      <label for="workspaceProject">Local project</label><select id="workspaceProject" aria-label="Local project"></select>
      <div class="workspace-actions">
        <button id="workspaceNewProject">New project</button><button id="workspaceRenameProject">Rename project</button><button id="workspaceDeleteProject">Delete project</button>
        <button id="workspaceNewFile">New file</button><button id="workspaceNewFolder">New folder</button>
        <button id="workspaceExport">Export saved projects v3</button><button id="workspaceImport">Import backup v1/v2/v3</button><button id="workspaceRecovery">Recover unsaved edits v3</button>
      </div>
      <input type="file" id="workspaceImportFile" accept=".json" hidden>
      <p id="workspaceStatus" role="status" aria-live="polite">Opening local workspace…</p>
      <section id="workspaceBackupOutput" class="workspace-backup-output" aria-label="Prepared backup file" hidden>
        <p id="workspaceBackupInfo"></p><a id="workspaceBackupDownload">Download prepared file</a>
        <button id="workspaceBackupShare" hidden>Share prepared file</button>
      </section>
      <details><summary>Move a project between Windows and iPhone</summary><ol>
        <li>Export saved projects, or Recover unsaved edits if Save fails. Wait for the complete file link.</li>
        <li>Download to Files/Downloads, or use Share prepared file when supported. Verify the file exists before closing this device.</li>
        <li>On the other device, Import backup and select that one JSON file from Files. Confirm creation of new local projects.</li>
        <li>Edit locally, then export and import back. Existing copies stay separate; choose the new project in Local project.</li>
      </ol><p>This is manual file transfer, not account or cloud synchronization. Each browser/PWA/Windows profile has its own local data. If iPhone cannot save/share a file, keep this page open and use Safari Downloads/Files; physical Safari/PWA acceptance is pending. Backups are plaintext. Check source for secrets before sharing.</p></details>
      <section id="workspaceStorage" class="workspace-storage" aria-label="Storage on this device"></section>
      <p class="workspace-boundary">Legacy samples keep their original database and v1 backup in Workspace. New projects use separate local storage. Local source stays in this browser; cloud metadata and AI memory are disconnected.</p>
      <div id="workspaceTree" aria-label="File explorer"></div>
      <details id="workspaceDiff"><summary>Diff against original source</summary><button id="workspaceRefreshDiff">Refresh diff</button><pre id="workspaceDiffText" tabindex="0" aria-label="Source diff"></pre></details>
      <details><summary>Browse public GitHub</summary>
        <label for="githubRepository">Public repository (owner/name)</label><input id="githubRepository" value="octocat/Hello-World" autocomplete="off">
        <button id="githubBrowse">Load repository</button><p id="githubMetadata"></p>
        <label for="githubBranch">Branch (first 100)</label><select id="githubBranch" aria-label="GitHub branch"></select>
        <label for="githubCommit">Commit (latest 30 on branch)</label><select id="githubCommit" aria-label="GitHub commit"></select>
        <button id="githubTreeButton">Load exact revision</button><div id="githubTree" aria-label="GitHub source files"></div>
        <p>Import creates a local copy pinned to its commit and blob SHA. Private GitHub: BLOCKED — GitHub App, callback, secure token backend and repository grant required.</p>
      </details>
      <details><summary>Connections and privacy</summary><p>Project/source cloud sync: BLOCKED. Account status is shown in Account; signing in does not synchronize these files. Cortex, Klaus, MellyCore and Yuzuki: disconnected. Free/offline editing works without login. Pro entitlements are not activated. No source or memory is uploaded automatically.</p></details>`;
    const action = (id, fn) => this.root.querySelector('#' + id).addEventListener('click', () => void this.perform(fn));
    this.root.querySelector('#workspaceProject').addEventListener('change', e => void this.perform(() => this.activate(e.target.value)));
    action('workspaceNewProject', async () => {
      const name = prompt('Project name'); if (name === null) return;
      await this.flush(); const project = createProject(name);
      await this.mutate(next => next.projects.push(project)); await this.activate(project.id);
    });
    action('workspaceRenameProject', async () => {
      const project = this.project(); if (!project) throw new Error('Legacy project names are preserved.');
      const name = prompt('New project name', project.name); if (name === null || !confirm(`Rename project to ${name}?`)) return;
      await this.mutate(next => { next.projects.find(p => p.id === project.id).name = name.trim(); });
    });
    action('workspaceDeleteProject', async () => {
      const project = this.project(); if (!project) throw new Error('Legacy project cannot be deleted here.');
      if (!confirm(`Delete local project ${project.name} and all its files? Export a backup first. This cannot be undone.`)) return;
      await this.flush(); await this.mutate(next => { next.projects = next.projects.filter(p => p.id !== project.id); next.activeProjectId = 'legacy'; }); await this.activate('legacy', false);
    });
    for (const kind of ['file', 'folder']) action(kind === 'file' ? 'workspaceNewFile' : 'workspaceNewFolder', async () => {
      const project = this.project(); if (!project) throw new Error('Create a new project to add files; legacy data is preserved.');
      const path = prompt(`Relative ${kind} path (for example src/main.js)`); if (path === null) return;
      await this.flush(); await this.mutate(next => addEntry(next.projects.find(p => p.id === project.id), path, kind)); await this.activate(project.id, false);
    });
    action('workspaceRefreshDiff', () => this.showDiff());
    this.root.querySelector('#workspaceDiff').addEventListener('toggle', () => { if (this.root.querySelector('#workspaceDiff').open) this.showDiff(); });
    action('workspaceExport', async () => {
      this.clearBackupOutput(); await this.flush();
      this.download(await createWorkspaceBackup(this.state), 'melly-projects-v3.json');
    });
    action('workspaceRecovery', async () => {
      this.clearBackupOutput();
      if (this.ready) {
        const recovery = captureRecovery(this.state, this.app.editor);
        this.download(await createWorkspaceBackup(this.state, {recovery}), 'melly-recovery-v3.json');
      } else {
        this.download(recoveryWorkspace(await this.store.raw()), 'melly-raw-recovery.json');
        this.message('Diagnostic recovery file ready; download offered, not confirmed saved. Manual repair is required before import. Stored data was preserved.');
      }
    });
    action('workspaceBackupShare', async () => {
      if (!this.backupFile || !navigator.share) throw new Error('File sharing is unavailable. Use the download link.');
      try {
        await navigator.share({files: [this.backupFile], title: 'Melly IDE workspace backup'});
        this.message('File handed to the share dialog. Verify it in Files or on the receiving device; delivery is not verified.');
      } catch (error) {
        if (error.name === 'AbortError') this.message('Share cancelled. The complete download link remains available.');
        else throw new Error('File sharing failed. Use the complete download link; keep this page open.');
      }
    });
    action('workspaceImport', () => this.root.querySelector('#workspaceImportFile').click());
    this.root.querySelector('#workspaceImportFile').addEventListener('change', event => void this.perform(async () => {
      const file = event.target.files[0]; event.target.value = ''; if (!file) return;
      if (file.size > BACKUP_V3_LIMIT) throw new Error('Backup exceeds 24 MiB.');
      const parsed = await parseWorkspaceBackup(await file.text());
      const {projects, mode, bufferCount} = parsed;
      if (!projects.length) throw new Error('Backup contains no projects. Nothing was imported.');
      validateWorkspace({...clone(this.state), projects: [...this.state.projects, ...projects]});
      if (!confirm(`Import ${projects.length} projects as new local copies? ${mode === 'recovery' ? `${bufferCount} unsaved recovery buffers will become content in the NEW copies. ` : ''}Existing projects and legacy data will be preserved.`)) {
        this.message('Import cancelled. No projects were created.'); return;
      }
      await this.flush(); await this.mutate(next => next.projects.push(...projects));
      this.message(`Imported ${projects.length} projects as new local copies${mode === 'recovery' ? `, including ${bufferCount} recovery buffers` : ''}. Existing copies were preserved; select a new copy in Local project. No cloud sync occurred.`);
    }));
    action('githubBrowse', async () => {
      this.remote = null; this.remoteEntries = null; this.root.querySelector('#githubTree').replaceChildren();
      this.root.querySelector('#githubBranch').replaceChildren(); this.root.querySelector('#githubCommit').replaceChildren();
      const remote = await this.github.browse(this.root.querySelector('#githubRepository').value); this.remote = remote;
      this.root.querySelector('#githubMetadata').textContent = `${remote.metadata.full_name} · ${remote.metadata.description || ''} · default ${remote.metadata.default_branch}`;
      for (const branch of remote.branches) this.root.querySelector('#githubBranch').add(new Option(branch.name, branch.name, false, branch.name === remote.metadata.default_branch));
      await this.loadCommits(); this.message('Live public GitHub metadata loaded. No local source changed.');
    });
    this.root.querySelector('#githubBranch').addEventListener('change', () => void this.perform(() => this.loadCommits()));
    action('githubTreeButton', async () => {
      if (!this.remote) throw new Error('Load a public repository first.');
      this.remoteEntries = null; this.root.querySelector('#githubTree').replaceChildren();
      const commit = this.root.querySelector('#githubCommit').value; const repository = this.remote.repository;
      const entries = await this.github.tree(repository, commit); this.remoteEntries = {repository, commit, entries};
      const tree = this.root.querySelector('#githubTree');
      for (const entry of entries) { const button = document.createElement('button'); button.textContent = entry.path; button.addEventListener('click', () => void this.perform(() => this.importRemote(entry, repository, commit))); tree.append(button); }
      this.message(`Live tree loaded at ${commit}. Select a file to create a local copy.`);
    });
  }
  async perform(fn) {
    if (this.busy) return;
    this.busy = true; this.root.setAttribute('aria-busy', 'true');
    try { await fn(); } catch (error) { this.message(error.message, true); }
    finally { this.busy = false; this.root.setAttribute('aria-busy', 'false'); this.renderProjects(); }
  }
  async loadCommits() {
    this.root.querySelector('#githubCommit').replaceChildren(); this.root.querySelector('#githubTree').replaceChildren(); this.remoteEntries = null;
    if (!this.remote) throw new Error('Load a repository first.');
    const commits = await this.github.commits(this.remote.repository, this.root.querySelector('#githubBranch').value);
    for (const commit of commits) this.root.querySelector('#githubCommit').add(new Option(`${commit.sha.slice(0, 10)} ${commit.commit.message.split('\n')[0]}`, commit.sha));
  }
  async importRemote(entry, repository, commit) {
    const file = await this.github.file(repository, commit, entry);
    if (!confirm(`Create a local working copy of ${repository}/${entry.path} at ${commit}?`)) return;
    await this.flush();
    let project = this.state.projects.find(p => p.githubRepository === repository && p.githubCommit === commit);
    if (!project) { project = createProject(`${repository} @ ${commit.slice(0, 8)}`); project.entries = []; project.activePath = null; project.githubRepository = repository; project.githubCommit = commit; }
    const id = project.id;
    await this.mutate(next => { if (!next.projects.some(p => p.id === id)) next.projects.push(project); addEntry(next.projects.find(p => p.id === id), entry.path, 'file', file.content, file.source); });
    await this.activate(id, false); this.message(`Saved local copy: ${entry.path} · commit ${commit}.`);
  }
  renderProjects() {
    window.dispatchEvent(new Event('workspace-changed'));
    const select = this.root.querySelector('#workspaceProject'); select.replaceChildren(new Option('Legacy samples (original storage)', 'legacy'));
    for (const project of this.state.projects) select.add(new Option(project.name, project.id)); select.value = this.state.activeProjectId;
    const project = this.project(); const tree = this.root.querySelector('#workspaceTree'); tree.replaceChildren();
    if (!project) { tree.textContent = 'Legacy files are available in the editor tabs. Backup v1 remains in Workspace.'; return; }
    for (const entry of [...project.entries].sort((a, b) => a.path.localeCompare(b.path))) {
      const row = document.createElement('div'); row.className = 'workspace-tree-row';
      const open = document.createElement('button'); open.textContent = `${entry.kind === 'folder' ? 'Folder: ' : ''}${entry.path}`; open.disabled = entry.kind === 'folder';
      open.addEventListener('click', () => { this.app.editor.setFile(entry.path); this.showDiff(); }); row.append(open);
      for (const kind of ['Rename', 'Delete']) {
        const button = document.createElement('button'); button.textContent = kind; button.setAttribute('aria-label', `${kind} ${entry.path}`);
        button.addEventListener('click', () => void this.perform(async () => {
          const nextPath = kind === 'Rename' ? prompt('New relative path', entry.path) : entry.path; if (nextPath === null) return;
          if (!confirm(`${kind} ${entry.path}${kind === 'Rename' ? ` to ${nextPath}` : ' and any nested entries'}?`)) return;
          await this.flush(); await this.mutate(next => { const p = next.projects.find(p => p.id === project.id); kind === 'Rename' ? renameEntry(p, entry.path, nextPath) : deleteEntry(p, entry.path); }); await this.activate(project.id, false);
        })); row.append(button);
      }
      tree.append(row);
    }
  }
  showDiff() {
    const editor = this.app.editor; editor.captureLiveEditorContent();
    const entry = this.project()?.entries.find(e => e.path === editor.activeFilename && e.kind === 'file');
    this.root.querySelector('#workspaceDiffText').textContent = entry ? lineDiff(entry.baseContent, editor.getActiveContent(), entry.path) : 'Select a file in a new project to compare against its original source.';
  }
  clearBackupOutput() {
    if (this.backupURL) URL.revokeObjectURL(this.backupURL);
    this.backupURL = null; this.backupFile = null;
    this.root.querySelector('#workspaceBackupOutput').hidden = true;
    this.root.querySelector('#workspaceBackupDownload').removeAttribute('href');
  }
  download(text, filename) {
    this.clearBackupOutput();
    const file = new File([text], filename, {type: 'application/json'});
    this.backupURL = URL.createObjectURL(file); this.backupFile = file;
    const output = this.root.querySelector('#workspaceBackupOutput');
    const link = this.root.querySelector('#workspaceBackupDownload');
    link.href = this.backupURL; link.download = filename;
    this.root.querySelector('#workspaceBackupInfo').textContent = `Complete file ready: ${filename} (${file.size.toLocaleString()} bytes). ${filename.includes('recovery') ? 'Recovery includes in-memory data; this does not acknowledge Save.' : 'Snapshot of acknowledged local data.'}`;
    let shareable = false;
    try { shareable = !!navigator.canShare?.({files: [file]}) && typeof navigator.share === 'function'; } catch { /* Download remains available. */ }
    this.root.querySelector('#workspaceBackupShare').hidden = !shareable;
    output.hidden = false;
    this.message('Complete file ready. Download offered; verify it in Files/Downloads before closing. Device storage and transfer are not verified.');
    link.click();
  }
}
