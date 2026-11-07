import test from 'node:test';
import assert from 'node:assert/strict';
import {AuthSession} from '../js/auth/session.js';
import {EMPTY_AUTH_CONFIG,validateAuthConfig,parsePublicConfigModule,publicConfigModule} from '../js/auth/config.js';
import {authConfigFromEnv,authCSP} from '../scripts/auth/public-config.mjs';
import {SHELL_ASSETS,shellRequestKey} from '../js/offline-shell.js';
import {buildPrivatePreview} from '../scripts/build-private-preview.mjs';
import {mkdtemp,readFile,mkdir,writeFile,copyFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DESKTOP_ASSETS,prepareDesktop} from '../scripts/prepare-desktop.mjs';
import {tmpdir} from 'node:os';

const issuer='https://melly-auth01-fixture.clerk.accounts.dev';
const approvedDevUrl='https://clearance-fixture.eu-west-1.convex.cloud';
const config={...EMPTY_AUTH_CONFIG,convexUrl:approvedDevUrl,clerkIssuer:issuer,clerkPublishableKey:'pk_test_'+btoa('melly-auth01-fixture.clerk.accounts.dev$'),dedicatedAppConfirmed:true};
const tick=()=>new Promise(r=>setImmediate(r));
function fixture({key=config,user='A',token='fixture-access',profileWait=null}={}){
 const events=new EventTarget(),storage=new Map(),clients=[],tokenCalls=[],mounts=[];
 const env={navigator:{onLine:true},location:{protocol:'https:',href:'https://127.0.0.1:4181/?untrusted=query#code'},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},addEventListener:events.addEventListener.bind(events),removeEventListener:events.removeEventListener.bind(events)};
 let listener;
 const session=id=>({id:'session-'+id,status:'active',getToken:async options=>{tokenCalls.push(options);return typeof token==='function'?token(options):token;}});
 const clerk={session:user?session(user):null,user:user?{id:user,fullName:'Fixture '+user}:null,addListener:fn=>{listener=fn;return()=>{listener=null}},signOut:async()=>{clerk.session=null;clerk.user=null;listener?.({session:null,user:null})},openSignIn:options=>mounts.push({kind:'sign-in',options}),openSignUp:options=>mounts.push({kind:'sign-up',options}),closeSignIn:()=>mounts.push({kind:'unmount-in'}),closeSignUp:()=>mounts.push({kind:'unmount-up'})};
 const sdk={clerk,load:async()=>{},createClient:()=>{const subject=clerk.user.id;const client={closed:false,setAuth(fn,notify){this.fetch=fn;this.notify=notify},readIdentity:async()=>profileWait&&subject==='A'?profileWait:{principal:issuer+'|'+subject,subject,issuer,displayName:'Fixture '+subject,plan:'free',syncEnabled:false},close(){this.closed=true;return Promise.resolve()}};clients.push(client);return client;}};
 let loads=0;const auth=new AuthSession(key,{approvedDevUrl,env,loadSDK:async()=>{loads++;return sdk}});
 return {auth,env,events,storage,clients,tokenCalls,mounts,sdk,get loads(){return loads},async switchUser(id){clerk.user={id,fullName:'Fixture '+id};clerk.session=session(id);listener?.({session:clerk.session,user:clerk.user});await tick();},async confirm(){clients.at(-1).notify(true);await tick();}};
}
test('AUTH01 missing config is a blocked guest without SDK/network work or local storage deletion',async()=>{
 const f=fixture({key:EMPTY_AUTH_CONFIG});f.storage.set('local-project','preserve');await f.auth.start();assert.equal(f.auth.state.status,'guest');assert.equal(f.auth.state.setupRequired,true);assert.equal(f.loads,0);assert.equal(f.storage.get('local-project'),'preserve');f.auth.dispose();
});
test('AUTH01 public config accepts only matching dedicated Clerk DEV key and exact Convex target',()=>{
 assert.equal(validateAuthConfig(config,approvedDevUrl).ready,true);
 for(const patch of [{clerkPublishableKey:'pk_live_invalid'},{clerkIssuer:'https://other.clerk.accounts.dev'},{convexUrl:'https://other.convex.cloud'},{dedicatedAppConfirmed:false},{secret:'must-not-package'},{environment:'production'}])assert.equal(validateAuthConfig({...config,...patch},approvedDevUrl).ready,false);
 assert.deepEqual(parsePublicConfigModule(publicConfigModule(config)),config);
 assert.throws(()=>parsePublicConfigModule('alert(1)'),/Invalid/);
});
test('AUTH01 environment injection ignores secrets and fails for partial setup',()=>{
 assert.deepEqual(authConfigFromEnv({CLERK_SECRET_KEY:'fixture-only-secret'}),EMPTY_AUTH_CONFIG);
 assert.throws(()=>authConfigFromEnv({CLERK_PUBLISHABLE_KEY:config.clerkPublishableKey}),/rejected/);
 const result=authConfigFromEnv({CLERK_PUBLISHABLE_KEY:config.clerkPublishableKey,CLERK_JWT_ISSUER_DOMAIN:issuer,MELLY_CLERK_APP_OWNER_CONFIRMED:'true',MELLY_CONVEX_URL:approvedDevUrl,CLERK_SECRET_KEY:'fixture-only-secret'});assert.deepEqual(result,config);assert.ok(!JSON.stringify(result).includes('fixture-only-secret'));
});
test('AUTH01 Clerk session and server-confirmed Convex identity are distinct; sync stays disabled',async()=>{
 const f=fixture();await f.auth.start();assert.equal(f.auth.state.status,'signed-in');assert.equal(f.auth.state.convex,'verifying');assert.equal(f.auth.state.profile,null);await f.confirm();assert.equal(f.auth.state.convex,'confirmed');assert.equal(f.auth.state.profile.subject,'A');assert.equal(f.auth.state.profile.syncEnabled,false);f.auth.dispose();
});
test('AUTH01 refresh forwards forceRefreshToken and explicit integration/template mode',async()=>{
 const f=fixture();await f.auth.start();assert.equal(await f.clients[0].fetch({forceRefreshToken:true}),'fixture-access');assert.deepEqual(f.tokenCalls,[{skipCache:true}]);f.auth.dispose();
 const legacy=fixture({key:{...config,tokenMode:'template'}});await legacy.auth.start();await legacy.clients[0].fetch({forceRefreshToken:false});assert.deepEqual(legacy.tokenCalls,[{skipCache:false,template:'convex'}]);legacy.auth.dispose();
});
test('AUTH01 session is restored from the SDK after a new controller; no identity/token is persisted',async()=>{
 const f=fixture();await f.auth.start();await f.confirm();f.auth.dispose();const next=new AuthSession(config,{approvedDevUrl,env:f.env,loadSDK:async()=>f.sdk});await next.start();f.clients.at(-1).notify(true);await tick();assert.equal(next.state.profile.subject,'A');assert.deepEqual([...f.storage],[]);next.dispose();
});
test('AUTH01 sign-out closes client, discards profile and preserves unrelated local data',async()=>{
 const f=fixture();f.storage.set('local-project','keep');await f.auth.start();await f.confirm();await f.auth.signOut();assert.equal(f.clients[0].closed,true);assert.equal(f.auth.state.status,'guest');assert.equal(f.auth.state.profile,null);assert.equal(f.storage.get('local-project'),'keep');assert.equal(await f.clients[0].fetch({forceRefreshToken:true}),null);f.auth.dispose();
});
test('AUTH01 late A profile cannot appear after account B is active',async()=>{
 let finish;const waiting=new Promise(r=>finish=r),f=fixture({profileWait:waiting});await f.auth.start();f.clients[0].notify(true);await f.switchUser('B');assert.equal(f.clients[0].closed,true);await f.confirm();finish({principal:issuer+'|A',subject:'A',issuer,plan:'free',syncEnabled:false});await tick();assert.equal(f.auth.state.profile.subject,'B');f.auth.dispose();
});
test('AUTH01 late token cannot retain privileges after sign-out',async()=>{
 let finish;const f=fixture({token:()=>new Promise(r=>finish=r)});await f.auth.start();const pending=f.clients[0].fetch({forceRefreshToken:true});await f.auth.signOut();finish('fixture-access');assert.equal(await pending,null);assert.equal(f.auth.state.profile,null);f.auth.dispose();
});
test('AUTH01 missing/rejected/throwing tokens enter Session expired and clear remote data',async()=>{
 for(const kind of ['missing','rejected','throws']){const f=fixture({token:kind==='missing'?null:kind==='throws'?()=>{throw new Error('private provider detail')}: 'fixture-access'});await f.auth.start();if(kind==='rejected')f.clients[0].notify(false);else await f.clients[0].fetch({forceRefreshToken:true});assert.equal(f.auth.state.status,'session-expired');assert.equal(f.auth.state.profile,null);assert.equal(f.clients[0].closed,true);assert.ok(!JSON.stringify(f.auth.state).includes('private provider detail'));f.auth.dispose();}
});
test('AUTH01 offline clears remote profile; online reconnect uses a fresh client',async()=>{
 const f=fixture();await f.auth.start();await f.confirm();f.env.navigator.onLine=false;f.events.dispatchEvent(new Event('offline'));assert.equal(f.auth.state.status,'offline');assert.equal(f.auth.state.profile,null);assert.equal(f.clients[0].closed,true);f.env.navigator.onLine=true;f.events.dispatchEvent(new Event('online'));await tick();await f.confirm();assert.equal(f.auth.state.profile.subject,'A');assert.equal(f.clients.length,2);f.auth.dispose();
});
test('AUTH01 failed remote sign-out remains fail-closed across reload until retried',async()=>{
 const f=fixture();await f.auth.start();await f.confirm();f.sdk.clerk.signOut=async()=>{throw new Error('private failure')};await f.auth.signOut();assert.equal(f.auth.state.reason,'SIGN_OUT_PENDING');assert.equal(f.auth.state.profile,null);const next=new AuthSession(config,{approvedDevUrl,env:f.env,loadSDK:async()=>f.sdk});await next.start();assert.equal(next.state.reason,'SIGN_OUT_PENDING');f.sdk.clerk.signOut=async()=>{};await next.signOut();assert.equal(next.state.status,'guest');assert.equal(f.storage.size,0);next.dispose();f.auth.dispose();
});
test('AUTH01 unexpected identity and backend error never become confirmed',async()=>{
 for(const failure of ['wrong-user','wrong-issuer','backend']){const f=fixture();await f.auth.start();f.clients[0].readIdentity=async()=>{if(failure==='backend')throw new Error('private response');return{principal:'x',subject:failure==='wrong-user'?'B':'A',issuer:failure==='wrong-issuer'?'https://other.test':issuer,plan:'free',syncEnabled:false}};await f.confirm();assert.equal(f.auth.state.convex,'error');assert.equal(f.auth.state.profile,null);f.auth.dispose();}
});
test('AUTH01 SDK UI APIs mount actual flow boundaries with query-free same-origin return URL',async()=>{
 const f=fixture({user:null});await f.auth.start();assert.equal(f.auth.mount('sign-in',{}),true);assert.equal(f.mounts[0].kind,'sign-in');assert.equal(f.mounts[0].options.forceRedirectUrl,'https://127.0.0.1:4181/#account');assert.equal(f.auth.mount('sign-up',{}),true);assert.ok(f.mounts.some(m=>m.kind==='unmount-in'));assert.equal(f.mounts.at(-1).kind,'sign-up');f.auth.dispose();
});
test('AUTH01 provider load failure stays generic and native auth stays blocked',async()=>{
 const f=fixture();f.auth.loadSDK=async()=>{throw new Error('private SDK failure')};await f.auth.start();assert.equal(f.auth.state.reason,'PROVIDER_UNAVAILABLE');assert.ok(!JSON.stringify(f.auth.state).includes('private SDK failure'));f.auth.dispose();
 const native=fixture();native.env.__TAURI_INTERNALS__={};await native.auth.start();assert.equal(native.auth.state.reason,'NATIVE_ORIGIN_UNVERIFIED');assert.equal(native.loads,0);native.auth.dispose();
});
test('AUTH01 CSP only opens exact configured DEV origins; auth endpoints and SDK are not SW-cached',()=>{
 const blocked=authCSP(EMPTY_AUTH_CONFIG),active=authCSP(config);assert.ok(!blocked.includes('clerk'));assert.ok(active.includes(issuer));assert.ok(active.includes('wss://clearance-fixture.eu-west-1.convex.cloud'));assert.ok(!active.includes('unsafe-eval'));assert.ok(!SHELL_ASSETS.some(a=>a.includes('sdk.js')));assert.equal(shellRequestKey({url:issuer+'/v1/client',method:'GET'},'https://melly.test/'),null);assert.equal(shellRequestKey({url:'https://melly.test/runtime/auth-sdk.js',method:'GET'},'https://melly.test/'),null);
});
test('AUTH01 configured preview uses distinct generation and public fields only',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'melly-auth01-bundle-')),result=await buildPrivatePreview(join(parent,'candidate'),{authConfig:config});assert.equal(result.manifest.authConfigured,true);assert.match(result.manifest.version,/^v\d+-20261022$/);assert.notEqual(result.manifest.version,'v9-20261022');const output=await readFile(join(result.path,'js/auth/public-config.js'),'utf8');assert.deepEqual(parsePublicConfigModule(output),config);assert.ok(!result.manifest.assets.some(a=>/\.env|convex\/|server\//.test(a.path)));
});

