import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRequest, buildMessages, validateProposal, safePath} from '../js/ai/contracts.js';
import {AIController} from '../js/ai/controller.js';
import {AgentChat} from '../js/chat.js';
import {MobileCodeEditor} from '../js/editor.js';
import {lineDiff} from '../js/workspace/model.js';
const file={path:'src/main.js',revision:2,content:'const answer = 1;',workspaceId:'p',workspaceToken:'t'};
const request=(patch={})=>({requestId:'fixture-request-0001',model:'fixture/model',kind:'chat',prompt:'Hello',files:[],maxOutputTokens:128,...patch});
test('AI01 context defaults to typed prompt only and exact messages include only selected files',()=>{
 const r=validateRequest(request());assert.equal(buildMessages(r).length,2);assert.ok(!JSON.stringify(buildMessages(r)).includes(file.content));
 const s=validateRequest(request({kind:'fix',files:[file]}));assert.ok(JSON.stringify(buildMessages(s)).includes(file.content));assert.match(buildMessages(s)[0].content,/UNTRUSTED/);
});
test('AI01 canonical text paths exclude traversal, hidden files, credentials and binaries',()=>{
 for(const p of ['../x.js','/x.js','C:/x.js','a\\x.js','.env','.env.local','a/.git/config','keys/a.js','credentials.json','id_rsa','x.png','a//b.js','a/%2e%2e/x.js','a/../x.js'])assert.throws(()=>safePath(p),p);
 assert.equal(safePath('src/good.ts'),'src/good.ts');
 for(const content of ['x\0y','\ud800','-----BEGIN PRIVATE KEY-----','sk-or-v1-'+'x'.repeat(48),'API_KEY="'+ 'x'.repeat(32)+'"'])assert.throws(()=>validateRequest(request({files:[{...file,content}]})));
 assert.throws(()=>validateRequest(request({files:[{...file,content:'x'.repeat(40000)}]})));
 assert.throws(()=>validateRequest(request({maxOutputTokens:99999})));
 assert.throws(()=>validateRequest(request({accountId:'B'})));
});
test('AI01 proposals are bound to selected path/revision and reject unselected files or malformed edits',()=>{
 const p={path:file.path,baseRevision:2,content:'const answer = 2;',explanation:'Fix value',diagnostics:['Tests not run']};
 assert.equal(validateProposal(JSON.stringify(p),[file]).content,p.content);
 for(const patch of [{path:'other.js'},{baseRevision:1},{content:file.content},{content:'\0'},{extra:true}])assert.throws(()=>validateProposal(JSON.stringify({...p,...patch}),[file]));
 assert.throws(()=>validateProposal('```json\n{}\n```',[file]));
});
function harness(complete=async()=>({mode:'mock',text:'Fixture response',proposal:null,usage:{}})){
 const auth={state:{convex:'confirmed',profile:{principal:'A'}},generation:1,subscribe(fn){this.receive=fn;fn(this.state);return()=>{};}};
 const c=new AIController({getAuth:()=>auth,getScope:()=> 'project-1',transport:{complete},env:{navigator:{onLine:true},localStorage:{getItem(){return ''},setItem(){}}}});
 return{c,auth};
}
test('AI01 no send before consent, authenticated async completion and no implicit file reading',async()=>{
 let calls=0;const {c}=harness(async()=>{calls++;return{mode:'mock',text:'Fixture response',proposal:null,usage:{}}});c.model='fixture/model';
 c.prepare('Hi','chat',[]);assert.equal(calls,0);assert.equal(c.preview.request.files.length,0);await c.confirm();assert.equal(calls,1);assert.equal(c.jobs[0].status,'complete');assert.equal(c.messages[0].mode,'mock');
});
test('AI01 cancel, logout and scope changes discard late responses and pending consent',async()=>{
 for(const change of ['cancel','logout','project','model']){
  let resolve;const {c,auth}=harness(()=>new Promise(r=>resolve=r));c.model='fixture/model';c.prepare('Hi','chat',[]);const running=c.confirm();await Promise.resolve();
  if(change==='cancel')c.cancel();if(change==='logout'){auth.state={convex:'not-connected',profile:null};auth.receive(auth.state);}if(change==='project')c.scopeChanged();if(change==='model')c.selectModel('other/model');
  resolve({mode:'mock',text:'LATE PRIVATE A',proposal:null});await running;assert.equal(c.messages.length,0,change);assert.equal(c.preview,null);
 }
});
test('AI01 offline/guest cannot prepare or send; errors are sanitized and terminal',async()=>{
 const {c,auth}=harness(async()=>{throw new Error('sk-or-SECRET raw prompt');});c.model='fixture/model';c.prepare('Hi','chat',[]);await c.confirm();assert.equal(c.jobs[0].status,'failed');assert.ok(!JSON.stringify(c.jobs).includes('SECRET'));
 auth.state={profile:null,convex:'not-connected'};assert.throws(()=>c.prepare('Hi','chat',[]));
});
test('AI01 client displays only verified provider identity and never relabels requested aliases',async()=>{
 const unavailable=harness(async()=>({mode:'provider',text:'unsafe',proposal:null,verification:{status:'unavailable'}})).c;unavailable.model='fixture/model';unavailable.prepare('Hi','chat',[]);await unavailable.confirm();assert.equal(unavailable.jobs[0].status,'failed');assert.equal(unavailable.jobs[0].error,'PROVIDER_VERIFICATION_UNAVAILABLE');assert.equal(unavailable.messages.length,0);
 const verified=harness(async()=>({mode:'provider',text:'verified',proposal:null,verification:{status:'verified',requestedModel:'fixture/model',responseModel:'fixture/model-2026',generationId:'gen-fixture-1',provider:'Fixture Provider'}})).c;verified.model='fixture/model';verified.prepare('Hi','chat',[]);await verified.confirm();assert.equal(verified.jobs[0].status,'complete');assert.equal(verified.messages[0].model,'fixture/model-2026');assert.equal(verified.messages[0].requestedModel,'fixture/model');assert.equal(verified.messages[0].provider,'Fixture Provider');
});
test('AI01 structured proposal uses real guarded editor: reject/cancel preserve, approve exact delta, stale and account changes deny',()=>{
 const old=globalThis.document;globalThis.document={getElementById:()=>null,activeElement:null};
 try{
  for(const decision of ['reject','cancel','approve','stale','account']){
   const editor=new MobileCodeEditor('none',{files:{'main.js':'const value=1;','keep.js':'// untouched'},schedule:()=>0});
   const chat=Object.create(AgentChat.prototype);chat.getFileSnapshot=p=>editor.getFileSnapshot(p);chat.onApplyCode=r=>editor.applyReviewedChange(r);chat.renderAndAttach=()=>{};chat.ai={ready:()=>true,authPrincipal:'A'};
   const snapshot={...editor.getFileSnapshot('main.js'),path:'main.js'},p={path:'main.js',baseRevision:0,content:'const value=2;',explanation:'Fixture edit',diagnostics:['Not run']};
   chat.receiveAIProposal(p,[snapshot],'mock','A');assert.equal(editor.files['main.js'],snapshot.content);assert.match(lineDiff(snapshot.content,p.content,'main.js'),/\+const value=2;/);
   if(decision==='reject')chat.rejectReview();if(decision==='cancel')chat.cancelReview();
   if(decision==='stale')editor.updateFileContent('main.js','// newer');if(decision==='account')chat.ai.authPrincipal='B';
   if(['approve','stale','account'].includes(decision))chat.approveReview();
   assert.equal(editor.files['main.js'],decision==='approve'?p.content:decision==='stale'?'// newer':snapshot.content);assert.equal(editor.files['keep.js'],'// untouched');if(['stale','account'].includes(decision))assert.equal(chat.pendingReview.status,'stale');
  }
 }finally{if(old===undefined)delete globalThis.document;else globalThis.document=old;}
});

