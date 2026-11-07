import {v,ConvexError} from 'convex/values';
import {actionGeneric,makeFunctionReference} from 'convex/server';
import {query,mutation,internalMutation} from './model.ts';
import {validateRequest,buildMessages,validateProposal,LIMITS} from '../js/ai/contracts.js';
import {policy,livePolicy,providerKey,expectedIssuer,parseCatalog,boundedJSON,fail,responseModelAllowed,authorizeOperator,providerRouting,providerAllowed,prices,PRICE_KEYS} from './aiPolicy.ts';
import type {CatalogModel,Policy} from './aiPolicy.ts';
import type {QueryCtx,MutationCtx} from './model.ts';
import type {GenericId} from 'convex/values';

type VerificationStatus='verified'|'mismatch'|'unavailable'|'pending';
type CompletionEvidence={routingClean:boolean;generationId:string|null;responseModel:string|null;routedProvider:string|null;routingStrategy:string|null;routingAttempt:number|null;serviceTier:string|null;reportedNano:number|null;reportedPromptTokens:number|null;reportedCompletionTokens:number|null};
type GenerationEvidence={generationId:string;responseModel:string;providerName:string;serviceTier:string|null;actualNano:number;promptTokens:number;completionTokens:number};
type Reconciliation={status:VerificationStatus;error:string};

const modelId=/^[\w.:-]+\/[\w.:/-]+$/;
const generationId=/^gen-[0-9A-Za-z-]+$/;
const safeMetadata=/^[\w .:/+-]+$/;
const status=v.union(v.literal('complete'),v.literal('failed'));
const verificationStatus=v.union(v.literal('verified'),v.literal('mismatch'),v.literal('unavailable'),v.literal('pending'));
// Public endpoint metadata is checked for the selected model, never inferred
// from the aggregate catalog's lowest price. No provider request is retried.
async function endpointReservation(model:string,p:Policy,output:number,catalogContext:number|null){
  const response=await fetch('https://openrouter.ai/api/v1/models/'+model+'/endpoints',{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10000)});
  if(!response.ok)fail('PRICE_UNKNOWN');
  const data=record(record(await boundedJSON(response,512000))?.data);
  if(data?.id!==model||!Array.isArray(data.endpoints)||data.endpoints.length>200)fail('PRICE_UNKNOWN');
  const candidates=data.endpoints.map(record).filter((e):e is Record<string,unknown>=>e!==null&&typeof e.tag==='string'&&p.provider.only.some(slug=>e.tag===slug||String(e.tag).startsWith(slug+'/')));
  if(!candidates.length)fail('NO_COMPLIANT_ENDPOINT');
  const ceiling=p.models[model];let bound=0;
  for(const e of candidates){
    // A base slug can match several variants. Every possible variant must pass.
    const price=prices(e.pricing),parameters=e.supported_parameters;
    if(e.model_id!==model||typeof e.provider_name!=='string'||!providerAllowed(p,e.provider_name)||!price||PRICE_KEYS.some(k=>price[k]>ceiling[k])||!Array.isArray(parameters)||!parameters.includes('max_tokens')||parameters.some(k=>typeof k!=='string'||k.includes('reasoning')))fail('PRICE_UNKNOWN');
    const context=tokenCount(e.context_length),maxOutput=tokenCount(e.max_completion_tokens);
    if(!context||context>p.maxInputTokens||!maxOutput||output>maxOutput||output>context)fail('INPUT_TOKEN_LIMIT');
    if(!catalogContext||context>catalogContext||(e.max_prompt_tokens!==undefined&&e.max_prompt_tokens!==null&&(!tokenCount(e.max_prompt_tokens)||Number(e.max_prompt_tokens)>context)))fail('PRICE_UNKNOWN');
    // Entire endpoint context is a conservative input bound independent of any
    // tokenizer assumption. Cache rates are added, never treated as free.
    const inputRate=ceiling.prompt+ceiling.input_cache_read+ceiling.input_cache_write+ceiling.input_cache_write_1h;
    const cost=context*Math.ceil(inputRate*1e9)+output*Math.ceil(ceiling.completion*1e9)+Math.ceil(ceiling.request*1e9);
    if(!Number.isSafeInteger(cost)||cost<0)fail('PRICE_UNKNOWN');bound=Math.max(bound,cost);
  }
  return Math.max(1,bound);
}
async function verifyKeyCap(p:Policy,reservationNano:number){
  try{
    const response=await fetch('https://openrouter.ai/api/v1/key',{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+providerKey()}});
    if(!response.ok)fail('PROVIDER_KEY_CAP_UNVERIFIED');
    const data=record(record(await boundedJSON(response,64000))?.data);
    if(!data||typeof data.limit!=='number'||!Number.isFinite(data.limit)||data.limit<=0||Math.ceil(data.limit*1e9)>p.keyCap||data.limit_reset!==null||data.include_byok_in_limit!==true||typeof data.limit_remaining!=='number'||!Number.isFinite(data.limit_remaining)||Math.floor(data.limit_remaining*1e9)<reservationNano)fail('PROVIDER_KEY_CAP_UNVERIFIED');
  }catch{fail('PROVIDER_KEY_CAP_UNVERIFIED');}
}
const nullableNumber=v.union(v.number(),v.null());
const nullableString=v.union(v.string(),v.null());
const refs={reserve:makeFunctionReference<'mutation'>('ai:reserve'),settle:makeFunctionReference<'mutation'>('ai:settle')};
const TTL=5*60*1000;
const HISTORY_BATCH=50;

