async function navigateLegacy(page, view) { await page.locator('#moreMenu').evaluate(e => e.open = true); await page.locator('[data-view="'+view+'"]').click(); }
// Real Service Worker tests: isolated storage, loopback origin, no repository mutation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname,'..');
const out = process.env.T11_AUDIT_DIR || path.join(require('node:os').tmpdir(),'melly-ide-t1-1');
fs.mkdirSync(path.join(out,'shots'),{recursive:true});
const results=[];const evidence=[];let browser;let shell;
const saveEvidence=()=>{
  fs.writeFileSync(path.join(out,'offline-results.json'),JSON.stringify(results,null,2));
  fs.writeFileSync(path.join(out,'worker-cache-evidence.json'),JSON.stringify(evidence,null,2));
};
async function scenario(name,run) {
  try{await run();results.push({name,status:'PASS'});console.log('PASS',name);}
  catch(error){results.push({name,status:'FAIL',error:error.stack});console.error('FAIL',name,error.message);}
  saveEvidence();
}
async function waitUntil(predicate,label) {
  for(let i=0;i<150;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,100));}
  throw new Error('Timed out: '+label);
}
async function createSite(prefix='/') {
  const state={version:1,failAsset:null,requests:[]};
  const allowed=new Set([...shell.SHELL_ASSETS,'sw.js']);
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');state.requests.push({path:url.pathname,version:state.version,method:req.method});
    if(!url.pathname.startsWith(prefix)){res.writeHead(404).end();return;}
    const asset=url.pathname.slice(prefix.length)||'index.html';
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Test-Generation',String(state.version));
    if(asset==='private-note'){res.setHeader('Content-Type','text/plain');res.end('private fixture; never cache');return;}
    if(asset===state.failAsset){res.writeHead(503,{'Content-Type':'text/plain'}).end('Deliberate essential-asset failure');return;}
    if(!allowed.has(asset)){res.writeHead(404).end();return;}
    fs.readFile(path.join(root,asset),(error,source)=>{
      if (source && !asset.endsWith('.png')) source=source.toString('utf8');
      if(error){res.writeHead(404).end();return;}
      if(asset==='js/offline-shell.js')source=source.replace(shell.SHELL_VERSION,state.version===1?shell.SHELL_VERSION:'v99-20261022');
      if(asset==='sw.js')source+=`\n// isolated browser fixture generation ${state.version}\n`;
      if(asset==='index.html')source=source.replace('</head>',`<meta name="test-shell-generation" content="${state.version}"></head>`);
      if(asset==='js/app.js')source+=`\nwindow.__offlineTestGeneration = ${state.version};\n`;
      res.setHeader('Content-Type',asset.endsWith('.png')?'image/png':asset.endsWith('.webmanifest')?'application/manifest+json':asset.endsWith('.css')?'text/css':asset.endsWith('.js')?'text/javascript':'text/html');res.end(source);
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {state,server,base:`http://127.0.0.1:${server.address().port}${prefix}`,async close(){await new Promise(resolve=>server.close(resolve));}};
}
async function fixture(width=390,height=844,prefix='/') {
  const site=await createSite(prefix);const ctx=await browser.newContext({viewport:{width,height},hasTouch:width<768});
  const page=await ctx.newPage();const errors=[];const consoleErrors=[];
  ctx.on('page',p=>{p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});});
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
  return {site,ctx,page,errors,consoleErrors,async close(){await ctx.close();await site.close();}};
}
async function appReady(page){await page.waitForFunction(()=>window.AntigravityApp?.editor?.persistenceReady);}
async function shellReady(page){await page.waitForFunction(()=>document.querySelector('#offlineShellStatus')?.dataset.ready==='true');}
async function install(f){await f.page.goto(f.site.base);await appReady(f.page);await shellReady(f.page);}
async function control(f){await f.page.reload();await appReady(f.page);await shellReady(f.page);assert.equal(await f.page.evaluate(()=>!!navigator.serviceWorker.controller),true);}
async function studio(page){await navigateLegacy(page,'studio');}
async function saved(page){await page.waitForFunction(()=>document.querySelector('#editorSaveStatus')?.textContent==='SAVED LOCALLY');}
async function screenshot(page,name){
  if(name==='D-offline-review') {
    await page.locator('.change-review-panel').screenshot({path:path.join(out,'shots',name+'.png'),animations:'disabled'});
    return;
  }
  if(!name.includes('accessories')) await page.evaluate(()=>window.scrollTo(0,0));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:path.join(out,'shots',name+'.png'),fullPage:false,animations:'disabled'});
}
async function statusEvidence(page,name){
  const data=await page.evaluate(async()=>{
    const registration=await navigator.serviceWorker.getRegistration();
    const inventory={};for(const name of await caches.keys()){const c=await caches.open(name);inventory[name]=(await c.keys()).map(r=>r.url);}
    return {url:location.href,title:document.title,controller:navigator.serviceWorker.controller?.scriptURL,active:registration?.active?.state,waiting:registration?.waiting?.state,scope:registration?.scope,status:document.querySelector('#offlineShellStatus')?.textContent,ready:document.querySelector('#offlineShellStatus')?.dataset.ready,inventory};
  });evidence.push({name,...data});return data;
}
(async()=>{
  shell=await import(pathToFileURL(path.join(root,'js/offline-shell.js')).href);
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  await scenario('A: complete installation, exact cache inventory and scoped registration under /ide/',async()=>{
    const f=await fixture(390,844,'/ide/');try{
      await install(f);const data=await statusEvidence(f.page,'A-initial-install');
      assert.equal(data.active,'activated');assert.equal(data.scope,f.site.base);assert.match(data.title,/Melly IDE/);
      const keys=Object.keys(data.inventory);assert.deepEqual(keys,[shell.shellCacheName(f.site.base)]);
      assert.deepEqual(data.inventory[keys[0]].sort(),shell.shellURLs(f.site.base).sort());
      await control(f);
      await f.page.evaluate(async()=>{await fetch('private-note');await fetch('private-note',{method:'POST',body:'fixture'});});
      const after=await statusEvidence(f.page,'A-no-arbitrary-request-caching');
      after.inventory[keys[0]].sort();
      assert.deepEqual(after.inventory,data.inventory);assert.deepEqual(f.errors,[]);assert.deepEqual(f.consoleErrors,[]);
      await screenshot(f.page,'A-scoped-online-ready');
    }finally{await f.close()}
  });
  await scenario('B/C/D: real offline reload, same-context reopen, review, autosave and reconnection',async()=>{
    const f=await fixture();try{
      await install(f);await control(f);await studio(f.page);
      const original='// T1.1 exact offline restore\nconst message = "Zażółć 🟣";\n';
      await f.page.locator('#editorTextarea').fill(original);await saved(f.page);
      await f.ctx.setOffline(true);
      const served=[];f.page.on('response',response=>{if(['script','stylesheet','document'].includes(response.request().resourceType()))served.push({url:response.url(),worker:response.fromServiceWorker()});});
      const response=await f.page.reload();assert.equal(response.fromServiceWorker(),true);
      await appReady(f.page);await shellReady(f.page);await studio(f.page);
      assert.equal(await f.page.locator('#editorTextarea').inputValue(),original);
      assert.ok(served.some(r=>r.url.endsWith('styles/main.css')&&r.worker));assert.ok(served.some(r=>r.url.endsWith('js/app.js')&&r.worker));
      assert.ok(served.every(r=>r.worker));evidence.push({name:'B-offline-resource-provenance',served});
      await statusEvidence(f.page,'B-offline-reload');await screenshot(f.page,'B-offline-editor-restored');
      await f.page.close();const reopened=await f.ctx.newPage();
      assert.equal((await reopened.goto(f.site.base)).fromServiceWorker(),true);await appReady(reopened);await shellReady(reopened);await studio(reopened);
      assert.equal(await reopened.locator('#editorTextarea').inputValue(),original);
      await statusEvidence(reopened,'C-offline-new-tab-same-storage');await screenshot(reopened,'C-offline-reopened');
      const before=await reopened.evaluate(()=>window.AntigravityApp.editor.files['NetworkService.swift']);
      for(const close of ['#reviewRejectBtn','#reviewCancelBtn']){
        await reopened.locator('.apply-to-editor-btn').first().click();
        assert.equal(await reopened.evaluate(()=>window.AntigravityApp.editor.files['NetworkService.swift']),before);
        await reopened.locator(close).click();assert.equal(await reopened.locator('#editorTextarea').inputValue(),original);
      }
      await reopened.locator('[data-file="NetworkService.swift"]').click();await reopened.locator('.apply-to-editor-btn').first().click();
      await reopened.locator('#editorTextarea').fill('// newer offline buffer');await reopened.locator('#reviewApproveBtn').click();
      assert.match(await reopened.locator('.review-error').innerText(),/Stale review rejected/);assert.equal(await reopened.locator('#editorTextarea').inputValue(),'// newer offline buffer');
      await reopened.locator('#reviewCancelBtn').click();await reopened.locator('.apply-to-editor-btn').first().click();
      const proposed=await reopened.locator('.review-proposed code').innerText();await screenshot(reopened,'D-offline-review');
      await reopened.locator('#reviewApproveBtn').click();await saved(reopened);
      assert.equal(await reopened.locator('#editorTextarea').inputValue(),proposed);
      await reopened.reload();await appReady(reopened);await shellReady(reopened);await studio(reopened);await reopened.locator('[data-file="NetworkService.swift"]').click();
      assert.equal(await reopened.locator('#editorTextarea').inputValue(),proposed);assert.equal(await reopened.evaluate(()=>window.AntigravityApp.editor.files['main.js']),original);
      await reopened.locator('#editorRunBtn').click();assert.match(await reopened.locator('#consoleOutput').innerText(),/was not run, compiled or tested/);
      await f.ctx.setOffline(false);await shellReady(reopened);assert.equal(await reopened.locator('#editorTextarea').inputValue(),proposed);
      await statusEvidence(reopened,'D-approved-offline-reload-and-reconnect');assert.deepEqual(f.errors,[]);
      // Chromium may report failed automatic update probes while explicitly offline.
      evidence.push({name:'B-D-console',errors:f.consoleErrors});
      assert.deepEqual(f.consoleErrors.filter(e=>!/ERR_INTERNET_DISCONNECTED/.test(e)),[]);
    }finally{await f.close()}
  });
  await scenario('E1: missing essential asset rejects installation, preserves files and unrelated cache, then retries',async()=>{
    const f=await fixture();f.site.state.failAsset='styles/onboarding.css';try{
      await f.page.goto(f.site.base);await appReady(f.page);
      await f.page.waitForFunction(()=>document.querySelector('#offlineShellStatus').dataset.state==='failed');
      assert.equal(await f.page.locator('#offlineShellStatus').getAttribute('data-ready'),'false');
      await studio(f.page);const content='// kept despite offline setup failure';await f.page.locator('#editorTextarea').fill(content);await saved(f.page);
      await f.page.evaluate(async()=>{const cache=await caches.open('unrelated-fixture-cache');await cache.put('/private-note',new Response('keep'));});
      const failed=await statusEvidence(f.page,'E1-failed-install');assert.deepEqual(Object.keys(failed.inventory),['unrelated-fixture-cache']);
      await screenshot(f.page,'E1-failed-setup-file-saved');
      f.site.state.failAsset=null;await f.page.reload();await appReady(f.page);await shellReady(f.page);await studio(f.page);
      assert.equal(await f.page.locator('#editorTextarea').inputValue(),content);
      assert.equal(await f.page.evaluate(async()=>await (await caches.open('unrelated-fixture-cache')).match('/private-note').then(r=>r.text())),'keep');
      assert.deepEqual(f.errors,[]);evidence.push({name:'E1-expected-503-console',errors:f.consoleErrors});
    }finally{await f.close()}
  });
  await scenario('E2: incomplete replacement cannot remove the working offline cache or saved files',async()=>{
    const f=await fixture();try{
      await install(f);await control(f);await studio(f.page);const content='// old shell survives failed replacement';await f.page.locator('#editorTextarea').fill(content);await saved(f.page);
      f.site.state.version=2;f.site.state.failAsset='styles/onboarding.css';
      await f.page.evaluate(async()=>{await (await navigator.serviceWorker.getRegistration()).update();});
      await f.page.waitForFunction(()=>document.querySelector('#offlineShellStatus').dataset.state==='update-failed');
      const data=await statusEvidence(f.page,'E2-incomplete-replacement');assert.equal(data.ready,'true');assert.deepEqual(Object.keys(data.inventory),[shell.shellCacheName(f.site.base)]);
      await f.ctx.setOffline(true);assert.equal((await f.page.reload()).fromServiceWorker(),true);await appReady(f.page);await shellReady(f.page);await studio(f.page);
      assert.equal(await f.page.locator('#editorTextarea').inputValue(),content);assert.equal(await f.page.evaluate(()=>window.__offlineTestGeneration),1);assert.deepEqual(f.errors,[]);
    }finally{await f.close()}
  });
  await scenario('F: new generation waits for all old tabs; coherent activation cleans only old owned cache',async()=>{
    const f=await fixture(1280,900);try{
      await install(f);await control(f);await studio(f.page);
      await f.page.evaluate(()=>{window.AntigravityApp.editor.autosaveDelay=60000;});
      const content='// unsaved update boundary\nconst preserve = 7;';await f.page.locator('#editorTextarea').fill(content);
      assert.equal(await f.page.locator('#editorSaveStatus').innerText(),'EDITED');
      await f.page.evaluate(async()=>{const cache=await caches.open('other-application-cache');await cache.put('/private-note',new Response('other app'));});
      const candidatePromise=f.ctx.waitForEvent('serviceworker');f.site.state.version=2;
      await f.page.evaluate(async()=>{await (await navigator.serviceWorker.getRegistration()).update();});const candidate=await candidatePromise;
      await f.page.waitForFunction(()=>document.querySelector('#offlineShellStatus').dataset.state==='update');
      assert.equal(await f.page.locator('#editorTextarea').inputValue(),content);assert.equal(await f.page.locator('#editorSaveStatus').innerText(),'EDITED');
      assert.equal(await f.page.evaluate(()=>window.__offlineTestGeneration),1);
      assert.equal(await f.page.evaluate(async()=> (await fetch('js/app.js')).headers.get('X-Test-Generation')),'1');
      const data=await statusEvidence(f.page,'F-v2-waiting-v1-editor-preserved');assert.equal(data.waiting,'installed');assert.equal(Object.keys(data.inventory).length,3);
      await screenshot(f.page,'F-update-waiting-unsaved-editor');
      await f.page.locator('#editorSaveBtn').click();await saved(f.page);
      const second=await f.ctx.newPage();await second.goto(f.site.base);await appReady(second);await shellReady(second);
      assert.equal(await second.evaluate(()=>window.__offlineTestGeneration),1);
      await f.page.close();assert.equal(await second.evaluate(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting),true);
      await second.close();
      await waitUntil(()=>candidate.evaluate(()=>!self.registration.waiting && self.registration.active?.state==='activated'),'new generation activation after all old tabs close');
      await f.ctx.setOffline(true);const updated=await f.ctx.newPage();assert.equal((await updated.goto(f.site.base)).fromServiceWorker(),true);await appReady(updated);await shellReady(updated);await studio(updated);
      assert.equal(await updated.evaluate(()=>window.__offlineTestGeneration),2);assert.equal(await updated.locator('meta[name=test-shell-generation]').getAttribute('content'),'2');
      assert.equal(await updated.evaluate(async()=> (await fetch('styles/main.css')).headers.get('X-Test-Generation')),'2');
      assert.equal(await updated.locator('#editorTextarea').inputValue(),content);
      const final=await statusEvidence(updated,'F-v2-active-offline');assert.deepEqual(Object.keys(final.inventory).sort(),['other-application-cache',shell.shellCacheName(f.site.base,'v99-20261022')].sort());assert.deepEqual(f.errors,[]);
    }finally{await f.close()}
  });
  for(const [width,height] of [[320,700],[390,844],[768,1024],[1280,900]]){
    await scenario(`G: offline responsive interactions ${width}x${height}`,async()=>{
      const f=await fixture(width,height);try{
        await install(f);await f.ctx.setOffline(true);await f.page.reload();await appReady(f.page);await shellReady(f.page);
        assert.equal(await f.page.locator('#offlineShellStatus').isVisible(),true);
        await navigateLegacy(f.page,'hub');await f.page.locator('[data-action=skills]').click();
        assert.equal(await f.page.locator('#hubModalWindow').evaluate(e=>e===document.activeElement),true);
        await f.page.keyboard.press('Escape');assert.equal(await f.page.locator('[data-action=skills]').evaluate(e=>e===document.activeElement),true);
        await studio(f.page);await f.page.locator('#editorTextarea').fill('// offline responsive '+width);await saved(f.page);
        const measure=await f.page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,clipped:[...document.querySelectorAll('.accessory-btn,#offlineShellStatus')].filter(e=>{const r=e.getBoundingClientRect();return r.left<0||r.right>innerWidth}).map(e=>e.id||e.className)}));
        assert.ok(measure.scrollWidth<=width);assert.deepEqual(measure.clipped,[]);evidence.push({name:`G-${width}`,measure});
        await f.page.locator('#offlineShellStatus').scrollIntoViewIfNeeded();await screenshot(f.page,`G-${width}-offline-status`);
        await f.page.locator('.mobile-accessory-bar').scrollIntoViewIfNeeded();await screenshot(f.page,`G-${width}-offline-editor-accessories`);
        assert.deepEqual(f.errors,[]);assert.deepEqual(f.consoleErrors.filter(e=>!/ERR_INTERNET_DISCONNECTED/.test(e)),[]);
      }finally{await f.close()}
    });
  }
})().catch(error=>{results.push({name:'runner',status:'FAIL',error:error.stack});console.error(error);}).finally(async()=>{
  await browser?.close();saveEvidence();console.log(JSON.stringify({passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,out}));
  if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
});
