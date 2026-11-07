// MEGA-04 Chromium acceptance. Two contexts:
//  - "browser": real web CSP (authCSP), no native bridge — static preview, gated surfaces.
//  - "mock-desktop": MOCK Tauri bridge (top frame only) + a real cross-origin preview server
//    sending the Rust preview CSP. Proves sandbox/CSP/postMessage behaviour in Chromium.
//    Real WebView2 + melly-preview protocol isolation is verified separately (native QA).
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const root = process.cwd(), out = process.env.MEGA04_AUDIT_DIR;
if (!out || path.resolve(out).startsWith(root + path.sep)) throw Error('Set external MEGA04_AUDIT_DIR');
fs.mkdirSync(out, {recursive: true});
const results = [], delay = ms => new Promise(r => setTimeout(r, ms));
const mime = {html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml', webmanifest: 'application/manifest+json', txt: 'text/plain'};
async function scenario(name, fn) {
  try { await fn(); results.push({name, status: 'PASS'}); } catch (e) { results.push({name, status: 'FAIL', error: e.stack}); }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2)); console.log(results.at(-1).status, name);
}
function listen(handler) { const s = http.createServer(handler); return new Promise(r => s.listen(0, '127.0.0.1', () => r(s))); }
const origin = s => `http://127.0.0.1:${s.address().port}`;
function appServer(csp) {
  return listen((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1)) || 'index.html';
    const file = path.join(root, name);
    if (name.includes('..') || !file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, {'Content-Type': mime[name.split('.').at(-1)] || 'application/octet-stream', 'Content-Security-Policy': csp(), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store'});
    res.end(fs.readFileSync(file));
  });
}
const trapHits = [];
const probePage = trap => `<!doctype html><html><head><title>Isolated probe</title><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="missing.css"><meta http-equiv="refresh" content="2;url=${trap}/meta-refresh"></head><body><h1>Isolated</h1><img src="${trap}/img.png"><script>
const post=(kind,text)=>parent.postMessage({source:'melly-preview',kind,text},'*');
addEventListener('error',e=>{const t=e.target;if(t&&t.tagName)post('resource','Failed to load '+t.tagName.toLowerCase()+' '+(t.getAttribute('href')||t.getAttribute('src')))},true);
document.addEventListener('securitypolicyviolation',e=>post('blocked','Blocked by preview policy: '+e.effectiveDirective+' '+e.blockedURI));
const r={};
try{r.parentDocument=String(parent.document.title)}catch(e){r.parentDocument='blocked:'+e.name}
try{r.parentTauri=typeof parent.__TAURI__}catch(e){r.parentTauri='blocked:'+e.name}
r.ownBridge=[typeof window.__TAURI__,typeof window.__TAURI_INTERNALS__,typeof window.ipc].join('/');
try{localStorage.setItem('probe','1');r.storage='available'}catch(e){r.storage='blocked:'+e.name}
try{document.cookie='p=1';r.cookie=document.cookie||'empty'}catch(e){r.cookie='blocked:'+e.name}
try{r.popup=String(window.open('${trap}/popup'))}catch(e){r.popup='blocked:'+e.name}
try{top.location.href='${trap}/top';r.top='attempted'}catch(e){r.top='blocked:'+e.name}
try{new WebSocket('${trap.replace('http', 'ws')}/ws');r.ws='created'}catch(e){r.ws='blocked:'+e.name}
document.body.append(Object.assign(new Image(),{src:'${trap}/dynamic-img.png'}));
fetch('${trap}/fetch').then(()=>post('error','FETCH-SUCCEEDED')).catch(()=>{r.fetch='blocked';post('error','PROBE '+JSON.stringify(r))});
</script></body></html>`;

