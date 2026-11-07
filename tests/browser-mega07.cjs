// MEGA-07 rendered UI checks with an explicitly MOCK native bridge: save-failure states,
// external-change conflict review, deleted files, restart recovery panel, interrupted-save
// notice and the Diagnostics tab. Real disk behaviour is covered by the Rust fault-injection
// suite and the native harness; nothing here touches a real file.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=process.cwd(),out=process.env.MEGA07_AUDIT_DIR;
if(!out || path.resolve(out).startsWith(root+path.sep))throw Error('External evidence directory required');
fs.mkdirSync(out,{recursive:true});const results=[],fixture='\uFEFF// żółć 日本語 🟣\r\nlet x=1;\r\n';
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64);
const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://x').pathname.slice(1)||'index.html',file=path.join(root,name);if(name.includes('..')||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404).end();return;}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));});
async function scenario(name,fn){try{await fn();results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:e.stack});}console.log(results.at(-1).status,name);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));}
const MOCK=`(text)=>{const f=window.AntigravityApp.localFolder;window.mockDisk={content:text,version:'${A}',exists:true,calls:[],failNext:null,interrupted:[]};
f.invoke=async(command,args)=>{const d=window.mockDisk;d.calls.push(command);
 if(command==='folder_open')return{sessionId:'synthetic',name:'disposable',recoveryKey:'qa-mega07-root'};
 if(command==='folder_close')return null;
 if(command==='folder_list')return{entries:[{name:'unicode.ts',path:'unicode.ts',kind:'file'}]};
 if(command==='folder_version')return{path:args.path,exists:d.exists,version:d.exists?d.version:'',bytes:d.content.length,interrupted:d.interrupted};
 if(command==='folder_read'){if(!d.exists)throw Error('Missing file or directory. Refresh the folder or select it again.');return{path:args.path,content:d.content,bytes:d.content.length,version:d.version,interrupted:d.interrupted};}
 if(command==='folder_save'){if(d.failNext){const m=d.failNext;d.failNext=null;throw Error(m);}if(!d.exists)throw Error('MISSING: Missing file.');if(args.expectedVersion!==d.version)throw Error('CONFLICT: File changed on disk.');d.content=args.content;d.version='${B}';return{path:args.path,content:d.content,version:d.version,bytes:d.content.length};}
 if(command==='folder_discard_interrupted'){d.interrupted=d.interrupted.filter(a=>a.path!==args.artifact);return d.interrupted;}
 if(command==='folder_restore_interrupted'){const a=d.interrupted.find(x=>x.path===args.artifact);d.exists=true;d.content='restored original';d.version=a.version;d.interrupted=d.interrupted.filter(x=>x!==a);return{path:args.path,content:d.content,bytes:d.content.length,version:d.version,interrupted:d.interrupted};}
 throw Error('unknown command '+command);};}`;
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{for(const width of [390,1280]){
 const context=await browser.newContext({viewport:{width,height:900},acceptDownloads:true});await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());
 const status=()=>p.locator('#folderPreviewEditor [data-editor-id="editorSaveStatus"]').innerText();
 const saves=()=>p.evaluate(()=>mockDisk.calls.filter(c=>c==='folder_save').length);
 async function open(){await p.goto(base);await p.waitForFunction(()=>window.AntigravityApp?.workspace?.ready);await p.locator('.primary-navigation [data-route="code"]').click();await p.evaluate(`(${MOCK})(${JSON.stringify(fixture)})`);await p.locator('#localFolderOpen').click();await p.getByRole('treeitem',{name:'file: unicode.ts',exact:true}).click();}
 await open();
 await scenario(`MOCK ${width}: each native save failure keeps the buffer and shows a specific state`,async()=>{
  const textarea=p.locator('#folderPreviewEditor textarea');
  for(const [error,label] of [['LOCKED: The file is locked by another program (sharing violation). Close it there and retry. Nothing was written.','SAVE FAILED · FILE LOCKED'],['ACCESS_DENIED: Access denied by Windows permissions. Nothing was written.','SAVE FAILED · ACCESS DENIED'],['READ_ONLY: The file has the Windows read-only attribute. Nothing was written.','SAVE FAILED · READ-ONLY']]){
   await textarea.fill('edit for '+label);await p.evaluate(e=>{mockDisk.failNext=e;},error);await p.locator('[data-editor-id="editorSaveBtn"]').click();
   await p.waitForFunction(l=>document.querySelector('#folderPreviewEditor [data-editor-id="editorSaveStatus"]').textContent===l,label);
   assert.equal(await textarea.inputValue(),'edit for '+label);assert.equal(await p.evaluate(()=>mockDisk.content.startsWith('\uFEFF')),true,'disk untouched');
   assert.equal(await p.locator('[data-editor-id="editorSaveBtn"]').isDisabled(),false,'retry stays possible');assert.match(await p.locator('#localFolderStatus').innerText(),new RegExp(error.split(':')[0]));
  }
  await p.locator('[data-editor-id="editorSaveBtn"]').click();await p.waitForFunction(()=>document.querySelector('#folderPreviewEditor [data-editor-id="editorSaveStatus"]').textContent==='SAVED ON DISK');
 });
 await scenario(`MOCK ${width}: external change while dirty is detected automatically and reviewed explicitly`,async()=>{
  await p.locator('#folderPreviewEditor textarea').fill('mine line 1\nmine line 2');await p.evaluate(v=>{mockDisk.content='disk line 1\nchanged by another editor';mockDisk.version=v;},C);
  await p.waitForFunction(()=>document.querySelector('#folderPreviewEditor [data-editor-id="editorSaveStatus"]').textContent==='DISK CONFLICT',null,{timeout:12000});
  assert.equal(await p.locator('[data-editor-id="editorSaveBtn"]').isDisabled(),true);assert.equal(await p.locator('#diskConflictDialog').evaluate(d=>d.open),false,'polling never opens a modal by itself');
  const before=await saves();
  await p.locator('#localConflictReview').click();await p.waitForFunction(()=>document.getElementById('diskConflictDialog').open);
  assert.equal(await p.evaluate(()=>document.activeElement.id),'diskConflictKeep','focus moves into the dialog');
  const dialogText=await p.locator('#diskConflictDialog').innerText();assert.match(dialogText,/mine line 1/);assert.match(dialogText,/changed by another editor/);
  await p.screenshot({path:path.join(out,`conflict-dialog-${width}.png`)});
  await p.keyboard.press('Escape');assert.equal(await p.locator('#diskConflictDialog').evaluate(d=>d.open),false,'Escape keeps the buffer');
  assert.equal(await p.evaluate(()=>mockDisk.content),'disk line 1\nchanged by another editor');
  await p.locator('#localConflictReview').click();await p.locator('#diskConflictRebase').click();
  assert.match(await status(),/UNSAVED/);assert.equal(await saves(),before,'rebase alone never saves');
  await p.locator('[data-editor-id="editorSaveBtn"]').click();await p.waitForFunction(()=>document.querySelector('#folderPreviewEditor [data-editor-id="editorSaveStatus"]').textContent==='SAVED ON DISK');
  assert.equal(await p.evaluate(()=>mockDisk.content),'mine line 1\nmine line 2');
 });
 await scenario(`MOCK ${width}: a clean buffer follows external changes; deletion disables Save`,async()=>{
  await p.evaluate(v=>{mockDisk.content='external clean update';mockDisk.version=v;},C);
  await p.waitForFunction(()=>document.querySelector('#folderPreviewEditor textarea').value==='external clean update',null,{timeout:12000});
  await p.locator('#folderPreviewEditor textarea').fill('typed before delete');await p.evaluate(()=>{mockDisk.exists=false;});
  await p.waitForFunction(()=>document.querySelector('#folderPreviewEditor [data-editor-id="editorSaveStatus"]').textContent==='DELETED ON DISK',null,{timeout:12000});
  assert.equal(await p.locator('[data-editor-id="editorSaveBtn"]').isDisabled(),true);assert.equal(await p.locator('#folderPreviewEditor textarea').inputValue(),'typed before delete');
 });
 await scenario(`MOCK ${width}: restart recovery panel lists stale and corrupt buffers and restores only on request`,async()=>{
  await p.evaluate(()=>{localStorage.setItem('melly.disk-buffer.v2:qa-mega07-root:broken.ts','{"v":2,"proj');});
  await p.locator('#localFolderClose').click();await open();
  await p.waitForSelector('#localRecoveryPanel:not([hidden]) li[data-recovery-path="unicode.ts"]');
  assert.equal(await p.locator('li[data-recovery-path="broken.ts"]').getAttribute('data-relation'),'corrupt');
  assert.equal(await p.locator('li[data-recovery-path="broken.ts"] [data-recovery-action="restore"]').count(),0,'corrupt records cannot be restored');
  const before=await saves();
  assert.notEqual(await p.locator('#folderPreviewEditor textarea').inputValue(),'typed before delete','nothing restored automatically');
  await p.locator('li[data-recovery-path="broken.ts"] [data-recovery-action="discard"]').click();
  await p.waitForFunction(()=>!document.querySelector('li[data-recovery-path="broken.ts"]'));
  assert.equal(await p.evaluate(()=>localStorage.getItem('melly.disk-buffer.v2:qa-mega07-root:broken.ts')),null);
  await p.locator('li[data-recovery-path="unicode.ts"] [data-recovery-action="restore"]').click();
  assert.equal(await p.locator('#folderPreviewEditor textarea').inputValue(),'typed before delete');
  assert.equal(await saves(),before,'restore never writes disk');
  await p.screenshot({path:path.join(out,`recovery-${width}.png`),fullPage:true});
 });
 await scenario(`MOCK ${width}: interrupted-save artifacts are reported with explicit restore/discard`,async()=>{
  await p.evaluate(v=>{mockDisk.interrupted=[{path:'.unicode.ts.melly-backup-0123456789ab',kind:'original',bytes:18,version:v}];},A);
  await p.locator('#localFileReload').click();
  await p.waitForSelector('#localInterrupted:not([hidden])');assert.match(await p.locator('#localInterrupted').innerText(),/Interrupted save detected/);
  await p.locator('#localInterrupted [data-action="discard"]').click();await p.waitForFunction(()=>document.getElementById('localInterrupted').hidden);
  assert.ok(await p.evaluate(()=>mockDisk.calls.includes('folder_discard_interrupted')));
 });
 await scenario(`MOCK ${width}: Diagnostics tab is keyboard reachable and exports codes only`,async()=>{
  await p.locator('.primary-navigation [data-route="devcenter"]').click();await p.locator('#devTab-agents').click();await p.locator('#devTab-agents').press('ArrowRight');
  assert.equal(await p.evaluate(()=>document.activeElement.id),'devTab-diagnostics');
  await p.waitForSelector('#diagEvents li[data-category="save"]');const text=await p.locator('#devPanel-diagnostics').innerText();
  assert.match(text,/FAILED_LOCKED/);assert.match(text,/EXTERNAL_CHANGE/);assert.match(text,new RegExp('Melly IDE '+require('../package.json').version.replace(/\./g,'\\.')+' '));
  const [download]=await Promise.all([p.waitForEvent('download'),p.locator('#diagExport').click()]);const file=path.join(out,`diagnostics-export-${width}.json`);await download.saveAs(file);
  const raw=fs.readFileSync(file,'utf8'),report=JSON.parse(raw);assert.equal(report.schema,'melly-diagnostics/1');
  for(const leak of ['unicode.ts','mine line','typed before delete','external clean update','żółć','disposable','qa-mega07-root'])assert.ok(!raw.includes(leak),`export leaked ${leak}`);
  assert.ok(report.events.some(e=>e.code==='FAILED_LOCKED'));
  await p.screenshot({path:path.join(out,`diagnostics-${width}.png`),fullPage:true});
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal page scroll');assert.deepEqual(errors,[]);
  await p.locator('.primary-navigation [data-route="code"]').click();await p.locator('#localFolderClose').click();
 });
 await context.close();
}}
finally{await browser.close();await new Promise(r=>server.close(r));}if(results.some(r=>r.status==='FAIL'))process.exitCode=1;})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
