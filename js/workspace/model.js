import { assertNoSecrets, parseBackup, BACKUP_LIMIT, FILE_LIMIT } from '../backup.js';

const bytes = s => new TextEncoder().encode(s).length;
export const clone = value => structuredClone(value);
export const WORKSPACE_LIMIT = 8 * 1024 * 1024;
export const newId = () => crypto.randomUUID();
export const emptyWorkspace = () => ({schemaVersion: 1, generation: 0, activeProjectId: 'legacy', projects: [], outbox: []});
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
export function validPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 240 && !/[\\\x00-\x1f<>:"|?*]/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..' && !unsafe.has(part));
}
export function assertPath(path) { if (!validPath(path)) throw new Error('Use a relative path without traversal, empty segments or reserved names.'); }
export function validateWorkspace(state) {
  if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.generation) || state.generation < 0
    || !Array.isArray(state.projects) || state.projects.length > 50 || !Array.isArray(state.outbox) || state.outbox.length > 100) throw new Error('Unsupported or damaged workspace. Export recovery data before continuing.');
  const ids = new Set(['legacy']);
  for (const project of state.projects) {
    if (typeof project.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(project.id) || ids.has(project.id)
      || typeof project.name !== 'string' || !project.name.trim() || project.name.length > 100 || !Array.isArray(project.entries) || project.entries.length > 1000) throw new Error('Invalid project.');
    ids.add(project.id);
    const paths = new Set();
    for (const entry of project.entries) {
      assertPath(entry.path);
      if (paths.has(entry.path) || !['file', 'folder'].includes(entry.kind)) throw new Error('Duplicate path or invalid entry.');
      paths.add(entry.path);
      if (entry.kind === 'file' && (typeof entry.content !== 'string' || bytes(entry.content) > FILE_LIMIT
        || typeof entry.baseContent !== 'string' || bytes(entry.baseContent) > FILE_LIMIT || !Number.isSafeInteger(entry.revision) || entry.revision < 0)) throw new Error('Invalid file or file exceeds 512 KiB.');
      if (entry.source && (!/^[a-f0-9]{40}$/.test(entry.source.commit) || !/^[a-f0-9]{40}$/.test(entry.source.blob)
        || !/^[\w.-]+\/[\w.-]+$/.test(entry.source.repository))) throw new Error('Invalid immutable GitHub source.');
    }
    for (const entry of project.entries) {
      const parts = entry.path.split('/'); parts.pop();
      while (parts.length) {
        const parent = project.entries.find(e => e.path === parts.join('/'));
        if (!parent || parent.kind !== 'folder') throw new Error('Missing parent folder.');
        parts.pop();
      }
    }
    if (project.activePath !== null && !project.entries.some(e => e.kind === 'file' && e.path === project.activePath)) throw new Error('Invalid active file.');
  }
  if (!ids.has(state.activeProjectId)) throw new Error('Invalid active project.');
  if (bytes(JSON.stringify(state)) > WORKSPACE_LIMIT) throw new Error('Workspace exceeds the 8 MiB safety limit. Keep recovery files and use a separate browser profile for additional copies.');
  return state;
}
export function createProject(name, id = newId()) {
  return {id, name: String(name).trim(), activePath: 'main.js', entries: [{path: 'main.js', kind: 'file', content: '', baseContent: '', revision: 0}]};
}
export function addEntry(project, path, kind, content = '', source) {
  assertPath(path);
  if (project.entries.some(e => e.path === path)) throw new Error('Path already exists.');
  const parts = path.split('/'); parts.pop();
  let parent = '';
  for (const part of parts) {
    parent = parent ? `${parent}/${part}` : part;
    const found = project.entries.find(e => e.path === parent);
    if (found && found.kind !== 'folder') throw new Error('A parent path is a file.');
    if (!found) project.entries.push({path: parent, kind: 'folder'});
  }
  project.entries.push(kind === 'folder' ? {path, kind} : {path, kind, content, baseContent: content, revision: 0, ...(source ? {source} : {})});
  if (kind === 'file') project.activePath = path;
}
export function renameEntry(project, from, to) {
  assertPath(to);
  if (to === from) return;
  if (!project.entries.some(e => e.path === from)) throw new Error('Path no longer exists.');
  if (to.startsWith(from + '/')) throw new Error('Cannot move a folder inside itself.');
  const moving = project.entries.filter(e => e.path === from || e.path.startsWith(from + '/'));
  const renamed = moving.map(e => to + e.path.slice(from.length));
  if (project.entries.some(e => !moving.includes(e) && renamed.includes(e.path))) throw new Error('Destination already exists.');
  const parts = to.split('/'); parts.pop();
  if (parts.length && !project.entries.some(e => e.path === parts.join('/') && e.kind === 'folder')) throw new Error('Create the destination folder first.');
  for (const entry of moving) { if (project.activePath === entry.path) project.activePath = to + entry.path.slice(from.length); entry.path = to + entry.path.slice(from.length); entry.revision = (entry.revision || 0) + 1; }
}
export function deleteEntry(project, path) {
  project.entries = project.entries.filter(e => e.path !== path && !e.path.startsWith(path + '/'));
  if (!project.entries.some(e => e.path === project.activePath && e.kind === 'file')) project.activePath = project.entries.find(e => e.kind === 'file')?.path ?? null;
}
export function lineDiff(before, after, name = 'file') {
  if (before === after) return 'No changes against the saved original revision.';
  // A complete, valid single hunk preserves every line, including final-newline changes.
  // Linear memory/time also bounds work for large generated files.
  const split = s => s === '' ? [] : s.split('\n').slice(0, s.endsWith('\n') ? -1 : undefined);
  const old = split(before), next = split(after);
  const lines = [`--- a/${name}`, `+++ b/${name}`, `@@ -${old.length ? 1 : 0},${old.length} +${next.length ? 1 : 0},${next.length} @@`];
  for (const [content, list, prefix] of [[before, old, '-'], [after, next, '+']]) {
    list.forEach((line, index) => { lines.push(prefix + line); if (index === list.length - 1 && !content.endsWith('\n')) lines.push('\\ No newline at end of file'); });
  }
  return lines.join('\n');
}
export function exportWorkspace(state) {
  validateWorkspace(state);
  const projects = state.projects.map(p => ({id:p.id, name:p.name, activePath:p.activePath, entries:p.entries.map(e => ({path:e.path, kind:e.kind,
    ...(e.kind === 'file' ? {content:e.content, baseContent:e.baseContent, revision:e.revision, ...(e.source ? {source:{repository:e.source.repository,commit:e.source.commit,blob:e.source.blob}} : {})} : {})}))}));
  const data = {format: 'melly-ide-workspace', schemaVersion: 2, exportedAt: new Date().toISOString(), projects};
  const text = JSON.stringify(data, null, 2);
  if (bytes(text) > BACKUP_LIMIT) throw new Error('Backup exceeds 2 MiB.');
  for (const p of data.projects) for (const e of p.entries) if (e.kind === 'file') { assertNoSecrets(e.content); assertNoSecrets(e.baseContent); }
  return text;
}
export function importProjects(text) {
  if (bytes(text) > BACKUP_LIMIT) throw new Error('Backup exceeds 2 MiB.');
  const data = JSON.parse(text);
  let projects;
  if (data.schemaVersion === 1) {
    const legacy = parseBackup(text);
    const project = createProject('Imported legacy backup');
    project.entries = legacy.files.map(e => ({path: e.filename, kind: 'file', content: e.content, baseContent: e.content, revision: e.revision}));
    project.activePath = legacy.settings.activeFilename;
    projects = [project];
  } else {
    if (data.format !== 'melly-ide-workspace' || data.schemaVersion !== 2 || !Array.isArray(data.projects)) throw new Error('Unsupported backup.');
    projects = data.projects.map(p => ({id: newId(), name: p.name, activePath: p.activePath, entries: p.entries.map(e => ({path: e.path, kind: e.kind, ...(e.kind === 'file' ? {content: e.content, baseContent: e.baseContent, revision: e.revision, ...(e.source ? {source: {repository: e.source.repository, commit: e.source.commit, blob: e.source.blob}} : {})} : {})}))}));
  }
  const state = {...emptyWorkspace(), projects};
  validateWorkspace(state);
  for (const p of projects) for (const e of p.entries) if (e.kind === 'file') { assertNoSecrets(e.content); assertNoSecrets(e.baseContent); }
  return projects;
}
export function recoveryWorkspace(raw) {
  // Recovery never serializes unknown fields or other stores, even for a future schema.
  const candidates = Array.isArray(raw?.projects) ? raw.projects : [];
  if (candidates.length > 50 || candidates.some(p => p?.name?.length > 100 || p?.entries?.length > 1000)) throw new Error('Diagnostic recovery exceeds model bounds. No data was truncated; keep this profile intact.');
  const projects = candidates.map(p => ({
    name: typeof p?.name === 'string' ? p.name : 'Recovered project',
    entries: (Array.isArray(p?.entries) ? p.entries : []).filter(e => validPath(e?.path)).map(e => ({
      path:e.path, kind:e.kind === 'folder' ? 'folder' : 'file',
      ...(typeof e.content === 'string' ? {content:e.content} : {}),
      ...(typeof e.baseContent === 'string' ? {baseContent:e.baseContent} : {})
    }))
  }));
  for (const p of projects) { assertNoSecrets(p.name); for (const e of p.entries) for (const value of Object.values(e)) if (typeof value === 'string') assertNoSecrets(value); }
  const text = JSON.stringify({format:'melly-ide-workspace-recovery',schemaVersion:1,projects},null,2);
  if (bytes(text)>WORKSPACE_LIMIT) throw new Error('Diagnostic recovery exceeds 8 MiB. Nothing was truncated.'); return text;
}