(async () => {
  const {authCSP} = await import(pathToFileURL(path.join(root, 'scripts/auth/public-config.mjs')).href);
  const {PUBLIC_AUTH_CONFIG} = await import(pathToFileURL(path.join(root, 'js/auth/public-config.js')).href);
  const trap = await listen((req, res) => { trapHits.push(req.url); res.writeHead(200, {'Content-Type': 'text/plain'}).end('trap'); });
  const T = origin(trap);
  let previewOrigin = '';
  const previewServer = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    const csp = `default-src 'none'; script-src ${previewOrigin} 'unsafe-inline' 'unsafe-eval'; style-src ${previewOrigin} 'unsafe-inline'; img-src ${previewOrigin} data: blob:; font-src ${previewOrigin} data:; media-src ${previewOrigin} data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'`;
    const headers = {'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'};
    if (url.pathname === '/tok/index.html' || url.pathname === '/tok/site.html') { res.writeHead(200, {...headers, 'Content-Type': 'text/html; charset=utf-8'}).end(probePage(T)); return; }
    if (url.pathname === '/tok/style.css') { res.writeHead(200, {...headers, 'Content-Type': 'text/css'}).end('h1{color:rgb(181,154,255)}'); return; }
    res.writeHead(404, {...headers, 'Content-Type': 'text/plain'}).end('Not found in preview project');
  });
  previewOrigin = origin(previewServer);
  const tauriCSP = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.security.csp.replace('http://melly-preview.localhost melly-preview://localhost', previewOrigin);
  const webServer = await appServer(() => authCSP(PUBLIC_AUTH_CONFIG));
  const desktopServer = await appServer(() => tauriCSP);
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
  const syntheticSite = {
    'index.html': '<!doctype html><html><head><title>Synthetic site</title><link rel="stylesheet" href="css/site.css"><meta http-equiv="refresh" content="1;url=' + T + '/static-refresh"></head><body><h1>Hello preview</h1><img src="logo.svg" alt="logo"><img src="' + T + '/static-img.png" alt=""><script>parent.document.title="pwned";fetch("' + T + '/static-fetch")</script></body></html>',
    'css/site.css': 'h1{color:rgb(0,128,0)}', 'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', 'about.html': '<p>About</p>'
  };
  async function openApp(context, base) {
    const p = await context.newPage(), errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(base); await p.waitForFunction(() => window.AntigravityApp?.workspace?.ready && window.AntigravityApp.devCenter);
    return {p, errors};
  }
  async function createProject(p, files) {
    await p.evaluate(async files => {
      const w = window.AntigravityApp.workspace; const {createProject, addEntry} = await import('./js/workspace/model.js');
      const project = createProject('MEGA-04 synthetic preview');
      for (const [file, content] of Object.entries(files)) addEntry(project, file, 'file', content);
      await w.mutate(state => state.projects.push(project)); await w.activate(project.id);
    }, files);
  }
  try {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({viewport: {width, height: 900}});
      const {p, errors} = await openApp(context, origin(webServer));
      await scenario(`browser ${width}: navigation, focus and keyboard tabs`, async () => {
        await p.locator('.primary-navigation [data-route="devcenter"]').click();
        assert.equal(await p.locator('#viewDevCenter').isVisible(), true);
        assert.equal(await p.evaluate(() => document.activeElement?.textContent), 'Dev Center');
        assert.equal(await p.locator('.primary-navigation [data-route="devcenter"]').getAttribute('aria-current'), 'page');
        await p.locator('#devTab-preview').focus(); await p.keyboard.press('ArrowRight');
        assert.equal(await p.locator('#devTab-git').getAttribute('aria-selected'), 'true');
        assert.equal(await p.evaluate(() => document.activeElement.id), 'devTab-git');
        assert.equal(await p.locator('#devPanel-git').isVisible(), true); assert.equal(await p.locator('#devPanel-preview').isVisible(), false);
        await p.keyboard.press('End'); assert.equal(await p.locator('#devTab-diagnostics').getAttribute('aria-selected'), 'true'); // MEGA-07: Diagnostics is the last tab
        await p.keyboard.press('ArrowRight'); assert.equal(await p.locator('#devTab-preview').getAttribute('aria-selected'), 'true');
        await p.keyboard.press('Home'); assert.equal(await p.evaluate(() => document.activeElement.id), 'devTab-preview');
        assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await p.screenshot({path: path.join(out, `devcenter-preview-${width}.png`), fullPage: true});
      });
      await scenario(`browser ${width}: honest unavailable and empty states`, async () => {
        await p.locator('#devTab-git').click();
        assert.match(await p.locator('#gitStatusLine').innerText(), /requires the Windows desktop app/);
        await p.locator('#devTab-terminal').click();
        await p.waitForFunction(() => document.getElementById('terminalCapability').textContent !== 'CHECKING');
        assert.equal(await p.locator('#terminalCapability').innerText(), 'UNAVAILABLE');
        assert.equal(await p.locator('#terminalStart').isDisabled(), true); assert.equal(await p.locator('#terminalStop').isDisabled(), true);
        assert.match(await p.locator('#terminalOutput').innerText(), /No process has been started/);
        assert.match(await p.locator('#terminalCwd').innerText(), /none — open a Local Folder/);
        await p.locator('#devTab-agents').click();
        assert.match(await p.locator('#jobList').innerText(), /No jobs yet/);
        assert.match(await p.locator('#devPanel-agents').innerText(), /never executed/);
        await p.locator('#devTab-preview').click();
        assert.equal(await p.locator('#previewEntry').inputValue(), '');
        assert.equal(await p.locator('#previewStart').isDisabled(), true);
        assert.equal(await p.locator('#previewSource option[value="folder"]').evaluate(el => el.disabled), true);
        await p.waitForFunction(() => /Browser mode/.test(document.getElementById('previewStatus').textContent));
      });
      await scenario(`browser ${width}: static preview is inert, isolated and network-free`, async () => {
        const before = trapHits.length;
        await createProject(p, syntheticSite);
        const workspaceBefore = await p.evaluate(() => JSON.stringify(window.AntigravityApp.workspace.store.raw()));
        await p.locator('.primary-navigation [data-route="devcenter"]').click(); await p.locator('#devTab-preview').click();
        assert.deepEqual(await p.locator('#previewEntry option').allInnerTexts(), ['index.html', 'about.html']);
        const title = await p.title();
        await p.locator('#previewStart').click();
        const frame = p.locator('#previewFrame');
        await frame.waitFor();
        assert.equal(await frame.getAttribute('sandbox'), '');
        assert.equal(await frame.getAttribute('src'), null);
        await p.waitForFunction(() => /Static snapshot of index\.html · 1 script\(s\) not run/.test(document.getElementById('previewStatus').textContent));
        assert.equal(await p.evaluate(() => document.getElementById('previewFrame').contentDocument), null, 'opaque origin: parent cannot reach the frame document');
        const child = p.frames().find(f => f !== p.mainFrame());
        assert.equal(await child.locator('h1').evaluate(el => getComputedStyle(el).color), 'rgb(0, 128, 0)', 'project-relative stylesheet resolved');
        assert.equal(await child.locator('img[alt="logo"]').evaluate(el => el.naturalWidth), 10, 'project-relative SVG resolved');
        await p.locator('#previewWidth').selectOption('390');
        assert.equal(await frame.evaluate(el => el.style.width), '390px');
        await p.locator('#previewCustomWidth').fill('512');
        assert.equal(await frame.evaluate(el => el.style.width), '512px');
        await p.locator('#previewCustomWidth').fill(''); await p.locator('#previewWidth').selectOption('fill');
        await delay(1600);
        assert.equal(await p.title(), title);
        assert.deepEqual(trapHits.slice(before), [], 'no request left the preview');
        await p.locator('#previewDockToggle').click();
        assert.equal(await p.locator('#previewDock').isVisible(), true);
        assert.equal(await p.locator('#previewDock #previewFrame').count(), 1);
        await p.locator('#previewUndock').click();
        assert.equal(await p.locator('#previewDock').isVisible(), false);
        await p.locator('#previewStop').click();
        assert.equal(await p.locator('#previewFrame').count(), 0);
        assert.equal(await p.evaluate(() => JSON.stringify(window.AntigravityApp.workspace.store.raw())), workspaceBefore, 'preview never mutates workspace');
      });
      // MEGA-08: the metadata-only queue became a real job engine. UI clicks no longer "authorize"
      // anything (approval is a native Windows dialog), so the browser scenario now checks that a
      // browser can never create a runnable job and that v1 data is migrated without being changed.
      await scenario(`browser ${width}: agent jobs need the desktop app, a folder and native approval; v1 data migrates read-only`, async () => {
        await p.locator('#devTab-agents').click();
        await p.locator('#jobCreate').click();
        assert.match(await p.locator('#jobFormStatus').innerText(), /Give the job a title/);
        await p.locator('#jobTitle').fill(`Synthetic job ${width}`); await p.locator('#jobAgent').selectOption('claude');
        assert.deepEqual(await p.locator('#jobProfile option').evaluateAll(o => o.map(x => x.value)), ['plan', 'edit']);
        await p.locator('#jobInstructions').fill('Do nothing; synthetic.'); await p.locator('#jobCreate').click();
        assert.match(await p.locator('#jobFormStatus').innerText(), /Open a Local Folder first/);
        assert.match(await p.locator('#jobList').innerText(), /No jobs yet/);
        assert.equal(await p.locator('button', {hasText: 'Authorize execution'}).count(), 0, 'no UI-only authorization exists');
        const legacy = JSON.stringify({version: 1, jobs: [{id: `legacy-${width}`, title: `Legacy ${width}`, instructions: 'synthetic', agentId: 'claude-code', state: 'pending', createdAt: '2026-10-25T10:00:00.000Z', events: [{at: '2026-10-25T10:00:00.000Z', type: 'created', detail: 'Metadata recorded. Not executed.'}]}]});
        await p.evaluate(v1 => { localStorage.removeItem('melly-agent-jobs-v2'); localStorage.setItem('melly-agent-jobs-v1', v1); }, legacy);
        await p.reload(); await p.waitForFunction(() => window.AntigravityApp?.devCenter);
        const jobs = await p.evaluate(() => window.AntigravityApp.devCenter.jobs.snapshot().map(j => [j.title, j.state, j.legacy]));
        assert.deepEqual(jobs, [[`Legacy ${width}`, 'cancelled', true]]);
        assert.equal(await p.evaluate(() => localStorage.getItem('melly-agent-jobs-v1')), legacy, 'v1 record is never rewritten');
        await p.locator('.primary-navigation [data-route="devcenter"]').click(); await p.locator('#devTab-agents').click();
        await p.locator(`[data-job="legacy-${width}"]`).click();
        assert.match(await p.locator('#jobDetail').innerText(), /state\s*cancelled/i);
        assert.match(await p.locator('#jobDetail').innerText(), /No executor output recorded/);
        assert.equal(await p.locator('#jobRun').isDisabled(), true);
        assert.match(await p.locator('#jobDetail .job-events').innerText(), /created: Metadata recorded\. Not executed\.[\s\S]*migrated: Migrated from schema v1/);
        await p.evaluate(() => { localStorage.removeItem('melly-agent-jobs-v1'); localStorage.removeItem('melly-agent-jobs-v2'); });
      });
      await scenario(`browser ${width}: existing workspace flows still work`, async () => {
        await p.locator('.primary-navigation [data-route="code"]').click();
        assert.equal(await p.locator('#editorContainer').isVisible(), true);
        await p.locator('.primary-navigation [data-route="tasks"]').click();
        await p.locator('[data-tool="preview"]').click();
        assert.equal(await p.locator('#devTab-preview').getAttribute('aria-selected'), 'true');
        await p.locator('.primary-navigation [data-route="tasks"]').click(); await p.locator('[data-tool="terminal"]').click();
        assert.equal(await p.locator('#devTab-terminal').getAttribute('aria-selected'), 'true');
        await p.locator('.primary-navigation [data-route="dashboard"]').click();
        assert.equal(await p.locator('#viewDashboard').isVisible(), true);
        assert.deepEqual(errors, []);
      });
      await context.close();
    }

    const context = await browser.newContext({viewport: {width: 1280, height: 900}});
    await context.addInitScript(previewOrigin => {
      if (window.top !== window) return; // MOCK bridge for the top-level app document only.
      const calls = window.__mockCalls = [];
      const invoke = async (cmd, args = {}) => {
        calls.push({cmd, args: JSON.parse(JSON.stringify(args))});
        switch (cmd) {
          case 'folder_open': return {sessionId: 'sid-1', name: 'synthetic-repo'};
          case 'folder_list': return {entries: args.path === '' ? [{name: 'src', path: 'src', kind: 'folder'}, {name: 'site.html', path: 'site.html', kind: 'file'}, {name: 'a.txt', path: 'a.txt', kind: 'file'}] : [{name: 'main.js', path: 'src/main.js', kind: 'file'}]};
          case 'folder_read': return {path: args.path, content: `synthetic ${args.path}\n`, bytes: 20};
          case 'folder_close': return null;
          case 'preview_capability': return {available: true, isolation: 'separate-origin-protocol+opaque-sandbox', origin: previewOrigin, sandbox: 'allow-scripts', network: 'denied-by-csp'};
          case 'preview_mount_files': if (window.__failMount) throw 'Entry file index.html is not in the project.'; return {token: 'tok', url: `${previewOrigin}/tok/${args.entry}`, origin: previewOrigin, entry: args.entry, source: 'workspace-files'};
          case 'preview_mount_folder': return {token: 'tok', url: `${previewOrigin}/tok/${args.entry}`, origin: previewOrigin, entry: args.entry, source: 'local-folder'};
          case 'preview_open': case 'preview_resize': case 'preview_close': return null;
          case 'preview_events': return window.__previewEvents || [];
          case 'git_status': if (window.__gitError) throw window.__gitError; return window.__gitStatus;
          case 'git_diff': return window.__gitDiff;
          case 'git_diff_summary': return args.items.map(i => ({path: i.path, staged: i.staged, additions: i.path === 'a.txt' ? 1 : 0, deletions: i.path === 'a.txt' ? 1 : 0, binary: false, approximate: false, error: null}));
          case 'terminal_capability': return {available: false, execution: 'disabled', approvalRequired: true, reason: 'Native terminal execution is not authorized in this build.'};
          case 'terminal_start': throw 'Native terminal execution is not authorized in this build.';
        }
        throw `unknown command ${cmd}`;
      };
      window.__TAURI__ = {core: {invoke}};
    }, previewOrigin);
    const {p, errors} = await openApp(context, origin(desktopServer));
    await scenario('mock-desktop: preview runs in a separate window — main window gets no frame, only bounded events', async () => {
      await createProject(p, {'index.html': '<p>source sent to mount</p>', 'app.js': '1'});
      await p.locator('.primary-navigation [data-route="devcenter"]').click();
      await p.waitForFunction(() => /separate isolated window/.test(document.getElementById('previewStatus').textContent));
      await p.evaluate(() => { window.__previewEvents = [{kind: 'ready', text: 'Synthetic'}, {kind: 'missing', text: 'css/missing.css'}, {kind: 'refused', text: '.env: Hidden files never served'}, {kind: 'blocked', text: 'Blocked by preview policy: connect-src http://ipc.localhost/folder_list'}, {kind: 'invoke', text: 'folder_list'}]; });
      await p.locator('#previewWidth').selectOption('390');
      await p.locator('#previewStart').click();
      await p.waitForFunction(() => /Preview loaded: Synthetic · isolated window/.test(document.getElementById('previewStatus').textContent));
      assert.equal(await p.locator('iframe').count(), 0, 'project content is never framed in the main window');
      assert.match(await p.locator('#previewWindowNote').innerText(), /separate “Melly Live Preview” window · Local Workspace/);
      const mount = await p.evaluate(() => window.__mockCalls.find(c => c.cmd === 'preview_mount_files'));
      assert.deepEqual(mount.args.files.map(f => f.path).sort(), ['app.js', 'index.html', 'main.js']);
      assert.deepEqual(await p.evaluate(() => window.__mockCalls.find(c => c.cmd === 'preview_open').args), {token: 'tok', width: 390});
      const text = await p.locator('#previewDiagnostics').innerText();
      assert.match(text, /Missing file css\/missing\.css/); assert.match(text, /Refused \.env/); assert.match(text, /Blocked Blocked by preview policy: connect-src/);
      assert.doesNotMatch(text, /invoke/, 'unknown event kinds are dropped');
      await p.locator('#previewWidth').selectOption('768');
      await p.locator('#previewDockToggle').click();
      await p.screenshot({path: path.join(out, 'mock-desktop-preview-window-mode.png'), fullPage: true});
      await p.locator('#previewReload').click();
      await p.waitForFunction(() => window.__mockCalls.filter(c => c.cmd === 'preview_open').length >= 3);
      await p.locator('#previewStop').click();
      const cmds = await p.evaluate(() => window.__mockCalls.map(c => c.cmd).filter(c => c.startsWith('preview_') && c !== 'preview_events'));
      assert.deepEqual(cmds, ['preview_capability', 'preview_mount_files', 'preview_open', 'preview_resize', 'preview_open', 'preview_mount_files', 'preview_open', 'preview_close']);
      assert.match(await p.locator('#previewStatus').innerText(), /Preview stopped/);
    });
    await scenario('mock-desktop: preview mount failure and Local Folder source', async () => {
      await p.evaluate(() => { window.__failMount = true; });
      await p.locator('#previewStart').click();
      await p.waitForFunction(() => document.getElementById('previewStatus').dataset.error === 'true');
      assert.match(await p.locator('#previewStatus').innerText(), /Preview failed: Entry file index\.html is not in the project/);
      await p.evaluate(() => { window.__failMount = false; });
      await p.locator('.primary-navigation [data-route="code"]').click(); await p.locator('#localFolderOpen').click();
      await p.waitForFunction(() => window.AntigravityApp.localFolder.directories.has(''));
      await p.locator('.primary-navigation [data-route="devcenter"]').click(); await p.locator('#devTab-preview').click();
      await p.locator('#previewSource').selectOption('folder');
      assert.deepEqual(await p.locator('#previewEntry option').allInnerTexts(), ['site.html']);
      await p.locator('#previewStart').click();
      await p.waitForFunction(() => /Local Folder \(disk\)/.test(document.getElementById('previewWindowNote')?.textContent || ''));
      assert.deepEqual(await p.evaluate(() => window.__mockCalls.filter(c => c.cmd === 'preview_mount_folder').map(c => c.args)), [{sessionId: 'sid-1', entry: 'site.html'}]);
    });
    await scenario('mock-desktop: Git groups, real diff rendering, open source, errors', async () => {
      await p.evaluate(() => {
        window.__gitStatus = {repository: true, rootName: 'synthetic-repo', engine: 'native-readonly', truncated: false,
          head: {branch: null, detached: true, unborn: false, oid: 'a'.repeat(40), short: 'aaaaaaa', summary: 'initial', author: 'Melly QA', time: 1792000000},
          counts: {staged: 1, unstaged: 2, untracked: 1, conflicted: 0}, notices: ['1 Git hook(s) present (post-checkout). Hooks are never executed by Melly.'],
          entries: [{path: 'a.txt', x: ' ', y: 'M', kind: 'modified'}, {path: 'src/main.js', x: 'M', y: 'M', kind: 'modified'}, {path: 'gone.txt', x: ' ', y: 'D', kind: 'deleted'}, {path: 'new.txt', x: '?', y: '?', kind: 'untracked'}]};
        window.__gitDiff = {path: 'a.txt', staged: false, oldLabel: 'index', newLabel: 'working tree', binary: false, approximate: false, lossy: false, additions: 1, deletions: 1,
          hunks: [{oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [{kind: 'context', text: 'one'}, {kind: 'del', text: 'two'}, {kind: 'add', text: 'TWO'}]}]};
      });
      await p.locator('#devTab-git').click();
      // Opening the Git tab with an open folder inspects automatically (read-only).
      await p.waitForFunction(() => /Detached HEAD at aaaaaaa/.test(document.getElementById('gitStatusLine').textContent));
      const body = await p.locator('#gitBody').innerText();
      assert.match(body, /Staged \(1\)[\s\S]*Not staged \(3\)[\s\S]*Untracked \(1\)/);
      assert.match(body, /Hooks are never executed/);
      assert.equal(await p.locator('button[aria-label="Open gone.txt read-only"]').count(), 0, 'deleted file cannot be opened');
      await p.locator('button[aria-label="Show unstaged diff for a.txt"]').click();
      await p.waitForFunction(() => document.querySelector('#gitDiff .add'));
      assert.equal(await p.locator('#gitDiff .del').innerText(), '-two\n'); assert.equal(await p.locator('#gitDiff .add').innerText(), '+TWO\n');
      // MEGA-08 adds one bounded, read-only per-file count request after status.
      assert.deepEqual(await p.evaluate(() => window.__mockCalls.filter(c => c.cmd.startsWith('git_')).map(c => c.cmd === 'git_diff_summary' ? [c.cmd, c.args.items.length] : [c.cmd, c.args])),
        [['git_status', {sessionId: 'sid-1'}], ['git_diff_summary', 5], ['git_diff', {sessionId: 'sid-1', path: 'a.txt', staged: false}]]);
      assert.match(await p.locator('#gitBody li[data-path="a.txt"]').first().innerText(), /\+1 −1/);
      await p.locator('button[aria-label="Open a.txt read-only"]').first().click();
      await p.waitForFunction(() => window.AntigravityApp.localFolder.activePath === 'a.txt');
      assert.equal(await p.locator('#folderPreviewEditor textarea').getAttribute('readonly'), '');
      await p.locator('.primary-navigation [data-route="devcenter"]').click(); await p.locator('#devTab-git').click();
      await p.evaluate(() => { window.__gitStatus = {repository: false, rootName: 'synthetic-repo', reason: 'No .git directory at the selected folder root.', entries: [], counts: {}, notices: []}; });
      await p.locator('#gitRefresh').click();
      await p.waitForFunction(() => /not a Git repository/.test(document.getElementById('gitStatusLine').textContent));
      assert.match(await p.locator('#gitBody').innerText(), /No \.git directory/);
      await p.evaluate(() => { window.__gitError = 'Git index checksum mismatch.'; });
      await p.locator('#gitRefresh').click();
      await p.waitForFunction(() => document.getElementById('gitStatusLine').dataset.error === 'true');
      assert.match(await p.locator('#gitStatusLine').innerText(), /Git inspection failed: Git index checksum mismatch/);
      await p.evaluate(() => { window.__gitError = null; });
      await p.screenshot({path: path.join(out, 'mock-desktop-git.png'), fullPage: true});
    });
    await scenario('mock-desktop: terminal gate disabled — no process start request', async () => {
      await p.locator('#devTab-terminal').click();
      await p.waitForFunction(() => document.getElementById('terminalCapability').textContent.includes('DISABLED'));
      assert.equal(await p.locator('#terminalCapability').innerText(), 'EXECUTION DISABLED · NOT AUTHORIZED');
      assert.match(await p.locator('#terminalCwd').innerText(), /synthetic-repo \(Local Folder\)/);
      assert.equal(await p.locator('#terminalStart').isDisabled(), true);
      const result = await p.evaluate(() => window.AntigravityApp.devCenter.terminal.start({cwdLabel: 'synthetic-repo', approved: true}));
      assert.equal(result.started, false);
      assert.equal(await p.evaluate(() => window.__mockCalls.filter(c => c.cmd === 'terminal_start').length), 0);
      assert.match(await p.locator('#terminalOutput').innerText(), /Start refused[\s\S]*No process was started/);
    });
    await scenario('mock-desktop: closing Local Folder stops folder preview and clears Git', async () => {
      await p.locator('#devTab-preview').click(); await p.locator('#previewSource').selectOption('folder'); await p.locator('#previewStart').click();
      await p.locator('#previewWindowNote').waitFor();
      const closesBefore = await p.evaluate(() => window.__mockCalls.filter(c => c.cmd === 'preview_close').length);
      await p.locator('.primary-navigation [data-route="code"]').click(); await p.locator('#localFolderClose').click();
      await p.waitForFunction(() => !window.AntigravityApp.localFolder.session);
      await p.locator('.primary-navigation [data-route="devcenter"]').click();
      await p.waitForFunction(() => /Local Folder closed/.test(document.getElementById('previewStatus').textContent));
      assert.equal(await p.locator('#previewWindowNote').count(), 0);
      assert.equal(await p.evaluate(() => window.__mockCalls.filter(c => c.cmd === 'preview_close').length), closesBefore + 1, 'preview window closed natively');
      await p.locator('#devTab-git').click();
      assert.match(await p.locator('#gitStatusLine').innerText(), /No Local Folder open/);
      assert.deepEqual(errors, []);
    });
    await context.close();
  } finally {
    await browser.close();
    for (const s of [webServer, desktopServer, previewServer, trap]) await new Promise(r => s.close(r));
  }
  fs.writeFileSync(path.join(out, 'trap-hits.json'), JSON.stringify(trapHits, null, 2));
  if (results.some(r => r.status === 'FAIL')) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