async function principal(ctx:{auth:{getUserIdentity:()=>Promise<{tokenIdentifier:string;issuer:string;subject:string}|null>}}){
  const identity=await ctx.auth.getUserIdentity();if(!identity)fail('UNAUTHENTICATED');
  const issuer=expectedIssuer();if(!/^https:\/\/[a-z0-9-]+\.clerk\.accounts\.dev$/.test(issuer) || identity.issuer!==issuer || !identity.subject || !identity.tokenIdentifier)fail('UNAUTHORIZED_IDENTITY');return identity;
}
const budget=(ctx:QueryCtx|MutationCtx,scope:string)=>ctx.db.query('aiBudgets').withIndex('by_scope',q=>q.eq('scope',scope)).unique();
const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const boundedString=(value:unknown,max:number,pattern=safeMetadata)=>typeof value==='string'&&value.length>0&&value.length<=max&&pattern.test(value)?value:null;
const tokenCount=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0?Number(value):null;
const nanoCost=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100?Math.ceil(value*1e9):null;
const storedNumber=(value:number|null)=>value===null?undefined:value;
const storedString=(value:string|null)=>value===null?undefined:value;

let cached:{models:CatalogModel[];updatedAt:number}|null=null;
let fetching:Promise<{models:CatalogModel[];updatedAt:number}>|null=null;
async function catalogData(){
  if(cached && Date.now()-cached.updatedAt<TTL)return{...cached,stale:false};
  try{
    if(!fetching)fetching=(async()=>{
      const response=await fetch('https://openrouter.ai/api/v1/models',{signal:AbortSignal.timeout(10000),redirect:'error',credentials:'omit'});
      if(!response.ok)fail('CATALOG_UNAVAILABLE');const models=parseCatalog(await boundedJSON(response,2_000_000));return{models,updatedAt:Date.now()};
    })().finally(()=>{fetching=null;});
    cached=await fetching;return{...cached,stale:false};
  }catch{if(cached)return{...cached,stale:true};return{models:[],updatedAt:0,stale:true};}
}