test('AUTH01 missing-config guest follows offline/online changes without loading SDK',async()=>{
 const f=fixture({key:EMPTY_AUTH_CONFIG});await f.auth.start();f.env.navigator.onLine=false;f.events.dispatchEvent(new Event('offline'));assert.equal(f.auth.state.status,'offline');f.env.navigator.onLine=true;f.events.dispatchEvent(new Event('online'));await tick();assert.equal(f.auth.state.status,'guest');assert.equal(f.loads,0);f.auth.dispose();
});
test('AUTH01 cross-tab pending sign-out immediately closes remote privileges',async()=>{
 const f=fixture();await f.auth.start();await f.confirm();const event=new Event('storage');Object.assign(event,{key:'melly-auth-logout-pending-v1',newValue:'true'});f.events.dispatchEvent(event);assert.equal(f.auth.state.profile,null);assert.equal(f.clients[0].closed,true);assert.equal(f.auth.state.reason,'SIGN_OUT_PENDING');f.auth.dispose();
});
test('AUTH01 a dismissed SDK flow can be opened again',async()=>{
 const f=fixture({user:null});await f.auth.start();f.auth.mount('sign-in');f.auth.mount('sign-in');assert.equal(f.mounts.filter(m=>m.kind==='sign-in').length,2);assert.ok(f.mounts.some(m=>m.kind==='unmount-in'));f.auth.dispose();
});
test('AUTH01 client construction failure is a recoverable Error state',async()=>{
 const f=fixture();f.sdk.createClient=()=>{throw new Error('private connection detail')};await f.auth.start();assert.equal(f.auth.state.status,'error');assert.equal(f.auth.state.reason,'CONVEX_UNAVAILABLE');assert.equal(f.auth.state.profile,null);f.auth.dispose();
});

