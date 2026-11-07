// Deterministic Convex emulator + fetch fixtures. No real provider calls or JWTs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {defineTestApp} from 'convex-test';
import schema from '../convex/schema.ts';
import * as ai from '../convex/ai.ts';
import {parseCatalog,policy as readPolicy,providerRouting} from '../convex/aiPolicy.ts';
import {validateRequest,buildMessages} from '../js/ai/contracts.js';
const {api,internal,createTest}=defineTestApp({schema}).defineModules({ai});
const issuer='https://melly-ai01-fixture.clerk.accounts.dev';
const basePolicy={enabled:true,approval:'AI01_OWNER_APPROVED',models:{'fixture/model':{prompt:0.000001,completion:0.000002}},userBudgetUSD:0.1,deploymentBudgetUSD:0.2,operators:['A','B','C'],maxRequestUSD:0.1,providerKeyCapUSD:1,maxInputTokens:32768,maxOutputTokens:2048,maxSerializedRequestBytes:4096,userParallel:1,deploymentParallel:4,userRequestsPerMinute:6,deploymentRequestsPerMinute:12,devGrant:{id:'fixture-grant-0001',subject:'A',model:'fixture/model',purpose:'chat',expiresAt:4102444800000},provider:{only:['fixture'],names:['Fixture Provider'],data_collection:'deny',zdr:true,allow_fallbacks:false,require_parameters:true}};
process.env.CLERK_JWT_ISSUER_DOMAIN=issuer;
const request=(patch={})=>({requestId:crypto.randomUUID(),model:'fixture/model',kind:'chat',prompt:'Hi',files:[],maxOutputTokens:128,...patch});
const catalog={data:[{id:'fixture/model',name:'Deterministic model',context_length:32768,pricing:{prompt:'0.000001',completion:'0.000002',request:'0'},supported_parameters:['max_tokens']}]};
const completion=(patch={})=>({id:'gen-fixture-1',model:'fixture/model',service_tier:'default',openrouter_metadata:{attempt:1,strategy:'direct',endpoints:{available:[{model:'fixture/model',provider:'Fixture Provider',selected:true}]}},choices:[{message:{content:'Fixture response'}}],usage:{prompt_tokens:5,completion_tokens:3,cost:0.000011},...patch});
const generation=(patch={})=>({data:{id:'gen-fixture-1',model:'fixture/model',provider_name:'Fixture Provider',service_tier:'default',tokens_prompt:5,tokens_completion:3,total_cost:0.000011,...patch}});
async function fixture(fn,{body,fetchError,status=200,metadata,metadataStatus=200,metadataError=false,policy=basePolicy,endpoints,keyData,modelCatalog}={}){
 const saved=globalThis.fetch,oldPolicy=process.env.MELLY_AI_POLICY,oldKey=process.env.OPENROUTER_API_KEY;let calls=[];
 process.env.MELLY_AI_POLICY=JSON.stringify(policy);process.env.OPENROUTER_API_KEY='DETERMINISTIC-NOT-A-REAL-KEY';
 globalThis.fetch=async(url,init)=>{
  const target=String(url);calls.push({url:target,init});
  if(target.endsWith('/key'))return Response.json({data:keyData || {limit:1,limit_remaining:1,limit_reset:null,include_byok_in_limit:true}});
  if(target.endsWith('/endpoints'))return Response.json(endpoints || {data:{id:'fixture/model',architecture:{input_modalities:['text'],output_modalities:['text']},endpoints:[{model_id:'fixture/model',tag:'fixture',provider_name:'Fixture Provider',context_length:32768,max_prompt_tokens:32768,max_completion_tokens:2048,supported_parameters:['max_tokens'],pricing:catalog.data[0].pricing}]}});
  if(target.endsWith('/models'))return Response.json(modelCatalog || catalog);
  if(target.includes('/generation?')){if(metadataError)throw new Error('metadata unavailable');if(metadataStatus!==200)return Response.json({error:'fixture'},{status:metadataStatus});return metadata instanceof Response?metadata:Response.json(metadata || generation());}
  if(fetchError)throw new Error('raw PRIVATE file data');
  return body instanceof Response?body:Response.json(body || completion(),{status});
 };
 try{await fn({t:createTest(),calls});}finally{globalThis.fetch=saved;if(oldPolicy===undefined)delete process.env.MELLY_AI_POLICY;else process.env.MELLY_AI_POLICY=oldPolicy;if(oldKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=oldKey;}
}
const account=(t,subject='A')=>t.withIdentity({issuer,subject});
const grant=(patch={})=>{const current=JSON.parse(process.env.MELLY_AI_POLICY);current.devGrant={...current.devGrant,id:crypto.randomUUID(),...patch};process.env.MELLY_AI_POLICY=JSON.stringify(current);};
const settlement=(id,patch={})=>({id,status:'failed',verificationStatus:'unavailable',generationId:null,responseModel:null,providerName:null,routedProvider:null,routingStrategy:null,routingAttempt:null,serviceTier:null,reportedNano:null,actualNano:null,reportedPromptTokens:null,reportedCompletionTokens:null,promptTokens:null,completionTokens:null,error:'TIMEOUT',...patch});
const storedJob=(owner,i,status='complete')=>({owner,requestId:`history-${owner.slice(-1)}-${i.toString().padStart(5,'0')}`,model:'fixture/model',responseModel:'fixture/model',generationId:`gen-history-${i}`,providerName:'Fixture Provider',verificationStatus:'verified',status,startedAt:i,finishedAt:i+1,reservationNano:100,chargedNano:90,reportedNano:90,actualNano:90,reportedPromptTokens:5,reportedCompletionTokens:3,promptTokens:5,completionTokens:3,error:'',hidden:false});
async function drainHistory(identity,maxBatches=100){let removed=0,last;for(let i=0;i<maxBatches;i++){last=await identity.mutation(api.ai.removeHistory,{});removed+=last.removed;if(last.complete)return{removed,batches:i+1,last};assert.ok(last.removed>0);}throw new Error('history drain did not complete');}

test('AI01 backend: every public endpoint denies anonymous and foreign issuers; forged identity args fail',async()=>fixture(async({t,calls})=>{
 for(const name of ['catalog','complete'])await assert.rejects(()=>t.action(api.ai[name],name==='complete'?{request:request()}:{}),/UNAUTHENTICATED/);
 for(const name of ['usage','removeHistory'])await assert.rejects(()=>t[name==='usage'?'query':'mutation'](api.ai[name],{}),/UNAUTHENTICATED/);
 await assert.rejects(()=>t.withIdentity({issuer:'https://foreign.test',subject:'A'}).action(api.ai.catalog,{}),/UNAUTHORIZED_IDENTITY/);
 await assert.rejects(()=>account(t).action(api.ai.complete,{request:request({accountId:'B'})}));assert.equal(calls.length,0);
}));

test('AI01 backend: default disabled/missing key/missing allowlist make zero inference calls',async()=>fixture(async({t,calls})=>{
 for(const patch of [{enabled:false},{models:{}},{approval:''}]){process.env.MELLY_AI_POLICY=JSON.stringify({...basePolicy,...patch});await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}));}
 process.env.MELLY_AI_POLICY=JSON.stringify(basePolicy);delete process.env.OPENROUTER_API_KEY;await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),/PROVIDER_NOT_CONFIGURED/);
 assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,0);
}));

