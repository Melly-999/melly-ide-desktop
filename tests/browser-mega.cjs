async function navigateLegacy(page, view) { await page.locator('#moreMenu').evaluate(e => e.open = true); await page.locator('[data-view="'+view+'"]').click(); }
// Real Chrome/IndexedDB/Service Worker acceptance. The GitHub scenario uses real HTTPS, no API interception.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=process.env.MEGA_AUDIT_DIR||path.join(require('node:os').tmpdir(),'melly-ide-mega01');
fs.mkdirSync(path.join(out,'shots'),{recursive:true});
const results=[]; let browser,server,base;
async function scenario(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS',name);}catch(error){results.push({name,status:'FAIL',error:error.stack});console.error('FAIL',name,error);}fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));}
const ready=page=>page.waitForFunction(()=>window.AntigravityApp?.workspace?.ready&&window.AntigravityApp?.editor?.persistenceReady&&document.querySelector('#offlineShellStatus').dataset.ready==='true');
const idle=page=>page.waitForFunction(()=>!window.AntigravityApp.workspace.busy);
async function newProject(page,name){page.once('dialog',d=>d.accept(name));await page.locator('#workspaceNewProject').click();await idle(page);await page.waitForFunction(n=>window.AntigravityApp.workspace.project()?.name===n,name);}
async function newFile(page,name){page.once('dialog',d=>d.accept(name));await page.locator('#workspaceNewFile').click();await idle(page);await page.waitForFunction(n=>window.AntigravityApp.editor.activeFilename===n,name);}
async function save(page,text){await page.locator('#editorTextarea').fill(text);await page.locator('#editorSaveBtn').click();await page.waitForFunction(()=>window.AntigravityApp.editor.getSaveState().status==='saved');}
async function legacyRecords(page){return page.evaluate(()=>window.AntigravityApp.workspace.legacy.fileStore.readBackupRecords().then(r=>r.records));}
(async()=>{
 server=spawn(process.execPath,['server/dev.mjs'],{cwd:root,env:{...process.env,PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
 base=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('Server startup timeout')),10000);server.stdout.on('data',data=>{text+=data;const found=text.match(/http:\/\/127\.0\.0\.1:\d+/);if(found){clearTimeout(timer);resolve(found[0]+'/');}});server.on('error',reject);});
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 for(const width of [390,1280])await scenario(`workspace browser ${width}: projects, folders, buffers, backups, reload, offline, approval and legacy preservation`,async()=>{
  const ctx=await browser.newContext({viewport:{width,height:900},acceptDownloads:true});const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.goto(base);await ready(page);await navigateLegacy(page,'studio');
   await save(page,'// untouched legacy 🟣\n');const before=await legacyRecords(page);
   await newProject(page,'Project One');await newFile(page,'src/lib/one.js');await save(page,'export const one = 1;\n');
   await page.getByRole('button',{name:'main.js',exact:true}).first().click();await save(page,'// independent main\n');
   await page.getByRole('button',{name:'src/lib/one.js',exact:true}).first().click();assert.equal(await page.locator('#editorTextarea').inputValue(),'export const one = 1;\n');
   await page.locator('#workspaceDiff summary').click();await page.waitForFunction(()=>document.querySelector('#workspaceDiffText').textContent.includes('+export const one = 1'));assert.match(await page.locator('#workspaceDiffText').innerText(),/\+export const one = 1/);
   const first=await page.evaluate(()=>window.AntigravityApp.workspace.state.activeProjectId);
   await newProject(page,'Project Two');await save(page,'// project two\n');
   await page.locator('#workspaceProject').selectOption(first);await idle(page);await page.waitForFunction(()=>window.AntigravityApp.editor.activeFilename==='src/lib/one.js');
   assert.equal(await page.locator('#editorTextarea').inputValue(),'export const one = 1;\n');
   await page.reload();await ready(page);await navigateLegacy(page,'studio');assert.equal(await page.locator('#workspaceProject').inputValue(),first);
   assert.equal(await page.locator('#editorTextarea').inputValue(),'export const one = 1;\n');assert.deepEqual(await legacyRecords(page),before);
   await navigateLegacy(page,'hub');await page.locator('#backupExport').click();await page.waitForFunction(()=>!window.AntigravityApp.backup.busy);
   assert.match(await page.locator('#backupStatus').innerText(),/legacy project/i);assert.deepEqual(await legacyRecords(page),before);await navigateLegacy(page,'studio');
   // Rename folder and cancel deletion through actual browser confirmations.
   let dialogs=0;const rename=d=>{dialogs++;d.accept(d.type()==='prompt'?'source':undefined)};page.on('dialog',rename);
   await page.getByRole('button',{name:'Rename src',exact:true}).click();await idle(page);page.off('dialog',rename);assert.equal(dialogs,2);
   await page.waitForFunction(()=>window.AntigravityApp.editor.activeFilename==='source/lib/one.js');
   page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Delete source',exact:true}).click();await idle(page);assert.ok(await page.getByRole('button',{name:'source/lib/one.js',exact:true}).count());
   // An old review must fail after switching to a different project, even with matching path/content.
   const review=await page.evaluate(()=>{const e=window.AntigravityApp.editor,s=e.getFileSnapshot('main.js');return {targetFilename:'main.js',baseRevision:s.revision,baseContent:s.content,proposedContent:'// never apply',workspaceId:s.workspaceId,workspaceToken:s.workspaceToken}});
   await page.locator('#workspaceProject').selectOption('legacy');await idle(page);assert.equal(await page.evaluate(r=>window.AntigravityApp.editor.applyReviewedChange(r).applied,review),false);
   await page.locator('#workspaceProject').selectOption(first);await idle(page);
   const downloadWait=page.waitForEvent('download');await page.locator('#workspaceExport').click();const download=await downloadWait;const backupPath=path.join(out,`projects-${width}.json`);await download.saveAs(backupPath);const backup=JSON.parse(fs.readFileSync(backupPath,'utf8'));assert.equal(backup.schemaVersion,3);assert.equal(backup.parts[0].payload.projects.length,2);
   page.once('dialog',d=>d.accept());await page.locator('#workspaceImportFile').setInputFiles(backupPath);await idle(page);await page.waitForFunction(()=>window.AntigravityApp.workspace.state.projects.length===4);
   const legacy={format:'melly-ide-workspace',schemaVersion:1,exportedAt:new Date().toISOString(),files:[{filename:'main.js',content:'// imported v1\n',revision:3,updatedAt:new Date().toISOString()}],settings:{activeFilename:'main.js'}};
   page.once('dialog',d=>d.accept());await page.locator('#workspaceImportFile').setInputFiles({name:'v1.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(legacy))});await idle(page);await page.waitForFunction(()=>window.AntigravityApp.workspace.state.projects.length===5);
   assert.deepEqual(await legacyRecords(page),before);
   await ctx.setOffline(true);await page.reload();await ready(page);await navigateLegacy(page,'studio');assert.equal(await page.locator('#editorTextarea').inputValue(),'export const one = 1;\n');await save(page,'export const one = 2; // offline\n');
   await page.reload();await ready(page);await navigateLegacy(page,'studio');assert.match(await page.locator('#editorTextarea').inputValue(),/offline/);
   const controls=await page.evaluate(()=>[...document.querySelectorAll('.real-workspace button,.real-workspace select,.real-workspace input')].filter(e=>e.getClientRects().length&&!e.disabled).map(e=>({label:e.getAttribute('aria-label')||e.textContent.trim()||e.labels?.[0]?.textContent,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height,right:e.getBoundingClientRect().right})));
   assert.ok(controls.every(c=>c.label&&c.w>=43.9&&c.h>=43.9&&c.right<=width+1));
   await page.screenshot({path:path.join(out,'shots',`workspace-${width}.png`),fullPage:true});assert.deepEqual(errors,[]);
  }finally{await ctx.close();}
 });
 await scenario('workspace browser: concurrent tabs detect storage conflict and preserve unsaved recovery copy',async()=>{
  const ctx=await browser.newContext({acceptDownloads:true});const a=await ctx.newPage();await a.goto(base);await ready(a);await navigateLegacy(a,'studio');await newProject(a,'Concurrent');await save(a,'// original\n');
  const b=await ctx.newPage();await b.goto(base);await ready(b);await b.evaluate(()=>window.AntigravityApp.workspace.mutate(next=>{next.projects[0].name='Other tab'}));
  await a.locator('#editorTextarea').fill('// preserve in memory\n');await a.locator('#editorSaveBtn').click();await a.waitForFunction(()=>window.AntigravityApp.editor.getSaveState().status==='failed');assert.equal(await a.locator('#editorTextarea').inputValue(),'// preserve in memory\n');
  const wait=a.waitForEvent('download');await a.locator('#workspaceRecovery').click();const d=await wait;const dest=path.join(out,'conflict-recovery.json');await d.saveAs(dest);assert.ok(fs.readFileSync(dest,'utf8').includes('preserve in memory'));await ctx.close();
 });
 await scenario('GitHub LIVE browser: metadata, branch/commit, SHA-verified source, real diff and offline saved revision',async()=>{
  const ctx=await browser.newContext({viewport:{width:1280,height:900}});const page=await ctx.newPage();
  try{
   await page.goto(base);await ready(page);await navigateLegacy(page,'studio');await page.getByText('Browse public GitHub',{exact:true}).click();
   await page.locator('#githubBrowse').click();await idle(page);assert.match(await page.locator('#githubMetadata').innerText(),/octocat\/Hello-World/,await page.locator('#workspaceStatus').innerText());
   assert.ok(await page.locator('#githubBranch option').count());assert.ok(await page.locator('#githubCommit option').count());
   const sha=await page.locator('#githubCommit').inputValue();await page.locator('#githubTreeButton').click();await idle(page);assert.ok(await page.locator('#githubTree button').count());
   const remotePath=await page.locator('#githubTree button').first().innerText();page.once('dialog',d=>d.accept());await page.locator('#githubTree button').first().click();await idle(page);
   const entry=await page.evaluate(()=>window.AntigravityApp.workspace.project().entries.find(e=>e.kind==='file'));assert.equal(entry.source.commit,sha);assert.equal(entry.path,remotePath);assert.equal(await page.locator('#editorTextarea').inputValue(),entry.baseContent);
   await save(page,entry.content+'\n// local working copy\n');await page.locator('#workspaceDiff summary').click();await page.waitForFunction(()=>document.querySelector('#workspaceDiffText').textContent.includes('+// local working copy'));assert.match(await page.locator('#workspaceDiffText').innerText(),/\+\/\/ local working copy/);
   fs.writeFileSync(path.join(out,'github-live.json'),JSON.stringify({repository:'octocat/Hello-World',commit:sha,path:entry.path,blob:entry.source.blob,original:entry.baseContent,verifiedAt:new Date().toISOString()},null,2));
   await page.screenshot({path:path.join(out,'shots','github-live.png'),fullPage:true});await ctx.setOffline(true);await page.reload();await ready(page);await navigateLegacy(page,'studio');assert.match(await page.locator('#editorTextarea').inputValue(),/local working copy/);assert.equal(await page.evaluate(()=>window.AntigravityApp.workspace.project().entries.find(e=>e.kind==='file').source.commit),sha);
  }finally{await ctx.close();}
 });
 await scenario('workspace browser: failed transaction preserves persisted generation and project contents',async()=>{
  const ctx=await browser.newContext();const page=await ctx.newPage();try{
   await page.goto(base);await ready(page);await navigateLegacy(page,'studio');await newProject(page,'Atomic');
   const result=await page.evaluate(async()=>{const w=window.AntigravityApp.workspace,before=await w.store.raw(),put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='state')throw new Error('Injected workspace write failure');return put.apply(this,args)};let error;try{await w.mutate(next=>{next.projects[0].name='Must not persist'})}catch(e){error=e.message}finally{IDBObjectStore.prototype.put=put}return {before,after:await w.store.raw(),name:w.state.projects[0].name,error}});
   assert.deepEqual(result.before,result.after);assert.equal(result.name,'Atomic');assert.match(result.error,/Injected/);
  }finally{await ctx.close()}
 });
 await scenario('workspace browser: future schema is preserved and recovery excludes unknown fields',async()=>{
  const ctx=await browser.newContext({acceptDownloads:true});const seed=await ctx.newPage();await seed.goto(base);await ready(seed);
  await seed.evaluate(()=>new Promise((resolve,reject)=>{const db=window.AntigravityApp.workspace.store.db,tx=db.transaction('state','readwrite');tx.objectStore('state').put({schemaVersion:99,generation:12,providerToken:'omit-me',projects:[{name:'Recovery',entries:[{path:'main.js',kind:'file',content:'// recover me',providerToken:'omit-me'}]}]},'workspace');tx.oncomplete=resolve;tx.onerror=reject}));
  await seed.reload();await seed.waitForFunction(()=>window.AntigravityApp?.editor?.persistenceReady&&document.querySelector('#workspaceStatus')?.textContent.includes('Unsupported'));await navigateLegacy(seed,'studio');
  const download=seed.waitForEvent('download');await seed.locator('#workspaceRecovery').click();const d=await download,dest=path.join(out,'future-schema-recovery.json');await d.saveAs(dest);const text=fs.readFileSync(dest,'utf8');assert.ok(text.includes('recover me'));assert.ok(!text.includes('omit-me'));assert.equal(await seed.evaluate(()=>window.AntigravityApp.workspace.store.raw().then(r=>r.schemaVersion)),99);await ctx.close();
 });
 await scenario('local server: backend, Git, node_modules and sensitive paths are unavailable',async()=>{
  for(const target of ['.git/config','package-lock.json','convex/schema.ts','server/cortex.ts','.env','node_modules/@cortexmemory/sdk/package.json'])assert.equal((await fetch(base+target)).status,404,target);
  const manifest=await (await fetch(base+'manifest.webmanifest')).json();assert.deepEqual(manifest.icons.map(i=>i.sizes),['192x192','512x512']);
 });
})().catch(error=>{results.push({name:'runner',status:'FAIL',error:error.stack});console.error(error);}).finally(async()=>{await browser?.close();server?.kill();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));if(results.some(r=>r.status==='FAIL'))process.exitCode=1;});
