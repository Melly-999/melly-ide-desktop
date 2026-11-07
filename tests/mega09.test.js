// MEGA-09 focused tests: workspace navigation logic, layout and tab memory, runner error
// categories, Git side-by-side rows, read-only limitation detection, and source-level security
// guards (no new execution route, writable agent profiles still gated, new IPC main-window only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fuzzyScore, rankItems } from '../js/workspace/picker.js';
import { readLayout, writeLayout, clampWidth, parseLine, LAYOUT_KEY, SHORTCUTS } from '../js/workspace/commands.js';
import { rememberTabs, tabLabels, lineOffset, TABS_KEY } from '../js/local-folder.js';
import { categorize, ERROR_CATEGORIES, CommandRunner } from '../js/devcenter/runner.js';
import { splitRows, deniedActions, PROFILE_HELP, MAX_DIFF_LINES } from '../js/devcenter/ui.js';
import { isWritable, WRITABLE_GATED } from '../js/devcenter/jobs.js';
import { SHELL_ASSETS } from '../js/offline-shell.js';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
function memory(seed = {}) { const m = new Map(Object.entries(seed)); return {getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), map: m}; }
const KEY = 'a'.repeat(64);

test('fuzzy matching: subsequence only, file-name and boundary matches rank first', () => {
  assert.equal(fuzzyScore('xyz', 'src/main.ts'), null);
  assert.deepEqual(fuzzyScore('', 'a').positions, []);
  const ranked = rankItems('main', ['docs/domain-notes.md', 'src/main.ts', 'src/legacy/a/m/a/i/n.txt'], p => p).map(r => r.item);
  assert.equal(ranked[0], 'src/main.ts');
  const camel = rankItems('lf', ['js/localFolder.js', 'js/flat.js'], p => p).map(r => r.item);
  assert.equal(camel[0], 'js/localFolder.js', 'camelCase boundaries count');
  assert.deepEqual(fuzzyScore('mts', 'src/main.ts').positions.length, 3);
  assert.equal(rankItems('', ['b', 'a'], p => p, 1).length, 1, 'empty query keeps order and limit');
  const unicode = rankItems('żół', ['src/żółć 日本語.ts', 'src/other.ts'], p => p);
  assert.equal(unicode.length, 1);
});

test('layout memory is versioned, bounded and tolerant of broken storage', () => {
  const storage = memory();
  assert.deepEqual(readLayout(storage), {version: 1});
  writeLayout({explorerWidth: 333, devTab: 'git'}, storage);
  writeLayout({guideSeen: true}, storage);
  assert.deepEqual(readLayout(storage), {version: 1, explorerWidth: 333, devTab: 'git', guideSeen: true});
  storage.setItem(LAYOUT_KEY, '{broken');
  assert.deepEqual(readLayout(storage), {version: 1});
  const throwing = {getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); }};
  assert.deepEqual(readLayout(throwing), {version: 1});
  assert.doesNotThrow(() => writeLayout({explorerWidth: 1}, throwing));
  assert.equal(clampWidth(10), 200); assert.equal(clampWidth(9999), 560); assert.equal(clampWidth('x'), 280);
  assert.deepEqual(parseLine(' 12 '), {line: 12, column: 1});
  assert.deepEqual(parseLine('7:4'), {line: 7, column: 4});
  assert.equal(parseLine('abc'), null); assert.equal(parseLine('1;rm'), null);
  assert.ok(SHORTCUTS.some(([k]) => k.includes('Ctrl+P')));
});

test('tab memory stores relative paths only, per project, capped', () => {
  let store = rememberTabs(null, KEY, ['src/a.ts', 'src/a.ts', 'b.md', '', 42], 'b.md', '2026-10-29T10:00:00.000Z');
  assert.deepEqual(store.projects[KEY], {paths: ['src/a.ts', 'b.md'], active: 'b.md', at: '2026-10-29T10:00:00.000Z'});
  store = rememberTabs(store, KEY, ['x.ts'], 'missing.ts');
  assert.equal(store.projects[KEY].active, 'x.ts', 'active must be one of the tabs');
  assert.deepEqual(rememberTabs(store, 'not-a-key', ['y'], 'y').projects, store.projects, 'only native recovery keys are accepted');
  for (let i = 0; i < 20; i++) store = rememberTabs(store, i.toString(16).padStart(64, '0'), ['f'], 'f', `2026-10-29T10:${String(i).padStart(2, '0')}:00.000Z`);
  assert.equal(Object.keys(store.projects).length, 16, 'at most 16 projects remembered');
  const many = rememberTabs(null, KEY, Array.from({length: 40}, (_, i) => `f${i}`), 'f0');
  assert.equal(many.projects[KEY].paths.length, 16, 'at most 16 tabs per project');
  assert.ok(!JSON.stringify(store).includes('content'));
  assert.equal(TABS_KEY, 'melly-folder-tabs-v1');
});