test('Gate2B UI uses the server output ceiling in the exact consent preview',()=>{
 const {c}=harness();c.model='fixture/model';c.catalog={limits:{maxOutputTokens:32}};
 c.prepare('Reply with exactly MELLY_DEV_OK.');assert.equal(c.preview.request.maxOutputTokens,32);assert.equal(c.preview.request.files.length,0);
});
test('Gate2B UI displays terminal authorization/grant/cost errors without retries',async()=>{
 for(const code of ['OPERATOR_NOT_ALLOWED','GRANT_CONSUMED','GRANT_NOT_ALLOWED','REQUEST_COST_LIMIT','INPUT_TOKEN_LIMIT','PROVIDER_KEY_CAP_UNVERIFIED','NO_COMPLIANT_ENDPOINT','PROVIDER_NOT_ALLOWED']){
  let calls=0;const {c}=harness(async()=>{calls++;throw {data:code};});c.model='fixture/model';c.prepare('Hi');await c.confirm();assert.equal(c.jobs[0].error,code);assert.equal(calls,1);assert.equal(c.messages.length,0);
 }
});
test('Gate2B account B cannot receive A output while a request is unfinished',async()=>{
 let release;const {c,auth}=harness(()=>new Promise(resolve=>release=resolve));c.model='fixture/model';c.prepare('A only');const pending=c.confirm();
 auth.state={convex:'confirmed',profile:{principal:'B'}};auth.receive(auth.state);release({mode:'mock',text:'PRIVATE A'});await pending;
 assert.equal(c.authPrincipal,'B');assert.equal(c.messages.length,0);assert.equal(c.jobs.length,0);assert.equal(c.preview,null);assert.equal(c.model,'');
});
