// MEGA-09 Chromium acceptance of the daily-driver workflow. Contexts:
//  - "browser": no native bridge (web/PWA). Desktop-only commands must explain why they are off.
//  - "mock-desktop": a MOCK Tauri bridge (top frame only) imitating the native folder, Git and
//    broker contracts. It proves renderer behaviour only; real filesystem walks, dialogs and
//    processes are covered by the Rust tests and the native WebView2 QA, not by this file.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = process.cwd(), out = process.env.MEGA09_AUDIT_DIR;
if (!out || path.resolve(out).startsWith(root + path.sep)) throw Error('Set external MEGA09_AUDIT_DIR');
fs.mkdirSync(out, {recursive: true});
const results = [];
const mime = {html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml', webmanifest: 'application/manifest+json'};
async function scenario(name, fn) {
  try { await fn(); results.push({name, status: 'PASS'}); } catch (e) { results.push({name, status: 'FAIL', error: e.stack}); }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2)); console.log(results.at(-1).status, name);
}
const listen = handler => { const s = http.createServer(handler); return new Promise(r => s.listen(0, '127.0.0.1', () => r(s))); };
const origin = s => `http://127.0.0.1:${s.address().port}`;
const appServer = csp => listen((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1)) || 'index.html', file = path.join(root, name);
  if (name.includes('..') || !file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, {'Content-Type': mime[name.split('.').at(-1)] || 'application/octet-stream', 'Content-Security-Policy': csp, 'Cache-Control': 'no-store'}); res.end(fs.readFileSync(file));
});