test('AI01 backend: exact response model and generation metadata are verified and preserved',async()=>fixture(async({t,calls})=>{
 const a=account(t),b=account(t,'B'),r=request({prompt:'PRIVATE SENTINEL'}),result=await a.action(api.ai.complete,{request:r});
 assert.equal(result.text,'Fixture response');assert.deepEqual(result.verification,{status:'verified',requestedModel:'fixture/model',responseModel:'fixture/model',generationId:'gen-fixture-1',provider:'Fixture Provider',routing:{provider:'Fixture Provider',strategy:'direct',attempt:1,serviceTier:'default'}});
 assert.equal(result.usage.actualNano,11000);assert.equal(result.usage.reportedNano,11000);assert.equal(result.usage.promptTokens,5);assert.equal(result.usage.completionTokens,3);
 const usage=await a.query(api.ai.usage,{});assert.equal(usage.jobs.length,1);assert.equal(usage.jobs[0].status,'complete');assert.equal(usage.jobs[0].verificationStatus,'verified');assert.equal(usage.jobs[0].generationId,'gen-fixture-1');assert.equal(usage.jobs[0].providerName,'Fixture Provider');assert.equal(usage.chargedNano,11000);assert.equal((await b.query(api.ai.usage,{})).jobs.length,0);
 await assert.rejects(()=>b.query(api.ai.job,{id:usage.jobs[0]._id}),/FORBIDDEN/);await assert.rejects(()=>t.query(api.ai.job,{id:usage.jobs[0]._id}),/UNAUTHENTICATED/);
 const rows=await t.run(async ctx=>await ctx.db.query('aiJobs').collect());assert.ok(!JSON.stringify(rows).includes('PRIVATE SENTINEL'));assert.ok(!JSON.stringify(rows).includes('DETERMINISTIC-NOT-A-REAL-KEY'));
 const call=calls.find(c=>c.url.includes('/chat/completions')),payload=JSON.parse(call.init.body);assert.equal(call.init.headers['X-OpenRouter-Metadata'],'enabled');assert.equal(payload.stream,false);assert.equal(payload.provider.allow_fallbacks,false);assert.equal(payload.max_tokens,128);assert.ok(payload.messages[1].content.includes('PRIVATE SENTINEL'));assert.equal(calls.filter(c=>c.url.includes('/generation?')).length,1);
 const deletion=await a.mutation(api.ai.removeHistory,{});assert.equal(deletion.complete,true);const after=await a.query(api.ai.usage,{});assert.equal(after.jobs.length,0);assert.equal(after.chargedNano,usage.chargedNano);await assert.rejects(()=>a.query(api.ai.job,{id:usage.jobs[0]._id}),/FORBIDDEN/);await assert.rejects(()=>a.action(api.ai.complete,{request:r}),/DUPLICATE_REQUEST/);
}));

test('AI01 backend: unexpected model aliases fail closed; explicitly approved concrete aliases verify',async()=>{
 await fixture(async({t})=>{
  await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),/MODEL_MISMATCH/);
  const usage=await account(t).query(api.ai.usage,{});assert.equal(usage.jobs[0].verificationStatus,'mismatch');assert.equal(usage.jobs[0].responseModel,'fixture/model-2026');assert.equal(usage.jobs[0].status,'failed');assert.ok(usage.chargedNano>=usage.jobs[0].reservationNano);
 },{body:completion({model:'fixture/model-2026',openrouter_metadata:{attempt:1,strategy:'direct',endpoints:{available:[{model:'fixture/model-2026',provider:'Fixture Provider',selected:true}]}}}),metadata:generation({model:'fixture/model-2026'})});
 await fixture(async({t})=>{
  const result=await account(t).action(api.ai.complete,{request:request()});assert.equal(result.verification.status,'verified');assert.equal(result.verification.responseModel,'fixture/model-2026');
 },{policy:{...basePolicy,models:{'fixture/model':{prompt:0.000001,completion:0.000002,responseModels:['fixture/model-2026']}}},body:completion({model:'fixture/model-2026',openrouter_metadata:{attempt:1,strategy:'direct',endpoints:{available:[{model:'fixture/model-2026',provider:'Fixture Provider',selected:true}]}}}),metadata:generation({model:'fixture/model-2026'})});
});

test('AI01 backend: missing generation ID and missing provider metadata are unavailable, never verified',async()=>{
 await fixture(async({t,calls})=>{await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),/PROVIDER_VERIFICATION_UNAVAILABLE/);const usage=await account(t).query(api.ai.usage,{});assert.equal(usage.jobs[0].verificationStatus,'unavailable');assert.equal(calls.filter(c=>c.url.includes('/generation?')).length,0);assert.equal(usage.chargedNano,usage.jobs[0].reservationNano);},{body:completion({id:undefined})});
 await fixture(async({t,calls})=>{await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),/PROVIDER_VERIFICATION_UNAVAILABLE/);const usage=await account(t).query(api.ai.usage,{});assert.equal(usage.jobs[0].verificationStatus,'unavailable');assert.equal(usage.jobs[0].providerName,undefined);assert.equal(calls.filter(c=>c.url.includes('/generation?')).length,1);},{metadata:generation({provider_name:undefined})});
});

