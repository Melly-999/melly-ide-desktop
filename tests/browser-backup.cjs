async function navigateLegacy(page, view) { await page.locator('#moreMenu').evaluate(e => e.open = true); await page.locator('[data-view="'+view+'"]').click(); }
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=process.env.T12_AUDIT_DIR||path.join(require('node:os').tmpdir(),'melly-ide-t1-2');fs.mkdirSync(path.join(out,'shots'),{recursive:true});
const results=[];let browser;
const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://localhost').pathname;const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}fs.readFile(file,(err,data)=>{if(err){res.writeHead(404).end();return;}res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',file.endsWith('.png')?'image/png':file.endsWith('.webmanifest')?'application/manifest+json':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(data);});});
const ready=page=>page.waitForFunction(()=>window.AntigravityApp?.editor.persistenceReady&&document.querySelector('#offlineShellStatus').dataset.ready==='true');
async function pick(page,text){await page.locator('#backupInput').setInputFiles({name:'test.mellyide.json',mimeType:'application/json',buffer:Buffer.from(text)});}
async function raw(page){return page.evaluate(()=>window.AntigravityApp.editor.fileStore.readBackupRecords().then(r=>r.records));}
async function exportText(page,button='#backupExport') {const wait=page.waitForEvent('download');await page.locator(button).click();const download=await wait;assert.match(download.suggestedFilename(),/\.mellyide\.json$/);const dest=path.join(out,download.suggestedFilename());await download.saveAs(dest);return fs.readFileSync(dest,'utf8');}
(async()=>{
await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
for(const [width,height] of [[390,844],[1280,900]]){
 const ctx=await browser.newContext({viewport:{width,height},acceptDownloads:true});const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await ready(page);
  await page.evaluate(async()=>{const e=window.AntigravityApp.editor;e.updateFileContent('main.js','// Zażółć 🟣\n\n');e.updateFileContent('NetworkService.swift','// keep Swift\n');e.refreshEditorAfterStorageChange();await e.saveFile('main.js');await e.saveFile('NetworkService.swift');e.refreshEditorAfterStorageChange();localStorage.setItem('provider-key-fixture','do-not-export');});
  await navigateLegacy(page,'hub');const text=await exportText(page);const backup=JSON.parse(text);
  assert.equal(backup.files[0].content,'// Zażółć 🟣\n\n');assert.ok(!text.includes('do-not-export'));
  await ctx.setOffline(true);assert.equal((await page.reload()).fromServiceWorker(),true);await ready(page);await navigateLegacy(page,'hub');
  assert.deepEqual(JSON.parse(await exportText(page)).files.map(r=>r.content),backup.files.map(r=>r.content));
  await page.evaluate(async()=>{const e=window.AntigravityApp.editor;e.updateFileContent('main.js','// existing conflict');e.refreshEditorAfterStorageChange();await e.saveFile('main.js');e.refreshEditorAfterStorageChange();});
  const before=await raw(page);await pick(page,text);await page.locator('#backupDialog').waitFor({state:'visible'});await page.waitForFunction(()=>!window.AntigravityApp.backup.busy);await page.locator('#backupDialog').waitFor({state:'visible'});assert.match(await page.locator('#backupPreview').innerText(),/CONFLICT/);
  await page.keyboard.press('Escape');assert.deepEqual(await raw(page),before);
  await pick(page,text);await page.locator('#backupDialog').waitFor({state:'visible'});await page.waitForFunction(()=>!window.AntigravityApp.backup.busy);await page.locator('#backupKeep').click();assert.deepEqual(await raw(page),before);
  await pick(page,text);await page.locator('#backupDialog').waitFor({state:'visible'});await page.waitForFunction(()=>!window.AntigravityApp.backup.busy);await page.locator('#backupPreview input[value="main.js"]').check();
  await page.locator('#backupDialog').screenshot({path:path.join(out,'shots',`${width}-preview.png`)});
  await page.locator('#backupApply').click();await page.waitForFunction(()=>document.querySelector('#backupStatus').textContent.startsWith('Imported'));
  assert.equal(await page.evaluate(()=>window.AntigravityApp.editor.files['main.js']),backup.files[0].content);
  assert.deepEqual((await raw(page)).find(r=>r.filename==='NetworkService.swift'),before.find(r=>r.filename==='NetworkService.swift'));
  await page.reload();await ready(page);assert.equal(await page.evaluate(()=>window.AntigravityApp.editor.files['main.js']),backup.files[0].content);await navigateLegacy(page,'hub');
  for(const value of ['{invalid',JSON.stringify({...backup,schemaVersion:999}),JSON.stringify({...backup,files:[backup.files[0],backup.files[0]]}),JSON.stringify({...backup,files:[{...backup.files[0],filename:'../.env'}]}),' '.repeat(2*1024*1024+1)]){
   const baseline=await raw(page);await pick(page,value);await page.waitForFunction(()=>!window.AntigravityApp.backup.busy);assert.equal(await page.locator('#backupDialog').isVisible(),false);assert.deepEqual(await raw(page),baseline);
  }
  // Abort after the first queued put; IndexedDB must roll back the entire transaction.
  await page.evaluate(()=>{const original=IDBObjectStore.prototype.put;let count=0;window.restorePut=()=>IDBObjectStore.prototype.put=original;IDBObjectStore.prototype.put=function(...args){if(++count===2)throw new Error('Injected second write failure');return original.apply(this,args);};});
  const failedBefore=await raw(page);await pick(page,text);await page.locator('#backupDialog').waitFor({state:'visible'});await page.waitForFunction(()=>!window.AntigravityApp.backup.busy);for(const box of await page.locator('#backupPreview input').all())await box.check();await page.locator('#backupApply').click();await page.waitForFunction(()=>!window.AntigravityApp.backup.busy);assert.match(await page.locator('#backupError').innerText(),/Injected/);assert.deepEqual(await raw(page),failedBefore);await page.locator('#backupCancel').click();await page.evaluate(()=>window.restorePut());
  // Stale stored data from another writer must not be replaced.
  await pick(page,text);await page.locator('#backupDialog').waitFor({state:'visible'});await page.waitForFunction(()=>!window.AntigravityApp.backup.busy);await page.locator('#backupPreview input[value="main.js"]').check();await page.evaluate(async()=>{const store=window.AntigravityApp.editor.fileStore;await store.saveFile({filename:'main.js',content:'// another writer',revision:80});});
  await page.locator('#backupApply').click();await page.waitForFunction(()=>!window.AntigravityApp.backup.busy);assert.match(await page.locator('#backupError').innerText(),/Stored file changed/);await page.locator('#backupCancel').click();
  // Recover an unsupported record without deleting or silently rewriting it.
  await page.evaluate(()=>new Promise((resolve,reject)=>{const db=window.AntigravityApp.editor.fileStore.db;const tx=db.transaction('files','readwrite');tx.objectStore('files').put({filename:'main.js',schemaVersion:99,content:'// raw recoverable\n',revision:91,updatedAt:'2026-10-22T12:00:00Z',providerToken:'omit-me'});tx.oncomplete=resolve;tx.onabort=reject;}));
  await page.reload();await ready(page);await navigateLegacy(page,'hub');const recoverBefore=await raw(page);const recovery=JSON.parse(await exportText(page,'#backupRecovery'));assert.equal(recovery.records.find(r=>r.filename==='main.js').content,'// raw recoverable\n');assert.ok(!JSON.stringify(recovery).includes('omit-me'));assert.deepEqual(await raw(page),recoverBefore);
  await pick(page,text);await page.locator('#backupDialog').waitFor({state:'visible'});await page.waitForFunction(()=>!window.AntigravityApp.backup.busy);await page.locator('#backupPreview input[value="main.js"]').check();await page.locator('#backupApply').click();await page.waitForFunction(()=>!window.AntigravityApp.backup.busy);assert.equal(await page.evaluate(()=>window.AntigravityApp.editor.recoveryRequired['main.js']),false);
  await page.evaluate(()=>{const e=window.AntigravityApp.editor;e.updateFileContent('main.js','const password = "private-password";');e.refreshEditorAfterStorageChange()});await page.locator('#backupExport').click();await page.waitForFunction(()=>!window.AntigravityApp.backup.busy);assert.match(await page.locator('#backupStatus').innerText(),/credential/);
  await page.locator('.workspace-backup').screenshot({path:path.join(out,'shots',`${width}-backup.png`)});
  assert.deepEqual(errors,[]);results.push({viewport:`${width}x${height}`,status:'PASS',checks:['download exact contents','offline export/import','cancel/keep','selective replacement','reload','invalid/schema/duplicate/path/size','atomic abort','stale storage','raw recovery','secret exclusion']});console.log('PASS backup interactions',width);
 }catch(error){results.push({viewport:`${width}x${height}`,status:'FAIL',error:error.stack});console.error(error);}finally{await ctx.close();}
}
})().finally(async()=>{await browser?.close();server.close();fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify(results,null,2));if(results.length!==2||results.some(r=>r.status==='FAIL'))process.exitCode=1;});