function completionEvidence(body:Record<string,unknown>):CompletionEvidence{
  const usage=record(body.usage),metadata=record(body.openrouter_metadata),endpoints=record(metadata?.endpoints);
  const available=Array.isArray(endpoints?.available)&&endpoints.available.length<=100?endpoints.available:[];
  const selected=available.map(record).filter((item):item is Record<string,unknown>=>item?.selected===true);
  return{
    routingClean:(metadata?.pipeline===undefined||(Array.isArray(metadata.pipeline)&&metadata.pipeline.length===0))&&(metadata?.attempts===undefined||(Array.isArray(metadata.attempts)&&metadata.attempts.length===1)),
    generationId:boundedString(body.id,128,generationId),responseModel:boundedString(body.model,180,modelId),
    routedProvider:selected.length===1?boundedString(selected[0].provider,100):null,
    routingStrategy:boundedString(metadata?.strategy,40),routingAttempt:tokenCount(metadata?.attempt),serviceTier:boundedString(body.service_tier,40),
    reportedNano:usage?nanoCost(usage.cost):null,reportedPromptTokens:usage?tokenCount(usage.prompt_tokens):null,reportedCompletionTokens:usage?tokenCount(usage.completion_tokens):null,
  };
}

async function generationEvidence(id:string):Promise<GenerationEvidence|null>{
  try{
    const response=await fetch('https://openrouter.ai/api/v1/generation?id='+encodeURIComponent(id),{method:'GET',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+providerKey()}});
    if(!response.ok)return null;
    const root=record(await boundedJSON(response,64_000)),data=record(root?.data);if(!data)return null;
    const foundId=boundedString(data.id,128,generationId),responseModel=boundedString(data.model,180,modelId),providerName=boundedString(data.provider_name,100);
    const actualNano=nanoCost(data.total_cost),promptTokens=tokenCount(data.tokens_prompt),completionTokens=tokenCount(data.tokens_completion);
    if(foundId!==id || !responseModel || !providerName || actualNano===null || promptTokens===null || completionTokens===null)return null;
    return{generationId:foundId,responseModel,providerName,serviceTier:boundedString(data.service_tier,40),actualNano,promptTokens,completionTokens};
  }catch{return null;}
}

function reconcile(requested:string,p:Policy,response:CompletionEvidence,generation:GenerationEvidence|null):Reconciliation{
  if(response.responseModel && !responseModelAllowed(p,requested,response.responseModel))return{status:'mismatch',error:'MODEL_MISMATCH'};
  if(!response.generationId || !response.responseModel || !generation || !response.routedProvider || response.routingAttempt===null || !response.routingStrategy)return{status:'unavailable',error:'PROVIDER_VERIFICATION_UNAVAILABLE'};
  if(!response.routingClean||response.routingAttempt!==1||!['direct','alias'].includes(response.routingStrategy))return{status:'mismatch',error:'PROVIDER_METADATA_MISMATCH'};
  if(generation.promptTokens>p.maxInputTokens)return{status:'mismatch',error:'INPUT_TOKEN_LIMIT'};
  if(!responseModelAllowed(p,requested,generation.responseModel) || generation.responseModel!==response.responseModel)return{status:'mismatch',error:'MODEL_MISMATCH'};
  if(generation.generationId!==response.generationId || (response.routedProvider!==null&&response.routedProvider!==generation.providerName) || (response.serviceTier!==null&&generation.serviceTier!==null&&response.serviceTier!==generation.serviceTier) || (response.reportedNano!==null&&response.reportedNano!==generation.actualNano) || (response.reportedPromptTokens!==null&&response.reportedPromptTokens!==generation.promptTokens) || (response.reportedCompletionTokens!==null&&response.reportedCompletionTokens!==generation.completionTokens))return{status:'mismatch',error:'PROVIDER_METADATA_MISMATCH'};
  if(!providerAllowed(p,generation.providerName)||(response.routedProvider!==null&&!providerAllowed(p,response.routedProvider)))return{status:'mismatch',error:'PROVIDER_NOT_ALLOWED'};
  return{status:'verified',error:''};
}

