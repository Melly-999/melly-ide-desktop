// Real Chromium tests. No mocked workspace, auth, GitHub or fabricated cloud acknowledgements.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=process.env.PREMIUM_AUDIT_DIR||path.join(require('node:os').tmpdir(),'melly-premium');
fs.mkdirSync(path.join(out,'shots'),{recursive:true});
const results=[];let browser,server,base;
const ready=p=>p.waitForFunction(()=>window.AntigravityApp?.workspace?.ready&&window.AntigravityApp?.editor?.persistenceReady&&document.querySelector('#offlineShellStatus').dataset.ready==='true');
const idle=p=>p.waitForFunction(()=>!window.AntigravityApp.workspace.busy);
const route=(p,name)=>p.locator(`.primary-navigation [data-route=${name}]`).click();
async function scenario(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS',name);}catch(e){results.push({name,status:'FAIL',error:e.stack});console.error('FAIL',name,e.message);}fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));}
function audit(){const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';return {width:innerWidth,scroll:document.documentElement.scrollWidth,small:[...document.querySelectorAll('button,input,select')].filter(visible).filter(e=>!e.disabled).filter(e=>{const r=e.getBoundingClientRect();return r.width<43.9||r.height<43.9}).map(e=>e.id||e.className),clipped:[...document.querySelectorAll('button,input,select,textarea')].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5}).map(e=>e.id||e.className)};}
(async()=>{
 server=spawn(process.execPath,['server/dev.mjs'],{cwd:root,env:{...process.env,PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
 base=await new Promise((resolve,reject)=>{let s='';const t=setTimeout(()=>reject(new Error('Server startup timeout')),10000);server.stdout.on('data',d=>{s+=d;const m=s.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(t);resolve(m[0]+'/');}});server.on('error',reject);});
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 for(const [width,height] of [[320,700],[375,812],[390,844],[430,932],[768,1024],[1280,900],[1440,900]])await scenario(`Dashboard-first ${width}x${height}, navigation, touch targets and panes`,async()=>{
  const ctx=await browser.newContext({viewport:{width,height},hasTouch:width<768});const p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  try{await p.goto(base);await ready(p);assert.equal(await p.evaluate(()=>AntigravityApp.shell.route),'dashboard');assert.match(await p.locator('#dashboardProjects').innerText(),/No local projects yet/);assert.match(await p.locator('#dashboardConnections').innerText(),/Convex sync\s+Not connected/);
   for(const name of ['dashboard','code','tasks','review']){await route(p,name);const a=await p.evaluate(audit);assert.ok(a.scroll<=width,`${name} page overflow`);assert.deepEqual(a.small,[],`${name} touch targets`);assert.deepEqual(a.clipped,[],`${name} clipped`);await p.screenshot({path:path.join(out,'shots',`${width}-${name}.png`),fullPage:true});}
   await route(p,'code');if(width<1100){assert.equal(await p.locator('#workspaceExplorer').isVisible(),false);assert.equal(await p.locator('#chatContainer').isVisible(),false);await p.locator('#explorerToggle').click();assert.equal(await p.locator('#workspaceExplorer').isVisible(),true);await p.keyboard.press('Escape');assert.equal(await p.locator('#explorerToggle').evaluate(e=>e===document.activeElement),true);}
   else{const rects=await p.evaluate(()=>['workspaceExplorer','editorContainer','chatContainer'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top};}));assert.ok(rects[0].right<=rects[1].left&&rects[1].right<=rects[2].left);assert.ok(Math.max(...rects.map(r=>r.top))-Math.min(...rects.map(r=>r.top))<2);}
   assert.deepEqual(errors,[]);
  }finally{await ctx.close();}
 });
 await scenario('real project Resume, stable IDs, exact buffer/selection, review guards and offline reload',async()=>{
  const ctx=await browser.newContext({viewport:{width:390,height:844}}),p=await ctx.newPage();
  try{await p.goto(base);await ready(p);await p.locator('[data-quick=open]').click();p.once('dialog',d=>d.accept('Actual local project'));await p.locator('#workspaceNewProject').click();await idle(p);const id=await p.evaluate(()=>AntigravityApp.workspace.state.activeProjectId);await p.locator('#explorerToggle').click();await p.locator('#editorTextarea').fill('// exact local draft 🟣\nconst keep = 34;');await p.locator('#editorTextarea').evaluate(e=>e.setSelectionRange(3,8));const token=await p.evaluate(()=>AntigravityApp.editor.workspaceToken);
   await route(p,'dashboard');assert.match(await p.locator('#dashboardContinue').innerText(),/Actual local project/);assert.equal(await p.locator(`[data-open-project="${id}"]`).count(),1);await p.locator('#dashboardContinue [data-route=code]').click();assert.equal(await p.locator('#editorTextarea').inputValue(),'// exact local draft 🟣\nconst keep = 34;');assert.deepEqual(await p.locator('#editorTextarea').evaluate(e=>[e.selectionStart,e.selectionEnd]),[3,8]);assert.equal(await p.evaluate(()=>AntigravityApp.editor.workspaceToken),token);
   await route(p,'tasks');assert.match(await p.locator('#viewTasks').innerText(),/No authorized task service/);await route(p,'code');assert.equal(await p.evaluate(()=>AntigravityApp.editor.workspaceToken),token);
   // Prepare a synthetic local proposal through the existing guarded-review API, never a cloud task.
   await p.evaluate(()=>{const app=AntigravityApp;app.chat.messages.push({id:'test-premium-review',role:'agent',text:'SIMULATED test proposal',targetFilename:'main.js',codeSnippetFull:'// proposed',codeSnippet:'// proposed',language:'javascript'});app.chat.startReview('test-premium-review');});
   await route(p,'dashboard');assert.match(await p.locator('#dashboardApprovals').innerText(),/Actual local project/);await p.locator('#dashboardApprovals [data-route=review]').click();assert.equal(await p.locator('#reviewApproveBtn').isVisible(),true);
   await route(p,'code');await p.locator('#editorTextarea').fill('// newer protected content');await route(p,'review');await p.locator('#reviewApproveBtn').click();assert.match(await p.locator('.review-error').innerText(),/Stale review rejected/);await p.locator('#reviewCancelBtn').click();await route(p,'code');assert.equal(await p.locator('#editorTextarea').inputValue(),'// newer protected content');await p.locator('#editorSaveBtn').click();await p.waitForFunction(()=>AntigravityApp.editor.getSaveState().status==='saved');
   await p.reload();await ready(p);assert.equal(await p.evaluate(()=>AntigravityApp.shell.route),'code');assert.equal(await p.locator('#editorTextarea').inputValue(),'// newer protected content');await ctx.setOffline(true);assert.equal((await p.reload()).fromServiceWorker(),true);await ready(p);await route(p,'dashboard');assert.match(await p.locator('#dashboardContinue').innerText(),/Actual local project/);await p.screenshot({path:path.join(out,'shots','390-real-project-offline.png'),fullPage:true});
  }finally{await ctx.close();}
 });
 await scenario('explicit deep link wins, denied sessionStorage does not prevent startup, 200-percent-equivalent reflow',async()=>{
  const ctx=await browser.newContext({viewport:{width:640,height:450}});const p=await ctx.newPage();
  try{await p.addInitScript(()=>{const original=Storage.prototype.getItem;Storage.prototype.getItem=function(key){if(key==='melly-view-v1')throw new DOMException('Denied','SecurityError');return original.call(this,key);};});await p.goto(base+'#code');await ready(p);assert.equal(await p.evaluate(()=>AntigravityApp.shell.route),'code');await route(p,'dashboard');const a=await p.evaluate(audit);assert.ok(a.scroll<=640);assert.deepEqual(a.clipped,[]);await p.screenshot({path:path.join(out,'shots','640-reflow.png'),fullPage:true});}finally{await ctx.close();}
 });
 await scenario('Dashboard quick actions wire public GitHub and backup input without uploading',async()=>{
  const ctx=await browser.newContext({viewport:{width:390,height:844}});const p=await ctx.newPage();
  try{await p.goto(base);await ready(p);await p.locator('[data-quick=github]').click();assert.equal(await p.locator('#githubRepository').isVisible(),true);assert.equal(await p.locator('#githubRepository').evaluate(e=>e===document.activeElement),true);await route(p,'dashboard');const chooser=p.waitForEvent('filechooser');await p.locator('[data-quick=import]').click();await chooser;assert.equal(await p.evaluate(()=>AntigravityApp.workspace.state.projects.length),0);}finally{await ctx.close();}
 });
 await scenario('project switcher recency survives reload; destination headings receive keyboard focus',async()=>{
  const ctx=await browser.newContext({viewport:{width:390,height:844}}),p=await ctx.newPage();
  try{await p.goto(base);await ready(p);const ids=[];
   for(const name of ['First actual project','Second actual project','Third actual project']){await route(p,'code');await p.locator('#explorerToggle').click();p.once('dialog',d=>d.accept(name));await p.locator('#workspaceNewProject').click();await idle(p);ids.push(await p.evaluate(()=>AntigravityApp.workspace.state.activeProjectId));}
   await p.locator('#workspaceProject').selectOption(ids[1]);await idle(p);await p.locator('#workspaceProject').selectOption(ids[0]);await idle(p);await p.reload();await ready(p);await route(p,'dashboard');
   assert.deepEqual(await p.locator('[data-open-project]').evaluateAll(es=>es.map(e=>e.dataset.openProject)),[ids[0],ids[1],ids[2]]);
   assert.equal(await p.locator('#viewDashboard h1').evaluate(e=>e===document.activeElement),true);
   await p.locator('#viewDashboard [data-route=tasks]').click();assert.equal(await p.locator('#viewTasks h1').evaluate(e=>e===document.activeElement),true);
  }finally{await ctx.close();}
 });
 console.log(JSON.stringify({passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,out}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();server?.kill();if(results.some(r=>r.status==='FAIL'))process.exitCode=1;});