test('tab labels disambiguate duplicates; line offsets clamp', () => {
  const labels = tabLabels(['src/index.js', 'test/index.js', 'README.md']);
  assert.equal(labels.get('src/index.js'), 'index.js — src');
  assert.equal(labels.get('test/index.js'), 'index.js — test');
  assert.equal(labels.get('README.md'), 'README.md');
  const text = 'one\ntwo\r\nthree';
  assert.equal(lineOffset(text, 1, 1), 0);
  assert.equal(lineOffset(text, 2, 2), 5);
  assert.equal(lineOffset(text, 3, 99), text.length);
  assert.equal(lineOffset(text, 99), text.length);
  assert.equal(lineOffset('ab\ncd', 1, 50), 2, 'column clamps to the end of its own line');
});

test('runner error categories cover refusals and outcomes; history records only the category', async () => {
  assert.equal(categorize('DENIED'), 'declined');
  for (const c of ['EXECUTABLE_REFUSED', 'ARGS_REFUSED', 'CWD_REFUSED', 'AGENT_VIA_ADAPTER', 'PROFILE_GATED']) assert.equal(categorize(c), 'policy', c);
  for (const c of ['APPROVAL_REPLAY', 'APPROVAL_EXPIRED', 'SPEC_MISMATCH', 'APPROVAL_INVALID']) assert.equal(categorize(c), 'approval', c);
  for (const c of ['DISABLED', 'BUSY', 'WORKSPACE_LOCKED', 'STALE_WORKSPACE']) assert.equal(categorize(c), 'availability', c);
  assert.equal(categorize('SPAWN_FAILED'), 'start'); assert.equal(categorize('WHATEVER'), 'other');
  assert.equal(categorize(null, 'exited', 0), null);
  assert.equal(categorize(null, 'exited', 2), 'exit');
  assert.equal(categorize(null, 'timed-out'), 'timeout');
  assert.equal(categorize(null, 'cancelled'), 'cancelled');
  assert.equal(categorize(null, 'exited', 0, false), 'tree', 'an unconfirmed tree is never a clean exit');
  for (const key of ['declined', 'policy', 'approval', 'availability', 'start', 'exit', 'timeout', 'cancelled', 'tree', 'monitor', 'other']) assert.ok(ERROR_CATEGORIES[key], key);
  // A declined native dialog is recorded with its category and without arguments.
  const storage = memory();
  const client = {available: true, async capability() { return {enabled: true}; }, async request() { throw 'DENIED: declined'; }};
  const runner = new CommandRunner({client, storage});
  await runner.refresh();
  const result = await runner.run({sessionId: 's', program: 'node', argsText: '--secret-flag\nvalue'});
  assert.equal(result.started, false);
  const history = JSON.parse(storage.getItem('melly-command-history-v1'));
  assert.equal(history.at(-1).category, 'declined');
  assert.equal(history.at(-1).argCount, 2);
  assert.ok(!JSON.stringify(history).includes('secret-flag'), 'arguments are never persisted');
  assert.deepEqual(runner.lastFailure, {code: 'DENIED', category: 'declined'});
});

test('side-by-side rows pair deletions with additions and report truncation', () => {
  const hunks = [{oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [{kind: 'ctx', text: 'a'}, {kind: 'del', text: 'b'}, {kind: 'del', text: 'c'}, {kind: 'add', text: 'B'}, {kind: 'ctx', text: 'd'}]}];
  const {rows, truncated} = splitRows(hunks);
  assert.equal(truncated, false);
  assert.deepEqual(rows.map(r => r.kind), ['hunk', 'ctx', 'change', 'change', 'ctx']);
  assert.deepEqual([rows[2].oldNo, rows[2].oldText, rows[2].newNo, rows[2].newText], [2, 'b', 2, 'B']);
  assert.deepEqual([rows[3].oldNo, rows[3].oldText, rows[3].newNo, rows[3].newText], [3, 'c', null, null]);
  assert.deepEqual([rows[4].oldNo, rows[4].newNo], [4, 3]);
  const run = [{oldStart: 1, oldLines: 0, newStart: 1, newLines: 9000, lines: Array.from({length: 9000}, (_, i) => ({kind: 'add', text: String(i)}))}];
  const cutRun = splitRows(run, 100);
  assert.equal(cutRun.truncated, true, 'one long added run is capped too'); assert.ok(cutRun.rows.length <= 100);
  const many = [{oldStart: 1, oldLines: 9000, newStart: 1, newLines: 9000, lines: Array.from({length: 9000}, (_, i) => ({kind: 'ctx', text: String(i)}))}];
  const capped = splitRows(many, 100);
  assert.equal(capped.truncated, true); assert.ok(capped.rows.length <= 100);
  assert.equal(MAX_DIFF_LINES, 5000);
});