export const catalog=actionGeneric({args:{},handler:async ctx=>{
  const identity=await principal(ctx),p=policy(),configured=!!providerKey();const data=await catalogData(),eligible=data.models.some(m=>m.bounded&&Object.hasOwn(p.models,m.id));
  return{models:data.models.map(m=>({...m,allowed:m.bounded&&p.operators.includes(identity.subject)&&Object.hasOwn(p.models,m.id)})),updatedAt:data.updatedAt,stale:data.stale,ready:p.enabled&&p.operators.includes(identity.subject)&&configured&&!data.stale&&eligible,limits:{maxOutputTokens:p.maxOutputTokens,maxInputTokens:p.maxInputTokens,maxRequestNano:p.maxRequestNano},reason:!p.enabled?'LIVE_APPROVAL_REQUIRED':!p.operators.includes(identity.subject)?'OPERATOR_NOT_ALLOWED':!configured?'PROVIDER_NOT_CONFIGURED':data.stale?'STALE_CATALOG':!eligible?'NO_ELIGIBLE_MODELS':'',mode:'provider'};
}});

// Budget, minute quota, concurrency and idempotency share one serializable transaction.
// Counters are spending controls; no rolling job scans or process-local rate counters.
export const reserve=internalMutation({args:{requestId:v.string(),model:v.string(),reservationNano:v.number(),purpose:v.optional(v.string()),policySnapshot:v.string()},handler:async(ctx,args)=>{
  const identity=await principal(ctx),owner=identity.tokenIdentifier,p=livePolicy();authorizeOperator(p,identity.subject);if(args.policySnapshot!==JSON.stringify(p))fail('POLICY_CHANGED');if(!Object.hasOwn(p.models,args.model))fail('MODEL_NOT_ALLOWED');
  if(!Number.isSafeInteger(args.reservationNano) || args.reservationNano<=0 || args.reservationNano>p.maxRequestNano || !/^[\w-]{12,80}$/.test(args.requestId))fail('INVALID_RESERVATION');
  const existing=await ctx.db.query('aiJobs').withIndex('by_owner_requestId',q=>q.eq('owner',owner).eq('requestId',args.requestId)).unique();if(existing)fail('DUPLICATE_REQUEST');
  const user=await budget(ctx,owner),global=await budget(ctx,'deployment'),minute=Math.floor(Date.now()/60000);
  if(user?.blocked || global?.blocked)fail('BUDGET_EXHAUSTED');
  if((user?.inflight || 0)>=p.userParallel || (global?.inflight || 0)>=p.deploymentParallel)fail('JOB_ALREADY_RUNNING');
  const requests=user?.minute===minute?user.requests:0;const globalRequests=global?.minute===minute?global.requests:0;if(requests>=p.userRequestsPerMinute||globalRequests>=p.deploymentRequestsPerMinute)fail('RATE_LIMITED');
  if((user?.chargedNano || 0)+args.reservationNano>p.userCap || (global?.chargedNano || 0)+args.reservationNano>p.globalCap)fail('BUDGET_EXHAUSTED');
  const grant=p.devGrant;
  if(!grant||grant.subject!==identity.subject||grant.model!==args.model||grant.purpose!==(args.purpose??'chat')||grant.expiresAt<=Date.now())fail('GRANT_NOT_ALLOWED');
  const used=await ctx.db.query('aiDevGrants').withIndex('by_grantId',q=>q.eq('grantId',grant.id)).unique();if(used)fail('GRANT_CONSUMED');
  // This tombstone and the reservation commit atomically BEFORE the only POST.
  // No recovery, cancellation, settlement or history deletion can restore it.
  await ctx.db.insert('aiDevGrants',{grantId:grant.id,owner,model:args.model,purpose:grant.purpose,expiresAt:grant.expiresAt,attemptedAt:Date.now(),requestId:args.requestId});
  for(const [scope,row] of [[owner,user],['deployment',global]] as const){
    const value={scope,chargedNano:(row?.chargedNano || 0)+args.reservationNano,inflight:(row?.inflight || 0)+1,minute,requests:scope===owner?requests+1:globalRequests+1,blocked:false};
    if(row)await ctx.db.patch(row._id,value);else await ctx.db.insert('aiBudgets',value);
  }
  return await ctx.db.insert('aiJobs',{grantId:grant.id,owner,requestId:args.requestId,model:args.model,verificationStatus:'pending',status:'running',startedAt:Date.now(),reservationNano:args.reservationNano,chargedNano:args.reservationNano,hidden:false});
}});

