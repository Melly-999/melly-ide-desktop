// M1.2 rendered integration with an explicitly MOCK native bridge. Real writes
// and OS protection are verified separately against the actual Windows binary.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=process.cwd(),out=process.env.MEGA05_AUDIT_DIR;
if(!out || path.resolve(out).startsWith(root+path.sep))throw Error('External evidence directory required');
fs.mkdirSync(out,{recursive:true});const results=[],fixture='\uFEFF// żółć 日本語 🟣\r\nlet x=1;\r\n';
const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://x').pathname.slice(1)||'index.html',file=path.join(root,name);if(name.includes('..')||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404).end();return;}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));});
async function scenario(name,fn){try{await fn();results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:e.stack});}console.log(results.at(-1).status,name);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));}
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{for(const width of [390,1280]){
 const context=await browser.newContext({viewport:{width,height:900}});await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());const p=await context.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('dialog',d=>d.accept());
 async function open(){await p.goto(base);await p.waitForFunction(()=>window.AntigravityApp?.workspace?.ready);await p.locator('.primary-navigation [data-route="code"]').click();await p.evaluate(text=>{const f=window.AntigravityApp.localFolder;window.mockDisk={content:text,version:'a'.repeat(64),calls:[]};f.invoke=async(command,args)=>{const d=window.mockDisk;d.calls.push(command);if(command==='folder_open')return{sessionId:'synthetic',name:'disposable',recoveryKey:'qa-root'};if(command==='folder_list')return{entries:[{name:'unicode.ts',path:'unicode.ts',kind:'file'}]};if(command==='folder_read')return{path:args.path,content:d.content,bytes:d.content.length,version:d.version};if(command==='folder_save'){if(args.expectedVersion!==d.version)throw Error('CONFLICT: File changed on disk');d.content=args.content;d.version='b'.repeat(64);return{content:d.content,version:d.version,bytes:d.content.length};}};},fixture);await p.locator('#localFolderOpen').click();await p.getByRole('treeitem',{name:'file: unicode.ts',exact:true}).click();}
 await open();const before=await p.evaluate(()=>window.AntigravityApp.workspace.store.raw());
 await scenario(`MOCK disk editing ${width}: exact Unicode/CRLF, dirty status, explicit Save`,async()=>{
  assert.equal(await p.evaluate(()=>AntigravityApp.localFolder.tabs.get('unicode.ts')),fixture);const textarea=p.locator('#folderPreviewEditor textarea');assert.equal(await textarea.getAttribute('readonly'),null);
  await textarea.fill(fixture.replace('x=1','x=2'));assert.match(await p.locator('[data-editor-id="editorSaveStatus"]').innerText(),/UNSAVED/);assert.equal(await p.evaluate(()=>mockDisk.calls.includes('folder_save')),false);
  assert.equal(await p.evaluate(()=>AntigravityApp.localFolder.preview.getFileSnapshot()),null);await p.locator('[data-editor-id="editorSaveBtn"]').click();await p.waitForFunction(()=>document.querySelector('[data-editor-id="editorSaveStatus"]').textContent==='SAVED ON DISK');
  assert.equal(await p.evaluate(()=>mockDisk.content),fixture.replace('x=1','x=2'));assert.deepEqual(await p.evaluate(()=>AntigravityApp.workspace.store.raw()),before);
 });
 await scenario(`MOCK conflict ${width}: external modification never overwritten`,async()=>{
  await p.locator('#folderPreviewEditor textarea').fill('my unsaved text');await p.evaluate(()=>{mockDisk.content='external';mockDisk.version='c'.repeat(64);});await p.locator('[data-editor-id="editorSaveBtn"]').click();await p.waitForFunction(()=>document.querySelector('[data-editor-id="editorSaveStatus"]').textContent==='DISK CONFLICT');assert.equal(await p.evaluate(()=>mockDisk.content),'external');assert.equal(await p.locator('#folderPreviewEditor textarea').inputValue(),'my unsaved text');
  await p.locator('#localFileReload').click();assert.equal(await p.locator('#folderPreviewEditor textarea').inputValue(),'external');
 });
 await scenario(`MOCK recovery ${width}: close and restart restores only after explicit action`,async()=>{
  await p.locator('#folderPreviewEditor textarea').fill('recover me 🟣');await p.locator('#localFolderClose').click();await open();assert.equal(await p.locator('#folderPreviewEditor textarea').inputValue(),fixture.replace(/\r\n/g,'\n'));assert.equal(await p.locator('#localBufferRestore').isVisible(),true);await p.locator('#localBufferRestore').click();assert.equal(await p.locator('#folderPreviewEditor textarea').inputValue(),'recover me 🟣');assert.match(await p.locator('[data-editor-id="editorSaveStatus"]').innerText(),/CONFLICT/);assert.equal(await p.evaluate(()=>mockDisk.calls.includes('folder_save')),false);
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(errors,[]);await p.screenshot({path:path.join(out,`disk-editing-${width}.png`),fullPage:true});await p.locator('#localFolderClose').click();
 });
 await context.close();
}}
finally{await browser.close();await new Promise(r=>server.close(r));}if(results.some(r=>r.status==='FAIL'))process.exitCode=1;})().catch(e=>{console.error(e.stack);server.close();process.exitCode=1;});
