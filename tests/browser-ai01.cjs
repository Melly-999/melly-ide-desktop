// Isolated Chromium contexts + explicit deterministic auth/provider adapters.
// No credentials, Clerk session, remote Convex writes or OpenRouter requests.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),out=process.env.AI01_AUDIT_DIR || path.join(require('node:os').tmpdir(),'melly-ai01-'+Date.now());
fs.mkdirSync(path.join(out,'shots'),{recursive:true});let browser,server,base;const results=[],external=[];
async function scenario(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS',name);}catch(e){results.push({name,status:'FAIL',error:e.stack});console.error('FAIL',name,e.message);}fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));}
async function fresh(width=390,height=844){const ctx=await browser.newContext({viewport:{width,height},hasTouch:width<1100});await ctx.route('**/*',route=>{if(new URL(route.request().url()).origin!==new URL(base).origin){external.push(route.request().url());return route.abort();}return route.continue();});const p=await ctx.newPage();p.errors=[];p.on('pageerror',e=>p.errors.push(e.message));await p.goto(base);await p.waitForFunction(()=>AntigravityApp?.workspace.ready&&document.querySelector('#offlineShellStatus').dataset.ready==='true');return{ctx,p};}
async function fixture(p){await p.evaluate(()=>{
 const app=AntigravityApp;window.aiFixture={calls:[],hold:false,fail:false};
 app.auth.client={close:async()=>{},ai:async(method,args)=>{
  const f=aiFixture;f.calls.push({method,args});
  if(method==='catalog')return{mode:'mock',ready:true,stale:false,updatedAt:Date.now(),models:[{id:'fixture/model',name:'Deterministic fixture',context:32768,prompt:0.000001,completion:0.000002,allowed:true}]};
  if(method==='usage')return{jobs:[],chargedNano:0,limitNano:100000000,accounting:'TEST ADAPTER; no charges'};
  if(method==='removeHistory')return{removed:0,complete:true,status:'complete',batchLimit:50};
  if(method==='complete'){
   if(f.fail)throw new Error(f.fail);
   if(f.hold)await new Promise(resolve=>f.release=resolve);
   const r=args.request,edit=['fix','refactor'].includes(r.kind),file=r.files[0];
   return{mode:'mock',text:edit?'Fixture proposed change. Tests not run.':'Fixture explanation <script>window.INJECTED=true</script>',proposal:edit?{path:file.path,baseRevision:file.revision,content:file.content+'\n// AI01 fixture proposed edit',explanation:'Fixture proposed edit',diagnostics:['Tests not run']}:null,usage:{actualNano:null}};
  }
 }};
 app.auth.publish({status:'signed-in',clerkSignedIn:true,convex:'confirmed',profile:{principal:'TEST-ADAPTER-A',subject:'fixture-A',issuer:'https://fixture.clerk.accounts.dev',plan:'free',syncEnabled:false}});
 const label=document.createElement('p');label.textContent='TEST ADAPTER — NOT LIVE AUTH / PROVIDER';label.style.cssText='position:fixed;bottom:76px;left:8px;right:8px;z-index:9999;background:#43234f;color:white;padding:6px;text-align:center;pointer-events:none;font:11px sans-serif';document.body.append(label);
 app.switchView('assistant');
});await p.locator('#viewAssistant [data-ai-refresh]').click();await p.locator('#viewAssistant [data-ai-model]').selectOption('fixture/model');}
const shot=(p,name)=>p.screenshot({path:path.join(out,'shots',name+'.png'),animations:'disabled'});
async function choose(p,kind){await p.locator('#viewAssistant [data-ai-kind]').selectOption(kind);if(!await p.locator('#viewAssistant [data-ai-file="main.js"]').isVisible())await p.locator('#viewAssistant [data-ai-context]').click();await p.locator('#viewAssistant [data-ai-file="main.js"]').check();}
async function preview(p,text='Explain fixture'){await p.locator('#assistantDraft').fill(text);await p.locator('#assistantForm button').click();await p.locator('#viewAssistant [data-ai-confirm]').waitFor();}
async function confirm(p){await p.locator('#viewAssistant [data-ai-confirm]').click();await p.waitForFunction(()=>!AntigravityApp.ai.active);}
(async()=>{
 const {buildPrivatePreview}=await import(pathToFileURL(path.join(root,'scripts/build-private-preview.mjs'))),{previewServer}=await import(pathToFileURL(path.join(root,'scripts/serve-private-preview.mjs')));
 const bundle=await buildPrivatePreview(path.join(out,'sanitized-preview'));fs.writeFileSync(path.join(out,'bundle.json'),JSON.stringify({path:bundle.path,...bundle.manifest},null,2));
 server=previewServer(bundle.path);await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}/`;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 for(const[w,h]of[[390,844],[844,390],[1440,900]])await scenario(`mock chat, explicit context, real guarded diff ${w}x${h}`,async()=>{
  const{ctx,p}=await fresh(w,h);try{
   assert.equal(await p.locator('#viewDashboard h1').innerText(),'Hello World');await fixture(p);
   await choose(p,'fix');await preview(p,'Add a fixture comment');assert.equal(await p.evaluate(()=>aiFixture.calls.filter(c=>c.method==='complete').length),0);
   const exact=await p.locator('#viewAssistant .ai01-preview pre').innerText();assert.match(exact,/request|Add a fixture comment/);assert.ok(exact.includes('main.js'));await shot(p,`${w}-consent`);
   await confirm(p);await p.locator('.ai01-diff').waitFor();assert.match(await p.locator('.ai01-diff').innerText(),/\+\/\/ AI01 fixture proposed edit/);
   assert.equal(await p.evaluate(()=>AntigravityApp.editor.files['main.js'].includes('AI01 fixture proposed edit')),false);await shot(p,`${w}-guarded-review`);
   await p.locator('#reviewRejectBtn').click();assert.equal(await p.evaluate(()=>AntigravityApp.editor.files['main.js'].includes('AI01 fixture proposed edit')),false);
   await p.evaluate(()=>AntigravityApp.switchView('assistant'));await choose(p,'fix');await preview(p);await confirm(p);await p.locator('#reviewApproveBtn').click();assert.equal(await p.evaluate(()=>AntigravityApp.editor.files['main.js'].includes('AI01 fixture proposed edit')),true);
   await p.evaluate(()=>AntigravityApp.switchView('tasks'));assert.match(await p.locator('#ai01TaskQueue').innerText(),/complete/);await shot(p,`${w}-tasks`);
   assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(p.errors,[]);
  }finally{await ctx.close();}
 });
 await scenario('Gate2B 32-token consent and terminal operator denial',async()=>{
  const{ctx,p}=await fresh();try{
   await fixture(p);await p.evaluate(()=>{AntigravityApp.ai.catalog.limits={maxOutputTokens:32};});
   await preview(p,'Reply with exactly MELLY_DEV_OK.');assert.match(await p.locator('#viewAssistant .ai01-preview').innerText(),/output cap: 32 tokens/);
   await p.evaluate(()=>aiFixture.fail='OPERATOR_NOT_ALLOWED');await confirm(p);
   assert.equal(await p.evaluate(()=>AntigravityApp.ai.jobs[0].error),'OPERATOR_NOT_ALLOWED');
   assert.equal(await p.evaluate(()=>aiFixture.calls.filter(c=>c.method==='complete').length),1);
   assert.equal(await p.evaluate(()=>AntigravityApp.ai.messages.length),0);await shot(p,'390-gate2b-denied');
  }finally{await ctx.close();}
 });
 await scenario('default prompt only, escaped output, no implicit context, local draft reload',async()=>{
  const{ctx,p}=await fresh();try{await fixture(p);await preview(p,'Typed prompt only');await confirm(p);assert.equal(await p.evaluate(()=>aiFixture.calls.find(c=>c.method==='complete').args.request.files.length),0);assert.equal(await p.evaluate(()=>window.INJECTED),undefined);assert.match(await p.locator('#viewAssistant .ai01-responses').innerText(),/TEST ADAPTER/);await shot(p,'390-chat-response');await p.reload();await p.waitForFunction(()=>AntigravityApp?.workspace.ready);await fixture(p);assert.equal(await p.locator('#assistantDraft').inputValue(),'Typed prompt only');assert.equal(await p.evaluate(()=>AntigravityApp.ai.messages.length),0);}finally{await ctx.close();}
 });
 await scenario('cancel before send; stale context; secret path excluded; no chargeable requests',async()=>{
  const{ctx,p}=await fresh();try{await fixture(p);await choose(p,'explain');await preview(p);await p.locator('#viewAssistant [data-ai-cancel]').click();assert.equal(await p.evaluate(()=>aiFixture.calls.filter(c=>c.method==='complete').length),0);
   await choose(p,'explain');await preview(p);await p.evaluate(()=>AntigravityApp.editor.updateFileContent('main.js','// newer fixture'));await p.locator('#viewAssistant [data-ai-confirm]').click();assert.match(await p.locator('#viewAssistant [data-ai-status]').innerText(),/STALE_CONTEXT/);assert.equal(await p.evaluate(()=>aiFixture.calls.filter(c=>c.method==='complete').length),0);
   await p.evaluate(()=>{AntigravityApp.editor.files['.env.local']='SECRET';AntigravityApp.shell.assistant.aiPanel.render();});assert.equal(await p.locator('#viewAssistant [data-ai-file=".env.local"]').count(),0);
  }finally{await ctx.close();}
 });
 await scenario('stale review cannot overwrite newer buffer; cancel keeps exact source',async()=>{
  const{ctx,p}=await fresh();try{await fixture(p);await choose(p,'refactor');await preview(p);await confirm(p);await p.evaluate(()=>AntigravityApp.switchView('code'));await p.locator('#editorTextarea').fill('// keep newer');await p.evaluate(()=>AntigravityApp.switchView('review'));await p.locator('#reviewApproveBtn').click();assert.match(await p.locator('.review-error').innerText(),/Stale review/);assert.equal(await p.evaluate(()=>AntigravityApp.editor.files['main.js']),'// keep newer');await p.locator('#reviewCancelBtn').click();assert.equal(await p.evaluate(()=>AntigravityApp.editor.files['main.js']),'// keep newer');}finally{await ctx.close();}
 });
 await scenario('cancellation, failures, account switch and offline leave no late A output',async()=>{
  const{ctx,p}=await fresh();try{await fixture(p);await p.evaluate(()=>aiFixture.fail='PROVIDER_429');await preview(p);await confirm(p);assert.equal(await p.evaluate(()=>AntigravityApp.ai.jobs[0].error),'PROVIDER_429');
   await p.evaluate(()=>{aiFixture.fail=false;aiFixture.hold=true;});await preview(p);await p.locator('#viewAssistant [data-ai-confirm]').click();await p.locator('#viewAssistant [data-ai-cancel]').click();await p.evaluate(()=>aiFixture.release());assert.equal(await p.evaluate(()=>AntigravityApp.ai.messages.length),0);
   await preview(p);await p.locator('#viewAssistant [data-ai-confirm]').click();await p.evaluate(()=>{AntigravityApp.auth.publish({convex:'not-connected',profile:null});aiFixture.release();});assert.equal(await p.evaluate(()=>AntigravityApp.ai.messages.length),0);assert.equal(await p.evaluate(()=>AntigravityApp.ai.jobs.length),0);
   await ctx.setOffline(true);await p.evaluate(()=>AntigravityApp.switchView('code'));assert.equal(await p.locator('#editorTextarea').isVisible(),true);await p.evaluate(()=>AntigravityApp.switchView('assistant'));assert.equal(await p.evaluate(()=>AntigravityApp.ai.ready()),false);
  }finally{await ctx.close();}
 });
 await scenario('preview inventory hashes and private-path denials',async()=>{
  const crypto=require('node:crypto');const bundle=JSON.parse(fs.readFileSync(path.join(out,'bundle.json')));for(const entry of bundle.assets){const bytes=fs.readFileSync(path.join(bundle.path,entry.path));assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),entry.sha256);assert.ok(!/sk-or-v1-[A-Za-z0-9_-]{20,}/.test(bytes.toString('utf8')));}
  for(const name of ['.env.local','.git/config','convex/ai.ts','docs/AI01.md'])assert.equal((await fetch(base+name)).status,404);
 });
 fs.writeFileSync(path.join(out,'external-requests.json'),JSON.stringify(external,null,2));assert.deepEqual(external,[]);console.log(JSON.stringify({passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,out,realProvider:'UNVERIFIED',physicalPhone:'OWNER DEVICE QA PENDING'}));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(r=>server?server.close(r):r());if(results.some(r=>r.status==='FAIL'))process.exitCode=1;});
