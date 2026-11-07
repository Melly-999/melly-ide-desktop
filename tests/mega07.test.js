// MEGA-07 unit tests: disk-buffer recovery, local diagnostics, IPC outcome classification and
// Local Folder save/conflict state. In-memory synthetic storage only; no disk, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { DiskRecovery, checksum, relation, PREFIX, LEGACY_PREFIX, MAX_CONTENT } from '../js/storage/disk-recovery.js';
import { Diagnostics, sanitize, DIAGNOSTICS_KEY, MAX_EVENTS } from '../js/diagnostics.js';
import { LocalFolder, errorCode, conflictSummary, SAVE_STATUS } from '../js/local-folder.js';
const { classify, summarize, CLASSES, PROBE_SOURCE } = createRequire(import.meta.url)('./lib/ipc-classify.cjs');
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

class MemoryStorage {
  constructor() { this.map = new Map(); this.quota = Infinity; this.broken = false; }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { if (this.broken) throw Error('SecurityError'); return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { if (this.broken) throw Error('SecurityError'); const size = [...this.map].reduce((n, [a, b]) => n + (a === k ? 0 : a.length + b.length), 0) + k.length + v.length; if (size > this.quota) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } this.map.set(k, String(v)); }
  removeItem(k) { if (this.broken) throw Error('SecurityError'); this.map.delete(k); }
}
const A = 'a'.repeat(64), B = 'b'.repeat(64), FIXTURE = '\uFEFF// żółć 日本語 🟣\r\nlet x=1;\r\nmixed\nend\r';

test('recovery: exact content round trip across a simulated restart, per project', () => {
  const storage = new MemoryStorage();
  const first = new DiskRecovery({storage, session: 's1', now: () => '2026-10-26T10:00:00.000Z'});
  assert.deepEqual(first.write('projA', 'src/unicode.ts', {baseVersion: A, content: FIXTURE}), {ok: true});
  assert.deepEqual(first.write('projB', 'src/unicode.ts', {baseVersion: B, content: 'other project'}), {ok: true});
  const restarted = new DiskRecovery({storage, session: 's2'});
  const found = restarted.read('projA', 'src/unicode.ts');
  assert.equal(found.status, 'ok'); assert.equal(found.record.content, FIXTURE); assert.equal(found.record.baseVersion, A);
  assert.equal(restarted.read('projB', 'src/unicode.ts').record.content, 'other project');
  const listed = restarted.list('projA');
  assert.deepEqual(listed.map(e => [e.path, e.status, e.previousSession, e.savedAt]), [['src/unicode.ts', 'ok', true, '2026-10-26T10:00:00.000Z']]);
  assert.equal(restarted.list('proj').length, 0, 'prefix of another project id never matches');
});

test('recovery: cross-project and tampered records are corrupt and never restored', () => {
  const storage = new MemoryStorage(), r = new DiskRecovery({storage, session: 's'});
  r.write('projA', 'a.ts', {baseVersion: A, content: 'mine'});
  const moved = storage.getItem(r.key('projA', 'a.ts')); storage.setItem(r.key('projB', 'a.ts'), moved);
  assert.equal(r.read('projB', 'a.ts').status, 'corrupt'); assert.match(r.read('projB', 'a.ts').reason, /different project/);
  const tampered = JSON.parse(moved); tampered.content = 'mine!'; storage.setItem(r.key('projA', 'a.ts'), JSON.stringify(tampered));
  assert.match(r.read('projA', 'a.ts').reason, /integrity/);
  storage.setItem(r.key('projA', 'b.ts'), '{"v":2,"project":"projA"');
  storage.setItem(r.key('projA', 'c.ts'), JSON.stringify({v: 9}));
  storage.setItem(r.key('projA', 'd.ts'), JSON.stringify({...JSON.parse(moved), path: 'other.ts'}));
  const listed = Object.fromEntries(r.list('projA').map(e => [e.path, e.status]));
  assert.deepEqual(listed, {'a.ts': 'corrupt', 'b.ts': 'corrupt', 'c.ts': 'corrupt', 'd.ts': 'corrupt'});
  assert.ok(r.list('projA').every(e => e.reason));
  for (const entry of r.list('projA')) assert.equal(r.discard(entry), true);
  assert.equal(r.list('projA').length, 0);
});