test('AI01 backend: failed or malformed generation metadata lookup is unavailable without retry and retains reservation',async()=>{
 for(const options of [{metadataStatus:500},{metadataError:true},{metadata:new Response('not json')}])await fixture(async({t,calls})=>{await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),/PROVIDER_VERIFICATION_UNAVAILABLE/);const usage=await account(t).query(api.ai.usage,{});assert.equal(usage.jobs[0].verificationStatus,'unavailable');assert.equal(usage.chargedNano,usage.jobs[0].reservationNano);assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,1);assert.equal(calls.filter(c=>c.url.includes('/generation?')).length,1);},options);
});

test('AI01 backend: inconsistent provider, usage or cost metadata fails closed and charges conservatively',async()=>{
 for(const metadata of [generation({provider_name:'Different Provider'}),generation({tokens_prompt:6}),generation({total_cost:0.000012})])await fixture(async({t})=>{await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),/PROVIDER_METADATA_MISMATCH/);const usage=await account(t).query(api.ai.usage,{});assert.equal(usage.jobs[0].verificationStatus,'mismatch');assert.ok(usage.chargedNano>=usage.jobs[0].reservationNano);}, {metadata});
});

test('AI01 backend: atomic single-user concurrency, rate limit, global/user budgets and idempotency',async()=>fixture(async({t})=>{
 const a=account(t),args={requestId:crypto.randomUUID(),model:'fixture/model',reservationNano:50000000};
 const id=await a.mutation(internal.ai.reserve,{...args,policySnapshot:JSON.stringify(readPolicy())});await assert.rejects(()=>a.mutation(internal.ai.reserve,{policySnapshot:JSON.stringify(readPolicy()),...args,requestId:crypto.randomUUID()}),/JOB_ALREADY_RUNNING/);
 await a.mutation(internal.ai.settle,settlement(id));
 await assert.rejects(()=>a.mutation(internal.ai.reserve,{policySnapshot:JSON.stringify(readPolicy()),...args,requestId:crypto.randomUUID(),reservationNano:60000000}),/BUDGET_EXHAUSTED/);await assert.rejects(()=>a.mutation(internal.ai.reserve,{...args,policySnapshot:JSON.stringify(readPolicy())}),/DUPLICATE_REQUEST/);
 grant({subject:'B'});const b=account(t,'B'),bId=await b.mutation(internal.ai.reserve,{policySnapshot:JSON.stringify(readPolicy()),...args,requestId:crypto.randomUUID(),reservationNano:100000000});await b.mutation(internal.ai.settle,settlement(bId));
 grant({subject:'C'});const c=account(t,'C');await assert.rejects(()=>c.mutation(internal.ai.reserve,{policySnapshot:JSON.stringify(readPolicy()),...args,requestId:crypto.randomUUID(),reservationNano:60000000}),/BUDGET_EXHAUSTED/);
 grant({subject:'A'});await t.run(async ctx=>{const row=await ctx.db.query('aiBudgets').withIndex('by_scope',q=>q.eq('scope',issuer+'|A')).unique();await ctx.db.patch(row._id,{minute:Math.floor(Date.now()/60000),requests:6});});
 await assert.rejects(()=>a.mutation(internal.ai.reserve,{policySnapshot:JSON.stringify(readPolicy()),...args,requestId:crypto.randomUUID(),reservationNano:1}),/RATE_LIMITED/);
}));

test('AI01 backend: server rejects unsafe context, output limit, unknown model/pricing and over-context before inference',async()=>fixture(async({t,calls})=>{
 for(const patch of [{model:'other/model'},{maxOutputTokens:9000},{files:[{path:'../secret.js',revision:0,content:'x'}]},{files:[{path:'x.js',revision:0,content:'x'.repeat(40000)}]}])await assert.rejects(()=>account(t).action(api.ai.complete,{request:request(patch)}));
 assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,0);
}));

test('AI01 backend: provider errors are redacted, reservation retained, no retries after uncertain failure',async()=>fixture(async({t,calls})=>{
 await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),/NETWORK_UNAVAILABLE/);const usage=await account(t).query(api.ai.usage,{});assert.equal(usage.jobs[0].error,'NETWORK_UNAVAILABLE');assert.equal(usage.jobs[0].verificationStatus,'unavailable');assert.ok(usage.chargedNano>0);assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,1);assert.ok(!JSON.stringify(usage).includes('PRIVATE'));
},{fetchError:true}));

test('AI01 backend: malformed proposal fails closed without editor writes',async()=>fixture(async({t})=>{
 grant({purpose:'fix'});await assert.rejects(()=>account(t).action(api.ai.complete,{request:request({kind:'fix',files:[{path:'main.js',revision:1,content:'const a=1;'}]})}),/MALFORMED_PROPOSAL/);
},{body:{choices:[{message:{content:'not JSON'}}]}}));

test('AI01 catalog: validates pricing/schema, refuses unknown and additional priced capabilities',()=>{
 process.env.MELLY_AI_POLICY=JSON.stringify(basePolicy);assert.equal(parseCatalog(catalog)[0].bounded,true);assert.deepEqual(readPolicy().models['fixture/model'].responseModels,['fixture/model']);
 assert.equal(parseCatalog({data:[{...catalog.data[0],pricing:{prompt:'-1',completion:'NaN'}}]})[0].prompt,null);
 assert.equal(parseCatalog({data:[{...catalog.data[0],pricing:{prompt:'0.1',completion:'0.1',request:'0.5'}}]})[0].bounded,true);
 assert.throws(()=>parseCatalog({}));assert.deepEqual(parseCatalog({data:[{}]}),[]);assert.deepEqual(parseCatalog({data:[catalog.data[0],catalog.data[0]]}),[]);
 process.env.MELLY_AI_POLICY=JSON.stringify({...basePolicy,models:{'fixture/model':{prompt:1e-6,completion:2e-6,responseModels:['bad alias']}}});assert.equal(readPolicy().enabled,false);process.env.MELLY_AI_POLICY=JSON.stringify(basePolicy);
});

test('AI01 backend: price ceiling, context bound, invalid payload and oversized response never return unsafe output',async()=>fixture(async({t,calls})=>{
 process.env.MELLY_AI_POLICY=JSON.stringify({...basePolicy,models:{'fixture/model':{prompt:0,completion:0}}});await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),/PRICE_UNKNOWN/);
 process.env.MELLY_AI_POLICY=JSON.stringify(basePolicy);await assert.rejects(()=>account(t).action(api.ai.complete,{request:request({prompt:'p'.repeat(7000),files:[{path:'a.js',revision:0,content:'a'.repeat(15000)},{path:'b.js',revision:0,content:'b'.repeat(15000)}]})}),/REQUEST_SIZE_LIMIT/);
 assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,0);
}));

