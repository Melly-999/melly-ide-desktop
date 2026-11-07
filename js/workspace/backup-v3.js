import { assertNoSecrets } from '../backup.js';
import { clone, createProject, emptyWorkspace, importProjects, validateWorkspace, WORKSPACE_LIMIT } from './model.js';

export const SNAPSHOT_LIMIT = WORKSPACE_LIMIT;
export const RECOVERY_LIMIT = 8 * 1024 * 1024;
export const BACKUP_V3_LIMIT = 24 * 1024 * 1024;
const encode = value => new TextEncoder().encode(value);
const size = value => encode(value).byteLength;
const idPattern = /^[a-zA-Z0-9-]{1,80}$/;

function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) {
    throw new Error('Incomplete or unsupported backup structure.');
  }
}
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function scanProject(project) {
  assertNoSecrets(project.name);
  for (const entry of project.entries) {
    assertNoSecrets(entry.path);
    if (entry.path.split('/').some(part => /^(?:\.env(?:\..*)?|\.ssh|\.aws|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(part))) {
      throw new Error('Possible credential file detected. Nothing was exported or imported.');
    }
    if (entry.kind === 'file') { assertNoSecrets(entry.content); assertNoSecrets(entry.baseContent); }
    if (entry.source) for (const value of Object.values(entry.source)) assertNoSecrets(value);
  }
}
function projectCopy(project) {
  return { id: project.id, name: project.name, activePath: project.activePath,
    entries: project.entries.map(entry => ({ path: entry.path, kind: entry.kind,
      ...(entry.kind === 'file' ? { content: entry.content, baseContent: entry.baseContent, revision: entry.revision } : {}),
      ...(entry.source ? { source: { repository: entry.source.repository, commit: entry.source.commit, blob: entry.source.blob } } : {}) })) };
}
function validateProjectShape(project) {
  fields(project, ['id', 'name', 'activePath', 'entries']);
  if (!Array.isArray(project.entries)) throw new Error('Invalid project entries.');
  for (const entry of project.entries) {
    const names = entry.kind === 'file' ? ['path', 'kind', 'content', 'baseContent', 'revision'] : ['path', 'kind'];
    fields(entry, entry.source ? [...names, 'source'] : names);
    if (entry.source) fields(entry.source, ['repository', 'commit', 'blob']);
  }
}
function stateOf(projects, generation = 0, activeProjectId = 'legacy') { return { ...emptyWorkspace(), generation, activeProjectId, projects }; }
function validatePayload(payload, mode) {
  fields(payload, ['generation', 'activeProjectId', 'projects', 'legacy', 'buffers']);
  if (!integer(payload.generation) || !Array.isArray(payload.projects) || payload.projects.length > 50
    || !Array.isArray(payload.buffers) || payload.buffers.length > 50002) throw new Error('Invalid backup counts or generation.');
  for (const project of payload.projects) validateProjectShape(project);
  validateWorkspace(stateOf(payload.projects, payload.generation, payload.activeProjectId));
  if (size(JSON.stringify(stateOf(payload.projects, payload.generation, payload.activeProjectId))) > SNAPSHOT_LIMIT) throw new Error('Snapshot exceeds 8 MiB.');
  const all = [...payload.projects];
  if (payload.legacy !== null) { validateProjectShape(payload.legacy); validateWorkspace(stateOf([payload.legacy])); all.push(payload.legacy); }
  const projects = new Map(all.map(project => [project.id, project]));
  if (projects.size !== all.length) throw new Error('Duplicate project identity.');
  for (const project of all) scanProject(project);
  if (mode === 'saved' && (payload.buffers.length || payload.legacy !== null)) throw new Error('Saved backup cannot contain recovery buffers.');
  if (size(JSON.stringify({legacy: payload.legacy, buffers: payload.buffers})) > RECOVERY_LIMIT) throw new Error('Unsaved recovery exceeds 8 MiB. Keep the editor open; nothing was truncated.');
  const seen = new Set();
  for (const buffer of payload.buffers) {
    fields(buffer, ['projectId', 'path', 'content', 'editorRevision', 'persistedRevision', 'hasPersistedRecord']);
    const entry = projects.get(buffer.projectId)?.entries.find(entry => entry.path === buffer.path && entry.kind === 'file');
    const key = JSON.stringify([buffer.projectId, buffer.path]);
    if (!entry || seen.has(key) || typeof buffer.content !== 'string' || !integer(buffer.editorRevision)
      || buffer.persistedRevision !== entry.revision || typeof buffer.hasPersistedRecord !== 'boolean') throw new Error('Invalid or duplicate recovery buffer.');
    seen.add(key); assertNoSecrets(buffer.content);
  }
}
async function digest(backupId, payload) {
  const hash = await crypto.subtle.digest('SHA-256', encode(JSON.stringify({backupId, index: 0, payload})));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Snapshot synchronously before hashing: a late save or edit cannot change the prepared backup.
export function captureRecovery(state, editor) {
  validateWorkspace(state);
  editor?.captureLiveEditorContent();
  const projects = state.projects.map(projectCopy);
  let legacy = null;
  let project = projects.find(project => project.id === editor?.workspaceId);
  if (!editor?.workspaceId && editor?.files) {
    legacy = createProject('Legacy samples recovery');
    legacy.activePath = editor.activeFilename;
    legacy.entries = Object.keys(editor.files).map(path => ({path, kind: 'file',
      content: editor.persistedContents[path], baseContent: editor.initialFiles[path], revision: editor.persistedVersions[path]}));
    project = legacy;
  }
  const buffers = [];
  for (const entry of project?.entries || []) {
    if (entry.kind !== 'file' || !Object.hasOwn(editor.files, entry.path)) continue;
    if (editor.files[entry.path] !== entry.content || !editor.hasPersistedRecord[entry.path]) {
      buffers.push({projectId: project.id, path: entry.path, content: editor.files[entry.path],
        editorRevision: editor.fileRevisions[entry.path], persistedRevision: entry.revision,
        hasPersistedRecord: !!editor.hasPersistedRecord[entry.path]});
    }
  }
  return {generation: state.generation, activeProjectId: state.activeProjectId, projects, legacy, buffers};
}
export async function createWorkspaceBackup(state, {recovery = null} = {}) {
  validateWorkspace(state);
  const mode = recovery ? 'recovery' : 'saved';
  const payload = recovery ? clone(recovery) : {generation: state.generation, activeProjectId: state.activeProjectId, projects: state.projects.map(projectCopy), legacy: null, buffers: []};
  validatePayload(payload, mode);
  const backupId = crypto.randomUUID();
  const part = {backupId, index: 0, payload, sha256: await digest(backupId, payload)};
  const text = JSON.stringify({format: 'melly-ide-workspace', schemaVersion: 3, backupId,
    exportedAt: new Date().toISOString(), mode, partCount: 1, parts: [part]});
  if (size(text) > BACKUP_V3_LIMIT) throw new Error('Backup exceeds 24 MiB. Nothing was truncated.');
  return text;
}
export async function parseWorkspaceBackup(text) {
  if (typeof text !== 'string' || size(text) > BACKUP_V3_LIMIT) throw new Error('Backup exceeds 24 MiB or is not text.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid or incomplete JSON backup.'); }
  if (data?.schemaVersion === 1 || data?.schemaVersion === 2) {
    const projects = importProjects(text); for (const project of projects) scanProject(project);
    return {projects, mode: 'saved', bufferCount: 0, version: data.schemaVersion};
  }
  fields(data, ['format', 'schemaVersion', 'backupId', 'exportedAt', 'mode', 'partCount', 'parts']);
  if (data.format !== 'melly-ide-workspace' || data.schemaVersion !== 3 || typeof data.backupId !== 'string' || !idPattern.test(data.backupId)
    || typeof data.exportedAt !== 'string' || !Number.isFinite(Date.parse(data.exportedAt))
    || !['saved', 'recovery'].includes(data.mode) || data.partCount !== 1 || !Array.isArray(data.parts) || data.parts.length !== 1) {
    throw new Error('Unsupported schema or missing, duplicate or mixed backup parts. Select one complete v3 file.');
  }
  const part = data.parts[0]; fields(part, ['backupId', 'index', 'payload', 'sha256']);
  if (part.backupId !== data.backupId || part.index !== 0 || !/^[a-f0-9]{64}$/.test(part.sha256)
    || await digest(data.backupId, part.payload) !== part.sha256) throw new Error('Backup integrity mismatch: corrupted or mixed part.');
  validatePayload(part.payload, data.mode);
  const projects = clone([...part.payload.projects, ...(part.payload.legacy ? [part.payload.legacy] : [])]);
  for (const buffer of part.payload.buffers) {
    const entry = projects.find(project => project.id === buffer.projectId).entries.find(entry => entry.path === buffer.path);
    entry.content = buffer.content; entry.revision = buffer.editorRevision;
  }
  // The backup can preserve an oversized unsaved edit; it cannot bypass storage-model limits on restoration.
  validateWorkspace(stateOf(projects));
  const originalIds = new Set(projects.map(project => project.id)); const assigned = new Set(originalIds);
  for (const project of projects) { do { project.id = crypto.randomUUID(); } while (assigned.has(project.id)); assigned.add(project.id); }
  validateWorkspace(stateOf(projects));
  return {projects, mode: data.mode, bufferCount: part.payload.buffers.length, version: 3};
}
