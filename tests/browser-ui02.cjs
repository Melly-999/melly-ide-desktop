async function navigateLegacy(page, view) { await page.locator('#moreMenu').evaluate(e => e.open = true); await page.locator('[data-view="'+view+'"]').click(); }
// Real browser regression suite. Uses an existing Playwright installation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(process.env.UI02_REPO || path.join(__dirname, '..'));
const out = process.env.UI02_AUDIT_DIR || path.join(require('node:os').tmpdir(), 'melly-ide-ui-02');
fs.mkdirSync(path.join(out, 'shots'), { recursive: true });
const mime = {'.webmanifest':'application/manifest+json','.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'};
const server = http.createServer((req,res) => {
  const filename = path.resolve(root, '.' + decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/\/$/,'/index.html'));
  if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(filename,(err,data) => { if(err) res.writeHead(404).end(); else {res.setHeader('Content-Type',mime[path.extname(filename)] || 'application/octet-stream');res.end(data);} });
});
const results = [];
let browser;
async function scenario(name, action) {
  try { await action(); results.push({name,status:'PASS'}); console.log('PASS',name); }
  catch(error) { results.push({name,status:'FAIL',error:error.stack}); console.error('FAIL',name,error.message); }
  fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify(results,null,2));
}
const visibleAudit = () => {
  const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const controls = [...document.querySelectorAll('button,input,textarea,select')].filter(visible).filter(e=>!e.disabled);
  const small = controls.filter(e=>{const r=e.getBoundingClientRect();return r.width<43.9 || r.height<43.9}).map(e=>({id:e.id || e.className,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}));
  const unnamed = controls.filter(e=>!e.getAttribute('aria-label') && !e.textContent.trim() && !e.labels?.length).map(e=>e.id || e.className);
  const clipped = controls.filter(e=>{const r=e.getBoundingClientRect(); return r.left<-.5 || r.right>innerWidth+.5}).map(e=>e.id || e.className);
  return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,small,unnamed,clipped};
};
async function context(w,h) {
  const ctx=await browser.newContext({ viewport:{width:w,height:h},hasTouch:w<768,deviceScaleFactor:1 });
  const page=await ctx.newPage(); const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error') errors.push(m.text())});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>window.AntigravityApp?.editor?.persistenceReady);
  return {ctx,page,errors};
}
async function shot(page,name) { await page.screenshot({path:path.join(out,'shots',name+'.png'),fullPage:true,animations:'disabled'}); }
async function assertFocus(page,selector) { assert.equal(await page.locator(selector).evaluate(e=>e===document.activeElement),true,`focus ${selector}`); }
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  for(const [w,h] of [[320,700],[375,812],[390,844],[430,932],[768,1024],[1280,900],[1440,900]]) {
    await scenario(`viewport ${w}x${h}: onboarding, workspace, editor, review, targets and names`,async()=>{
      const {ctx,page,errors}=await context(w,h);
      try {
        const measurements={};
        for(const view of ['onboarding','hub','studio']) {
          await navigateLegacy(page,view);
          measurements[view]=await page.evaluate(visibleAudit);
          assert.ok(measurements[view].scrollWidth<=w,`${view} overflow`);
          assert.deepEqual(measurements[view].clipped,[],`${view} clipped controls`);
          assert.deepEqual(measurements[view].unnamed,[],`${view} unnamed controls`);
          assert.deepEqual(measurements[view].small,[],`${view} small touch controls`);
          await shot(page,`${w}x${h}-${view}`);
        }
        await page.locator('.apply-to-editor-btn').first().click();
        await assertFocus(page,'#changeReviewTitle');
        assert.equal(await page.locator('.change-review-panel').getAttribute('role'),'region');
        measurements.review=await page.evaluate(visibleAudit);
        assert.deepEqual(measurements.review.clipped,[]);
        await shot(page,`${w}x${h}-review`);
        await page.locator('#reviewCancelBtn').click();
        await navigateLegacy(page,'hub'); await page.locator('[data-action=skills]').click();
        assert.equal(await page.locator('#hubModalWindow').getAttribute('aria-modal'),'true');
        await shot(page,`${w}x${h}-skills-modal`);
        await page.keyboard.press('Escape');
        fs.writeFileSync(path.join(out,`measurements-${w}.json`),JSON.stringify(measurements,null,2));
        assert.deepEqual(errors,[],'console errors');
      } finally {await ctx.close()}
    });
  }
  for(const [w,h] of [[390,844],[1280,900]]) {
    await scenario(`keyboard, dialogs, palette, capability honesty ${w}x${h}`,async()=>{
      const {ctx,page,errors}=await context(w,h);
      try {
        await navigateLegacy(page,'hub');
        await page.locator('#hubMenuTrigger').focus();
        const actions=['screen-awareness','commands','extensions','projects','automations','agents','skills','mcp'];
        for(let i=0;i<actions.length;i++) {
          await page.keyboard.press('Tab'); const selector=`.feature-card[data-action="${actions[i]}"]`;
          await assertFocus(page,selector);
          await page.keyboard.press(i%2 ? 'Space' : 'Enter');
          await assertFocus(page,'#hubModalWindow');
          assert.equal(await page.locator('.app-master-header').evaluate(e=>e.inert),true);
          await page.keyboard.press('Shift+Tab');
          assert.equal(await page.locator('#hubModalWindow').evaluate(e=>e.contains(document.activeElement)),true);
          await page.keyboard.press('Tab'); await assertFocus(page,'#modalCloseBtn');
          await page.keyboard.press('Escape'); await assertFocus(page,selector);
          assert.equal(await page.locator('.app-master-header').evaluate(e=>e.inert),false);
        }
        await page.locator('[data-action=skills]').click();
        assert.match(await page.locator('.modal-desc').innerText(),/not used.*SIMULATED/);
        await page.locator('#modalCloseBtn').click(); await assertFocus(page,'[data-action=skills]');
        await page.locator('[data-action=projects]').click();
        assert.match(await page.locator('.modal-desc').innerText(),/No shared chat memory/);
        await page.keyboard.press('Escape');
        await page.locator('[data-action=agents]').click();
        assert.match(await page.locator('.modal-desc').innerText(),/SIMULATED/);
        await page.locator('.btn-select-persona').nth(1).click();
        await page.keyboard.press('Escape');
        await page.locator('#hubSearchTrigger').click(); await assertFocus(page,'#paletteInput');
        await page.locator('#paletteInput').fill('Explain');
        await page.keyboard.press('Tab'); await assertFocus(page,'#paletteClose');
        await page.keyboard.press('Tab'); await assertFocus(page,'.palette-item');
        await page.keyboard.press('Enter'); await assertFocus(page,'#hubModalWindow');
        await page.keyboard.press('Escape'); await assertFocus(page,'#hubSearchTrigger');
        await page.keyboard.press('Control+k'); await assertFocus(page,'#paletteInput');
        await page.keyboard.press('Escape'); await assertFocus(page,'#hubSearchTrigger');
        await page.locator('[data-action=commands]').click();
        assert.match(await page.locator('.modal-desc').innerText(),/no command is executed/i);
        await page.locator('.btn-run-cmd').first().click();
        await page.waitForFunction(()=>!document.querySelector('#viewStudio').style.display || document.querySelector('#viewStudio').style.display==='block');
        assert.match(await page.locator('.review-notice').innerText(),/No command was executed/);
        await page.waitForFunction(()=>document.querySelectorAll('.user-row').length>0);
        assert.match(await page.locator('.agent-banner-sub').innerText(),/SIMULATED/);
        assert.ok(!/Executing|Dispatched/.test(await page.locator('body').innerText()));
        assert.deepEqual(errors,[]);
      }finally{await ctx.close()}
    });
    await scenario(`review safety, IDB persistence, language, frame ${w}x${h}`,async()=>{
      const {ctx,page,errors}=await context(w,h);
      try {
        await navigateLegacy(page,'studio');
        const js='// UI-02 unrelated buffer\nconst keep = 42;';
        await page.locator('#editorTextarea').fill(js);
        await page.waitForFunction(()=>document.querySelector('#editorSaveStatus').textContent==='SAVED LOCALLY');
        await page.locator('#editorSaveBtn').click();
        await page.reload(); await page.waitForFunction(()=>window.AntigravityApp?.editor.persistenceReady);
        await navigateLegacy(page,'studio');
        assert.equal(await page.locator('#editorTextarea').inputValue(),js);
        const target=await page.evaluate(()=>window.AntigravityApp.editor.files['NetworkService.swift']);
        for(const close of ['#reviewRejectBtn','#reviewCancelBtn']) {
          await page.locator('.apply-to-editor-btn').first().click();
          assert.equal(await page.evaluate(()=>window.AntigravityApp.editor.files['NetworkService.swift']),target);
          await page.locator(close).click(); await assertFocus(page,'.apply-to-editor-btn');
          assert.equal(await page.locator('#editorTextarea').inputValue(),js);
        }
        await page.locator('[data-file="NetworkService.swift"]').click();
        await page.locator('.apply-to-editor-btn').first().click();
        await page.locator('#editorTextarea').fill('// Newer edit must survive');
        await page.locator('#reviewApproveBtn').click();
        assert.match(await page.locator('.review-error').innerText(),/Stale review rejected/);
        assert.equal(await page.locator('#reviewApproveBtn').isDisabled(),true);
        assert.equal(await page.locator('#editorTextarea').inputValue(),'// Newer edit must survive');
        await assertFocus(page,'#reviewCancelBtn'); await page.locator('#reviewCancelBtn').click();
        await page.locator('.apply-to-editor-btn').first().click();
        const expected=await page.locator('.review-proposed code').innerText();
        await page.locator('#reviewApproveBtn').click();
        assert.equal(await page.locator('#editorTextarea').inputValue(),expected);
        await page.waitForFunction(()=>document.querySelector('#editorSaveStatus').textContent==='SAVED LOCALLY');
        await page.locator('[data-file="main.js"]').click(); assert.equal(await page.locator('#editorTextarea').inputValue(),js);
        await page.locator('#toggleLanguage').click();
        assert.equal(await page.locator('html').getAttribute('lang'),'pl');
        assert.equal(await page.locator('#editorTextarea').getAttribute('aria-label'),'Edytor kodu');
        assert.equal(await page.locator('#editorSaveStatus').innerText(),'ZAPISANO LOKALNIE');
        assert.equal(await page.locator('#editorTextarea').inputValue(),js);
        await page.locator('#toggleLanguage').click(); assert.equal(await page.locator('html').getAttribute('lang'),'en');
        await page.locator('#editorRunBtn').click(); assert.match(await page.locator('#consoleOutput').innerText(),/not run, compiled or tested/);
        if(w>600) {
          await page.locator('#moreMenu').evaluate(e=>e.open=true);await page.locator('#toggleDeviceFrame').click();await page.locator('#moreMenu').evaluate(e=>e.open=false); assert.equal(await page.locator('#toggleDeviceFrame').getAttribute('aria-pressed'),'true');
          assert.match(await page.locator('#toggleDeviceFrame').textContent(),/Phone frame: on/);
          await shot(page,`${w}-frame-on`);
          await page.locator('#moreMenu').evaluate(e=>e.open=true);await page.locator('#toggleDeviceFrame').click();await page.locator('#moreMenu').evaluate(e=>e.open=false);
        } else assert.equal(await page.locator('#toggleDeviceFrame').isVisible(),false);
        await page.reload(); await page.waitForFunction(()=>window.AntigravityApp?.editor.persistenceReady);
        await navigateLegacy(page,'studio');
        await page.locator('[data-file="NetworkService.swift"]').click();
        assert.equal(await page.locator('#editorTextarea').inputValue(),expected);
        assert.equal(await page.evaluate(()=>window.AntigravityApp.editor.files['main.js']),js);
        const schema=await page.evaluate(()=>new Promise(resolve=>{
          const request=indexedDB.open('mobileide-editor');request.onsuccess=()=>{const db=request.result;const tx=db.transaction('files');resolve({version:db.version,key:tx.objectStore('files').keyPath});db.close();};
        }));
        assert.deepEqual(schema,{version:1,key:'filename'});
        assert.deepEqual(errors,[]);
      }finally{await ctx.close()}
    });
  }
  await scenario('200% equivalent zoom: 640 CSS px at 1280 physical px',async()=>{
    const ctx=await browser.newContext({viewport:{width:640,height:450},deviceScaleFactor:2});const page=await ctx.newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.AntigravityApp?.editor.persistenceReady);
      const viewport=await page.locator('meta[name=viewport]').getAttribute('content');assert.ok(!/maximum-scale|user-scalable/.test(viewport));
      await navigateLegacy(page,'hub');await page.locator('[data-action=skills]').click();
      await assertFocus(page,'#hubModalWindow');await page.keyboard.press('Escape');
      await navigateLegacy(page,'studio');await page.locator('#editorTextarea').fill('// Zoom editing');
      await page.locator('#editorTextarea').evaluate(e=>{e.setSelectionRange(0,7);e.dispatchEvent(new Event('select'));});
      assert.equal(await page.locator('#editorCallout').isVisible(),true);
      await page.locator('#editorSaveBtn').click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await shot(page,'zoom-200-equivalent');
    }finally{await ctx.close()}
  });
  await scenario('contrast, focus rings, all onboarding slides and Workspace modals',async()=>{
    const {ctx,page}=await context(390,844); const evidence=[];
    const auditContrast = () => {
      const rgba=s=>(s.match(/[\d.]+/g)||[]).map(Number);
      const composite=(a,b)=>{const alpha=a[3]??1;return [0,1,2].map(i=>a[i]*alpha+b[i]*(1-alpha)).concat(1)};
      const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const failures=[];
      for(const e of document.querySelectorAll('body *')) {
        if(!e.getClientRects().length || ![...e.childNodes].some(n=>n.nodeType===3 && n.textContent.trim()) || e.closest('[inert],button:disabled,svg')) continue;
        const style=getComputedStyle(e); if(style.visibility==='hidden')continue;
        const chain=[];let gradient=false;
        for(let node=e;node;node=node.parentElement){const cs=getComputedStyle(node);chain.unshift(rgba(cs.backgroundColor));if(cs.backgroundImage!=='none')gradient=true;}
        if(gradient)continue; // Original decorative logo gradients require separate visual assessment.
        let bg=[0,0,0,1];for(const color of chain)if(color.length>=3)bg=composite(color,bg);
        const fg=composite(rgba(style.color),bg);const light=[lum(fg),lum(bg)].sort((a,b)=>b-a);const ratio=(light[0]+.05)/(light[1]+.05);
        const large=parseFloat(style.fontSize)>=24 || (parseFloat(style.fontSize)>=18.66 && Number(style.fontWeight)>=700);
        if(ratio<(large?3:4.5)) failures.push({text:e.textContent.trim().slice(0,70),selector:e.id || e.className,ratio:+ratio.toFixed(2),color:style.color,bg});
      }return failures;
    };
    try {
      await navigateLegacy(page,'onboarding');
      for(let i=0;i<4;i++) {
        await page.locator(`.dot-btn[data-index="${i}"]`).click();
        evidence.push({scene:`onboarding-${i}`,failures:await page.evaluate(auditContrast)});
        await shot(page,`390-onboarding-slide-${i}`);
      }
      await navigateLegacy(page,'hub');
      for(const action of ['skills','projects','commands','agents','automations','mcp','screen-awareness','extensions']) {
        await page.locator(`[data-action="${action}"]`).click();await page.waitForTimeout(250);
        evidence.push({scene:action,failures:await page.evaluate(auditContrast)});
        const audit=await page.evaluate(visibleAudit);
        // Measurements ignore background controls, which remain inert throughout the modal.
        assert.deepEqual(audit.clipped,[],`${action} clipped`);
        assert.deepEqual(audit.small,[],`${action} small controls`);
        assert.deepEqual(audit.unnamed,[],`${action} unnamed controls`);
        await shot(page,`390-modal-${action}`);
        await page.keyboard.press('Escape');
      }
      await page.locator('#hubSearchTrigger').click();await page.waitForTimeout(250);
      evidence.push({scene:'palette',failures:await page.evaluate(auditContrast)});
      await shot(page,'390-palette');await page.keyboard.press('Escape');
      await navigateLegacy(page,'studio');await page.locator('.apply-to-editor-btn').first().click();
      evidence.push({scene:'editor-review',failures:await page.evaluate(auditContrast)});
      await page.locator('#editorTextarea').focus();
      assert.equal(await page.locator('#editorTextarea').evaluate(e=>getComputedStyle(e).outlineStyle),'solid');
      fs.writeFileSync(path.join(out,'contrast.json'),JSON.stringify(evidence,null,2));
      assert.deepEqual(evidence.filter(e=>e.failures.length),[],'normal text contrast below threshold');
    }finally{await ctx.close()}
  });
})().catch(e=>{results.push({name:'runner',status:'FAIL',error:e.stack});console.error(e);}).finally(async()=>{
  await browser?.close();server.close();
  fs.writeFileSync(path.join(out,'browser-results.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,out}));
  if(results.some(r=>r.status==='FAIL')) process.exitCode=1;
});