for(const providerStatus of [401,403,429,500])test(`AI01 provider HTTP ${providerStatus} is sanitized without retry`,async()=>fixture(async({t,calls})=>{
 await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),new RegExp(providerStatus===500?'PROVIDER_5XX':'PROVIDER_'+providerStatus));assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,1);
},{status:providerStatus}));

test('AI01 provider invalid JSON, timeout and output-token exhaustion are terminal with charged reservations',async()=>{
 for(const variant of ['json','timeout','tokens'])await fixture(async({t,calls})=>{
  const baseFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>{if(!String(url).includes('/chat/completions'))return baseFetch(url,options);calls.push({url:String(url),init:options});if(variant==='json')return new Response('INVALID PRIVATE JSON');if(variant==='timeout')throw new DOMException('PRIVATE','TimeoutError');return Response.json({choices:[{message:{content:'text'}}],usage:{completion_tokens:5000}});};
  await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),new RegExp(variant==='json'?'INVALID_PROVIDER_RESPONSE':variant==='timeout'?'TIMEOUT':'OUTPUT_TOKEN_LIMIT'));
  const usage=await account(t).query(api.ai.usage,{});assert.ok(usage.chargedNano>0);assert.equal(usage.inflight,0);assert.ok(!JSON.stringify(usage).includes('PRIVATE'));assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,1);
 });
});

test('AI01 settlement: verified cost can release reservation; unavailable and overruns remain conservative; cross-owner denied',async()=>{
 await fixture(async({t})=>{const usage=await account(t).action(api.ai.complete,{request:request()});const after=await account(t).query(api.ai.usage,{});assert.equal(after.chargedNano,usage.usage.actualNano);});
 await fixture(async({t})=>{const a=account(t),b=account(t,'B'),id=await a.mutation(internal.ai.reserve,{policySnapshot:JSON.stringify(readPolicy()),requestId:crypto.randomUUID(),model:'fixture/model',reservationNano:100});await assert.rejects(()=>b.mutation(internal.ai.settle,settlement(id)),/FORBIDDEN/);await a.mutation(internal.ai.settle,settlement(id,{verificationStatus:'verified',status:'complete',generationId:'gen-overrun',responseModel:'fixture/model',providerName:'Fixture Provider',reportedNano:200,actualNano:200,reportedPromptTokens:1,reportedCompletionTokens:1,promptTokens:1,completionTokens:1,error:''}));const usage=await a.query(api.ai.usage,{});assert.equal(usage.blocked,true);assert.equal(usage.chargedNano,200);assert.equal(usage.jobs[0].error,'BUDGET_OVERRUN');await assert.rejects(()=>b.mutation(internal.ai.reserve,{policySnapshot:JSON.stringify(readPolicy()),requestId:crypto.randomUUID(),model:'fixture/model',reservationNano:1}),/BUDGET_EXHAUSTED/);});
});

test('AI01 catalog TTL/failure displays stale cache and refuses inference',async()=>fixture(async({t})=>{
 await account(t).action(api.ai.catalog,{});const time=Date.now,fetch=globalThis.fetch;Date.now=()=>time()+600000;globalThis.fetch=async()=>{throw new Error('offline');};
 try{const stale=await account(t).action(api.ai.catalog,{});assert.equal(stale.stale,true);assert.equal(stale.ready,false);assert.ok(stale.updatedAt>0);await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),/STALE_CATALOG/);}finally{Date.now=time;globalThis.fetch=fetch;}
}));

for(const count of [0,1,49,50,51,100,500])test(`AI01 history deletion: owner-scoped complete deletion for ${count} records`,async()=>fixture(async({t})=>{
 const owner=issuer+'|A',other=issuer+'|B';await t.run(async ctx=>{for(let i=0;i<count;i++){await ctx.db.insert('aiJobs',storedJob(owner,i));if(i<3)await ctx.db.insert('aiJobs',storedJob(other,i));}});
 const result=await drainHistory(account(t),20);assert.equal(result.removed,count);assert.equal(result.last.complete,true);
 const rows=await t.run(async ctx=>await ctx.db.query('aiJobs').collect());assert.equal(rows.filter(row=>row.owner===owner&&!row.hidden).length,0);assert.equal(rows.filter(row=>row.owner===other&&row.hidden).length,0);
 const repeated=await account(t).mutation(api.ai.removeHistory,{});assert.deepEqual(repeated,{removed:0,complete:true,status:'complete',batchLimit:50});
}));

test('AI01 history deletion: interrupted batches resume; running rows, ledgers, costs and audit evidence are preserved',async()=>fixture(async({t})=>{
 const owner=issuer+'|A';let sampleId;await t.run(async ctx=>{await ctx.db.insert('aiBudgets',{scope:owner,chargedNano:9000,inflight:1,minute:1,requests:1,blocked:false});for(let i=0;i<100;i++){const id=await ctx.db.insert('aiJobs',storedJob(owner,i,i%2?'complete':'failed'));if(i===0)sampleId=id;}await ctx.db.insert('aiJobs',storedJob(owner,999,'running'));});
 const first=await account(t).mutation(api.ai.removeHistory,{});assert.deepEqual(first,{removed:50,complete:false,status:'partial',batchLimit:50});
 const continuation=await drainHistory(account(t),10);assert.equal(continuation.removed,50);
 const state=await t.run(async ctx=>({budget:await ctx.db.query('aiBudgets').withIndex('by_scope',q=>q.eq('scope',owner)).unique(),rows:await ctx.db.query('aiJobs').collect(),sample:await ctx.db.get(sampleId)}));
 assert.equal(state.rows.filter(row=>row.status!=='running'&&!row.hidden).length,0);assert.equal(state.rows.filter(row=>row.status==='running'&&row.hidden).length,0);assert.equal(state.budget.chargedNano,9000);assert.equal(state.budget.inflight,1);
 assert.equal(state.sample.model,'fixture/model');assert.equal(state.sample.generationId,'gen-history-0');assert.equal(state.sample.actualNano,90);assert.equal(state.sample.verificationStatus,'verified');assert.equal(state.sample.hidden,true);
}));