export const settle=internalMutation({args:{id:v.id('aiJobs'),status,verificationStatus,generationId:nullableString,responseModel:nullableString,providerName:nullableString,routedProvider:nullableString,routingStrategy:nullableString,routingAttempt:nullableNumber,serviceTier:nullableString,reportedNano:nullableNumber,actualNano:nullableNumber,reportedPromptTokens:nullableNumber,reportedCompletionTokens:nullableNumber,promptTokens:nullableNumber,completionTokens:nullableNumber,error:v.string()},handler:async(ctx,args)=>{
  const {tokenIdentifier:owner}=await principal(ctx),job=await ctx.db.get(args.id);if(!job || job.owner!==owner)fail('FORBIDDEN');if(job.status!=='running')return{overrun:false,chargedNano:job.chargedNano};
  const validNano=(value:number|null)=>value===null||(Number.isSafeInteger(value)&&value>=0),validTokens=(value:number|null)=>value===null||(Number.isSafeInteger(value)&&value>=0);
  if(!validNano(args.reportedNano)||!validNano(args.actualNano)||![args.reportedPromptTokens,args.reportedCompletionTokens,args.promptTokens,args.completionTokens].every(validTokens))fail('INVALID_SETTLEMENT');
  const charged=args.verificationStatus==='verified'&&args.actualNano!==null?args.actualNano:Math.max(job.reservationNano,args.reportedNano??0,args.actualNano??0),overrun=charged>job.reservationNano;
  for(const scope of [owner,'deployment']){const row=await budget(ctx,scope);if(!row)fail('INVALID_LEDGER');await ctx.db.patch(row._id,{chargedNano:row.chargedNano+charged-job.reservationNano,inflight:Math.max(0,row.inflight-1),blocked:row.blocked||overrun});}
  const safeErrors=['','TIMEOUT','NETWORK_UNAVAILABLE','PROVIDER_401','PROVIDER_403','PROVIDER_429','PROVIDER_5XX','INVALID_PROVIDER_RESPONSE','MALFORMED_PROPOSAL','UNBOUND_PROPOSAL','OUTPUT_TOKEN_LIMIT','INPUT_TOKEN_LIMIT','MODEL_MISMATCH','PROVIDER_NOT_ALLOWED','PROVIDER_METADATA_MISMATCH','PROVIDER_VERIFICATION_UNAVAILABLE'];
  await ctx.db.patch(job._id,{status:overrun?'failed':args.status,finishedAt:Date.now(),chargedNano:charged,verificationStatus:args.verificationStatus,generationId:storedString(args.generationId),responseModel:storedString(args.responseModel),providerName:storedString(args.providerName),routedProvider:storedString(args.routedProvider),routingStrategy:storedString(args.routingStrategy),routingAttempt:storedNumber(args.routingAttempt),serviceTier:storedString(args.serviceTier),reportedNano:storedNumber(args.reportedNano),actualNano:storedNumber(args.actualNano),reportedPromptTokens:storedNumber(args.reportedPromptTokens),reportedCompletionTokens:storedNumber(args.reportedCompletionTokens),promptTokens:storedNumber(args.promptTokens),completionTokens:storedNumber(args.completionTokens),error:overrun?'BUDGET_OVERRUN':safeErrors.includes(args.error)?args.error:'REQUEST_FAILED'});
  return{overrun,chargedNano:charged};
}});

