import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { SHELL_ASSETS, SHELL_VERSION, isOwnedShellCache, shellCacheName } from '../js/offline-shell.js';
import { shellFingerprint } from '../scripts/shell-fingerprint.mjs';

const root = new URL('../', import.meta.url);
const release = JSON.parse(readFileSync(new URL('tests/fixtures/shell-release.json', root), 'utf8'));

// Static references from index.html through every reachable module and stylesheet.
function referencedAssets() {
  const seen = new Set(), queue = ['index.html'];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(new URL(file, root), 'utf8');
    for (const [, ref] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bhref=|\bsrc=)['"]([^'"]+)['"]/g)) {
      if (/^(?:[a-z]+:|#|\/\/)/i.test(ref)) continue;
      const target = posix.normalize(posix.join(posix.dirname(file), ref)).replace(/^\//, '');
      if (/\.(?:js|css|png|webmanifest|html)$/.test(target) && existsSync(new URL(target, root))) queue.push(target);
    }
  }
  const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', root), 'utf8'));
  for (const icon of manifest.icons) seen.add(icon.src);
  return seen;
}

test('shell inventory equals the statically referenced asset graph exactly', () => {
  const graph = referencedAssets();
  assert.deepEqual([...graph].filter(a => !SHELL_ASSETS.includes(a)).sort(), [], 'referenced but not cached offline');
  assert.deepEqual(SHELL_ASSETS.filter(a => !graph.has(a)).sort(), [], 'cached but never referenced');
  assert.ok(SHELL_ASSETS.includes('js/storage/durability.js'));
});

test('shell release revision: any asset change requires a new SHELL_VERSION', () => {
  const current = shellFingerprint();
  assert.equal(release.version, SHELL_VERSION, 'tests/fixtures/shell-release.json must name the current SHELL_VERSION');
  assert.equal(current.sha256, release.sha256,
    'Shell assets changed. Bump SHELL_VERSION in js/offline-shell.js, then record `node scripts/shell-fingerprint.mjs` in tests/fixtures/shell-release.json.');
});

test('shell release revision: sw.js carries the same release so its own bytes change on every release', async () => {
  const { SW_RELEASE } = await import('../sw.js');
  assert.equal(SW_RELEASE, SHELL_VERSION, 'Update SW_RELEASE in sw.js together with SHELL_VERSION.');
});

test('shell release revision: version format stays owned and differs from the previous release', () => {
  assert.equal(isOwnedShellCache(shellCacheName('https://melly.test/', SHELL_VERSION), 'https://melly.test/'), true);
  assert.ok(release.previousVersions.length > 0);
  assert.equal(release.previousVersions.includes(SHELL_VERSION), false);
});

test('shell fingerprint is line-ending independent and ignores only the version literal', () => {
  const base = shellFingerprint();
  // The checkout itself may already mix LF and CRLF files; both conversions must agree.
  const convert = eol => asset => {
    const bytes = readFileSync(new URL(asset, root));
    return asset.endsWith('.png') ? bytes : Buffer.from(bytes.toString('utf8').replace(/\r?\n/g, eol));
  };
  assert.equal(shellFingerprint(convert('\r\n')).sha256, base.sha256);
  assert.equal(shellFingerprint(convert('\n')).sha256, base.sha256);
  const edited = shellFingerprint(asset => {
    const bytes = readFileSync(new URL(asset, root));
    return asset === 'js/editor.js' ? Buffer.concat([bytes, Buffer.from('\n// changed')]) : bytes;
  });
  assert.notEqual(edited.sha256, base.sha256);
});