test('Gate2B operator allowlist: unauthorized or malformed identity cannot reserve or invoke',async()=>fixture(async({t,calls})=>{
 for(const subject of ['ordinary','A-forged']){
  await assert.rejects(()=>account(t,subject).action(api.ai.complete,{request:request()}),/OPERATOR_NOT_ALLOWED/);
  await assert.rejects(()=>account(t,subject).mutation(internal.ai.reserve,{policySnapshot:JSON.stringify(readPolicy()),requestId:crypto.randomUUID(),model:'fixture/model',reservationNano:1}),/OPERATOR_NOT_ALLOWED/);
 }
 for(const operators of [undefined,[],{},['A',42],['A','A']]){
  process.env.MELLY_AI_POLICY=JSON.stringify({...basePolicy,operators});
  await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}));
 }
 assert.equal(calls.length,0);
 assert.deepEqual(await t.run(async ctx=>await ctx.db.query('aiBudgets').collect()),[]);
 assert.deepEqual(await t.run(async ctx=>await ctx.db.query('aiJobs').collect()),[]);
}));

test('Gate2B routing: server emits exact privacy and provider fields, malformed settings disable',async()=>fixture(async({t,calls})=>{
 await account(t).action(api.ai.complete,{request:request()});
 const payload=JSON.parse(calls.find(c=>c.url.includes('/chat/completions')).init.body);
 assert.deepEqual(payload.provider,{only:['fixture'],order:['fixture'],data_collection:'deny',zdr:true,allow_fallbacks:false,require_parameters:true,max_price:{prompt:1,completion:2,request:0}});
 for(const patch of [{only:[]},{only:['Fixture']},{zdr:false},{data_collection:'allow'},{allow_fallbacks:true},{require_parameters:false},{unknown:true}]){
  process.env.MELLY_AI_POLICY=JSON.stringify({...basePolicy,provider:{...basePolicy.provider,...patch}});assert.equal(readPolicy().enabled,false);
 }
 process.env.MELLY_AI_POLICY=JSON.stringify({...basePolicy,operator:true});assert.equal(readPolicy().enabled,false);
}));

test('Gate2B routing: consistent but unexpected provider is denied',async()=>fixture(async({t})=>{
 await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),/PROVIDER_NOT_ALLOWED/);
 const usage=await account(t).query(api.ai.usage,{});assert.equal(usage.jobs[0].verificationStatus,'mismatch');
},{body:completion({openrouter_metadata:{attempt:1,strategy:'direct',endpoints:{available:[{provider:'Unapproved',selected:true}]}}}),metadata:generation({provider_name:'Unapproved'})}));

test('Gate2B catalog: unrelated invalid entries do not poison exact IDs; all duplicates are excluded',()=>{
 const good=catalog.data[0];
 assert.deepEqual(parseCatalog({data:[null,{}, {...good,id:'~bad/alias'},good]}).map(m=>m.id),['fixture/model']);
 assert.deepEqual(parseCatalog({data:[good,{...good,pricing:{prompt:'1',completion:'1'}}]}),[]);
 assert.deepEqual(parseCatalog({data:[{...good,id:'~fixture/model'}]}),[]);
 assert.equal(parseCatalog({data:[{...good,pricing:undefined} ]})[0].bounded,false);
});
test('Gate2B catalog: Granite, Qwen and Sonnet prices use explicit units and known cache charges',()=>{
 const rows=[
  {id:'ibm-granite/granite-4.0-h-micro',pricing:{prompt:'0.000000017',completion:'0.000000112'}},
  {id:'qwen/qwen3-coder',pricing:{prompt:'0.0000003',completion:'0.000001',input_cache_read:'0.0000001'}},
  {id:'anthropic/claude-sonnet-4.6',pricing:{prompt:'0.000003',completion:'0.000015',input_cache_read:'0.0000003',input_cache_write:'0.00000375',web_search:'0.01'}},
 ].map(row=>({...catalog.data[0],...row}));
 const models=parseCatalog({data:rows});assert.equal(models[0].bounded,true);assert.equal(models[1].bounded,true);assert.equal(models[1].pricing.input_cache_read,0.0000001);
 // Search has no bounded number of billable units in this text-only contract.
 assert.equal(models[2].bounded,false);
 for(const pricing of [{prompt:'0.1',completion:'0.2',unknown:'0.1'},{prompt:'-1',completion:'0'},{prompt:'0',completion:'NaN'},{prompt:'0',completion:'0',input_cache_read:'wat'},{prompt:'0',completion:'0',unknown:'garbage'}])assert.equal(parseCatalog({data:[{...catalog.data[0],pricing} ]})[0].bounded,false);
 assert.equal(parseCatalog({data:[{...catalog.data[0],pricing:{prompt:'0',completion:'0',unknown:'0'}}]})[0].bounded,true);
});

