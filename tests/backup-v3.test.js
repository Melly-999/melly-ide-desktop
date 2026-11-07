import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceBackup, parseWorkspaceBackup, captureRecovery, BACKUP_V3_LIMIT} from '../js/workspace/backup-v3.js';
import {emptyWorkspace, createProject, addEntry, validateWorkspace, exportWorkspace, recoveryWorkspace, WORKSPACE_LIMIT} from '../js/workspace/model.js';
import {RealWorkspace} from '../js/workspace/ui.js';
import {mergeTextareaInput} from '../js/editor.js';

const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
const state = () => ({...emptyWorkspace(), projects: [createProject('Synthetic')]});
function sized(target) {
  const s = state();
  for (let i = 0; i < 9; i++) addEntry(s.projects[0], `file${i}.txt`, 'file');
  let remaining = target - bytes(s);
  for (const e of s.projects[0].entries) {
    const count = Math.min(500000, Math.floor(remaining / 2));
    e.content = e.baseContent = 'x'.repeat(count); remaining -= count * 2;
  }
  s.projects[0].entries[0].content += 'x'.repeat(remaining);
  assert.equal(bytes(s), target); return validateWorkspace(s);
}
function editor(s, content) {
  const p = s.projects[0], e = p.entries[0];
  return {workspaceId: p.id, files: {[e.path]: content}, fileRevisions: {[e.path]: 9},
    hasPersistedRecord: {[e.path]: true}, captureLiveEditorContent() {}};
}
for (const target of [2*1024*1024-1024, 2*1024*1024+1024, WORKSPACE_LIMIT-4096, WORKSPACE_LIMIT]) {
  test(`MVP01 v3 exact round trip for accepted snapshot ${target} bytes`, async () => {
    const s = sized(target), text = await createWorkspaceBackup(s), result = await parseWorkspaceBackup(text);
    assert.deepEqual(result.projects[0].entries, s.projects[0].entries);
    assert.notEqual(result.projects[0].id, s.projects[0].id);
    assert.ok(bytes(text) < BACKUP_V3_LIMIT);
  });
}
test('MVP01 large originals, nested Unicode paths, CRLF, lone surrogates and JSON escaping survive', async () => {
  const s = state(), p = s.projects[0];
  addEntry(p, 'src/zażółć.js', 'file', '\r\n\t"\\\u0000🟣\ud800\r\n', {repository: 'owner/repo', commit: 'a'.repeat(40), blob: 'b'.repeat(40)});
  p.entries.at(-1).baseContent = '\r\n\\"'.repeat(50000); p.entries.at(-1).revision = 77;
  const result = await parseWorkspaceBackup(await createWorkspaceBackup(s));
  assert.deepEqual(result.projects[0].entries, p.entries);
});
test('MVP01 recovery captures all dirty buffers without flush or mutation of the saved snapshot', async () => {
  const s = state(), before = structuredClone(s), e = editor(s, '// unsaved\r\n');
  const recovery = captureRecovery(s, e); const text = await createWorkspaceBackup(s, {recovery});
  assert.deepEqual(s, before); const raw = JSON.parse(text).parts[0].payload;
  assert.equal(raw.projects[0].entries[0].content, ''); assert.equal(raw.buffers[0].persistedRevision, 0);
  assert.equal(raw.buffers[0].editorRevision, 9);
  const result = await parseWorkspaceBackup(text); assert.equal(result.mode, 'recovery'); assert.equal(result.bufferCount, 1);
  assert.equal(result.projects[0].entries[0].content, '// unsaved\r\n');
});
test('MVP01 legacy unsaved recovery becomes a new project without touching legacy storage', async () => {
  const s = state(), e = {files: {'main.js': '// unsaved'}, initialFiles: {'main.js': '// original'}, persistedContents: {'main.js': '// saved'}, persistedVersions: {'main.js': 3}, fileRevisions: {'main.js': 4}, hasPersistedRecord: {'main.js': true}, activeFilename: 'main.js', captureLiveEditorContent() {}};
  const parsed = await parseWorkspaceBackup(await createWorkspaceBackup(s, {recovery: captureRecovery(s, e)}));
  assert.equal(parsed.projects.length, 2); assert.equal(parsed.projects[1].entries[0].content, '// unsaved');
  assert.equal(parsed.projects[1].entries[0].baseContent, '// original'); assert.equal(e.persistedContents['main.js'], '// saved');
});
test('MVP01 snapshot stays immutable while async checksum is pending', async () => {
  const s = state(), pending = createWorkspaceBackup(s); s.projects[0].entries[0].content = '// later';
  assert.equal((await parseWorkspaceBackup(await pending)).projects[0].entries[0].content, '');
});
const invalid = [
  ['missing part', d => d.parts = []], ['duplicate part', d => d.parts.push(d.parts[0])],
  ['mixed backup identity', d => d.parts[0].backupId = crypto.randomUUID()],
  ['unsupported schema', d => d.schemaVersion = 4], ['mixed part count', d => d.partCount = 2],
  ['mixed part index', d => d.parts[0].index = 1], ['corrupted content', d => d.parts[0].payload.projects[0].entries[0].content = '// corrupted'],
  ['missing payload', d => delete d.parts[0].payload], ['unknown field', d => d.providerToken = 'must-not-import'],
  ['corrupted checksum', d => d.parts[0].sha256 = '0'.repeat(64)]
];
for (const [name, mutate] of invalid) test('MVP01 rejects ' + name + ' before import', async () => {
  const d = JSON.parse(await createWorkspaceBackup(state())); mutate(d);
  await assert.rejects(() => parseWorkspaceBackup(JSON.stringify(d)));
});
test('MVP01 rejects invalid JSON and file above bounded v3 limit', async () => {
  await assert.rejects(() => parseWorkspaceBackup('{bad'), /JSON/);
  await assert.rejects(() => parseWorkspaceBackup(' '.repeat(BACKUP_V3_LIMIT+1)), /24 MiB/);
});
test('MVP01 v1 and v2 remain accepted with new copy identities', async () => {
  const s = state(); const v2 = await parseWorkspaceBackup(exportWorkspace(s)); assert.equal(v2.version, 2);
  const v1 = {format: 'melly-ide-workspace', schemaVersion: 1, exportedAt: new Date().toISOString(), files: [{filename: 'main.js', content: '// v1\r\n', revision: 2, updatedAt: new Date().toISOString()}], settings: {activeFilename: 'main.js'}};
  const result = await parseWorkspaceBackup(JSON.stringify(v1)); assert.equal(result.version, 1); assert.equal(result.projects[0].entries[0].content, '// v1\r\n');
});
for (const target of ['content', 'baseContent', 'name', 'path', 'buffer']) test('MVP01 blocks secret patterns in ' + target, async () => {
  const s = state(), secret = 'const password = "private-synthetic-value";';
  let recovery;
  if (target === 'buffer') recovery = captureRecovery(s, editor(s, secret));
  else if (target === 'name') s.projects[0].name = secret;
  else if (target === 'path') { s.projects[0].entries[0].path = '.env'; s.projects[0].activePath = '.env'; }
  else s.projects[0].entries[0][target] = secret;
  await assert.rejects(() => createWorkspaceBackup(s, {recovery}), /credential/);
});
test('MVP01 excludes unrelated metadata, outbox and unknown credential fields', async () => {
  const s = state(); s.providerToken = 'OMIT-SENTINEL'; s.projects[0].auth = 'OMIT-SENTINEL'; s.projects[0].entries[0].token = 'OMIT-SENTINEL'; s.outbox.push({token: 'OMIT-SENTINEL'});
  assert.ok(!(await createWorkspaceBackup(s)).includes('OMIT-SENTINEL'));
});
test('MVP01 oversized unsaved file is recoverable as data, but cannot bypass model validation at import', async () => {
  const s = state(), recovery = captureRecovery(s, editor(s, 'x'.repeat(600000)));
  const text = await createWorkspaceBackup(s, {recovery}); assert.equal(JSON.parse(text).parts[0].payload.buffers[0].content.length, 600000);
  await assert.rejects(() => parseWorkspaceBackup(text), /512 KiB/);
});
test('MVP01 duplicate project IDs fail and diagnostic recovery never silently truncates counts', async () => {
  const s = state(); s.projects.push(structuredClone(s.projects[0])); await assert.rejects(() => createWorkspaceBackup(s));
  assert.throws(() => recoveryWorkspace({projects: Array.from({length: 51}, () => ({name:'p',entries:[]}))}), /truncated/);
});
test('MVP01 failed workspace transaction keeps state and pre-existing projects unchanged', async () => {
  const w = Object.create(RealWorkspace.prototype); w.state = state(); const before = structuredClone(w.state);
  w.ready = true; w.queue = Promise.resolve(); w.renderProjects = () => {};
  w.store = {save: async () => { throw new Error('SYNTHETIC_QUOTA_FAILURE'); }};
  const incoming = (await parseWorkspaceBackup(await createWorkspaceBackup(state()))).projects;
  await assert.rejects(() => w.mutate(next => next.projects.push(...incoming)), /QUOTA/);
  assert.deepEqual(w.state, before);
});
test('MVP01 flush permits retry after a rolled-back mutation but rejects a current failed save', async () => {
  const w = Object.create(RealWorkspace.prototype);
  w.app = {editor: {files: {}, captureLiveEditorContent() {}}};
  w.queue = Promise.reject(new Error('previous rollback')); w.queue.catch(() => {});
  await w.flush();
  w.app.editor = {files: {'a.js': '// dirty'}, captureLiveEditorContent() {}, isFileDirty: () => true, saveFile: async () => ({ok:false}), waitForPendingSaves: async () => {}};
  await assert.rejects(() => w.flush(), /Save failed/);
});
test('MVP01 recovery captures independent unsaved files and does not conflate persisted/editor revisions', async () => {
  const s = state(); addEntry(s.projects[0], 'nested/second.js', 'file', '// saved second');
  const e=editor(s,'// dirty first'); e.files['nested/second.js']='// dirty second\r\n';e.fileRevisions['nested/second.js']=12;e.hasPersistedRecord['nested/second.js']=true;
  const recovery=captureRecovery(s,e);assert.equal(recovery.buffers.length,2);
  const result=await parseWorkspaceBackup(await createWorkspaceBackup(s,{recovery}));
  assert.equal(result.projects[0].entries.find(e=>e.path==='nested/second.js').content,'// dirty second\r\n');assert.equal(result.projects[0].entries.find(e=>e.path==='nested/second.js').revision,12);
});
test('MVP01 recovery budget rejects oversized data explicitly without mutating source buffers', async () => {
  const s=state(),e=editor(s,'x'.repeat(8*1024*1024));const recovery=captureRecovery(s,e);
  await assert.rejects(()=>createWorkspaceBackup(s,{recovery}),/recovery exceeds 8 MiB/);assert.equal(e.files['main.js'].length,8*1024*1024);
});
test('MVP01 secret pattern in immutable source metadata blocks the complete operation', async () => {
  const s=state();s.projects[0].entries[0].source={repository:'owner/ghp_12345678901234567890',commit:'a'.repeat(40),blob:'b'.repeat(40)};
  await assert.rejects(()=>createWorkspaceBackup(s),/credential/);
});
test('MVP01 every accepted saved snapshot exports even with a one-character active project ID at the exact byte limit', async () => {
  const s=sized(WORKSPACE_LIMIT);s.projects[0].id='p';s.activeProjectId='p';
  const remaining=WORKSPACE_LIMIT-bytes(s);s.projects[0].entries[0].content+='x'.repeat(remaining);validateWorkspace(s);
  const text=await createWorkspaceBackup(s),payload=JSON.parse(text).parts[0].payload;
  assert.equal(payload.activeProjectId,'p');assert.deepEqual(payload.projects[0].entries,s.projects[0].entries);
});
for (const original of ['one\r\ntwo\r\n', 'one\rtwo\r', 'one\r\ntwo\rlast\n', 'Zażółć 🟣\r\n\r\n']) {
  test('MVP01 passive textarea capture preserves exact newline bytes '+JSON.stringify(original), () => {
    assert.equal(mergeTextareaInput(original,original.replace(/\r\n?/g,'\n')),original);
  });
}
test('MVP01 editing preserves mixed unchanged line endings and uses source newline for inserted lines', () => {
  assert.equal(mergeTextareaInput('one\r\ntwo\rlast\n','one\nTWO\nlast\n'),'one\r\nTWO\rlast\n');
  assert.equal(mergeTextareaInput('one\r\ntwo\r\n','one\nnew\ntwo\n'),'one\r\nnew\r\ntwo\r\n');
  assert.equal(mergeTextareaInput('one\r\ntwo\r\n','one\n'),'one\r\n');
  assert.equal(mergeTextareaInput('','first\n'),'first\n');
});
