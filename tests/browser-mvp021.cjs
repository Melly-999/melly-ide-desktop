// MVP-02.1: real Service Worker upgrade from the previous published shell, storage reporting
// and share fallback. Chromium, fresh profiles, loopback only, synthetic data only.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '..');
const out = process.env.MVP021_AUDIT_DIR || path.join(require('node:os').tmpdir(), 'melly-mvp021');
if (path.resolve(out).startsWith(root + path.sep)) throw new Error('Evidence directory must be outside the repository.');
// The previous published generation (v14) frozen by MVP-02 outside the repository.
const previous = path.resolve(process.env.MVP021_PREVIOUS_SHELL || 'set-MVP021_PREVIOUS_SHELL-to-the-previous-shell-snapshot');
fs.mkdirSync(out, {recursive: true});
const results = [], stalls = []; let browser;
async function scenario(name, fn) {
  try { await fn(); results.push({name, status: 'PASS'}); console.log('PASS', name); }
  catch (error) { results.push({name, status: 'FAIL', error: error.stack}); console.error('FAIL', name, error.stack); }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
}
const mime = {html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', webmanifest: 'application/manifest+json', txt: 'text/plain'};
// One origin whose served generation can be switched, like a redeployed preview.
async function site() {
  const state = {dir: root, requests: []};
  const server = http.createServer((req, res) => {
    const asset = new URL(req.url, 'http://127.0.0.1').pathname.slice(1) || 'index.html';
    state.requests.push(asset);
    const file = path.join(state.dir, asset);
    if (asset.includes('..') || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, {'Content-Type': mime[asset.split('.').at(-1)] || 'application/octet-stream', 'Cache-Control': 'no-store'});
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {state, base: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(r => server.close(r))};
}
const shellReady = page => page.waitForFunction(() => document.querySelector('#offlineShellStatus')?.dataset.ready === 'true', null, {timeout: 20000});
const ready = page => page.waitForFunction(() => window.AntigravityApp?.workspace?.ready && window.AntigravityApp?.editor?.persistenceReady, null, {timeout: 20000});
const idle = page => page.waitForFunction(() => !window.AntigravityApp.workspace.busy);
const nav = async page => { await page.locator('#moreMenu').evaluate(el => el.open = true); await page.locator('[data-view="studio"]').click(); };
const raw = page => page.evaluate(() => window.AntigravityApp.workspace.store.raw());
const ownedCaches = page => page.evaluate(async () => (await caches.keys()).filter(n => n.startsWith('melly-ide-shell:')).sort());
async function context(base, {width = 1280, init} = {}) {
  const ctx = await browser.newContext({viewport: {width, height: width < 1100 ? 844 : 900}, hasTouch: width < 1100});
  const external = [], errors = [];
  await ctx.route('**/*', route => { if (new URL(route.request().url()).origin === new URL(base).origin) return route.continue(); external.push(route.request().url()); return route.abort(); });
  if (init) await ctx.addInitScript(init);
  ctx.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  return {ctx, external, errors};
}
const FIXTURE = '// Zażółć gęślą jaźń — 日本語 — 🟣 e\u0301\r\nwindows line\r\nold mac line\runix line\n';

(async () => {
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
  const {SHELL_VERSION} = await import(pathToFileURL(path.join(root, 'js/offline-shell.js')).href);
  const prevSource = fs.readFileSync(path.join(previous, 'js/offline-shell.js'), 'utf8');
  const PREVIOUS_VERSION = (prevSource.match(/SHELL_VERSION = '([^']+)'/) || [])[1];
  assert.ok(PREVIOUS_VERSION && PREVIOUS_VERSION !== SHELL_VERSION, `previous shell at ${previous} must have a different SHELL_VERSION`);

  for (const width of [390, 1280]) {
    await scenario(`upgrade ${width}: ${PREVIOUS_VERSION} -> ${SHELL_VERSION} keeps projects, never mixes shells, then works offline`, async () => {
      const s = await site(); s.state.dir = previous;
      const {ctx, external, errors} = await context(s.base, {width});
      try {
        let page = await ctx.newPage(); await page.goto(s.base); await ready(page); await shellReady(page); await nav(page);
        page.once('dialog', d => d.accept('Upgrade synthetic')); await page.locator('#workspaceNewProject').click(); await idle(page);
        await page.evaluate(async text => {
          const w = window.AntigravityApp.workspace, {addEntry} = await import('/js/workspace/model.js');
          await w.mutate(state => { addEntry(state.projects.find(p => p.name === 'Upgrade synthetic'), 'src/zażółć.txt', 'file', text); });
        }, FIXTURE);
        const before = await raw(page);
        assert.equal(before.projects.find(p => p.name === 'Upgrade synthetic').entries.find(e => e.path === 'src/zażółć.txt').content, FIXTURE);
        assert.deepEqual(await ownedCaches(page), [`melly-ide-shell:%2F:${PREVIOUS_VERSION}`]);
        assert.equal(await page.locator('#workspaceStorage').count(), 0, 'previous shell has no storage panel');

        // Redeploy. The open tab keeps the complete previous shell until every tab is closed.
        s.state.dir = root;
        await page.reload(); await ready(page);
        await page.waitForFunction(() => /update available/i.test(document.querySelector('#offlineShellStatus')?.textContent || ''), null, {timeout: 20000});
        const mixed = await page.evaluate(async () => ({storagePanel: !!document.querySelector('#workspaceStorage'), editorExports: Object.keys(await import('/js/editor.js'))}));
        assert.equal(mixed.storagePanel, false, 'controlled tab must still run the previous shell');
        assert.equal(mixed.editorExports.includes('mergeTextareaInput'), false, 'previous editor module must still be served');
        assert.deepEqual(await ownedCaches(page), [`melly-ide-shell:%2F:${PREVIOUS_VERSION}`, `melly-ide-shell:%2F:${SHELL_VERSION}`].sort());
        assert.deepEqual(await raw(page), before);

        // The waiting shell activates only while no tab is open, so each attempt closes its tab again.
        await page.close();
        for (let attempt = 0; ; attempt++) {
          await new Promise(r => setTimeout(r, 300));
          page = await ctx.newPage();
          const pending = new Map();
          page.on('request', r => pending.set(r, r.url())); page.on('requestfinished', r => pending.delete(r)); page.on('requestfailed', r => pending.delete(r));
          try { await page.goto(s.base, {timeout: 15000}); }
          catch (error) {
            // Observed intermittently in Chromium during the activation handoff. Record it, then
            // check that closing the tab and reopening recovers without data loss.
            stalls.push({width, attempt, error: error.message.split('\n')[0], pending: [...pending.values()], workers: ctx.serviceWorkers().map(w => w.url()), serverTail: s.state.requests.slice(-15)});
            fs.writeFileSync(path.join(out, 'navigation-stalls.json'), JSON.stringify(stalls, null, 2));
            if (attempt === 20) throw error;
            await page.close(); continue;
          }
          await ready(page);
          if (await page.locator('#workspaceStorage').count()) break;
          if (attempt === 20) throw new Error('New shell never activated after all tabs closed');
          await page.close();
        }
        await shellReady(page); await nav(page);
        const current = await page.evaluate(async () => ({storagePanel: !!document.querySelector('#workspaceStorage'), editorExports: Object.keys(await import('/js/editor.js'))}));
        assert.equal(current.storagePanel, true); assert.ok(current.editorExports.includes('mergeTextareaInput'));
        assert.deepEqual(await ownedCaches(page), [`melly-ide-shell:%2F:${SHELL_VERSION}`], 'previous owned cache is removed only after activation');
        assert.deepEqual(await raw(page), before, 'projects, Unicode and CR/LF/CRLF bytes preserved across the upgrade');

        await ctx.setOffline(true);
        assert.equal((await page.reload()).fromServiceWorker(), true); await ready(page); await shellReady(page); await nav(page);
        assert.equal(await page.locator('#workspaceStorage').count(), 1);
        assert.deepEqual(await raw(page), before);
        await page.screenshot({path: path.join(out, `upgrade-${width}-offline.png`)});
        assert.deepEqual(errors, []); assert.deepEqual(external, []);
      } finally { await ctx.close(); await s.close(); }
    });
  }

  const s = await site();
  const failing = () => {
    const reject = () => Promise.reject(new DOMException('synthetic failure', 'UnknownError'));
    Object.defineProperty(navigator, 'storage', {configurable: true, value: {persisted: reject, persist: reject, estimate: reject}});
  };
  const missing = () => Object.defineProperty(navigator, 'storage', {configurable: true, value: undefined});
  const savesStillWork = async page => {
    await page.getByRole('button', {name: 'main.js', exact: true}).first().click();
    await page.locator('#editorTextarea').fill('// saved despite storage reporting\n'); await page.locator('#editorSaveBtn').click();
    await page.waitForFunction(() => window.AntigravityApp.editor.getSaveState().status === 'saved');
  };
  await scenario('storage panel: real Chromium persisted/persist/estimate are reported truthfully', async () => {
    const {ctx, errors, external} = await context(s.base, {width: 390});
    try {
      const page = await ctx.newPage(); await page.goto(s.base); await ready(page); await nav(page);
      await page.waitForFunction(() => !/Checking/.test(document.querySelector('#storagePersistence')?.textContent || 'Checking'));
      const real = await page.evaluate(async () => ({persisted: await navigator.storage.persisted()}));
      const panel = page.locator('#workspaceStorage');
      assert.match(await panel.innerText(), real.persisted ? /Persistent storage: granted/ : /Persistent storage: not granted/);
      assert.match(await panel.innerText(), /Approximate usage: .+ of .+ available to this site/);
      assert.match(await panel.innerText(), /No platform guarantees retention/);
      if (!real.persisted) {
        await page.locator('#storageRequest').click();
        await page.waitForFunction(() => document.querySelector('#storageOutcome').textContent.length > 0);
        const after = await page.evaluate(() => navigator.storage.persisted());
        assert.match(await page.locator('#storageOutcome').innerText(), after ? /granted persistent storage/ : /did not grant/);
        assert.equal(await panel.getAttribute('data-persisted'), String(after));
      }
      const box = await page.locator('#storageRequest').boundingBox();
      assert.ok(box.height >= 44 && box.width >= 44, `request button ${box.width}x${box.height}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `horizontal overflow ${overflow}px`);
      await panel.screenshot({path: path.join(out, 'storage-panel-390.png')});
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
    } finally { await ctx.close(); }
  });
  await scenario('storage panel: rejected storage APIs are labelled as failures and never block Save', async () => {
    const {ctx, errors} = await context(s.base, {width: 1280, init: failing});
    try {
      const page = await ctx.newPage(); await page.goto(s.base); await ready(page); await nav(page);
      await page.waitForFunction(() => /could not be read/.test(document.querySelector('#storagePersistence')?.textContent || ''));
      assert.match(await page.locator('#storageUsage').innerText(), /Usage estimate failed/);
      await page.locator('#storageRequest').click();
      await page.waitForFunction(() => /request failed/.test(document.querySelector('#storageOutcome').textContent));
      await savesStillWork(page); assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });
  await scenario('storage panel: missing navigator.storage is reported as unavailable and never blocks Save', async () => {
    const {ctx, errors} = await context(s.base, {width: 390, init: missing});
    try {
      const page = await ctx.newPage(); await page.goto(s.base); await ready(page); await nav(page);
      await page.waitForFunction(() => /status unavailable/.test(document.querySelector('#storagePersistence')?.textContent || ''));
      assert.equal(await page.locator('#storageRequest').isDisabled(), true);
      await savesStillWork(page); assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });
  await scenario('backup v3 share fallback: download link always, Share only when files can be shared', async () => {
    const noShare = () => { delete Navigator.prototype.share; delete Navigator.prototype.canShare; };
    for (const [label, init, shareVisible] of [['no Web Share', noShare, false], ['Web Share with files', () => { navigator.canShare = () => true; navigator.share = async () => {}; }, true]]) {
      const {ctx, errors} = await context(s.base, {width: 390, init});
      try {
        const page = await ctx.newPage(); await page.goto(s.base); await ready(page); await nav(page);
        await page.locator('#workspaceExport').click(); await idle(page);
        await page.waitForFunction(() => /^blob:/.test(document.querySelector('#workspaceBackupDownload')?.href || ''));
        assert.equal(await page.locator('#workspaceBackupShare').isVisible(), shareVisible, label);
        const text = await page.evaluate(async () => (await fetch(document.querySelector('#workspaceBackupDownload').href)).text());
        assert.equal(JSON.parse(text).schemaVersion, 3, label); assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    }
  });
  await s.close();
  await browser.close();
  const failed = results.filter(r => r.status !== 'PASS').length;
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({total: results.length, passed: results.length - failed, failed, navigationStalls: stalls.length, previousShell: previous, previousVersion: PREVIOUS_VERSION, currentVersion: SHELL_VERSION}, null, 2));
  console.log(`MVP-02.1 browser: ${results.length - failed}/${results.length} PASS; upgrade navigation stalls recovered: ${stalls.length}`);
  process.exitCode = failed ? 1 : 0;
})().catch(async error => { console.error(error); await browser?.close(); process.exitCode = 1; });