test('Gate2B grant: one durable attempt despite timeout, cancellation or replay after settlement',async()=>{
 for(const name of ['TimeoutError','AbortError','Error'])await fixture(async({t,calls})=>{
  const original=globalThis.fetch;globalThis.fetch=async(url,init)=>{if(!String(url).includes('/chat/completions'))return original(url,init);calls.push({url:String(url),init});throw new DOMException('fixture',name);};
  const a=account(t),r=request();await assert.rejects(()=>a.action(api.ai.complete,{request:r}));
  await assert.rejects(()=>a.action(api.ai.complete,{request:r}),/DUPLICATE_REQUEST/);
  await assert.rejects(()=>a.action(api.ai.complete,{request:request()}),/GRANT_CONSUMED/);
  const grants=await t.run(async ctx=>await ctx.db.query('aiDevGrants').collect());assert.equal(grants.length,1);assert.equal(grants[0].grantId,basePolicy.devGrant.id);assert.equal(grants[0].purpose,'chat');
  assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,1);
  await a.mutation(api.ai.removeHistory,{});assert.equal((await t.run(async ctx=>await ctx.db.query('aiDevGrants').collect())).length,1);
 });
});
test('Gate2B grant: concurrent attempts cannot both invoke; used ID stays spent after policy changes',async()=>fixture(async({t,calls})=>{
 const a=account(t),results=await Promise.allSettled([a.action(api.ai.complete,{request:request()}),a.action(api.ai.complete,{request:request()})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,1);
 process.env.MELLY_AI_POLICY=JSON.stringify({...basePolicy,devGrant:{...basePolicy.devGrant,expiresAt:4102444800001}});
 await assert.rejects(()=>a.action(api.ai.complete,{request:request()}),/GRANT_CONSUMED/);
}));
test('Gate2B grant: subject, exact model, purpose and expiry are bound; failed admission spends nothing',async()=>fixture(async({t,calls})=>{
 for(const patch of [{subject:'B'},{model:'other/model'},{purpose:'fix'},{expiresAt:1}]){
  process.env.MELLY_AI_POLICY=JSON.stringify({...basePolicy,devGrant:{...basePolicy.devGrant,...patch}});
  await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}));
 }
 assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,0);assert.equal((await t.run(async ctx=>await ctx.db.query('aiBudgets').collect())).length,0);
 assert.equal((await t.run(async ctx=>await ctx.db.query('aiDevGrants').collect())).length,0);
}));
test('Gate2B limits: request cap, input/output ceiling and provider-key cap fail before reservation',async()=>{
 for(const patch of [{maxRequestUSD:0.000001},{maxInputTokens:100},{maxOutputTokens:32}])await fixture(async({t,calls})=>{
  await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}));assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,0);
  assert.equal((await t.run(async ctx=>await ctx.db.query('aiJobs').collect())).length,0);
 },{policy:{...basePolicy,...patch}});
 for(const keyData of [{limit:null,limit_remaining:null,limit_reset:null,include_byok_in_limit:true},{limit:2,limit_remaining:2,limit_reset:null,include_byok_in_limit:true},{limit:1,limit_remaining:1,limit_reset:'daily',include_byok_in_limit:true},{limit:1,limit_remaining:0,limit_reset:null,include_byok_in_limit:true},{limit:1,limit_remaining:1,limit_reset:null,include_byok_in_limit:false}])await fixture(async({t,calls})=>{
  await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),/PROVIDER_KEY_CAP_UNVERIFIED/);assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,0);assert.equal((await t.run(async ctx=>await ctx.db.query('aiDevGrants').collect())).length,0);
 },{keyData});
});
test('Gate2B endpoint bound: cache and request charges included; unknown pricing/reasoning deny',async()=>{
 const endpoint={model_id:'fixture/model',tag:'fixture',provider_name:'Fixture Provider',context_length:32768,max_completion_tokens:2048,supported_parameters:['max_tokens'],pricing:{prompt:'0.000001',completion:'0.000002',input_cache_read:'0.0000005',request:'0.00001'}};
 const data=e=>({data:{id:'fixture/model',architecture:{input_modalities:['text'],output_modalities:['text']},endpoints:[e]}});
 await fixture(async({t})=>{const result=await account(t).action(api.ai.complete,{request:request()});assert.ok(result.usage.reservationNano>=49418000);},{endpoints:data(endpoint),policy:{...basePolicy,models:{'fixture/model':{prompt:0.000001,completion:0.000002,input_cache_read:0.0000005,request:0.00001}}}});
 for(const e of [{...endpoint,pricing:{...endpoint.pricing,unknown:'0.1'}},{...endpoint,supported_parameters:['max_tokens','reasoning']},{...endpoint,tag:'unapproved'},{...endpoint,pricing:{prompt:'0.1',completion:'0.1'}}])await fixture(async({t,calls})=>{await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}));assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,0);},{endpoints:data(e)});
});

test('Gate2B policy rejects malformed optional prices, unknown nested fields and underflow costs',async()=>fixture(async()=>{
 for(const patch of [{input_cache_read:null},{responseModels:null},{extraSecurity:true}]){
  process.env.MELLY_AI_POLICY=JSON.stringify({...basePolicy,models:{'fixture/model':{...basePolicy.models['fixture/model'],...patch}}});assert.equal(readPolicy().enabled,false);
 }
 process.env.MELLY_AI_POLICY=JSON.stringify({...basePolicy,devGrant:{...basePolicy.devGrant,purpose:['chat']}});assert.equal(readPolicy().enabled,false);
 for(const field of ['prompt','unknown'])assert.equal(parseCatalog({data:[{...catalog.data[0],pricing:{...catalog.data[0].pricing,[field]:'1e-400'}}]})[0].bounded,false);
}));
test('Gate2B configurable deployment rate applies across different verified operators',async()=>fixture(async({t})=>{
 const a=account(t),id=await a.mutation(internal.ai.reserve,{policySnapshot:JSON.stringify(readPolicy()),requestId:crypto.randomUUID(),model:'fixture/model',reservationNano:1});await a.mutation(internal.ai.settle,settlement(id));
 grant({subject:'B'});const current=JSON.parse(process.env.MELLY_AI_POLICY);current.deploymentRequestsPerMinute=1;process.env.MELLY_AI_POLICY=JSON.stringify(current);
 await assert.rejects(()=>account(t,'B').mutation(internal.ai.reserve,{policySnapshot:JSON.stringify(readPolicy()),requestId:crypto.randomUUID(),model:'fixture/model',reservationNano:1}),/RATE_LIMITED/);
 assert.equal((await t.run(async ctx=>await ctx.db.query('aiDevGrants').collect())).length,1);
}));

test('Gate2B reconciliation rejects hidden fallbacks, missing route evidence and paid pipelines',async()=>{
 for(const patch of [{attempt:2},{strategy:'fallback'},{attempt:undefined},{endpoints:{available:[]}},{pipeline:[{type:'plugin',name:'web-search'}]}])await fixture(async({t,calls})=>{
  await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}));assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,1);
  const usage=await account(t).query(api.ai.usage,{});assert.equal(usage.jobs[0].status,'failed');assert.ok(usage.chargedNano>=usage.jobs[0].reservationNano);
 },{body:completion({openrouter_metadata:{...completion().openrouter_metadata,...patch}})});
});

test('Gate2B grant identity cannot change between preflight and atomic admission',async()=>fixture(async({t,calls})=>{
 const fetch=globalThis.fetch;globalThis.fetch=async(url,init)=>{
  const result=await fetch(url,init);if(String(url).endsWith('/key'))grant();return result;
 };
 await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),/POLICY_CHANGED/);
 assert.equal(calls.filter(c=>c.url.includes('/chat/completions')).length,0);assert.equal((await t.run(async ctx=>await ctx.db.query('aiDevGrants').collect())).length,0);
}));