test('recovery: legacy v1 records are read and migrated on the next write', () => {
  const storage = new MemoryStorage(), r = new DiskRecovery({storage});
  storage.setItem(`${LEGACY_PREFIX}proj:x.ts`, JSON.stringify({path: 'x.ts', version: A, content: 'old buffer'}));
  storage.setItem(`${LEGACY_PREFIX}proj:bad.ts`, '{nope');
  const found = r.read('proj', 'x.ts');
  assert.equal(found.status, 'ok'); assert.equal(found.legacy, true); assert.equal(found.record.content, 'old buffer');
  assert.deepEqual(r.list('proj').map(e => [e.path, e.status, e.legacy]), [['bad.ts', 'corrupt', true], ['x.ts', 'ok', true]]);
  r.write('proj', 'x.ts', {baseVersion: A, content: 'old buffer edited'});
  assert.equal(storage.getItem(`${LEGACY_PREFIX}proj:x.ts`), null); assert.ok(storage.getItem(`${PREFIX}proj:x.ts`));
});

test('recovery: quota, unavailable storage, size limit and invalid input are reported, not thrown', () => {
  const storage = new MemoryStorage(), r = new DiskRecovery({storage});
  storage.quota = 300;
  assert.deepEqual(r.write('p', 'a.ts', {baseVersion: A, content: 'x'.repeat(400)}), {ok: false, code: 'QUOTA'});
  assert.deepEqual(r.write('p', 'a.ts', {baseVersion: A, content: 'x'.repeat(MAX_CONTENT + 1)}), {ok: false, code: 'TOO_LARGE'});
  assert.deepEqual(r.write('p', 'a.ts', {baseVersion: 'nope', content: 'x'}), {ok: false, code: 'INVALID'});
  storage.broken = true;
  assert.deepEqual(r.write('p', 'a.ts', {baseVersion: A, content: 'x'}), {ok: false, code: 'UNAVAILABLE'});
  assert.equal(r.read('p', 'a.ts').status, 'corrupt'); assert.deepEqual(r.list('p'), []); assert.equal(r.remove('p', 'a.ts'), false);
});

test('recovery: stale and missing detection against the current disk version', () => {
  const record = {baseVersion: A};
  assert.equal(relation(record, {exists: true, version: A}), 'current');
  assert.equal(relation(record, {exists: true, version: B}), 'stale');
  assert.equal(relation(record, {exists: false, version: ''}), 'missing');
  assert.notEqual(checksum('ab'), checksum('ba')); assert.notEqual(checksum('a'), checksum('a\0'));
  assert.match(checksum(FIXTURE), /^fnv1a32:\d+:[0-9a-f]{8}$/);
});

test('diagnostics: sanitizer strips paths, emails, tokens and control characters', () => {
  const text = sanitize('Failed C:\\Users\\Owner\\proj\\secret.ts and \\\\server\\share\\x /Users/me/a.txt mail me@example.com Bearer abc.def sk-live_ABCDEFGH12345678 ghp_abcdefghijklmnopqrstuvwxyz0123 eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xxxxxx\nnext');
  for (const leak of ['Owner', 'secret.ts', 'server', '/Users/me', 'me@example.com', 'abc.def', 'sk-live', 'ghp_', 'eyJhbGci', '\n']) assert.ok(!text.includes(leak), `${leak} leaked: ${text}`);
  assert.match(text, /<path>/); assert.match(text, /<redacted>/); assert.match(text, /<email>/);
});