test('AUTH01 retry after reload retains session listener for a later sign-in',async()=>{
 const f=fixture();await f.auth.start();f.sdk.clerk.signOut=async()=>{throw new Error('offline')};await f.auth.signOut();f.auth.dispose();
 const next=new AuthSession(config,{approvedDevUrl,env:f.env,loadSDK:async()=>f.sdk});await next.start();
 f.sdk.clerk.signOut=async()=>{f.sdk.clerk.session=null;f.sdk.clerk.user=null};await next.signOut();await f.switchUser('B');
 assert.equal(next.state.clerkSignedIn,true);f.clients.at(-1).notify(true);await tick();assert.equal(next.state.profile.subject,'B');next.dispose();
});

test('AUTH01 local env input selects only public fields and preserves literal values',async()=>{
 const {parsePublicAuthEnv}=await import('../scripts/auth/local-public-config.mjs');
 const result=parsePublicAuthEnv('CONVEX_DEPLOYMENT=dev:fixture-only\nCLERK_SECRET_KEY=never-forward\nCLERK_PUBLISHABLE_KEY="fixture-public" # comment\nCLERK_JWT_ISSUER_DOMAIN=https://fixture.clerk.accounts.dev\n');
 assert.deepEqual(result,{CLERK_PUBLISHABLE_KEY:'fixture-public',CLERK_JWT_ISSUER_DOMAIN:'https://fixture.clerk.accounts.dev'});assert.ok(!JSON.stringify(result).includes('never-forward'));
 assert.equal(parsePublicAuthEnv('MELLY_CLERK_TOKEN_MODE=$OTHER').MELLY_CLERK_TOKEN_MODE,'$OTHER');
});
test('AUTH01 local env rejects duplicate or malformed public fields without echoing values',async()=>{
 const {parsePublicAuthEnv}=await import('../scripts/auth/local-public-config.mjs');
 assert.throws(()=>parsePublicAuthEnv('CLERK_PUBLISHABLE_KEY=a\nCLERK_PUBLISHABLE_KEY=b'),/Duplicate public authentication setting: CLERK_PUBLISHABLE_KEY/);
 assert.throws(()=>parsePublicAuthEnv('CLERK_PUBLISHABLE_KEY="unclosed'),/Malformed public authentication setting: CLERK_PUBLISHABLE_KEY/);
});
test('AUTH01 local config honors explicit process overrides and never forwards secrets',async()=>{
 const {readPublicAuthEnv}=await import('../scripts/auth/local-public-config.mjs');const parent=await mkdtemp(join(tmpdir(),'melly-public-config-'));const file=join(parent,'local.env');
 const {writeFile}=await import('node:fs/promises');await writeFile(file,'CLERK_PUBLISHABLE_KEY=from-file\nMELLY_CLERK_TOKEN_MODE=integration\n');
 assert.deepEqual(await readPublicAuthEnv(file,{CLERK_PUBLISHABLE_KEY:'explicit',CLERK_SECRET_KEY:'never-forward'}),{CLERK_PUBLISHABLE_KEY:'explicit',MELLY_CLERK_TOKEN_MODE:'integration'});
 assert.deepEqual(await readPublicAuthEnv(join(parent,'missing'),{}),{});
});

