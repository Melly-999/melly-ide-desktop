export const BACKUP_LIMIT = 2 * 1024 * 1024;
export const FILE_LIMIT = 512 * 1024;
export const FILENAMES = ['main.js', 'NetworkService.swift'];
const bytes = value => new TextEncoder().encode(value).length;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Malformed structure or unsupported fields.');
}
export function assertNoSecrets(value) {
  if (/-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["'][^"'\n]{4,}["']/i.test(value)) {
    throw new Error('Possible credential detected. Remove it from a separate copy before backing up or importing; nothing was changed.');
  }
}
export function parseBackup(text) {
  if (bytes(text) > BACKUP_LIMIT) throw new Error('Backup exceeds 2 MiB.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON backup.'); }
  keys(data, ['format', 'schemaVersion', 'exportedAt', 'files', 'settings']);
  if (data.format !== 'melly-ide-workspace' || data.schemaVersion !== 1) throw new Error('Unsupported backup format or schema version.');
  if (typeof data.exportedAt !== 'string' || !Number.isFinite(Date.parse(data.exportedAt))) throw new Error('Invalid backup timestamp.');
  if (!Array.isArray(data.files) || !data.files.length || data.files.length > FILENAMES.length) throw new Error('Invalid file list.');
  const seen = new Set();
  for (const record of data.files) {
    keys(record, ['filename', 'content', 'revision', 'updatedAt']);
    if (!FILENAMES.includes(record.filename) || seen.has(record.filename)) throw new Error('Duplicate or unsupported filename.');
    seen.add(record.filename);
    if (typeof record.content !== 'string' || bytes(record.content) > FILE_LIMIT) throw new Error('Invalid content or file exceeds 512 KiB.');
    if (!Number.isSafeInteger(record.revision) || record.revision < 0 || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) throw new Error('Invalid file metadata.');
    assertNoSecrets(record.content);
  }
  keys(data.settings, ['activeFilename']);
  if (!FILENAMES.includes(data.settings.activeFilename)) throw new Error('Invalid active file setting.');
  return data;
}
export function createBackup(editor, now = new Date().toISOString()) {
  editor.captureLiveEditorContent();
  const data = {format:'melly-ide-workspace',schemaVersion:1,exportedAt:now,
    files:FILENAMES.map(filename => ({filename,content:editor.files[filename],revision:editor.fileRevisions[filename],updatedAt:now})),
    settings:{activeFilename:editor.activeFilename}};
  const text = JSON.stringify(data, null, 2) + '\n';
  parseBackup(text);
  return text;
}
export function recoveryBackup(records) {
  // Only known scalar fields of supported files; never serialize arbitrary stores.
  const safe = records.filter(r => object(r) && FILENAMES.includes(r.filename)).map(record => {
    const result = {filename:record.filename};
    for (const key of ['content','schemaVersion','revision','updatedAt']) {
      if (['string','number','boolean'].includes(typeof record[key]) || record[key] === null) result[key] = record[key];
    }
    return result;
  });
  const text = JSON.stringify({format:'melly-ide-recovery',schemaVersion:1,exportedAt:new Date().toISOString(),records:safe},null,2)+'\n';
  if (bytes(text) > BACKUP_LIMIT) throw new Error('Recovery export exceeds 2 MiB.');
  assertNoSecrets(text); // Scan actual content as well as its JSON representation.
  for (const record of safe) for (const value of Object.values(record)) if (typeof value === 'string') assertNoSecrets(value);
  return text;
}
export async function previewBackup(editor, data) {
  await editor.initializePersistence();
  editor.captureLiveEditorContent();
  await Promise.all(FILENAMES.map(name => editor.waitForPendingSaves(name)));
  const stored = await editor.fileStore.readBackupRecords();
  if (!stored.ok) throw new Error(stored.message);
  return {data,stored:stored.records, snapshots:Object.fromEntries(data.files.map(r=>[r.filename,editor.getFileSnapshot(r.filename)]))};
}
export async function applyBackup(editor, preview, selected) {
  if (!selected.length) return {ok:true,kept:true};
  parseBackup(JSON.stringify(preview.data));
  if (new Set(selected).size !== selected.length || selected.some(name=>!preview.data.files.some(r=>r.filename===name))) throw new Error('Invalid replacement selection.');
  for (const name of selected) editor.cancelAutosave(name);
  await Promise.all(selected.map(name=>editor.waitForPendingSaves(name)));
  const guard = () => selected.every(name => {
    const current = editor.getFileSnapshot(name), before = preview.snapshots[name];
    return current.content === before.content && current.revision === before.revision;
  });
  try {
    if (!guard()) throw new Error('Preview is stale. Cancel and select the backup again.');
    const result = await editor.fileStore.restoreBackup(preview.data.files.filter(r=>selected.includes(r.filename)), preview.stored, guard);
    if (!result.ok) throw new Error(result.message);
    for (const record of result.records) {
      editor.updateFileContent(record.filename,record.content,{skipAutosave:true});
      editor.persistedContents[record.filename]=record.content;
      editor.persistedVersions[record.filename]=record.revision;
      editor.nextPersistedVersions[record.filename]=record.revision+1;
      editor.hasPersistedRecord[record.filename]=true;
      editor.recoveryRequired[record.filename]=false;
      editor.saveStates[record.filename]={status:'saved',message:'Imported file committed to browser-local storage.'};
    }
    editor.storageWarning=Object.values(editor.recoveryRequired).some(Boolean) ? 'Other files still require recovery; their stored records were preserved.' : '';
    editor.refreshEditorAfterStorageChange();
    editor.setFile(preview.data.settings.activeFilename);
    return {ok:true,count:result.records.length};
  } finally {
    for (const name of selected) if (editor.isFileDirty(name) && !editor.recoveryRequired[name]) editor.scheduleAutosave(name);
  }
}