async function visibleJobs(ctx:QueryCtx,owner:string){
  const groups=await Promise.all((['running','complete','failed'] as const).map(state=>ctx.db.query('aiJobs').withIndex('by_owner_hidden_status',q=>q.eq('owner',owner).eq('hidden',false).eq('status',state)).order('desc').take(50)));
  return groups.flat().sort((a,b)=>b._creationTime-a._creationTime).slice(0,50);
}
export const usage=query({args:{},handler:async ctx=>{
  const {tokenIdentifier:owner}=await principal(ctx),p=policy(),row=await budget(ctx,owner),jobs=await visibleJobs(ctx,owner);
  return{chargedNano:row?.chargedNano || 0,limitNano:p.userCap,inflight:row?.inflight || 0,blocked:row?.blocked || false,jobs:jobs.map(({owner:_,requestId:__,...job})=>job),accounting:'Verified generation cost settles usage. Missing or inconsistent metadata retains at least the full reservation; lifetime DEV cap.'};
}});
export const job=query({args:{id:v.id('aiJobs')},handler:async(ctx,{id})=>{const {tokenIdentifier:owner}=await principal(ctx),job=await ctx.db.get(id);if(!job || job.owner!==owner || job.hidden)fail('FORBIDDEN');const{owner:_,requestId:__,...safe}=job;return safe;}});
export const removeHistory=mutation({args:{},handler:async ctx=>{
  const {tokenIdentifier:owner}=await principal(ctx);
  const groups=await Promise.all((['complete','failed'] as const).map(state=>ctx.db.query('aiJobs').withIndex('by_owner_hidden_status',q=>q.eq('owner',owner).eq('hidden',false).eq('status',state)).order('asc').take(HISTORY_BATCH+1)));
  const eligible=groups.flat().sort((a,b)=>a._creationTime-b._creationTime),batch=eligible.slice(0,HISTORY_BATCH);
  for(const row of batch)await ctx.db.patch(row._id,{hidden:true});
  const complete=eligible.length<=HISTORY_BATCH;
  return{removed:batch.length,complete,status:complete?'complete':'partial',batchLimit:HISTORY_BATCH};
}});

