import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeEntry, groupEntries, unifiedDiff, headLabel, GitClient, GIT_UNAVAILABLE } from '../js/devcenter/git.js';

const entries = [
  {path: 'a.txt', x: ' ', y: 'M', kind: 'modified'}, {path: 'c.txt', x: 'M', y: 'M', kind: 'modified'},
  {path: 'd.txt', x: 'A', y: ' ', kind: 'added'}, {path: 'b.txt', x: ' ', y: 'D', kind: 'deleted'},
  {path: 'u.txt', x: '?', y: '?', kind: 'untracked'}, {path: 'nested/', x: '?', y: '?', kind: 'nested-repository'},
  {path: 'm.txt', x: 'U', y: 'U', kind: 'conflicted'}
];

test('entries are grouped and described like porcelain XY codes', () => {
  const g = groupEntries(entries);
  assert.deepEqual(g.staged.map(e => e.path), ['c.txt', 'd.txt']);
  assert.deepEqual(g.unstaged.map(e => e.path), ['a.txt', 'c.txt', 'b.txt']);
  assert.deepEqual(g.untracked.map(e => e.path), ['u.txt', 'nested/']);
  assert.deepEqual(g.conflicted.map(e => e.path), ['m.txt']);
  assert.equal(describeEntry(entries[1]), 'modified · staged, modified · not staged');
  assert.equal(describeEntry(entries[5]), 'Nested repository · not inspected');
  assert.match(describeEntry(entries[6]), /Conflicted/);
});

test('unified diff rendering, binary and head labels', () => {
  const diff = {path: 'a.txt', oldLabel: 'index', newLabel: 'working tree', binary: false, approximate: false, additions: 2, deletions: 1,
    hunks: [{oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [{kind: 'context', text: 'one'}, {kind: 'del', text: 'two\r'}, {kind: 'add', text: 'TWO'}, {kind: 'context', text: 'three'}, {kind: 'add', text: 'four'}]}]};
  assert.equal(unifiedDiff(diff), '--- a/a.txt (index)\n+++ b/a.txt (working tree)\n@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n three\n+four');
  assert.equal(unifiedDiff({...diff, binary: true}), 'Binary files differ: a.txt');
  assert.equal(unifiedDiff({...diff, hunks: []}), 'No textual changes.');
  assert.equal(headLabel({branch: 'main', short: 'abc1234'}), 'main @ abc1234');
  assert.equal(headLabel({detached: true, short: 'abc1234'}), 'Detached HEAD at abc1234');
  assert.equal(headLabel({branch: 'main', unborn: true}), 'main · no commits yet');
});

test('client: browser unavailable, desktop uses fixed read-only commands', async () => {
  await assert.rejects(new GitClient(undefined).status('s'), new RegExp(GIT_UNAVAILABLE.slice(0, 20)));
  const calls = [];
  const client = new GitClient(async (cmd, args) => { calls.push([cmd, args]); return {}; });
  await client.status('sid'); await client.diff('sid', 'src/a.js', 1);
  assert.deepEqual(calls, [['git_status', {sessionId: 'sid'}], ['git_diff', {sessionId: 'sid', path: 'src/a.js', staged: true}]]);
});

test('native permission grants only read-only Dev Center commands; no git mutation command exists', () => {
  const toml = readFileSync(new URL('../src-tauri/permissions/mega04.toml', import.meta.url), 'utf8');
  const allowed = JSON.parse(toml.match(/commands\.allow = (\[.*\])/)[1]);
  assert.deepEqual(allowed, ['git_status', 'git_diff', 'preview_capability', 'preview_mount_files', 'preview_mount_folder', 'preview_open', 'preview_resize', 'preview_close', 'preview_events', 'terminal_capability', 'terminal_start']);
  const main = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /git_(commit|push|pull|checkout|reset|clean|stash|merge|add|stage)/);
  const rust = readFileSync(new URL('../src-tauri/src/git_inspect.rs', import.meta.url), 'utf8').split('mod tests')[0];
  assert.doesNotMatch(rust, /Command::new|std::process|fs::write|create_dir|remove_file|OpenOptions/);
});
