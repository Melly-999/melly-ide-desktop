import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildStaticDocument, cleanEvents, htmlEntries, PreviewRuntime, STATIC_CSP, STATIC_SANDBOX } from '../js/devcenter/preview.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('entry discovery prefers index.html and skips hidden paths', () => {
  assert.deepEqual(htmlEntries(['b/x.html', 'about.HTM', 'index.html', '.git/a.html', 'src/.hidden/b.html', 'app.js']), ['index.html', 'about.HTM', 'b/x.html']);
});

test('browser static document: scripts removed, local styles inlined, CSP injected, no remote fetch', () => {
  const files = {
    'site/index.html': '<!doctype html><html><head><title>T</title><link rel="stylesheet" href="css/a.css"><link rel="stylesheet" href="https://cdn.example/x.css"><link rel="preload" href="big.js"></head><body><script>parent.document.title="pwned"</script><script src="app.js"></script><img src="logo.svg"><img src="https://tracker.example/p.png"><p>Hi</p></body></html>',
    'site/css/a.css': 'p{color:red}</style><b>breakout</b>',
    'site/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'site/app.js': 'alert(1)'
  };
  const out = buildStaticDocument(files, 'site/index.html');
  assert.equal(out.scriptsRemoved, 2); assert.equal(out.missingStyles, 1);
  assert.doesNotMatch(out.html, /<script\b/i);
  assert.match(out.html, /<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:/);
  assert.match(out.html, /<style>p\{color:red\}<\\\/style>/);
  assert.doesNotMatch(out.html, /cdn\.example|big\.js/);
  assert.match(out.html, /src="data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  assert.match(out.html, /tracker\.example/, 'remote <img> stays but STATIC_CSP img-src data: blocks it');
  assert.ok(STATIC_CSP.includes("default-src 'none'") && !STATIC_CSP.includes('script-src'));
  assert.throws(() => buildStaticDocument(files, 'missing.html'), /not in the project/);
  assert.equal(buildStaticDocument({'a.html': '<link rel="stylesheet" href=".env">', '.env': 'SECRET_VALUE'}, 'a.html').html.includes('SECRET_VALUE'), false);
  assert.equal(STATIC_SANDBOX, '', 'browser static frame is fully inert');
});

test('native events are reduced to a known, bounded text-only shape', () => {
  const events = cleanEvents([{kind: 'error', text: 'x'.repeat(900)}, {kind: 'invoke', text: 'folder_list'}, {kind: 'missing', text: {}}, null, {kind: 'refused', text: '.env'}]);
  assert.deepEqual(events.map(e => [e.kind, e.text.length]), [['error', 300], ['refused', 4]]);
  assert.deepEqual(cleanEvents('nope'), []);
});

test('desktop runtime: mounts, opens the isolated window, polls events, closes', async () => {
  const calls = [];
  const invoke = async (cmd, args) => { calls.push([cmd, args]); if (cmd === 'preview_capability') return {available: true}; if (cmd.startsWith('preview_mount')) return {token: `t${calls.length}`, url: 'http://melly-preview.localhost/t/index.html', origin: 'http://melly-preview.localhost', entry: 'index.html', source: 'workspace-files'}; if (cmd === 'preview_events') return [{kind: 'ready', text: 'T'}, {kind: 'bogus', text: 'x'}]; return null; };
  const runtime = new PreviewRuntime({invoke});
  assert.equal(runtime.mode, 'desktop-window');
  assert.equal((await runtime.capability()).scripts, true);
  const first = await runtime.startWorkspace({'index.html': '<p>x</p>', 'bin': new Uint8Array(1)}, 'index.html', 390);
  assert.equal(first.mode, 'window');
  assert.deepEqual(calls[1], ['preview_mount_files', {files: [{path: 'index.html', content: '<p>x</p>'}], entry: 'index.html'}]);
  assert.deepEqual(calls[2], ['preview_open', {token: 't2', width: 390}]);
  assert.deepEqual(await runtime.events(), [{kind: 'ready', text: 'T'}]);
  await runtime.resize(768);
  await runtime.startFolder('session-1', 'index.html');
  assert.deepEqual(calls.slice(5).map(c => c[0]), ['preview_mount_folder', 'preview_open']);
  assert.deepEqual(calls[5][1], {sessionId: 'session-1', entry: 'index.html'});
  await runtime.stop();
  assert.equal(calls.at(-1)[0], 'preview_close');
  assert.ok(!calls.some(c => c[0] === 'preview_unmount'));
  const browser = new PreviewRuntime({invoke: undefined});
  assert.equal((await browser.capability()).scripts, false);
  assert.equal((await browser.startWorkspace({'index.html': '<p>x</p>'}, 'index.html')).mode, 'static');
  await assert.rejects(browser.startFolder('s', 'index.html'), /Windows desktop/);
});

test('architecture: main window never frames preview; preview window has no capability; IPC guarded by label', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.doesNotMatch(conf.app.security.csp, /frame-src|melly-preview/, 'main window CSP must not allow framing preview content');
  assert.deepEqual(conf.app.security.capabilities, ['main']);
  const capability = JSON.parse(read('src-tauri/capabilities/main.json'));
  assert.deepEqual(capability.windows, ['main']);
  assert.equal(capability.webviews, undefined); assert.equal(capability.remote, undefined);
  const rust = read('src-tauri/src/preview.rs');
  for (const directive of ["connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "default-src 'none'", "frame-ancestors 'none'", 'sandbox allow-scripts']) assert.ok(rust.includes(directive), directive);
  assert.match(rust, /ctx\.webview_label\(\) != WINDOW/, 'protocol serves only the preview window');
  assert.match(rust, /\.on_navigation\(\|url\| is_preview_url/); assert.match(rust, /NewWindowResponse::Deny/);
  const main = read('src-tauri/src/main.rs');
  assert.match(main, /if !invoke_allowed\(invoke\.message\.webview_ref\(\)\.label\(\)\)/);
  assert.match(main, /webview_label == "main"/);
  const ui = read('js/devcenter/ui.js');
  assert.doesNotMatch(ui, /addEventListener\('message'|postMessage|allow-scripts/, 'no messaging channel or scripted iframe in the main window');
});