export const complete=actionGeneric({args:{request:v.any()},handler:async(ctx,{request:raw})=>{
  const identity=await principal(ctx),p=livePolicy();authorizeOperator(p,identity.subject);let request;
  try{request=validateRequest(raw);}catch(error){return fail(error instanceof Error?error.message:'INVALID_PAYLOAD');}
  const ceiling=p.models[request.model];if(!ceiling)fail('MODEL_NOT_ALLOWED');
  if(request.maxOutputTokens>p.maxOutputTokens)fail('OUTPUT_TOKEN_LIMIT');
  const purpose=p.devGrant?.purpose==='synthetic-smoke'?'synthetic-smoke':request.kind;
  if(purpose==='synthetic-smoke'&&(request.kind!=='chat'||request.files.length||request.prompt!=='Reply with exactly MELLY_DEV_OK.'))fail('GRANT_NOT_ALLOWED');
  const grant=p.devGrant;if(!grant||grant.subject!==identity.subject||grant.model!==request.model||grant.purpose!==purpose||grant.expiresAt<=Date.now())fail('GRANT_NOT_ALLOWED');
  // Serialize once, after ALL server templates/routing are included. A string is
  // immutable; the exact checked string is the only body passed to transport.
  // This byte cap is deliberately independent of upstream tokenization/billing.
  const serializedBody=JSON.stringify({model:request.model,messages:buildMessages(request),max_tokens:request.maxOutputTokens,stream:false,provider:providerRouting(p,request.model)});
  if(new TextEncoder().encode(serializedBody).byteLength>p.maxSerializedRequestBytes)fail('REQUEST_SIZE_LIMIT');
  const catalog=await catalogData();if(catalog.stale)fail('STALE_CATALOG');const model=catalog.models.find(m=>m.id===request.model);
  if(!model || !model.bounded || model.prompt===null || model.completion===null || model.prompt>ceiling.prompt || model.completion>ceiling.completion)fail('PRICE_UNKNOWN');
  const reservationNano=await endpointReservation(request.model,p,request.maxOutputTokens,model.context);
  if(reservationNano>p.maxRequestNano)fail('REQUEST_COST_LIMIT');
  await verifyKeyCap(p,reservationNano);
  const id=await ctx.runMutation(refs.reserve,{requestId:request.requestId,model:request.model,reservationNano,purpose,policySnapshot:JSON.stringify(p)}) as GenericId<'aiJobs'>;
  let responseEvidence:CompletionEvidence={routingClean:false,generationId:null,responseModel:null,routedProvider:null,routingStrategy:null,routingAttempt:null,serviceTier:null,reportedNano:null,reportedPromptTokens:null,reportedCompletionTokens:null};
  let actual:GenerationEvidence|null=null,reconciliation:Reconciliation={status:'pending',error:''},settled=false;
  const settlement=(state:VerificationStatus,error:string)=>({id,status:state==='verified'?'complete' as const:'failed' as const,verificationStatus:state,generationId:responseEvidence.generationId,responseModel:responseEvidence.responseModel,providerName:actual?.providerName??null,routedProvider:responseEvidence.routedProvider,routingStrategy:responseEvidence.routingStrategy,routingAttempt:responseEvidence.routingAttempt,serviceTier:actual?.serviceTier??responseEvidence.serviceTier,reportedNano:responseEvidence.reportedNano,actualNano:actual?.actualNano??null,reportedPromptTokens:responseEvidence.reportedPromptTokens,reportedCompletionTokens:responseEvidence.reportedCompletionTokens,promptTokens:actual?.promptTokens??null,completionTokens:actual?.completionTokens??null,error});
  try{
    const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+providerKey(),'Content-Type':'application/json','X-OpenRouter-Metadata':'enabled'},body:serializedBody});
    if(!response.ok)fail([401,403,429].includes(response.status)?'PROVIDER_'+response.status:'PROVIDER_5XX');
    const body=record(await boundedJSON(response,128000));if(!body)fail('INVALID_PROVIDER_RESPONSE');
    responseEvidence=completionEvidence(body);
    const choices=Array.isArray(body.choices)?body.choices:[],message=record(record(choices[0])?.message),text=message?.content;
    if(typeof text!=='string' || !text.trim() || new TextEncoder().encode(text).length>LIMITS.response || message?.tool_calls)fail('INVALID_PROVIDER_RESPONSE');
    if(responseEvidence.reportedCompletionTokens!==null && responseEvidence.reportedCompletionTokens>request.maxOutputTokens)fail('OUTPUT_TOKEN_LIMIT');
    let proposal=null;if(['fix','refactor'].includes(request.kind))try{proposal=validateProposal(text,request.files);}catch(error){fail(error instanceof Error?error.message:'MALFORMED_PROPOSAL');}
    actual=responseEvidence.generationId?await generationEvidence(responseEvidence.generationId):null;
    reconciliation=actual&&actual.completionTokens>request.maxOutputTokens?{status:'mismatch',error:'OUTPUT_TOKEN_LIMIT'}:reconcile(request.model,p,responseEvidence,actual);
    const result=await ctx.runMutation(refs.settle,settlement(reconciliation.status,reconciliation.error)) as {overrun:boolean;chargedNano:number};settled=true;
    if(reconciliation.status!=='verified')fail(reconciliation.error);
    if(result.overrun)fail('BUDGET_EXHAUSTED');
    return{mode:'provider',text:proposal?.explanation || text,proposal,verification:{status:'verified',requestedModel:request.model,responseModel:actual!.responseModel,generationId:actual!.generationId,provider:actual!.providerName,routing:{provider:responseEvidence.routedProvider,strategy:responseEvidence.routingStrategy,attempt:responseEvidence.routingAttempt,serviceTier:actual!.serviceTier}},usage:{reservationNano,chargedNano:result.chargedNano,reportedNano:responseEvidence.reportedNano,actualNano:actual!.actualNano,reportedPromptTokens:responseEvidence.reportedPromptTokens,reportedCompletionTokens:responseEvidence.reportedCompletionTokens,promptTokens:actual!.promptTokens,completionTokens:actual!.completionTokens}};
  }catch(error){
    const code=error instanceof ConvexError&&typeof error.data==='string'?error.data:error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)?'TIMEOUT':'NETWORK_UNAVAILABLE';
    if(!settled){reconciliation={status:reconciliation.status==='pending'?'unavailable':reconciliation.status,error:code};await ctx.runMutation(refs.settle,settlement(reconciliation.status,code));}
    return fail(code);
  }
}});