test('AUTH01 repeated SDK builds do not accumulate stale legal notices',async()=>{
 const {buildAuthSDK}=await import('../scripts/auth/build-sdk.mjs');const dir=await mkdtemp(join(tmpdir(),'melly-sdk-repro-')),output=join(dir,'auth-sdk.js');
 await buildAuthSDK(output);const firstJS=await readFile(output),firstLegal=await readFile(output+'.LEGAL.txt','utf8');
 await buildAuthSDK(output);assert.deepEqual(await readFile(output),firstJS);assert.equal(await readFile(output+'.LEGAL.txt','utf8'),firstLegal);
 assert.equal(firstLegal.split('Third-party package notices for bundled inputs').length-1,1);
});

test('clearance requires an explicit canonical dev endpoint bound to the configured target',()=>{
 const env={CLERK_PUBLISHABLE_KEY:config.clerkPublishableKey,CLERK_JWT_ISSUER_DOMAIN:issuer,MELLY_CLERK_APP_OWNER_CONFIRMED:'true'};
 assert.throws(()=>authConfigFromEnv(env),/rejected/);
 assert.equal(validateAuthConfig(config).ready,false);
 const nonString=new URL(approvedDevUrl);
 assert.equal(validateAuthConfig({...config,convexUrl:nonString},nonString).ready,false);
 for(const url of [approvedDevUrl+'/',approvedDevUrl+':443',approvedDevUrl+'/x','https://clearance-fixture.convex.cloud.evil.test','http://clearance-fixture.convex.cloud','https://user@clearance-fixture.convex.cloud',approvedDevUrl+'\n']){
   assert.throws(()=>authConfigFromEnv({...env,MELLY_CONVEX_URL:url}),/rejected/);
 }
 assert.equal(authConfigFromEnv({...env,MELLY_CONVEX_URL:approvedDevUrl}).convexUrl,approvedDevUrl);
});