test('diagnostics: bounded ring, allow-listed detail, run id, persistence and export shape', () => {
  const storage = new MemoryStorage();
  const d = new Diagnostics({storage, runId: 'run-a', now: () => '2026-10-26T10:00:00.000Z', build: {version: '0.6.0-rc.1'}});
  const event = d.record('save', 'FAILED_LOCKED', {bytes: 12, content: 'SECRET SOURCE', path: 'C:\\Users\\x', kind: 'C:\\Users\\Owner\\a', ms: 3});
  assert.deepEqual(event.detail, {bytes: 12, kind: '<path>', ms: 3});
  assert.equal(d.record('nonsense', 'bad code').category, 'app'); assert.equal(d.events.at(-1).code, 'OTHER');
  for (let i = 0; i < MAX_EVENTS + 20; i++) d.record('agents', 'TRANSITION', {from: 'pending', to: 'cancelled'});
  assert.equal(d.events.length, MAX_EVENTS);
  const again = new Diagnostics({storage, runId: 'run-b'});
  assert.equal(again.events.length, MAX_EVENTS); assert.equal(again.events[0].run, 'run-a');
  again.setNative({product: 'Melly IDE Windows QA', version: '0.6.0-rc.1', capabilities: {terminal: 'disabled · not compiled', bogus: 1}, saveFailures: {LOCKED: 2, 'C:\\x': 1}, dispatcherRejections: {preview: 0, evil: 3}, secret: 'x'});
  const report = again.report();
  assert.equal(report.schema, 'melly-diagnostics/1'); assert.equal(report.native.secret, undefined); assert.deepEqual(report.native.saveFailures, {LOCKED: 2});
  assert.deepEqual(report.native.dispatcherRejections, {preview: 0}); assert.equal(report.native.capabilities.bogus, undefined);
  assert.ok(!JSON.stringify(report).includes('SECRET SOURCE')); assert.match(report.privacy, /Nothing was transmitted/);
  again.clear(); assert.equal(JSON.parse(storage.getItem(DIAGNOSTICS_KEY)).events.length, 0);
  storage.setItem(DIAGNOSTICS_KEY, '{broken'); assert.match(new Diagnostics({storage}).persistError, /unreadable/);
  storage.quota = 10; const full = new Diagnostics({storage}); full.record('app', 'START'); assert.match(full.persistError, /full/);
});

test('IPC classification: explicit denials, label denials, transport blocks and timeouts are distinct', () => {
  assert.equal(classify({status: 'rejected', error: 'folder_save not allowed on window "preview", webview "preview", URL: local'}), 'EXPLICIT_ACL_DENIAL');
  assert.equal(classify({status: 'rejected', error: 'app.version not allowed. Permissions associated with this command: core:app:allow-version'}), 'EXPLICIT_ACL_DENIAL');
  assert.equal(classify({status: 'rejected', error: 'Melly IDE commands are available only to the main window.'}), 'EXPLICIT_LABEL_DENIAL');
  assert.equal(classify({status: 'rejected', error: 'TypeError: Failed to fetch'}), 'TRANSPORT_BLOCKED');
  assert.equal(classify({status: 'timeout'}), 'UNRESOLVED_TIMEOUT', 'a timeout is never a denial');
  assert.equal(classify({status: 'rejected', error: 'TIMEOUT'}), 'OTHER_REJECTION', 'the MEGA-06 "rejected:TIMEOUT" label is not an ACL denial');
  assert.equal(classify({status: 'no-bridge'}), 'NO_BRIDGE');
  assert.equal(classify({status: 'resolved', value: '{}'}), 'RESOLVED');
  assert.throws(() => classify({status: 'weird'}), TypeError);
  assert.equal(CLASSES.length, 7); assert.match(PROBE_SOURCE, /Promise\.race/);
});

test('IPC summary: verdict requires clean side-effect evidence and never upgrades timeouts', () => {
  const clean = {stateUnchanged: true, privilegedEffects: 0, trapHits: 0, dispatcherDelta: 0, secretsServed: 0};
  const denied = [{command: 'folder_save', status: 'rejected', error: 'not allowed on window "preview"'}];
  assert.equal(summarize(denied, clean).verdict, 'PASS');
  const timedOut = [...denied, {command: 'git_status', status: 'timeout'}];
  const s = summarize(timedOut, clean);
  assert.equal(s.verdict, 'NO_EFFECT_UNRESOLVED'); assert.equal(s.explicitDenials, 1); assert.equal(s.unresolved, 1);
  assert.equal(summarize(timedOut, {...clean, trapHits: 1}).verdict, 'FAIL');
  assert.equal(summarize(timedOut, {...clean, dispatcherDelta: 2}).verdict, 'FAIL');
  assert.equal(summarize(timedOut).verdict, 'INCONCLUSIVE', 'missing side-effect evidence is inconclusive, not a pass');
  assert.equal(summarize([{command: 'x', status: 'resolved', value: 'ok'}], clean).verdict, 'FAIL');
});

test('save error codes and status labels', () => {
  assert.equal(errorCode('LOCKED: The file is locked by another program'), 'LOCKED');
  assert.equal(errorCode('CONFLICT: File changed on disk.'), 'CONFLICT');
  assert.equal(errorCode('Missing file or directory.'), 'OTHER');
  assert.equal(errorCode('C:\\x: no'), 'OTHER');
  for (const code of ['CONFLICT', 'MISSING', 'LOCKED', 'ACCESS_DENIED', 'READ_ONLY', 'DISK_FULL', 'INTERRUPTED', 'ROLLBACK_FAILED']) assert.ok(SAVE_STATUS[code]);
  assert.equal(SAVE_STATUS.CONFLICT, 'DISK CONFLICT', 'earlier QA harnesses assert this exact label');
});