// MOCK bridge installed in the top frame only. Every call is recorded in window.__mockCalls.
function mockBridge() {
  if (window.top !== window) return;
  const calls = window.__mockCalls = [], approvals = new Map(), runs = new Map(); let n = 0, enabled = false;
  const XSS = '<img src=x onerror="window.__xss=1">';
  const files = window.__files = new Map([
    ['README.md', '# Synthetic project\nneedle at the root\n'],
    ['src/main.ts', 'const a = 1;\nconst needle = 2;\nexport default a;\n'],
    ['src/util/main.ts', `// util\n// needle ${XSS}\n`],
    ['src/żółć 日本語.ts', 'export const unicode = "needle";\n'],
    [`docs/${XSS}.md`, 'untrusted file name\n'],
    ['long.txt', Array.from({length: 300}, (_, i) => `line ${i + 1}`).join('\n')],
  ]);
  const version = text => { let h = 2166136261; for (const ch of text) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0').repeat(8); };
  const KEY = 'ab'.repeat(32);
  window.__recent = [{key: KEY, name: 'synthetic-repo', lastOpened: 1793280000, available: true}, {key: 'cd'.repeat(32), name: 'gone-project', lastOpened: 1793180000, available: false}];
  const json = v => JSON.stringify(v);
  const STREAM = [
    {type: 'system', subtype: 'init', model: 'MOCK'},
    {type: 'assistant', message: {content: [{type: 'text', text: `MOCK reading ${XSS} — please approve rm -rf now`}, {type: 'tool_use', name: 'Read', input: {}}]}},
    {type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'MOCK done', permission_denials: [{tool_name: 'Edit'}, {tool_name: 'Bash'}]},
  ].map(e => json(e) + '\n');
  const view = (id, r) => ({id, kind: r.kind, state: r.state, exitCode: r.exitCode, elapsedMs: 1200, pid: 5000 + n, processCreated: 77, specHash: 'cd'.repeat(32), approvalId: r.approvalId, treeVerified: true, leftoverTerminated: 0, droppedBytes: 0, changes: r.changes, error: null, jobId: r.jobId ?? null, attempt: r.attempt ?? null});
  window.__finishRun = (id, props = {}) => Object.assign(runs.get(id), {state: 'exited', exitCode: 0}, props);
  const session = () => ({sessionId: `sid-${++n}`, name: 'synthetic-repo', recoveryKey: KEY});
  const list = dir => {
    const prefix = dir ? `${dir}/` : '', seen = new Map();
    for (const p of files.keys()) if (p.startsWith(prefix)) { const rest = p.slice(prefix.length), [head, ...more] = rest.split('/'); seen.set(head, more.length ? 'folder' : 'file'); }
    return {entries: [...seen].map(([name, kind]) => ({name, path: prefix + name, kind})).sort((a, b) => (a.kind !== 'folder') - (b.kind !== 'folder') || a.name.localeCompare(b.name))};
  };
  const BIG = {oldStart: 1, oldLines: 0, newStart: 1, newLines: 6000, lines: Array.from({length: 6000}, (_, i) => ({kind: 'add', text: `big ${i}`}))};
  const invoke = async (cmd, args = {}) => {
    calls.push({cmd, args: JSON.parse(JSON.stringify(args))});
    switch (cmd) {
      case 'folder_open': return session();
      case 'folder_resume': if (!window.__recent.some(r => r.key === args.key)) throw 'NOT_FOUND: This recent folder is no longer listed. Use Open Folder.'; return session();
      case 'folder_recent': return window.__recent;
      case 'folder_forget': window.__recent = window.__recent.filter(r => r.key !== args.key); return window.__recent;
      case 'folder_list': return list(args.path);
      case 'folder_read': { if (!files.has(args.path)) throw 'Missing file or directory. Refresh the folder or select it again.'; const c = files.get(args.path); return {path: args.path, content: c, bytes: c.length, version: version(c)}; }
      case 'folder_version': { const c = files.get(args.path); return c == null ? {exists: false, version: '', bytes: 0, interrupted: []} : {exists: true, version: version(c), bytes: c.length, interrupted: []}; }
      case 'folder_save': { const c = files.get(args.path); if (version(c) !== args.expectedVersion) throw 'CONFLICT: File changed on disk.'; files.set(args.path, args.content); return {path: args.path, content: args.content, bytes: args.content.length, version: version(args.content)}; }
      case 'folder_index': return {files: [...files.keys()], directories: 4, skipped: ['node_modules', '.git'], blocked: 0};
      case 'folder_search': {
        const q = args.caseSensitive ? args.query : args.query.toLowerCase(), matches = [];
        for (const [p, c] of files) c.split('\n').forEach((line, i) => { const at = (args.caseSensitive ? line : line.toLowerCase()).indexOf(q); if (at >= 0) matches.push({path: p, line: i + 1, column: at + 1, preview: line.trim()}); });
        return {matches, filesScanned: files.size, filesSkipped: 1, directories: 4, skipped: ['node_modules']};
      }
      case 'folder_close': return null;
      case 'preview_capability': return {available: true, scripts: true};
      case 'terminal_capability': return {available: false, execution: 'disabled', approvalRequired: true, reason: 'Native terminal execution is not authorized in this build.'};
      case 'git_status': return {repository: true, rootName: 'synthetic-repo', engine: 'native-readonly', truncated: false, renames: [],
        head: {branch: 'main', detached: false, unborn: false, oid: 'a'.repeat(40), short: 'aaaaaaa', summary: 'base'}, counts: {staged: 1, unstaged: 2, untracked: 1, conflicted: 0}, notices: [],
        entries: [{path: 'src/main.ts', x: ' ', y: 'M', kind: 'modified'}, {path: 'big.txt', x: ' ', y: 'M', kind: 'modified'}, {path: 'new file ñ.txt', x: 'A', y: ' ', kind: 'added'}, {path: 'scratch.txt', x: '?', y: '?', kind: 'untracked'}]};
      case 'git_diff_summary': return args.items.map(i => ({path: i.path, staged: i.staged, additions: 2, deletions: 1, binary: false, approximate: false, error: null}));
      case 'git_diff': return {path: args.path, staged: args.staged, oldLabel: 'index', newLabel: 'working tree', binary: false, approximate: false, lossy: false,
        additions: args.path === 'big.txt' ? 6000 : 2, deletions: 1,
        hunks: args.path === 'big.txt' ? [BIG] : [{oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [{kind: 'ctx', text: 'const a = 1;'}, {kind: 'del', text: 'const needle = 1;'}, {kind: 'add', text: 'const needle = 2;'}]}, {oldStart: 9, oldLines: 0, newStart: 9, newLines: 1, lines: [{kind: 'add', text: 'tail'}]}]};
      case 'exec_capability': return {compiled: true, enabled, mode: 'approved-one-shot', interactiveShell: false, maxConcurrent: 1, activeRuns: 0, reason: enabled ? 'Enabled for this app session.' : 'Disabled. Execution starts disabled in every app session.'};
      case 'exec_enable': enabled = true; return invoke('exec_capability');
      case 'exec_disable': enabled = false; return invoke('exec_capability');
      case 'exec_set_concurrency': return invoke('exec_capability');
      case 'exec_request': {
        if (!enabled) throw 'DISABLED: Command and agent execution is disabled for this session.';
        if (window.__deny) throw 'DENIED: You declined this run in the native dialog. Nothing was started.';
        const id = `appr${++n}`, token = `tok${n}`;
        approvals.set(id, {token, request: json(args.request), used: false});
        const r = args.request;
        return {approvalId: id, token, specHash: 'cd'.repeat(32), expiresInSecs: r.kind === 'agent' ? 900 : 60,
          normalized: {executable: r.kind === 'agent' ? 'C:\\MOCK\\claude.exe' : 'C:\\MOCK\\node.exe', args: r.kind === 'agent' ? ['-p'] : r.args, cwd: r.cwd || ''}};
      }
      case 'exec_start': {
        const a = approvals.get(args.approvalId);
        if (!a || a.token !== args.token) throw 'APPROVAL_INVALID: No such approval.';
        if (a.used) throw 'APPROVAL_REPLAY: This approval was already used.';
        a.used = true;
        if (a.request !== json(args.request)) throw 'SPEC_MISMATCH: The request differs from what was approved.';
        const id = `run${++n}`, r = args.request;
        const chunks = r.kind === 'agent' ? STREAM.map((text, seq) => ({seq, stream: 'stdout', text})) : [{seq: 0, stream: 'stdout', text: 'v99.0.0-MOCK\n'}, {seq: 1, stream: 'stderr', text: 'MOCK warning on stderr\n'}];
        runs.set(id, {kind: r.kind, state: 'running', exitCode: null, approvalId: args.approvalId, chunks, jobId: r.jobId, attempt: r.attempt, changes: null});
        setTimeout(() => window.__finishRun(id), 150);
        return view(id, runs.get(id));
      }
      case 'exec_poll': { const r = runs.get(args.runId); if (!r) throw 'NOT_FOUND: No such run.'; return {run: view(args.runId, r), chunks: r.chunks.filter(c => c.seq >= args.cursor), nextCursor: r.chunks.length, missed: false}; }
      case 'exec_cancel': { const r = runs.get(args.runId); Object.assign(r, {state: 'cancelled', exitCode: 1}); return view(args.runId, r); }
      case 'exec_runs': return [];
      case 'exec_reconcile': return args.records.map(r => ({runId: r.runId, status: 'gone', run: null}));
      case 'agent_detect': return [{id: 'claude', name: 'Claude Code', state: window.__probed ? 'ready' : 'installed', executable: 'C:\\MOCK\\claude.exe', version: window.__probed ? '9.9.9' : null, profiles: window.__probed ? [{id: 'plan', label: 'Read-only plan', sourceEdits: false}, {id: 'edit', label: 'Edit files in this folder', sourceEdits: true}] : [], missing: [], notes: ['MOCK note'], writableEnabled: false},
        {id: 'codex', name: 'Codex CLI', state: 'not-installed', executable: null, profiles: [], missing: [], notes: []}];
      case 'agent_probe': if (!enabled) throw 'DISABLED: Enable execution first.'; window.__probed = true; return (await invoke('agent_detect')).find(p => p.id === args.provider);
      case 'app_diagnostics': return {product: 'MOCK', version: '0', build: 'debug', os: 'windows', arch: 'x86_64', tauri: '2', webview2: '1', runId: 'x'.repeat(32), capabilities: {}, savesOk: 0, saveFailures: {}, dispatcherRejections: {}};
    }
    throw `unknown command ${cmd}`;
  };
  window.__TAURI__ = {core: {invoke}};
}
// Counts live intervals so a long session can prove timers are released.
function timerProbe() {
  const live = window.__liveIntervals = new Set(), set = window.setInterval.bind(window), clear = window.clearInterval.bind(window);
  window.setInterval = (fn, ms, ...a) => { const id = set(fn, ms, ...a); live.add(id); return id; };
  window.clearInterval = id => { live.delete(id); return clear(id); };
}

(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
  const tauriCSP = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.security.csp;
  const server = await appServer(tauriCSP);
  const calls = (p, cmd) => p.evaluate(c => window.__mockCalls.filter(x => x.cmd === c).map(x => x.args), cmd);
  async function open(context) {
    const p = await context.newPage(), errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(origin(server)); await p.waitForFunction(() => window.AntigravityApp?.workspace?.ready && window.AntigravityApp.devCenter && window.AntigravityApp.commands);
    return {p, errors};
  }
  const noHScroll = p => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  const code = async p => { await p.locator('.primary-navigation [data-route="code"]').click(); };
  try {
    // ---------- Browser / PWA: no native bridge ----------
    for (const [width, height] of [[1920, 1080], [1366, 768], [390, 844]]) {
      const context = await browser.newContext({viewport: {width, height}});
      const {p, errors} = await open(context);
      await scenario(`browser ${width}x${height}: palette explains desktop-only commands; guide is keyboard-accessible; no horizontal scroll`, async () => {
        await code(p);
        if (width < 1100) await p.locator('#explorerToggle').click(); // the card lives in Files & projects
        assert.ok(await p.locator('#gettingStartedCard').isVisible(), 'first-run card is shown, non-modal');
        await p.keyboard.press('Control+Shift+P');
        await p.waitForSelector('.picker[open] [role="combobox"]');
        assert.equal(await p.evaluate(() => document.activeElement.getAttribute('role')), 'combobox');
        await p.keyboard.type('go to file');
        const option = p.locator('.picker[open] [role="option"]').first();
        assert.equal(await option.getAttribute('aria-disabled'), 'true');
        assert.match(await option.innerText(), /needs the Windows desktop app/);
        await p.keyboard.press('Enter');
        assert.ok(await p.locator('.picker[open]').count(), 'a disabled command keeps the palette open');
        assert.match(await p.locator('.picker[open] .picker-status').innerText(), /unavailable/);
        await p.keyboard.press('Escape');
        assert.equal(await p.locator('.picker[open]').count(), 0);
        await p.locator('#gettingStartedOpen').click();
        await p.waitForSelector('#gettingStarted[open]');
        assert.equal(await p.evaluate(() => document.activeElement.id), 'guideTitle');
        assert.match(await p.locator('#gettingStarted').innerText(), /browser or the installed web app[\s\S]*never routed to a cloud service/);
        await p.keyboard.press('Escape');
        await p.waitForFunction(() => !document.getElementById('gettingStartedCard'), null, {timeout: 3000});
        assert.equal(await noHScroll(p), true, 'no horizontal scroll');
        await p.screenshot({path: path.join(out, `browser-code-${width}.png`)});
        await p.reload(); await p.waitForFunction(() => window.AntigravityApp?.commands);
        assert.equal(await p.locator('#gettingStartedCard').count(), 0, 'dismissal persists across reloads');
        assert.deepEqual(errors, []);
      });
      await context.close();
    }

    // ---------- MOCK desktop ----------
    const context = await browser.newContext({viewport: {width: 1366, height: 768}, acceptDownloads: true});
    await context.addInitScript(timerProbe); await context.addInitScript(mockBridge);
    const {p, errors} = await open(context);

    await scenario('mock-desktop: recent folders show name and time only; Resume goes through the native dialog command; Forget removes', async () => {
      await code(p);
      await p.waitForSelector('#localRecent li');
      const text = await p.locator('#localRecent').innerText();
      assert.match(text, /synthetic-repo/); assert.match(text, /gone-project[\s\S]*not found on this device/);
      assert.doesNotMatch(text, /[A-Z]:\\/, 'no path is shown');
      const gone = `#localRecent li[data-recent="${'cd'.repeat(32)}"]`;
      assert.equal(await p.locator(`${gone} [data-recent-action="resume"]`).isDisabled(), true);
      await p.locator(`${gone} [data-recent-action="forget"]`).click();
      await p.waitForFunction(() => document.querySelectorAll('#localRecent li').length === 1);
      assert.equal((await calls(p, 'folder_forget')).length, 1);
      await p.locator(`#localRecent li[data-recent="${'ab'.repeat(32)}"] [data-recent-action="resume"]`).click();
      await p.waitForFunction(() => window.AntigravityApp.localFolder.session);
      assert.deepEqual((await calls(p, 'folder_resume')).map(a => a.key), ['ab'.repeat(32)]);
      assert.equal(await p.locator('#localRecent').isHidden(), true, 'recent list hides while a folder is open');
      assert.equal(await p.locator('#localFolderNav').isVisible(), true);
    });

    await scenario('mock-desktop: Go to File (Ctrl+P) fuzzy-ranks the bounded native index and opens the file; tabs show identity', async () => {
      await p.keyboard.press('Control+P');
      await p.waitForSelector('.picker[open] [role="option"]');
      assert.match(await p.locator('.picker[open] .picker-status').innerText(), /6 files indexed · skipped node_modules, \.git/);
      await p.keyboard.type('srcmain');
      await p.waitForFunction(() => document.querySelector('.picker[open] [role="option"]')?.textContent.startsWith('src/main.ts'));
      assert.equal(await p.evaluate(() => document.querySelector('.picker[open] [role="combobox"]').getAttribute('aria-activedescendant')), await p.locator('.picker[open] [role="option"]').first().getAttribute('id'));
      await p.keyboard.press('Enter');
      await p.waitForFunction(() => window.AntigravityApp.localFolder.activePath === 'src/main.ts');
      await p.waitForFunction(() => document.activeElement.classList.contains('editor-textarea'));
      assert.equal((await p.locator('#folderPreviewEditor .tab-btn.active').innerText()).trim(), 'main.ts');
      assert.equal(await p.locator('#folderPreviewEditor .tab-btn.active').getAttribute('title'), 'src/main.ts');
      assert.match(await p.locator('#folderEditorPath').innerText(), /synthetic-repo › src › main\.ts/);
      assert.equal(await p.locator('[data-close-tab="src/main.ts"]').getAttribute('aria-label'), 'Close src/main.ts');
      // The untrusted file name is listed as text and never executed.
      await p.keyboard.press('Control+P'); await p.waitForSelector('.picker[open]'); await p.keyboard.type('docs');
      await p.waitForFunction(() => [...document.querySelectorAll('.picker[open] [role="option"]')].some(o => o.textContent.includes('<img')));
      await p.keyboard.press('Escape');
      assert.equal(await p.evaluate(() => window.__xss), undefined);
    });

    await scenario('mock-desktop: Find in Files renders untrusted lines as text and jumps to the match line', async () => {
      await p.keyboard.press('Control+Shift+F');
      await p.waitForSelector('#findInFiles[open]');
      await p.fill('#findQuery', 'needle'); await p.keyboard.press('Enter');
      await p.waitForFunction(() => document.querySelectorAll('#findResults .find-hit').length >= 4);
      assert.match(await p.locator('#findStatus').innerText(), /match\(es\) in 4 file\(s\)[\s\S]*folders not searched: node_modules/);
      assert.equal(await p.evaluate(() => window.__xss), undefined, 'match previews are inert text');
      assert.equal(await p.locator('#findResults img').count(), 0);
      await p.locator('#findQuery').focus(); await p.keyboard.press('ArrowDown');
      assert.equal(await p.evaluate(() => document.activeElement.classList.contains('find-hit')), true, 'arrow keys move into results');
      await p.locator('#findResults .find-hit[data-path="src/main.ts"]').click();
      await p.waitForFunction(() => window.AntigravityApp.localFolder.activePath === 'src/main.ts' && !document.querySelector('#findInFiles[open]'));
      const caret = await p.evaluate(() => { const t = document.querySelector('#folderPreviewEditor .editor-textarea'); return t.value.slice(0, t.selectionStart).split('\n').length; });
      assert.equal(caret, 2, 'caret is on the matching line');
    });

    await scenario('mock-desktop: Go to Line (Ctrl+G) clamps to the file and moves the caret', async () => {
      await p.evaluate(() => window.AntigravityApp.localFolder.openFile('long.txt'));
      await p.keyboard.press('Control+G'); await p.waitForSelector('.picker[open]');
      await p.keyboard.type('120'); await p.waitForSelector('.picker[open] [role="option"]'); await p.keyboard.press('Enter');
      await p.waitForFunction(() => { const t = document.querySelector('#folderPreviewEditor .editor-textarea'); return t && t.value.slice(0, t.selectionStart).split('\n').length === 120; });
    });

    await scenario('mock-desktop: closing a dirty tab asks; Cancel keeps it, Keep moves the buffer to recovery, nothing is saved', async () => {
      await p.evaluate(() => window.AntigravityApp.localFolder.openFile('README.md'));
      await p.locator('#folderPreviewEditor .editor-textarea').click(); await p.keyboard.press('Control+End'); await p.keyboard.type(' edited');
      await p.waitForFunction(() => window.AntigravityApp.localFolder.isDirty('README.md'));
      await p.locator('[data-close-tab="README.md"]').click();
      await p.waitForSelector('#closeTabDialog[open]');
      assert.equal(await p.evaluate(() => document.activeElement.id), 'closeTabSave');
      assert.match(await p.locator('#closeTabDialog').innerText(), /Nothing is discarded/);
      await p.locator('#closeTabCancel').click();
      assert.ok(await p.evaluate(() => window.AntigravityApp.localFolder.tabs.has('README.md')), 'Cancel keeps the tab');
      await p.locator('[data-close-tab="README.md"]').click(); await p.waitForSelector('#closeTabDialog[open]');
      await p.locator('#closeTabKeep').click();
      await p.waitForFunction(() => !window.AntigravityApp.localFolder.tabs.has('README.md'));
      await p.waitForSelector('#localRecoveryPanel li[data-recovery-path="README.md"]');
      assert.equal((await calls(p, 'folder_save')).length, 0, 'Keep never writes to disk');
      assert.equal(await p.evaluate(() => window.__files.get('README.md')), '# Synthetic project\nneedle at the root\n');
    });

    await scenario('mock-desktop: Save and close writes once through explicit save with the base version; Ctrl+W closes a clean tab', async () => {
      await p.evaluate(() => window.AntigravityApp.localFolder.openFile('src/util/main.ts'));
      await p.locator('#folderPreviewEditor .editor-textarea').click(); await p.keyboard.press('Control+End'); await p.keyboard.type('// saved\n');
      await p.locator('[data-close-tab="src/util/main.ts"]').click(); await p.waitForSelector('#closeTabDialog[open]');
      await p.locator('#closeTabSave').click();
      await p.waitForFunction(() => !window.AntigravityApp.localFolder.tabs.has('src/util/main.ts'));
      const saves = await calls(p, 'folder_save');
      assert.equal(saves.length, 1); assert.equal(saves[0].path, 'src/util/main.ts'); assert.match(saves[0].expectedVersion, /^[0-9a-f]{64}$/);
      assert.ok((await p.evaluate(() => window.__files.get('src/util/main.ts'))).endsWith('// saved\n'));
      const before = await p.evaluate(() => window.AntigravityApp.localFolder.tabs.size);
      await p.locator('#folderPreviewEditor .editor-textarea').click(); await p.keyboard.press('Control+W');
      await p.waitForFunction(n => window.AntigravityApp.localFolder.tabs.size === n - 1, before);
      assert.equal(await p.locator('#closeTabDialog[open]').count(), 0, 'a clean tab closes without a dialog');
    });

    await scenario('mock-desktop: layout splitter is keyboard-resizable and persists with tabs and the Dev Center tool across reload', async () => {
      const splitter = p.locator('.explorer-splitter');
      await splitter.focus(); await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight');
      const width = Number(await splitter.getAttribute('aria-valuenow'));
      assert.ok(width >= 200 && width <= 560);
      assert.equal(await p.evaluate(() => document.getElementById('viewStudio').dataset.explorerWidth), String(width));
      await p.locator('.primary-navigation [data-route="devcenter"]').click(); await p.locator('#devTab-git').click();
      const tabs = await p.evaluate(() => [...window.AntigravityApp.localFolder.tabs.keys()]);
      await p.reload(); await p.waitForFunction(() => window.AntigravityApp?.commands);
      assert.equal(await p.evaluate(() => document.getElementById('viewStudio').dataset.explorerWidth), String(width), 'width restored');
      assert.equal(await p.evaluate(() => window.AntigravityApp.devCenter.tab), 'git', 'Dev Center tool restored');
      assert.equal(await p.evaluate(() => window.AntigravityApp.localFolder.session), null, 'a restart never reopens a folder by itself');
      await code(p);
      const resume = p.locator(`#localRecent li[data-recent="${'ab'.repeat(32)}"] [data-recent-action="resume"]`);
      await resume.waitFor(); await resume.click();
      await p.waitForFunction(n => window.AntigravityApp.localFolder.tabs.size === n, tabs.length);
      assert.deepEqual(await p.evaluate(() => [...window.AntigravityApp.localFolder.tabs.keys()]), tabs, 'tabs restored after the person confirms the folder');
      assert.match(await p.locator('#localFolderStatus').innerText(), /Restored \d tab\(s\)/);
      assert.equal(await noHScroll(p), true);
      await p.screenshot({path: path.join(out, 'mock-desktop-code-1366.png')});
    });

    await scenario('mock-desktop: Git review filters, totals, side-by-side diff, large-diff truncation and refresh after save', async () => {
      await p.locator('.primary-navigation [data-route="devcenter"]').click(); await p.locator('#devTab-git').click();
      await p.locator('#gitRefresh').click();
      await p.waitForSelector('#gitBody .git-entries li[data-path="src/main.ts"]');
      await p.waitForFunction(() => /\+\d+ −\d+/.test(document.querySelector('#gitBody section[aria-label="Not staged"] h2')?.textContent || ''));
      assert.match(await p.locator('#gitBody').innerText(), /new file ñ\.txt/);
      await p.fill('#gitFilter', 'ñ');
      assert.equal(await p.locator('#gitBody .git-entries li[data-path]:visible').count(), 1);
      assert.match(await p.locator('#gitFilterNote').innerText(), /Showing 1 of 4/);
      await p.fill('#gitFilter', '');
      await p.locator('[data-git-diff="src/main.ts"]').click();
      await p.waitForSelector('#gitDiff .hunk');
      await p.locator('#gitDiffMode').click();
      await p.waitForSelector('#gitSplit table');
      assert.equal(await p.locator('#gitDiffMode').getAttribute('aria-pressed'), 'true');
      assert.match(await p.locator('#gitSplit thead').innerText(), /Before · index[\s\S]*After · working tree/);
      assert.equal(await p.locator('#gitSplit td.git-code.del').first().innerText(), 'const needle = 1;');
      assert.equal(await p.locator('#gitSplit td.git-code.add').first().innerText(), 'const needle = 2;');
      await p.locator('#gitSplit').focus(); await p.keyboard.press('n');
      assert.match(await p.locator('#gitHunkLabel').innerText(), /Hunk 1 of 2/);
      await p.locator('[data-git-diff="big.txt"]').click();
      await p.waitForFunction(() => !document.getElementById('gitDiffNote').hidden);
      assert.match(await p.locator('#gitDiffNote').innerText(), /only the first 5000 of \d+ lines are rendered/);
      assert.ok(await p.locator('#gitSplit tbody tr').count() <= 5001);
      const before = (await calls(p, 'git_status')).length;
      await p.evaluate(() => document.dispatchEvent(new Event('melly:disk-saved')));
      await p.waitForFunction(n => window.__mockCalls.filter(c => c.cmd === 'git_status').length > n, before, {timeout: 5000});
      await p.waitForFunction(() => !document.getElementById('gitSplit').hidden, null, {timeout: 5000});
      assert.equal(await p.locator('#gitDiffMode').getAttribute('aria-pressed'), 'true', 'the open diff and its view survive the refresh');
      for (const forbidden of ['git_add', 'git_commit', 'git_checkout', 'git_reset', 'git_stash', 'git_push', 'git_pull']) assert.equal((await calls(p, forbidden)).length, 0, forbidden);
    });

    await scenario('mock-desktop: runner previews the exact argument array, categorizes a declined run, separates streams and shows tree evidence', async () => {
      await p.locator('#devTab-terminal').click();
      await p.locator('#runnerEnable').click();
      await p.waitForFunction(() => document.getElementById('runnerCapability').textContent.startsWith('ENABLED'));
      await p.locator('#runnerExample').click();
      assert.deepEqual(await p.locator('#runnerPreview li code').allInnerTexts(), ['node', '--version']);
      assert.equal((await calls(p, 'exec_request')).length, 0, 'loading the example runs nothing');
      await p.fill('#runnerArgs', '--eval\nconsole.log("a b")  ');
      assert.deepEqual(await p.locator('#runnerPreview li code').allInnerTexts(), ['node', '--eval', 'console.log("a b")  '], 'arguments are shown exactly, unsplit');
      await p.evaluate(() => { window.__deny = true; });
      await p.locator('#runnerRun').click();
      await p.waitForFunction(() => /Declined in the Windows dialog/.test(document.getElementById('runnerHistory').textContent));
      assert.equal((await calls(p, 'exec_start')).length, 0, 'a declined dialog starts nothing');
      await p.evaluate(() => { window.__deny = false; });
      await p.fill('#runnerArgs', '--version');
      await p.locator('#runnerRun').click();
      await p.waitForFunction(() => !document.getElementById('runnerLast').hidden && /exited/.test(document.getElementById('runnerLast').textContent));
      const last = await p.locator('#runnerLast').innerText();
      assert.match(last, /clean exit/); assert.match(last, /confirmed stopped/);
      assert.equal(await p.locator('#runnerOutput .stream-stderr').count(), 1);
      await p.selectOption('#runnerStream', 'stderr');
      assert.doesNotMatch(await p.locator('#runnerOutput').innerText(), /v99\.0\.0-MOCK/);
      assert.match(await p.locator('#runnerOutput').innerText(), /stderr │ MOCK warning/);
      await p.selectOption('#runnerStream', 'all');
      const starts = await calls(p, 'exec_start');
      assert.equal(starts.length, 1); assert.deepEqual(starts[0].request.args, ['--version']);
      await p.locator('#runnerCard details summary').click();
      await p.locator('#runnerHistory .runner-reuse').first().click();
      assert.equal(await p.inputValue('#runnerProgram'), 'node'); assert.equal(await p.inputValue('#runnerArgs'), '', 'arguments are not restored from history');
      assert.equal((await calls(p, 'exec_request')).length, 2, 'reuse never requests approval by itself');
    });

    await scenario('mock-desktop: Agent Control Center checklist, effective profile, gated writable profile and read-only limitation', async () => {
      await p.locator('#devTab-agents').click();
      await p.waitForSelector('#agentChecklist');
      const checklist = await p.locator('#agentChecklist').innerText();
      assert.match(checklist, /Use the Windows desktop app[\s\S]*Done/); assert.match(checklist, /Check the CLI[\s\S]*Not yet/);
      await p.locator('#agentProbe-claude').click();
      await p.waitForFunction(() => /READY/.test(document.getElementById('agentProviders').textContent));
      assert.match(await p.locator('#jobProfileHelp').innerText(), /Read, Glob and Grep/);
      assert.equal(await p.locator('#jobProfile option[value="edit"]').getAttribute('disabled'), '', 'writable profile stays disabled');
      await p.fill('#jobTitle', 'MEGA09 mock job'); await p.fill('#jobInstructions', 'List files. Do not modify anything.');
      await p.locator('#jobCreate').click();
      await p.locator('#jobRun').click();
      await p.waitForFunction(() => /completed/.test(document.getElementById('jobDetail').textContent), null, {timeout: 10000});
      await p.waitForSelector('#jobLimitation');
      assert.match(await p.locator('#jobLimitation').innerText(), /Denied: Edit, Bash[\s\S]*never raises permissions/);
      assert.equal(await p.locator('#agentChecklist').count(), 0, 'checklist is only the empty state');
      assert.equal(await p.evaluate(() => window.__xss), undefined, 'agent output is inert text');
      const agentStarts = (await calls(p, 'exec_start')).filter(c => c.request.kind === 'agent');
      assert.equal(agentStarts.length, 1); assert.equal(agentStarts[0].request.profile, 'plan');
    });

    await scenario('mock-desktop: Diagnostics shows session facts and exports them without names, paths or task text', async () => {
      await p.locator('#devTab-diagnostics').click(); await p.locator('#diagRefresh').click();
      await p.waitForFunction(() => /Execution broker/.test(document.getElementById('diagIdentity').textContent));
      const facts = await p.locator('#diagIdentity').innerText();
      assert.match(facts, /enabled for this session/); assert.match(facts, /id abababab \(hash, not the path\)/); assert.match(facts, /never resumed automatically/);
      assert.doesNotMatch(facts, /synthetic-repo/);
      const [download] = await Promise.all([p.waitForEvent('download'), p.locator('#diagExport').click()]);
      const report = fs.readFileSync(await download.path(), 'utf8');
      fs.writeFileSync(path.join(out, 'diagnostics-export.json'), report);
      const parsed = JSON.parse(report);
      assert.equal(parsed.session.execution, 'enabled'); assert.equal(parsed.session.workspace.id, 'abababab'); assert.equal(parsed.session.recovery.autoResume, false);
      for (const leak of ['synthetic-repo', 'List files', 'MEGA09 mock job', 'MOCK\\\\', 'needle', '--version']) assert.ok(!report.includes(leak), `export must not contain ${leak}`);
    });

    await scenario('mock-desktop: long session — 12 folder open/close cycles release timers, dialogs and state', async () => {
      await code(p);
      const baseline = await p.evaluate(() => ({intervals: window.__liveIntervals.size, dialogs: document.querySelectorAll('dialog').length}));
      const closesBefore = (await calls(p, 'folder_close')).length;
      for (let i = 0; i < 12; i++) {
        await p.evaluate(async () => { const f = window.AntigravityApp.localFolder; if (f.session) await f.close(); });
        await p.evaluate(async () => { await window.AntigravityApp.localFolder.open(); });
        await p.evaluate(async () => { const f = window.AntigravityApp.localFolder; await f.fileIndex(); await f.openFile('src/main.ts'); });
      }
      const after = await p.evaluate(() => ({intervals: window.__liveIntervals.size, dialogs: document.querySelectorAll('dialog').length, index: window.AntigravityApp.localFolder.index?.generation === window.AntigravityApp.localFolder.generation}));
      assert.equal(after.dialogs, baseline.dialogs, 'no dialog leaks');
      assert.ok(after.intervals <= baseline.intervals + 1, `intervals stay bounded (${baseline.intervals} → ${after.intervals})`);
      assert.equal(after.index, true, 'the file index belongs to the current session only');
      assert.equal((await calls(p, 'folder_close')).length - closesBefore, 12, 'every cycle closed its native session');
      assert.deepEqual(errors, [], 'no page errors during the session');
    });

    await scenario('mock-desktop: accessibility — dialogs are labelled, buttons are named, focus returns after Escape', async () => {
      const unnamed = await p.evaluate(() => [...document.querySelectorAll('button')].filter(b => b.offsetParent && !(b.getAttribute('aria-label') || b.textContent.trim() || b.title)).map(b => b.outerHTML.slice(0, 80)));
      assert.deepEqual(unnamed, []);
      // Every dialog declares a label; dialogs that build their title on open are checked while open.
      const declared = await p.evaluate(() => [...document.querySelectorAll('dialog')].filter(d => !d.getAttribute('aria-labelledby') && !d.getAttribute('aria-label')).map(d => d.id || d.className));
      assert.deepEqual(declared, []);
      await p.locator('[data-close-tab]').first().waitFor();
      await p.evaluate(() => window.AntigravityApp.localFolder.tabs.set('src/main.ts', 'dirty for label check'));
      await p.locator('[data-close-tab="src/main.ts"]').click(); await p.waitForSelector('#closeTabDialog[open]');
      assert.match(await p.evaluate(() => document.getElementById(document.getElementById('closeTabDialog').getAttribute('aria-labelledby')).textContent), /unsaved changes/);
      await p.keyboard.press('Escape');
      for (const picker of await p.locator('dialog.picker').all()) assert.ok(await picker.evaluate(d => document.getElementById(d.getAttribute('aria-labelledby'))?.textContent.trim()), 'pickers are always labelled');
      await p.locator('#commandPaletteOpen').focus(); await p.keyboard.press('Enter');
      await p.waitForSelector('.picker[open]'); await p.keyboard.press('Escape');
      assert.equal(await p.evaluate(() => document.activeElement.id), 'commandPaletteOpen', 'focus returns to the opener');
      await p.emulateMedia({reducedMotion: 'reduce'});
      assert.equal(await p.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    });
    await context.close();
  } finally {
    await browser.close(); server.close();
    const failed = results.filter(r => r.status === 'FAIL').length;
    console.log(`${results.length - failed}/${results.length} MEGA-09 browser scenarios passed`);
    process.exitCode = failed ? 1 : 0;
  }
})();