test('read-only limitation: denied write tools are detected and never treated as granted', () => {
  assert.deepEqual(deniedActions({}), {all: [], writes: []});
  const job = {progress: {result: {denials: ['Edit', 'Bash', 'Edit', 'WebFetch']}}};
  assert.deepEqual(deniedActions(job), {all: ['Edit', 'Bash', 'WebFetch'], writes: ['Edit', 'Bash']});
  assert.match(PROFILE_HELP.edit, /Disabled \(PROFILE_GATED\)/);
  assert.match(PROFILE_HELP['workspace-write'], /Disabled \(PROFILE_GATED\)/);
  assert.match(PROFILE_HELP.plan, /Read, Glob and Grep/);
  assert.match(PROFILE_HELP['read-only'], /not confined/);
  assert.equal(isWritable('claude', 'edit'), true); assert.equal(isWritable('codex', 'workspace-write'), true);
  assert.match(WRITABLE_GATED, /disabled until the owner accepts/);
});

test('security guards: new UI code has no execution route, no HTML sinks, no writable switch', () => {
  for (const file of ['js/workspace/picker.js', 'js/workspace/commands.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|new Function|eval\(/, `${file}: no HTML/script sinks`);
    assert.doesNotMatch(src, /exec_(request|start|enable)|agent_probe|invoke\(/, `${file}: never calls the broker or native IPC directly`);
    assert.doesNotMatch(src, /allow_?writable|writableEnabled|dangerously|bypass/i, `${file}: no writable or bypass switch`);
  }
  const folder = read('js/local-folder.js');
  for (const cmd of ['folder_index', 'folder_search', 'folder_recent', 'folder_resume', 'folder_forget']) assert.match(folder, new RegExp(`'${cmd}'`), cmd);
  assert.doesNotMatch(folder, /exec_(request|start)/, 'the folder module never starts processes');
  // Writable agent profiles: only Rust tests can flip the registry flag; no command, env var or UI setting does.
  const rust = ['src-tauri/src/agent_cli.rs', 'src-tauri/src/exec_broker.rs', 'src-tauri/src/main.rs', 'src-tauri/src/local_folder.rs'].map(read).join('\n');
  assert.doesNotMatch(rust, /allow_writable\s*=\s*true/, 'no production code enables writable profiles');
  assert.doesNotMatch(rust, /env::var\([^)]*WRITABLE/i, 'no environment switch for writable profiles');
  assert.match(read('src-tauri/src/exec_broker/tests.rs'), /allow_writable = true/, 'the only switch lives in the test module');
});

test('new native commands are main-window only and read-only by contract', () => {
  const perms = read('src-tauri/permissions/local-folder.toml'), capability = JSON.parse(read('src-tauri/capabilities/main.json'));
  const block = perms.slice(perms.indexOf('allow-mega09-workspace'));
  assert.match(block, /commands\.allow = \["folder_index", "folder_search", "folder_recent", "folder_forget", "folder_resume"\]/);
  assert.deepEqual(capability.windows, ['main']);
  assert.ok(capability.permissions.includes('allow-mega09-workspace'));
  const main = read('src-tauri/src/main.rs');
  assert.match(main, /invoke_allowed\(invoke\.message\.webview_ref\(\)\.label\(\)\)/, 'the dispatcher still rejects non-main webviews');
  for (const cmd of ['workspace_index::folder_index', 'workspace_index::folder_search', 'recent::folder_recent', 'recent::folder_forget', 'local_folder::folder_resume']) assert.ok(main.includes(cmd), cmd);
  const index = read('src-tauri/src/local_folder/workspace_index.rs');
  const product = index.slice(0, index.indexOf('#[cfg(test)]'));
  assert.doesNotMatch(product, /fs::write|\.write\(true\)|remove_file|fs::rename/, 'index and search never write');
  assert.match(product, /guarded\(root, &dir\)/, 'every directory is opened through the junction-safe guard');
  const recent = read('src-tauri/src/local_folder/recent.rs');
  assert.match(recent, /pub struct Recent \{\s*key: String,\s*name: String,\s*last_opened: u64,\s*available: bool,\s*\}/, 'the renderer view carries no path');
  assert.match(read('src-tauri/src/local_folder.rs'), /fn folder_resume[\s\S]*?open_with\(window, state, Some\(start\)\)/, 'resume always goes through the Windows folder dialog');
});

test('offline shell lists the new assets', () => {
  for (const asset of ['js/workspace/picker.js', 'js/workspace/commands.js', 'styles/mega09.css']) assert.ok(SHELL_ASSETS.includes(asset), asset);
  assert.match(read('index.html'), /styles\/mega09\.css/);
});
