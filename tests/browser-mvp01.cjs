// Real Chromium/IndexedDB, synthetic local data only. No external requests or credentials.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {spawn} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = process.env.MVP01_AUDIT_DIR || path.join(require('node:os').tmpdir(), 'melly-mvp01');
if (path.resolve(out).startsWith(root + path.sep)) throw new Error('Evidence directory must be outside the repository.');
fs.mkdirSync(out, {recursive: true});
const results = []; let server, browser, base;
async function scenario(name, fn) {
  try { await fn(); results.push({name, status: 'PASS'}); console.log('PASS', name); }
  catch (error) { results.push({name, status: 'FAIL', error: error.stack}); console.error('FAIL', name, error.stack); }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
}
const ready = page => page.waitForFunction(() => window.AntigravityApp?.workspace?.ready && window.AntigravityApp?.editor?.persistenceReady && document.querySelector('#offlineShellStatus').dataset.ready === 'true');
const idle = page => page.waitForFunction(() => !window.AntigravityApp.workspace.busy);
const nav = async page => { await page.locator('#moreMenu').evaluate(el => el.open = true); await page.locator('[data-view="studio"]').click(); };
async function context(width = 1280) {
  const ctx = await browser.newContext({viewport: {width, height: width < 1100 ? 844 : 900}, hasTouch: width < 1100, acceptDownloads: true});
  await ctx.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
  const page = await ctx.newPage(); await page.goto(base); await ready(page); await nav(page); return {ctx, page};
}
async function newProject(page, name) {
  page.once('dialog', d => d.accept(name)); await page.locator('#workspaceNewProject').click(); await idle(page);
  await page.waitForFunction(name => window.AntigravityApp.workspace.project()?.name === name, name);
}
async function save(page, text) {
  await page.locator('#editorTextarea').fill(text); await page.locator('#editorSaveBtn').click();
  await page.waitForFunction(() => window.AntigravityApp.editor.getSaveState().status === 'saved');
}
async function download(page, control, filename) {
  const event = page.waitForEvent('download'); await page.locator(control).click(); const d = await event;
  const dest = path.join(out, filename); await d.saveAs(dest); await idle(page); return fs.readFileSync(dest, 'utf8');
}
async function pick(page, text, approve = true) {
  page.once('dialog', d => approve ? d.accept() : d.dismiss());
  await page.locator('#workspaceImportFile').setInputFiles({name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(text)}); await idle(page);
}
const raw = page => page.evaluate(() => window.AntigravityApp.workspace.store.raw());
(async () => {
  server = spawn(process.execPath, ['server/dev.mjs'], {cwd: root, env: {...process.env, PORT: '0'}, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  base = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('Server startup timeout')), 10000);
    server.stdout.on('data', data => { text += data; const match = text.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) {clearTimeout(timer); resolve(match[0] + '/');} }); server.on('error', reject);
  });
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
  for (const width of [390, 1280]) {
    await scenario(`handoff ${width}: actual v3 downloads, new-copy import, reverse transfer and offline reopen`, async () => {
      const a = await context(width), b = await context(width); const errors = [];
      a.page.on('pageerror', e => errors.push(e.message)); b.page.on('pageerror', e => errors.push(e.message));
      try {
        await newProject(a.page, 'Synthetic source');
        await a.page.evaluate(async () => {
          const w = window.AntigravityApp.workspace, {addEntry} = await import('/js/workspace/model.js');
          await w.mutate(s => { const p = s.projects[0]; for (let i = 0; i < 3; i++) addEntry(p, `src/file${i}.txt`, 'file', 'x'.repeat(400000)); });
          await w.activate(w.state.projects[0].id, false);
        });
        await a.page.getByRole('button', {name: 'main.js', exact: true}).first().click();
        await save(a.page, '// Zażółć 🟣\n\n');
        const text = await download(a.page, '#workspaceExport', `handoff-${width}-forward.json`);
        assert.equal(JSON.parse(text).schemaVersion, 3); assert.ok(Buffer.byteLength(text) > 2*1024*1024);
        assert.match(await a.page.locator('#workspaceStatus').innerText(), /Download offered/);
        assert.ok(await a.page.locator('#workspaceBackupDownload').getAttribute('href'));
        await newProject(b.page, 'Pre-existing destination'); await save(b.page, '// preserve destination\n'); const before = await raw(b.page);
        await pick(b.page, text); const after = await raw(b.page); assert.equal(after.projects.length, 2); assert.deepEqual(after.projects[0], before.projects[0]);
        assert.notEqual(after.projects[1].id, JSON.parse(text).parts[0].payload.projects[0].id);
        await b.page.locator('#workspaceProject').selectOption(after.projects[1].id); await idle(b.page);
        await b.page.getByRole('button', {name: 'main.js', exact: true}).first().click(); await save(b.page, '// edit on receiving device\n');
        const back = await download(b.page, '#workspaceExport', `handoff-${width}-return.json`);
        const original = (await raw(a.page)).projects[0]; await pick(a.page, back); const roundtrip = await raw(a.page);
        assert.deepEqual(roundtrip.projects[0], original); assert.equal(roundtrip.projects.length, 3);
        const restored = roundtrip.projects.find(p => p.id !== original.id && p.name === 'Synthetic source');
        assert.equal(restored.entries.find(e => e.path === 'main.js').content, '// edit on receiving device\n');
        assert.equal(restored.entries.find(e => e.path === 'src/file0.txt').baseContent.length, 400000);
        await a.page.locator('#workspaceProject').selectOption(restored.id); await idle(a.page); await a.ctx.setOffline(true);
        assert.equal((await a.page.reload()).fromServiceWorker(), true); await ready(a.page); await nav(a.page);
        assert.equal(await a.page.locator('#editorTextarea').inputValue(), '// edit on receiving device\n');
        await a.page.close(); const reopened = await a.ctx.newPage(); await reopened.goto(base); await ready(reopened); await nav(reopened);
        assert.equal(await reopened.locator('#editorTextarea').inputValue(), '// edit on receiving device\n');
        const sizes = await reopened.locator('.workspace-actions button').evaluateAll(els => els.map(el => ({w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height, right: el.getBoundingClientRect().right})));
        assert.ok(sizes.every(s => s.w >= 44 && s.h >= 44 && s.right <= width + 1));
        await reopened.screenshot({path: path.join(out, `handoff-${width}.png`), fullPage: true}); assert.deepEqual(errors, []);
      } finally { await a.ctx.close(); await b.ctx.close(); }
    });
  }
  await scenario('recovery: quota/failed transaction retains saved snapshot and latest unsaved contents without flush', async () => {
    const {ctx, page} = await context(390);
    try {
      await newProject(page, 'Synthetic recovery'); await save(page, '// acknowledged\n');
      const before = await raw(page);
      await page.evaluate(() => {const w = window.AntigravityApp.workspace; window.originalSave = w.store.save; w.store.save = async () => { throw new DOMException('Synthetic quota exceeded', 'QuotaExceededError'); };});
      await page.locator('#editorTextarea').fill('// latest unsaved 🟣\n'); await page.locator('#editorSaveBtn').click();
      await page.waitForFunction(() => window.AntigravityApp.editor.getSaveState().status === 'failed');
      const text = await download(page, '#workspaceRecovery', 'quota-recovery.json'); const payload = JSON.parse(text).parts[0].payload;
      assert.equal(payload.projects[0].entries[0].content, '// acknowledged\n'); assert.equal(payload.buffers[0].content, '// latest unsaved 🟣\n');
      assert.deepEqual(await raw(page), before); assert.match(await page.locator('#workspaceBackupInfo').innerText(), /does not acknowledge Save/);
      await page.screenshot({path: path.join(out, 'quota-recovery-390.png'), fullPage: true});
      const target = await context(390); try {await pick(target.page, text); assert.equal((await raw(target.page)).projects[0].entries[0].content, '// latest unsaved 🟣\n');} finally {await target.ctx.close();}
    } finally {await ctx.close();}
  });
  await scenario('recovery: generation conflict exports local buffers while preserving the other tab', async () => {
    const {ctx, page} = await context();
    try {
      await newProject(page, 'Synthetic conflict'); await save(page, '// baseline\n'); const other = await ctx.newPage(); await other.goto(base); await ready(other);
      await other.evaluate(() => window.AntigravityApp.workspace.mutate(s => s.projects[0].name = 'Other tab name'));
      await page.locator('#editorTextarea').fill('// preserve conflicted edit\n'); await page.locator('#editorSaveBtn').click(); await page.waitForFunction(() => window.AntigravityApp.editor.getSaveState().status === 'failed');
      const before = await raw(other); const text = await download(page, '#workspaceRecovery', 'conflict-recovery.json');
      assert.equal(JSON.parse(text).parts[0].payload.buffers[0].content, '// preserve conflicted edit\n'); assert.deepEqual(await raw(other), before);
    } finally {await ctx.close();}
  });
  await scenario('atomic import: cancelled, missing/duplicate/mixed/corrupt parts and storage abort create no projects', async () => {
    const {ctx, page} = await context();
    try {
      await newProject(page, 'Existing'); await save(page, '// unchanged\n');
      const valid = await page.evaluate(async () => {const {createWorkspaceBackup} = await import('/js/workspace/backup-v3.js'); return createWorkspaceBackup(window.AntigravityApp.workspace.state);});
      const before = await raw(page); await pick(page, valid, false); assert.deepEqual(await raw(page), before);
      const mutations = [d => d.parts = [], d => d.parts.push(d.parts[0]), d => d.parts[0].backupId = 'foreign', d => d.parts[0].payload.projects[0].name = 'corrupted', d => d.schemaVersion = 999];
      for (const mutate of mutations) {const data = JSON.parse(valid); mutate(data); await page.locator('#workspaceImportFile').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))}); await idle(page); assert.deepEqual(await raw(page), before); assert.equal(await page.locator('#workspaceStatus').getAttribute('data-error'), 'true');}
      await page.evaluate(() => {const put = IDBObjectStore.prototype.put;window.restorePut = () => IDBObjectStore.prototype.put = put;IDBObjectStore.prototype.put = function(...args) {const r = put.apply(this, args); if(this.name === 'state') this.transaction.abort(); return r;};});
      await pick(page, valid); assert.deepEqual(await raw(page), before); assert.equal((await page.evaluate(() => window.AntigravityApp.workspace.state.projects.length)), 1);
      assert.equal(await page.locator('#workspaceStatus').getAttribute('data-error'), 'true'); await page.evaluate(() => window.restorePut());
      await pick(page, valid); assert.equal((await raw(page)).projects.length, 2); assert.deepEqual((await raw(page)).projects[0], before.projects[0]);
      const other=await ctx.newPage();await other.goto(base);await ready(other);await other.evaluate(()=>window.AntigravityApp.workspace.mutate(s=>s.projects[0].name='Other writer during import'));
      const conflictBefore=await raw(other);await pick(page,valid);assert.deepEqual(await raw(other),conflictBefore);
      assert.equal(await page.evaluate(()=>window.AntigravityApp.workspace.state.projects.length),2);assert.equal(await page.locator('#workspaceStatus').getAttribute('data-error'),'true');
    } finally {await ctx.close();}
  });
  await scenario('delivery: fallback download survives share cancellation and errors; failed export hides stale success', async () => {
    const {ctx,page} = await context(390);
    try {
      await newProject(page, 'Delivery'); await save(page, '// safe');
      await page.evaluate(() => {Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{throw new DOMException('Synthetic cancel','AbortError');}});});
      await download(page,'#workspaceExport','delivery.json'); await page.locator('#workspaceBackupShare').click(); await idle(page); assert.match(await page.locator('#workspaceStatus').innerText(), /cancelled/); assert.ok(await page.locator('#workspaceBackupDownload').getAttribute('href'));
      await page.evaluate(() => Object.defineProperty(navigator,'share',{configurable:true,value:async()=>{throw new Error('Synthetic share failure');}}));
      await page.locator('#workspaceBackupShare').click(); await idle(page); assert.match(await page.locator('#workspaceStatus').innerText(), /sharing failed/); assert.ok(await page.locator('#workspaceBackupDownload').getAttribute('href'));
      await page.locator('#editorTextarea').fill('const password = "private-synthetic-value";'); await page.locator('#workspaceRecovery').click(); await idle(page);
      assert.equal(await page.locator('#workspaceBackupOutput').isVisible(),false); assert.match(await page.locator('#workspaceStatus').innerText(), /credential/);
    } finally {await ctx.close();}
  });
  await scenario('capacity: near-8-MiB actual download restores into a fresh profile', async () => {
    const source = await context(), target = await context();
    try {
      const expected = await source.page.evaluate(async () => {
        const {emptyWorkspace,createProject,addEntry,validateWorkspace,WORKSPACE_LIMIT} = await import('/js/workspace/model.js');
        const w=window.AntigravityApp.workspace, s=emptyWorkspace(), p=createProject('Synthetic capacity');s.projects.push(p);
        for(let i=0;i<9;i++)addEntry(p,`file${i}.txt`,'file');
        let remaining=WORKSPACE_LIMIT-8192-new TextEncoder().encode(JSON.stringify(s)).length;
        for(const entry of p.entries){const n=Math.min(500000,Math.floor(remaining/2));entry.content=entry.baseContent='x'.repeat(n);remaining-=n*2;}
        p.entries[0].content+='x'.repeat(remaining);validateWorkspace(s);
        await w.mutate(next=>next.projects.push(p));return p.entries.map(e=>({path:e.path,length:e.content.length,original:e.baseContent.length}));
      });
      const text=await download(source.page,'#workspaceExport','capacity-near-8mib.json');assert.ok(Buffer.byteLength(text)>8*1024*1024-16384);
      await pick(target.page,text);assert.deepEqual((await raw(target.page)).projects[0].entries.map(e=>({path:e.path,length:e.content.length,original:e.baseContent.length})),expected);
    } finally {await source.ctx.close();await target.ctx.close();}
  });
  await scenario('compatibility: v1 and v2 UI imports preserve pre-existing projects', async () => {
    const {ctx,page}=await context();
    try {
      await newProject(page,'Existing compatibility');await save(page,'// keep');const before=(await raw(page)).projects[0];
      const v2=await page.evaluate(async()=>{const {exportWorkspace}=await import('/js/workspace/model.js');return exportWorkspace(window.AntigravityApp.workspace.state);});
      const v1=JSON.stringify({format:'melly-ide-workspace',schemaVersion:1,exportedAt:new Date().toISOString(),files:[{filename:'main.js',content:'// v1\r\n',revision:3,updatedAt:new Date().toISOString()}],settings:{activeFilename:'main.js'}});
      await pick(page,v2);await pick(page,v1);const after=await raw(page);assert.equal(after.projects.length,3);assert.deepEqual(after.projects[0],before);assert.equal(after.projects[2].entries[0].content,'// v1\r\n');
    }finally{await ctx.close();}
  });
  await scenario('line endings: real textarea passive export and edits preserve CRLF/CR/LF source bytes', async () => {
    const {ctx,page}=await context(390);
    try{
      await newProject(page,'Synthetic newline preservation');
      const exact='\r\none\r\ntwo\rlast\n\u0000';
      await page.evaluate(async content=>{const w=window.AntigravityApp.workspace;await w.mutate(s=>{s.projects[0].entries[0].content=content;s.projects[0].entries[0].baseContent=content;});await w.activate(w.state.projects[0].id,false);},exact);
      assert.equal(await page.locator('#editorTextarea').inputValue(),'\none\ntwo\nlast\n\u0000');
      const first=JSON.parse(await download(page,'#workspaceExport','newline-unmodified.json'));assert.equal(first.parts[0].payload.projects[0].entries[0].content,exact);
      await save(page,'\none\nTWO\nlast\n\u0000');const edited=JSON.parse(await download(page,'#workspaceExport','newline-edited.json'));
      assert.equal(edited.parts[0].payload.projects[0].entries[0].content,'\r\none\r\nTWO\rlast\n\u0000');assert.equal(edited.parts[0].payload.projects[0].entries[0].baseContent,exact);
      await ctx.setOffline(true);await page.reload();await ready(page);await nav(page);
      const reopened=JSON.parse(await download(page,'#workspaceExport','newline-offline.json'));assert.equal(reopened.parts[0].payload.projects[0].entries[0].content,'\r\none\r\nTWO\rlast\n\u0000');
    }finally{await ctx.close();}
  });
})().catch(error => {console.error(error.stack);process.exitCode=1;}).finally(async () => {
  await browser?.close(); server?.kill();
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({engine:'Chromium',results,physicalIOS:'OWNER DEVICE ACCEPTANCE PENDING',nativeWindows:'OWNER DEVICE ACCEPTANCE PENDING',externalRequests:'blocked'},null,2));
  if(results.length !== 9 || results.some(result => result.status !== 'PASS')) process.exitCode=1;
});