test('desktop stages no preview SDK or active auth config, and rejects stale assets',async()=>{
 const original=fileURLToPath(new URL('../',import.meta.url));
 const folder=await mkdtemp(join(tmpdir(),'melly-clearance-desktop-'));
 const source=join(folder,'synthetic-dev-source');
 for(const asset of DESKTOP_ASSETS){
   await mkdir(dirname(join(source,asset)),{recursive:true});
   await copyFile(join(original,asset),join(source,asset));
 }
 await writeFile(join(source,'js/auth/public-config.js'),publicConfigModule(config));
 const target=join(folder,'desktop-dist');
 await prepareDesktop(source,target);
 await prepareDesktop(source,target);
 assert.ok(!DESKTOP_ASSETS.some(asset=>asset.startsWith('runtime/')));
 const packaged=await readFile(join(target,'js/auth/public-config.js'),'utf8');
 assert.deepEqual(parsePublicConfigModule(packaged),EMPTY_AUTH_CONFIG);
 const f=fixture({key:parsePublicConfigModule(packaged)});
 f.env.__TAURI_INTERNALS__={};
 await f.auth.start();
 assert.equal(f.auth.state.setupRequired,true);
 assert.equal(f.loads,0);
 await mkdir(join(target,'runtime'));
 await writeFile(join(target,'runtime/auth-sdk.js'),'stale fixture');
 await assert.rejects(prepareDesktop(source,target),/Unexpected desktop staging entry: runtime/);
 assert.equal(await readFile(join(target,'runtime/auth-sdk.js'),'utf8'),'stale fixture');
});
