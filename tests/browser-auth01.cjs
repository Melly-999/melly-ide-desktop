// Deterministic adapter evidence is explicitly labeled; this suite never logs in to Clerk.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),out=process.env.AUTH01_AUDIT_DIR||path.join(require('node:os').tmpdir(),'melly-auth01-'+Date.now());
fs.mkdirSync(path.join(out,'shots'),{recursive:true});
let browser,server,base,bundle,shell;const results=[];
async function scenario(name,fn){try{await fn();results.push({name,status:'PASS'});console.log('PASS',name);}catch(e){results.push({name,status:'FAIL',error:e.stack});console.error('FAIL',name,e.message);}fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));}
const ready=p=>p.waitForFunction(()=>window.AntigravityApp?.workspace?.ready&&document.querySelector('#offlineShellStatus').dataset.ready==='true');
const shot=(p,name)=>p.screenshot({path:path.join(out,'shots',name+'.png'),animations:'disabled'});
async function fresh(width=390,height=844){const ctx=await browser.newContext({viewport:{width,height},hasTouch:width<1100}),p=await ctx.newPage();p.errors=[];p.on('pageerror',e=>p.errors.push(e.message));await p.goto(base);await ready(p);return{ctx,p};}
async function installFixture(p,{loading=false,error=false}={}){
 await p.evaluate(async ({loading,error})=>{
  const {AuthSession}=await import('./js/auth/session.js'),{AccountScreen}=await import('./js/auth/account.js'),{EMPTY_AUTH_CONFIG}=await import('./js/auth/config.js');
  const app=AntigravityApp;app.account.unsubscribe();app.account.languageObserver.disconnect();app.auth.dispose();app.account.root.remove();
  const issuer='https://melly-browser-fixture.clerk.accounts.dev';let listener;
  const f={nextUser:'A',clients:[],fail:false,hold:loading};window.authFixture=f;
  const clerk={session:null,user:null,addListener(fn){listener=fn;return()=>{listener=null}},async signOut(){this.session=null;this.user=null;listener?.({session:null,user:null})},closeSignIn(){document.querySelector('#fixtureDialog')?.remove()},closeSignUp(){this.closeSignIn()}};
  const open=kind=>{
   clerk.closeSignIn();const dialog=document.createElement('dialog');dialog.id='fixtureDialog';
   dialog.innerHTML='<h2>TEST ADAPTER — NOT LIVE AUTH</h2><p>'+kind+' API boundary</p><p>No credentials or real account are used.</p><button id="fixtureComplete">Complete test verification</button><button id="fixtureCancel">Cancel</button>';
   dialog.style.cssText='max-width:min(350px,90vw);background:#171421;color:#f6f0ff;border:1px solid #a176f4;border-radius:16px;padding:20px';
   document.body.append(dialog);dialog.showModal();dialog.querySelector('#fixtureCancel').onclick=()=>dialog.remove();
   dialog.querySelector('#fixtureComplete').onclick=()=>{dialog.remove();const id=f.nextUser;clerk.user={id,fullName:'Fixture account '+id};clerk.session={id:'session-'+id,status:'active',getToken:async()=> 'TEST-ADAPTER-NOT-A-JWT'};listener?.({session:clerk.session,user:clerk.user})};
  };clerk.openSignIn=()=>open('Sign in');clerk.openSignUp=()=>open('Sign up');
  const sdk={clerk,load:()=>loading?new Promise(resolve=>f.release=resolve):Promise.resolve(),createClient(){const subject=clerk.user.id,c={closed:false,setAuth(fetch,notify){this.fetch=fetch;this.notify=notify;queueMicrotask(()=>notify(true))},async readIdentity(){return{principal:issuer+'|'+subject,subject,issuer,displayName:'Fixture account '+subject,plan:'free',syncEnabled:false}},close(){this.closed=true;return Promise.resolve()}};f.clients.push(c);return c}};
  f.clerk=clerk;f.sdk=sdk;f.expire=()=>{clerk.session={...clerk.session,status:'expired'};listener?.({session:clerk.session,user:clerk.user})};
  app.auth=new AuthSession({...EMPTY_AUTH_CONFIG,convexUrl:'https://clearance-browser-fixture.convex.cloud',clerkIssuer:issuer,clerkPublishableKey:'pk_test_'+btoa('melly-browser-fixture.clerk.accounts.dev$'),dedicatedAppConfirmed:true},{env:window,approvedDevUrl:'https://clearance-browser-fixture.convex.cloud',loadSDK:async()=>{if(error)throw new Error('fixture unavailable');return sdk}});
  app.account=new AccountScreen(app,app.auth);app.account.init();app.account.open();
  const label=document.createElement('p');label.textContent='TEST ADAPTER — NOT LIVE AUTH';label.id='fixtureEvidenceLabel';label.style.cssText='position:fixed;bottom:82px;left:8px;right:8px;z-index:9999;background:#431a53;color:white;text-align:center;padding:8px;pointer-events:none;font:12px sans-serif';document.body.append(label);
  void app.auth.start();
 },{loading,error});
}
(async()=>{
 const {buildPrivatePreview}=await import(pathToFileURL(path.join(root,'scripts/build-private-preview.mjs')));
 const {previewServer}=await import(pathToFileURL(path.join(root,'scripts/serve-private-preview.mjs')));
 shell=await import(pathToFileURL(path.join(root,'js/offline-shell.js')));
 bundle=await buildPrivatePreview(path.join(out,'sanitized-preview'));
 fs.writeFileSync(path.join(out,'bundle.json'),JSON.stringify({path:bundle.path,...bundle.manifest},null,2));
 server=previewServer(bundle.path);await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}/`;
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 for(const [w,h]of[[375,812],[390,844],[430,932],[1280,900],[844,390]])await scenario(`guest account and scrolled safe-area fixture ${w}x${h}`,async()=>{
  const {ctx,p}=await fresh(w,h),external=[];p.on('request',r=>{if(new URL(r.url()).origin!==new URL(base).origin)external.push(r.url())});
  try{
   await p.locator('[data-config="account"]').click();assert.equal(await p.locator('#accountState').innerText(),'Guest');assert.match(await p.locator('#viewAccount').innerText(),/BLOCKED — OWNER SETUP REQUIRED/);
   assert.equal(await p.locator('[data-account-action="sign-in"]').count(),0);assert.equal(await p.locator('#viewAccount h1').evaluate(e=>e===document.activeElement),true);
   assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot(p,`${w}-guest`);
   await p.locator('[data-account-action="back"]').first().click();assert.equal(await p.locator('#viewDashboard h1').innerText(),'Hello World');
   await p.addStyleTag({content:':root{--melly-safe-top:54px;--melly-safe-bottom:34px}'});
   await p.mouse.wheel(0,1200);await p.waitForFunction(()=>scrollY>0);
   const metrics=await p.evaluate(()=>{const h=document.querySelector('header'),r=h.getBoundingClientRect(),logo=document.querySelector('.brand-logo-icon').getBoundingClientRect();return{scrollY,top:r.top,bottom:r.bottom,logoTop:logo.top,cover:document.elementFromPoint(20,20)?.closest('header')!==null,width:document.documentElement.scrollWidth,viewport:innerWidth,position:getComputedStyle(h).position}});
   assert.equal(metrics.top,0);assert.equal(metrics.position,'fixed');assert.ok(metrics.logoTop>=54);assert.equal(metrics.cover,true);assert.ok(metrics.width<=metrics.viewport);
   fs.writeFileSync(path.join(out,`safe-area-${w}.json`),JSON.stringify(metrics,null,2));await shot(p,`${w}-scrolled-insets-fixture`);assert.deepEqual(external,[]);assert.deepEqual(p.errors,[]);
  }finally{await ctx.close()}
 });
 await scenario('adapter sign-up, modal reopening, A/logout/B and local editor persistence',async()=>{
  const {ctx,p}=await fresh();await ctx.tracing.start({screenshots:true,snapshots:true});
  try{
   await p.locator('.primary-navigation [data-route="code"]').click();await p.locator('#editorTextarea').fill('// AUTH01 local work remains 🟣\n');await p.locator('#editorSaveBtn').click();await p.waitForFunction(()=>AntigravityApp.editor.getSaveState().status==='saved');
   await installFixture(p);await p.waitForFunction(()=>AntigravityApp.auth.state.status==='guest');
   await p.locator('[data-account-action="sign-up"]').click();await p.locator('#fixtureDialog').waitFor();await shot(p,'390-sign-up-ADAPTER');await p.locator('#fixtureCancel').click();
   await p.locator('[data-account-action="sign-up"]').click();await p.locator('#fixtureComplete').click();await p.waitForFunction(()=>AntigravityApp.auth.state.convex==='confirmed');
   assert.equal(await p.locator('#accountIdentityReference').innerText(),'A');assert.equal(await p.locator('#accountState').innerText(),'Signed in');assert.equal(await p.locator('#convexIdentityState').innerText(),'Confirmed by server');assert.match(await p.locator('#viewAccount').innerText(),/Free plan/);assert.match(await p.locator('#viewAccount').innerText(),/sync is not enabled/);await shot(p,'390-signed-in-A-ADAPTER');
   await p.locator('[data-account-action="sign-out"]').click();await p.waitForFunction(()=>AntigravityApp.auth.state.status==='guest');assert.equal(await p.locator('.account-name').count(),0);assert.equal(await p.locator('#accountIdentityReference').count(),0);assert.equal(await p.evaluate(()=>authFixture.clients[0].closed),true);
   await p.evaluate(()=>authFixture.nextUser='B');await p.locator('[data-account-action="sign-in"]').click();await shot(p,'390-sign-in-ADAPTER');await p.locator('#fixtureComplete').click();await p.waitForFunction(()=>AntigravityApp.auth.state.profile?.subject==='B');assert.equal(await p.locator('#accountIdentityReference').innerText(),'B');assert.equal(await p.locator('.account-name').innerText(),'Fixture account B');await shot(p,'390-signed-in-B-ADAPTER');
   await p.locator('[data-account-action="sign-out"]').click();await p.waitForFunction(()=>AntigravityApp.auth.state.status==='guest');await p.locator('[data-account-action="back"]').first().click();await p.locator('.primary-navigation [data-route="code"]').click();assert.equal(await p.locator('#editorTextarea').inputValue(),'// AUTH01 local work remains 🟣\n');
   await p.reload();await ready(p);await p.locator('.primary-navigation [data-route="code"]').click();assert.equal(await p.locator('#editorTextarea').inputValue(),'// AUTH01 local work remains 🟣\n');assert.equal(await p.evaluate(()=>AntigravityApp.auth.state.setupRequired),true);assert.deepEqual(p.errors,[]);
  }finally{await ctx.tracing.stop({path:path.join(out,'adapter-flow.zip')});await ctx.close()}
 });
 await scenario('adapter Loading/Error/Session expired and offline states are visible and recoverable',async()=>{
  const {ctx,p}=await fresh();try{
   await installFixture(p,{loading:true});await p.waitForFunction(()=>AntigravityApp.auth.state.status==='loading');assert.equal(await p.locator('#accountState').innerText(),'Loading');await shot(p,'390-loading-ADAPTER');
   await p.evaluate(()=>authFixture.release());await p.waitForFunction(()=>AntigravityApp.auth.state.status==='guest');await p.locator('[data-account-action="sign-in"]').click();await p.locator('#fixtureComplete').click();await p.waitForFunction(()=>AntigravityApp.auth.state.convex==='confirmed');
   await p.evaluate(()=>authFixture.expire());await p.waitForFunction(()=>AntigravityApp.auth.state.status==='session-expired');assert.equal(await p.locator('.account-name').count(),0);await shot(p,'390-expired-ADAPTER');
   await ctx.setOffline(true);await p.waitForFunction(()=>AntigravityApp.auth.state.status==='offline');await shot(p,'390-offline-ADAPTER');await ctx.setOffline(false);
   await p.reload();await ready(p);await installFixture(p,{error:true});await p.waitForFunction(()=>AntigravityApp.auth.state.status==='error');await shot(p,'390-error-ADAPTER');await p.locator('[data-account-action="back"]').first().click();assert.equal(await p.locator('#viewDashboard h1').innerText(),'Hello World');assert.deepEqual(p.errors,[]);
  }finally{await ctx.close()}
 });
 await scenario('every sanitized asset has exact hash/MIME; auth runtime stays outside SW cache',async()=>{
  for(const a of bundle.manifest.assets){const r=await fetch(base+a.path);assert.equal(r.status,200,a.path);const body=Buffer.from(await r.arrayBuffer());assert.equal(crypto.createHash('sha256').update(body).digest('hex'),a.sha256,a.path);const mime={js:'text/javascript',html:'text/html',css:'text/css',png:'image/png',webmanifest:'application/manifest+json',txt:'text/plain'};assert.ok(r.headers.get('content-type').startsWith(mime[a.path.split('.').at(-1)]),a.path)}
  for(const a of ['.env.local','.git/config','convex/account.ts','node_modules/@clerk/clerk-js/package.json','docs/AUTH01.md','%2eenv.local'])assert.equal((await fetch(base+a)).status,404);
  const {ctx,p}=await fresh();try{
   await p.reload();await ready(p);const cache=await p.evaluate(async()=>{const names=await caches.keys(),c=await caches.open(names[0]);return{names,urls:(await c.keys()).map(r=>r.url)}});assert.deepEqual(cache.names,[shell.shellCacheName(base)]);assert.deepEqual(cache.urls.sort(),shell.shellURLs(base).sort());assert.ok(!cache.urls.some(u=>u.includes('runtime/')||u.includes('clerk.accounts.dev')));
   await ctx.setOffline(true);assert.equal((await p.reload()).fromServiceWorker(),true);await ready(p);await p.locator('[data-config="account"]').click();assert.equal(await p.locator('#accountState').innerText(),'Offline');await shot(p,'390-offline-real-missing-config');
   await ctx.setOffline(false);await p.waitForFunction(()=>AntigravityApp.auth.state.status==='guest');await p.locator('#toggleLanguage').click();assert.equal(await p.locator('#accountState').innerText(),'Gość');await shot(p,'390-guest-polish');fs.writeFileSync(path.join(out,'cache.json'),JSON.stringify(cache,null,2));assert.deepEqual(p.errors,[]);
  }finally{await ctx.close()}
 });
 console.log(JSON.stringify({passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,out,liveAuthentication:'BLOCKED_OWNER_SETUP_REQUIRED'}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();await new Promise(r=>server?server.close(r):r());if(results.some(r=>r.status==='FAIL'))process.exitCode=1});