test('conflict summary trims common lines and keeps both sides', () => {
  const s = conflictSummary('a\r\nb\r\nmine\r\nz', 'a\nb\ndisk1\ndisk2\nz');
  assert.deepEqual([s.firstLine, s.mine, s.disk, s.mineLines, s.diskLines, s.more], [3, ['mine'], ['disk1', 'disk2'], 4, 5, false]);
  assert.equal(conflictSummary('same', 'same').mine.length, 0);
  assert.equal(conflictSummary('x\n'.repeat(30), 'y\n'.repeat(30), 5).more, true);
});

// Minimal Local Folder harness: real LocalFolder logic, synthetic native bridge, no DOM rendering.
function folderWith(bridge, storage = new MemoryStorage()) {
  const events = [], f = new LocalFolder({diagnostics: {record: (c, code) => events.push(`${c}.${code}`)}}, bridge);
  f.recovery = new DiskRecovery({storage, session: 'test'});
  f.session = {sessionId: 'synthetic', name: 'disposable', recoveryKey: 'qa-root'};
  const messages = []; f.message = (text, error) => messages.push([text, !!error]);
  f.updateDiskStatus = () => {}; f.renderPreview = () => {}; f.renderInterrupted = () => {}; f.showConflict = async () => {}; f.renderRecoveryPanel = async () => {};
  f.panel = {querySelector: () => ({hidden: true, replaceChildren() {}, append() {}, dataset: {}})};
  f.tabs.set('a.ts', FIXTURE); f.diskFiles.set('a.ts', {path: 'a.ts', version: A, base: FIXTURE, content: FIXTURE, conflict: false, missing: false, status: null}); f.activePath = 'a.ts';
  return {f, events, messages, storage};
}

test('Local Folder: typing persists a recovery copy; a successful save clears it', async () => {
  const calls = [];
  const {f, events, storage} = folderWith(async (command, args) => { calls.push(command); if (command === 'folder_save') return {path: args.path, content: args.content, bytes: args.content.length, version: B}; });
  f.tabs.set('a.ts', FIXTURE + 'edit'); f.persistBuffer('a.ts');
  assert.equal(f.recovered('a.ts').content, FIXTURE + 'edit');
  await f.save();
  assert.deepEqual(calls, ['folder_save']); assert.equal(f.diskFiles.get('a.ts').version, B);
  assert.equal(f.recovered('a.ts'), null); assert.equal(storage.length, 0); assert.ok(events.includes('save.SAVED'));
});

test('Local Folder: each native failure keeps the buffer, sets the right state, never retries silently', async () => {
  for (const [error, check] of [
    ['CONFLICT: File changed on disk.', file => file.conflict === true],
    ['MISSING: Missing file: it was deleted or renamed on disk.', file => file.missing === true],
    ['LOCKED: The file is locked by another program (sharing violation).', file => file.status === 'LOCKED'],
    ['ACCESS_DENIED: Access denied by Windows permissions.', file => file.status === 'ACCESS_DENIED'],
    ['READ_ONLY: The file has the Windows read-only attribute.', file => file.status === 'READ_ONLY'],
    ['ROLLBACK_FAILED: Save could not finish.', file => file.status === 'ROLLBACK_FAILED']
  ]) {
    let saves = 0;
    const {f, events, messages} = folderWith(async command => { if (command === 'folder_save') { saves++; throw new Error(error); } });
    f.tabs.set('a.ts', 'my edit'); f.persistBuffer('a.ts');
    await f.save();
    const file = f.diskFiles.get('a.ts');
    assert.ok(check(file), error); assert.equal(f.tabs.get('a.ts'), 'my edit'); assert.equal(file.version, A);
    assert.equal(f.recovered('a.ts').content, 'my edit', 'recovery copy survives a failed save');
    assert.equal(saves, 1); assert.equal(messages.at(-1)[1], true); assert.ok(events.includes(`save.FAILED_${errorCode(error)}`));
    if (file.conflict || file.missing) { await f.save(); assert.equal(saves, 1, 'no save attempt while in conflict'); }
  }
});

