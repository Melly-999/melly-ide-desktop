// Acceptance against the generated sanitized bundle, in fresh browser storage.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),out=process.env.UX02_AUDIT_DIR||path.join(require('node:os').tmpdir(),'melly-ux02');
fs.mkdirSync(path.join(out,'shots'),{recursive:true});
const results=[];let browser,server,base,bundle,shell;
async function scenario(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS',name);}catch(e){results.push({name,status:'FAIL',error:e.stack});console.error('FAIL',name,e.message);}fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));}
const ready=p=>p.waitForFunction(()=>window.AntigravityApp?.workspace?.ready&&document.querySelector('#offlineShellStatus').dataset.ready==='true');
const route=(p,name)=>p.evaluate(name=>AntigravityApp.switchView(name),name);
function layout(){const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';return{width:innerWidth,scroll:document.documentElement.scrollWidth,small:[...document.querySelectorAll('button,summary,input,select,textarea')].filter(visible).filter(e=>!e.disabled).filter(e=>{const r=e.getBoundingClientRect();return r.width<43.9||r.height<43.9}).map(e=>e.id||e.className),clipped:[...document.querySelectorAll('button,input,select,textarea')].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5}).map(e=>e.id||e.className)};}
(async()=>{
 const {buildPrivatePreview}=await import(pathToFileURL(path.join(root,'scripts/build-private-preview.mjs')));
 const {previewServer}=await import(pathToFileURL(path.join(root,'scripts/serve-private-preview.mjs')));
 shell=await import(pathToFileURL(path.join(root,'js/offline-shell.js')));
 bundle=await buildPrivatePreview(path.join(out,'sanitized-preview'));
 fs.writeFileSync(path.join(out,'bundle.json'),JSON.stringify({path:bundle.path,...bundle.manifest},null,2));
 server=previewServer(bundle.path);await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}/`;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 for(const [width,height] of [[320,700],[375,812],[390,844],[430,932],[768,1024],[1280,900],[1440,900],[844,390]])await scenario(`approved four surfaces, focus and layout ${width}x${height}`,async()=>{
  const ctx=await browser.newContext({viewport:{width,height},hasTouch:width<1100}),p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await ctx.tracing.start({screenshots:true,snapshots:true});
  try{
   await p.goto(base);await ready(p);assert.equal(await p.evaluate(()=>isSecureContext),true);
   assert.equal(await p.locator('#viewDashboard h1').innerText(),'Hello World');assert.equal(await p.locator('.view-nav-group').count(),0);
   for(const view of ['dashboard','code','tasks','assistant']){
    if(view==='assistant'){await p.locator('.primary-navigation [data-route=dashboard]').click();await p.locator('.dashboard-composer').click();}
    else await p.locator(`.primary-navigation [data-route=${view}]`).click();
    assert.equal(await p.evaluate(()=>AntigravityApp.shell.route),view);
    const a=await p.evaluate(layout);assert.ok(a.scroll<=width,`${view} overflow`);assert.deepEqual(a.small,[],`${view} small controls`);assert.deepEqual(a.clipped,[],`${view} clipped`);
    await p.screenshot({path:path.join(out,'shots',`${width}-${view}.png`),fullPage:true,animations:'disabled'});
   }
   assert.match(await p.locator('#viewAssistant').innerText(),/AI provider not connected/);assert.equal(await p.locator('#viewAssistant h1').evaluate(e=>e===document.activeElement),true);
   await p.locator('#assistantDraft').fill('Debug my local file without sending it');await p.locator('#assistantForm button').click();assert.equal(await p.locator('#connectionDialog').isVisible(),true);assert.match(await p.locator('#connectionDescription').innerText(),/No prompt is sent/);await p.keyboard.press('Escape');
   await p.reload();await ready(p);await route(p,'assistant');assert.equal(await p.locator('#assistantDraft').inputValue(),'Debug my local file without sending it');assert.equal(await p.locator('[role=log] h2').innerText(),'Your next idea starts here.');assert.equal(await p.locator('[role=log] .assistant-welcome').count(),1);
   await p.locator('#assistantUpgrade').click();assert.match(await p.locator('#connectionDescription').innerText(),/Subscriptions not available yet/);await p.keyboard.press('Escape');
   await route(p,'tasks');await p.locator('[data-filter=Integrations]').click();assert.equal(await p.locator('.agent-tool:visible').count(),2);await p.locator('[data-filter=All]').click();assert.equal(await p.locator('.agent-tool:visible').count(),11);
   await route(p,'code');await p.locator('[data-inspect=tests]').click();assert.match(await p.locator('#inspectionContent').innerText(),/^Not run/);await p.locator('[data-inspect=diff]').click();assert.match(await p.locator('#inspectionContent').innerText(),/Select a file/);
   assert.equal(await p.locator('.ios-status-bar,.status-time,.notch-island').count(),0);assert.equal(await p.locator('.brand-logo-icon').evaluate(e=>e.tagName),'IMG');assert.deepEqual(errors,[]);
  }finally{await ctx.tracing.stop({path:path.join(out,`trace-${width}.zip`)});await ctx.close();}
 });
 await scenario('sanitized bundle cache completeness, offline reopen and local editor save',async()=>{
  const ctx=await browser.newContext({viewport:{width:390,height:844}}),p=await ctx.newPage();
  try{
   await p.goto(base);await ready(p);await p.reload();await ready(p);
   const cached=await p.evaluate(async()=>{const names=await caches.keys(),cache=await caches.open(names[0]);return{names,urls:(await cache.keys()).map(r=>r.url)}});
   assert.deepEqual(cached.names,[shell.shellCacheName(base)]);assert.deepEqual(cached.urls.sort(),shell.shellURLs(base).sort());
   await route(p,'code');await p.locator('#editorTextarea').fill('// UX02 preserved offline 🟣\n');await p.locator('#editorSaveBtn').click();await p.waitForFunction(()=>AntigravityApp.editor.getSaveState().status==='saved');
   await ctx.setOffline(true);assert.equal((await p.reload()).fromServiceWorker(),true);await ready(p);await route(p,'code');assert.equal(await p.locator('#editorTextarea').inputValue(),'// UX02 preserved offline 🟣\n');
   await p.close();const reopened=await ctx.newPage();assert.equal((await reopened.goto(base)).fromServiceWorker(),true);await ready(reopened);await route(reopened,'code');assert.equal(await reopened.locator('#editorTextarea').inputValue(),'// UX02 preserved offline 🟣\n');
   fs.writeFileSync(path.join(out,'cache-completeness.json'),JSON.stringify(cached,null,2));
  }finally{await ctx.close();}
 });
 await scenario('private preview refuses secrets, backend, provenance source and path variants',async()=>{
  for(const url of ['.env.local','.git/config','server/dev.mjs','convex/schema.ts','node_modules/package.json','images/brand/approved-orbit-option-2-original.png','%2eenv.local','js/../.env.local','docs/MEGA-01.md','token.json'])assert.equal((await fetch(base+url)).status,404,url);
  for(const asset of bundle.manifest.assets){const r=await fetch(base+asset.path);assert.equal(r.status,200,asset.path);assert.equal(r.headers.get('x-content-type-options'),'nosniff');}
  const served=[];const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else served.push(path.relative(bundle.path,p).replaceAll('\\','/'));}};walk(bundle.path);assert.deepEqual(served.sort(),bundle.manifest.assets.map(a=>a.path).sort());
 });
 await scenario('keyboard viewport heuristic hides nav and preserves assistant draft',async()=>{
  const ctx=await browser.newContext({viewport:{width:390,height:844}}),p=await ctx.newPage();try{
   await p.goto(base+'#assistant');await ready(p);await p.locator('#assistantDraft').fill('Keep this keyboard draft');
   await p.evaluate(()=>{Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>400});visualViewport.dispatchEvent(new Event('resize'));});
   assert.equal(await p.locator('.primary-navigation').isVisible(),false);assert.equal(await p.locator('#assistantDraft').inputValue(),'Keep this keyboard draft');
   await p.screenshot({path:path.join(out,'shots','390-keyboard-heuristic.png'),fullPage:true});
   await p.evaluate(()=>{delete visualViewport.height;visualViewport.dispatchEvent(new Event('resize'));});assert.equal(await p.locator('.primary-navigation').isVisible(),true);
  }finally{await ctx.close();}
 });
 console.log(JSON.stringify({passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,out,bundle:bundle.path}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();await new Promise(r=>server?server.close(r):r());if(results.some(r=>r.status==='FAIL'))process.exitCode=1});