// Gate 2C-BR2: transport is fully intercepted by fixture(); never a live POST.
const expectedBody=r=>JSON.stringify({model:r.model,messages:buildMessages(validateRequest(r)),max_tokens:r.maxOutputTokens,stream:false,provider:providerRouting(readPolicy(),r.model)});
async function noAdmission(t,calls){
 assert.equal(calls.length,0,'byte/shape denial must precede ALL network I/O');
 for(const table of ['aiJobs','aiBudgets','aiDevGrants'])assert.equal((await t.run(async ctx=>await ctx.db.query(table).collect())).length,0,table);
}
test('BR2 policy: byte cap is a required positive safe integer <=65536; disabled legacy config remains closed',async()=>fixture(async()=>{
 for(const value of [undefined,null,0,-1,0.5,'4096',{},[],65537,Number.MAX_SAFE_INTEGER]){
  process.env.MELLY_AI_POLICY=JSON.stringify({...basePolicy,maxSerializedRequestBytes:value});assert.equal(readPolicy().enabled,false);
 }
 for(const value of [1,4096,65536]){process.env.MELLY_AI_POLICY=JSON.stringify({...basePolicy,maxSerializedRequestBytes:value});assert.equal(readPolicy().maxSerializedRequestBytes,value);}
 for(const raw of ['{','null','[]',JSON.stringify({enabled:false,approval:''})]){process.env.MELLY_AI_POLICY=raw;assert.equal(readPolicy().enabled,false);assert.equal(readPolicy().maxSerializedRequestBytes,0);}
}));
for(const delta of [-1,0,1])test(`BR2 exact UTF-8 transport boundary: 4096 ${delta>=0?'+':''}${delta} bytes`,async()=>fixture(async({t,calls})=>{
 const r=request({prompt:'x'}),overhead=Buffer.byteLength(expectedBody(r));r.prompt+='a'.repeat(4096+delta-overhead);
 const expected=expectedBody(r);assert.equal(Buffer.byteLength(expected),4096+delta);
 if(delta>0){await assert.rejects(()=>account(t).action(api.ai.complete,{request:r}),/REQUEST_SIZE_LIMIT/);await noAdmission(t,calls);return;}
 const result=await account(t).action(api.ai.complete,{request:r}),post=calls.find(c=>c.url.endsWith('/chat/completions'));
 assert.equal(post.init.body,expected);assert.deepEqual(Buffer.from(await new Request(post.url,post.init).arrayBuffer()),Buffer.from(expected,'utf8'));
 assert.equal(result.usage.reservationNano,33024000,'full context 32768*1000 + output 128*2000 nanodollars');
}));
for(const [name,prompt] of [['short','Hi'],['Polish','Zażółć gęślą jaźń'],['emoji','🧑‍💻🙂🚀'],['JSON escaping','"quoted" \\ slash /'],['allowed control characters','a\tb\nc\rd']])test(`BR2 serialized ${name}: exact bytes accepted; one byte less denied`,async()=>{
 let size;
 await fixture(async({t,calls})=>{
  const r=request({prompt}),expected=expectedBody(r);size=Buffer.byteLength(expected);const p=JSON.parse(process.env.MELLY_AI_POLICY);p.maxSerializedRequestBytes=size;process.env.MELLY_AI_POLICY=JSON.stringify(p);
  const result=await account(t).action(api.ai.complete,{request:r}),post=calls.find(c=>c.url.endsWith('/chat/completions'));
  assert.equal(post.init.body,expected);assert.equal(new TextEncoder().encode(post.init.body).length,size);assert.equal(result.usage.reservationNano,33024000);
  if(name==='Polish'||name==='emoji')assert.ok(size>expected.length);
 });
 await fixture(async({t,calls})=>{await assert.rejects(()=>account(t).action(api.ai.complete,{request:request({prompt})}),/REQUEST_SIZE_LIMIT/);await noAdmission(t,calls);},{policy:{...basePolicy,maxSerializedRequestBytes:size-1}});
});
test('BR2 system prompt, hidden edit template, selected file and nested escaping are inside the cap',async()=>{
 for(const kind of ['chat','explain','fix','refactor'])await fixture(async({t,calls})=>{
  grant({purpose:kind});const r=request({kind,prompt:'Explain',files:[{path:'source.js',revision:7,content:'const text="Zażółć 🙂";\n'}]}),expected=expectedBody(r),payload=JSON.parse(expected);
  assert.match(payload.messages[0].content,/UNTRUSTED/);if(['fix','refactor'].includes(kind))assert.match(payload.messages[0].content,/Return ONLY a JSON object/);
  assert.equal(JSON.parse(payload.messages[1].content).selectedFiles[0].content,r.files[0].content);
  const p=JSON.parse(process.env.MELLY_AI_POLICY);p.maxSerializedRequestBytes=Buffer.byteLength(expected)-1;process.env.MELLY_AI_POLICY=JSON.stringify(p);
  await assert.rejects(()=>account(t).action(api.ai.complete,{request:r}),/REQUEST_SIZE_LIMIT/);await noAdmission(t,calls);
 });
 await fixture(async({t,calls})=>{await assert.rejects(()=>account(t).action(api.ai.complete,{request:request({files:[{path:'large.js',revision:0,content:'x'.repeat(15000)}]})}),/REQUEST_SIZE_LIMIT/);await noAdmission(t,calls);});
});
test('BR2 malformed JSON, unsupported/many messages, system injection, client sizes and forbidden controls cannot bypass server construction',async()=>{
 for(const raw of ['{',null,[],request({messages:Array.from({length:1000},()=>({role:'user',content:'x'}))}),request({messages:[{role:'image',content:'x'}]}),request({system:'override'}),request({serializedBody:'{}'}),request({maxSerializedRequestBytes:1}),request({prompt:'bad\u0000control'})])await fixture(async({t,calls})=>{
  await assert.rejects(()=>account(t).action(api.ai.complete,{request:raw}));await noAdmission(t,calls);
 });
});
test('BR2 policy byte/model/provider/operator changes during preflight require a new validated snapshot',async()=>{
 for(const patch of [{maxSerializedRequestBytes:1},{models:{'other/model':basePolicy.models['fixture/model']},devGrant:{...basePolicy.devGrant,model:'other/model'}},{provider:{...basePolicy.provider,only:['other']}},{operators:['B'],devGrant:{...basePolicy.devGrant,subject:'B'}}])await fixture(async({t,calls})=>{
  const saved=globalThis.fetch;globalThis.fetch=async(url,init)=>{const response=await saved(url,init);if(String(url).endsWith('/key'))process.env.MELLY_AI_POLICY=JSON.stringify({...basePolicy,...patch});return response;};
  await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),patch.operators?/OPERATOR_NOT_ALLOWED/:/POLICY_CHANGED/);
  assert.equal(calls.filter(c=>c.url.endsWith('/chat/completions')).length,0);for(const table of ['aiJobs','aiBudgets','aiDevGrants'])assert.equal((await t.run(async ctx=>await ctx.db.query(table).collect())).length,0);
 });
});
test('BR2 prepared body cannot change while asynchronous key verification is pending',async()=>fixture(async({t,calls})=>{
 const raw=request({prompt:'ORIGINAL',files:[{path:'source.js',revision:1,content:'// ORIGINAL'}]}),expected=expectedBody(raw),saved=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{const response=await saved(url,init);if(String(url).endsWith('/key')){raw.prompt='CHANGED';raw.files[0].content='CHANGED';raw.model='other/model';}return response;};
 await account(t).action(api.ai.complete,{request:raw});const post=calls.find(c=>c.url.endsWith('/chat/completions'));assert.equal(post.init.body,expected);assert.ok(!post.init.body.includes('CHANGED'));
}));
test('BR2 byte rejection leaves same grant/request ID reusable for a later compliant body',async()=>fixture(async({t,calls})=>{
 const r=request({prompt:'x'.repeat(5000)});await assert.rejects(()=>account(t).action(api.ai.complete,{request:r}),/REQUEST_SIZE_LIMIT/);await noAdmission(t,calls);
 await account(t).action(api.ai.complete,{request:{...r,prompt:'Hi'}});assert.equal(calls.filter(c=>c.url.endsWith('/chat/completions')).length,1);
 await assert.rejects(()=>account(t).action(api.ai.complete,{request:{...r,prompt:'Hi'}}),/DUPLICATE_REQUEST/);assert.equal(calls.filter(c=>c.url.endsWith('/chat/completions')).length,1);
}));
test('BR2 AbortError retains full reservation and permanently consumes grant without retry',async()=>fixture(async({t,calls})=>{
 const saved=globalThis.fetch;globalThis.fetch=async(url,init)=>{if(!String(url).endsWith('/chat/completions'))return saved(url,init);calls.push({url:String(url),init});throw new DOMException('PRIVATE','AbortError');};
 await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),/TIMEOUT/);const usage=await account(t).query(api.ai.usage,{});assert.equal(usage.chargedNano,33024000);assert.equal(usage.inflight,0);
 await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}),/GRANT_CONSUMED/);assert.equal(calls.filter(c=>c.url.endsWith('/chat/completions')).length,1);
}));
test('BR2 endpoint inconsistent context/output metadata fails before ledger and POST',async()=>{
 for(const patch of [{context_length:40000},{max_prompt_tokens:40000},{max_prompt_tokens:-1},{max_prompt_tokens:'32768'},{context_length:32},{context_length:0},{max_completion_tokens:0}])await fixture(async({t,calls})=>{
  await assert.rejects(()=>account(t).action(api.ai.complete,{request:request()}));assert.equal(calls.filter(c=>c.url.endsWith('/chat/completions')).length,0);for(const table of ['aiJobs','aiBudgets','aiDevGrants'])assert.equal((await t.run(async ctx=>await ctx.db.query(table).collect())).length,0);
 },{endpoints:{data:{id:'fixture/model',endpoints:[{model_id:'fixture/model',tag:'fixture',provider_name:'Fixture Provider',context_length:32768,max_completion_tokens:2048,supported_parameters:['max_tokens'],pricing:catalog.data[0].pricing,...patch}]}}});
});
test('BR2 planned Granite single synthetic smoke reserves full 131000 context, independent of small body',async()=>{
 const model='ibm-granite/granite-4.0-h-micro',price={prompt:'0.000000017',completion:'0.000000112',discount:0},clock=Date.now;
 const p={...basePolicy,models:{[model]:{prompt:0.000000017,completion:0.000000112}},operators:['A'],userBudgetUSD:0.02,deploymentBudgetUSD:0.25,maxRequestUSD:0.02,maxInputTokens:131000,maxOutputTokens:32,deploymentParallel:1,userRequestsPerMinute:1,deploymentRequestsPerMinute:1,provider:{...basePolicy.provider,only:['cloudflare'],names:['Cloudflare']},devGrant:{...basePolicy.devGrant,model,purpose:'synthetic-smoke'}};
 // Expire only the process-local public catalog cache, with no network outside fixture.
 Date.now=()=>clock()+600001;
 try{await fixture(async({t,calls})=>{
  const r=request({model,prompt:'Reply with exactly MELLY_DEV_OK.',maxOutputTokens:32}),expected=expectedBody(r),result=await account(t).action(api.ai.complete,{request:r});
  assert.ok(Buffer.byteLength(expected)<4096);assert.equal(result.usage.reservationNano,2230584);assert.equal(calls.find(c=>c.url.endsWith('/chat/completions')).init.body,expected);
  const payload=JSON.parse(expected);assert.deepEqual(payload.provider.only,['cloudflare']);assert.deepEqual(payload.provider.order,['cloudflare']);assert.equal(payload.provider.zdr,true);assert.equal(payload.provider.data_collection,'deny');assert.equal(payload.provider.allow_fallbacks,false);assert.equal(payload.provider.require_parameters,true);
 },{policy:p,modelCatalog:{data:[{id:model,name:'Granite fixture',context_length:131000,pricing:price}]},endpoints:{data:{id:model,endpoints:[{model_id:model,tag:'cloudflare',provider_name:'Cloudflare',context_length:131000,max_prompt_tokens:null,max_completion_tokens:117900,supported_parameters:['max_tokens'],pricing:price}]}},body:completion({model,openrouter_metadata:{attempt:1,strategy:'direct',endpoints:{available:[{provider:'Cloudflare',selected:true}]}}}),metadata:generation({model,provider_name:'Cloudflare'})});}finally{Date.now=clock;}
});