test('Local Folder: recovery quota failure is surfaced and recorded', () => {
  const {f, events, messages, storage} = folderWith(async () => {});
  storage.quota = 50; f.tabs.set('a.ts', 'x'.repeat(200)); f.persistBuffer('a.ts');
  assert.equal(f.recoveryError, 'QUOTA'); assert.match(messages.at(-1)[0], /NOT protected/); assert.ok(events.includes('recovery.WRITE_QUOTA'));
  storage.quota = Infinity; f.persistBuffer('a.ts'); assert.equal(f.recoveryError, null); assert.ok(events.includes('recovery.STORAGE_OK'));
});

test('Local Folder: a stale recovered buffer is restored as a conflict, a current one is not', () => {
  const {f} = folderWith(async () => {});
  f.recovery.write('qa-root', 'a.ts', {baseVersion: B, content: 'stale buffer'});
  assert.equal(f.restoreBuffer('a.ts'), true);
  assert.equal(f.tabs.get('a.ts'), 'stale buffer'); assert.equal(f.diskFiles.get('a.ts').conflict, true);
  const {f: g} = folderWith(async () => {});
  g.recovery.write('qa-root', 'a.ts', {baseVersion: A, content: 'current buffer'});
  g.restoreBuffer('a.ts'); assert.equal(g.diskFiles.get('a.ts').conflict, false); assert.equal(g.tabs.get('a.ts'), 'current buffer');
});

test('Local Folder: external change detection uses folder_version and falls back for older bridges', async () => {
  let disk = {exists: true, version: A, bytes: 1, interrupted: []};
  const {f, events} = folderWith(async command => { if (command === 'folder_version') return disk; if (command === 'folder_read') return {content: 'external text', version: B}; });
  disk = {...disk, version: B}; await f.checkExternal();
  assert.equal(f.tabs.get('a.ts'), 'external text', 'clean buffer follows the disk'); assert.ok(events.includes('save.EXTERNAL_RELOAD'));
  f.tabs.set('a.ts', 'dirty now'); disk = {...disk, version: 'c'.repeat(64)}; await f.checkExternal();
  assert.equal(f.diskFiles.get('a.ts').conflict, true); assert.equal(f.tabs.get('a.ts'), 'dirty now', 'dirty buffer is never replaced');
  disk = {exists: false, version: '', bytes: 0, interrupted: []}; await f.checkExternal();
  assert.equal(f.diskFiles.get('a.ts').missing, true); assert.ok(events.includes('save.EXTERNAL_DELETE'));
  const {f: legacy} = folderWith(async command => { if (command === 'folder_read') return {content: FIXTURE, version: A, bytes: 3}; });
  assert.deepEqual(await legacy.diskVersion('a.ts'), {exists: true, version: A, bytes: 3, content: FIXTURE, interrupted: []});
});

test('Local Folder source: artifacts stay read-only and conflicts never auto-overwrite', () => {
  const src = read('js/local-folder.js');
  assert.match(src, /interrupted-save artifacts, stay read-only/);
  assert.ok(!/folder_save[^\n]*\{[^}]*force/i.test(src), 'no forced save path');
  assert.match(src, /window\.confirm\('Your next explicit Save will replace the current disk content/);
  assert.ok(!src.includes('innerHTML = `'), 'dynamic text is never injected as HTML');
});

test('native boundary sources: new commands are registered, permissioned and main-window only', () => {
  const main = read('src-tauri/src/main.rs'), build = read('src-tauri/build.rs'), perms = read('src-tauri/permissions/local-folder.toml'), cap = JSON.parse(read('src-tauri/capabilities/main.json'));
  for (const command of ['folder_version', 'folder_restore_interrupted', 'folder_discard_interrupted', 'app_diagnostics']) { assert.ok(main.includes(command), command); assert.ok(build.includes(`"${command}"`), command); }
  assert.match(perms, /"folder_save", "folder_restore_interrupted", "folder_discard_interrupted"/);
  assert.deepEqual(cap.windows, ['main']); assert.ok(cap.permissions.includes('allow-mega07-diagnostics'));
  assert.match(main, /diagnostics::note_rejected/);
  const lf = read('src-tauri/src/local_folder.rs');
  assert.match(lf, /FileRenameInfo resolves relative names against the process working/);
  assert.match(lf, /#\[cfg\(test\)\]\s*\{\s*FAULT\.with/, 'fault injection is compiled only into tests');
});
