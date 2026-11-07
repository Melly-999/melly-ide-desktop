import {ConvexError} from 'convex/values';
declare const process:{env:Record<string,string|undefined>};
export interface ApprovedModel extends Prices {responseModels:string[]}
export interface Routing {only:string[];names:string[];data_collection:'deny';zdr:true;allow_fallbacks:false;require_parameters:true}
export interface DevGrant {id:string;subject:string;model:string;purpose:'chat'|'explain'|'fix'|'refactor'|'synthetic-smoke';expiresAt:number}
export interface Policy {enabled:boolean;models:Record<string,ApprovedModel>;userCap:number;globalCap:number;operators:string[];provider:Routing;maxRequestNano:number;keyCap:number;maxInputTokens:number;maxOutputTokens:number;maxSerializedRequestBytes:number;userParallel:number;deploymentParallel:number;userRequestsPerMinute:number;deploymentRequestsPerMinute:number;devGrant:DevGrant|null}
const record=(x:unknown):x is Record<string,unknown>=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x:unknown,keys:readonly string[])=>record(x)&&Object.keys(x).every(k=>keys.includes(k));
const strings=(x:unknown,max:number,pattern:RegExp):x is string[]=>Array.isArray(x)&&x.length>0&&x.length<=max&&new Set(x).size===x.length&&x.every(s=>typeof s==='string'&&s.length<=180&&pattern.test(s));
const integer=(x:unknown,max:number):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>0&&x<=max;
const usd=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x)&&x>=1e-9&&x<=100;
const nano=(usd:number)=>Math.floor(usd*1e9);
const modelId=/^[A-Za-z0-9_.:-]+[/][A-Za-z0-9_.:/-]+$/;
export function fail(code:string):never {throw new ConvexError(code);}
export function policy():Policy {
  const disabled:Policy={enabled:false,models:{},userCap:0,globalCap:0,operators:[],provider:{only:[],names:[],data_collection:'deny',zdr:true,allow_fallbacks:false,require_parameters:true},maxRequestNano:0,keyCap:0,maxInputTokens:0,maxOutputTokens:0,maxSerializedRequestBytes:0,userParallel:0,deploymentParallel:0,userRequestsPerMinute:0,deploymentRequestsPerMinute:0,devGrant:null};
  try{
    const raw=JSON.parse(process.env.MELLY_AI_POLICY || '{}');
    const fields=['enabled','approval','models','userBudgetUSD','deploymentBudgetUSD','operators','provider','maxRequestUSD','providerKeyCapUSD','maxInputTokens','maxOutputTokens','maxSerializedRequestBytes','userParallel','deploymentParallel','userRequestsPerMinute','deploymentRequestsPerMinute','devGrant'];
    if(!exact(raw,fields)||raw.enabled!==true||raw.approval!=='AI01_OWNER_APPROVED'||!record(raw.models))return disabled;
    if(!strings(raw.operators,100,/^[A-Za-z0-9_-]+$/)||!exact(raw.provider,['only','names','data_collection','zdr','allow_fallbacks','require_parameters']))return disabled;
    const routing=raw.provider as Record<string,unknown>;
    if(!strings(routing.only,10,/^[a-z0-9-]+(?:[/][a-z0-9-]+)*$/)||!strings(routing.names,20,/^[A-Za-z0-9 ._()+/-]+$/)||routing.data_collection!=='deny'||routing.zdr!==true||routing.allow_fallbacks!==false||routing.require_parameters!==true)return disabled;
    if(![raw.userBudgetUSD,raw.deploymentBudgetUSD,raw.maxRequestUSD,raw.providerKeyCapUSD].every(usd))return disabled;
    if(raw.maxRequestUSD>raw.userBudgetUSD||raw.userBudgetUSD>raw.deploymentBudgetUSD||raw.deploymentBudgetUSD>raw.providerKeyCapUSD)return disabled;
    if(!integer(raw.maxInputTokens,2000000)||!integer(raw.maxOutputTokens,2048)||!integer(raw.maxSerializedRequestBytes,65536)||!integer(raw.userParallel,4)||!integer(raw.deploymentParallel,16)||!integer(raw.userRequestsPerMinute,60)||!integer(raw.deploymentRequestsPerMinute,120))return disabled;
    const models:Policy['models']={};
    for(const [id,value] of Object.entries(raw.models)){
      if(!modelId.test(id)||id.length>180||!exact(value,[...PRICE_KEYS,'responseModels']))return disabled;
      const price=value as Record<string,unknown>;
      if(![price.prompt,price.completion].every(p=>typeof p==='number'&&Number.isFinite(p)&&p>=0&&p<=0.001))return disabled;
      const components=Object.fromEntries(PRICE_KEYS.map(k=>[k,Object.hasOwn(price,k)?price[k]:0])) as Prices;
      if(!Object.values(components).every(p=>typeof p==='number'&&Number.isFinite(p)&&p>=0&&p<=1))return disabled;
      const explicit=Object.hasOwn(price,'responseModels')?price.responseModels:[];
      if(!Array.isArray(explicit)||explicit.length>10||!explicit.every(m=>typeof m==='string'&&m.length<=180&&modelId.test(m)))return disabled;
      models[id]={...components,responseModels:[...new Set([id,...explicit])]};
    }
    if(!Object.keys(models).length||Object.keys(models).length>20)return disabled;
    if(!exact(raw.devGrant,['id','subject','model','purpose','expiresAt']))return disabled;
    const g=raw.devGrant as Record<string,unknown>;
    if(typeof g.id!=='string'||! /^[A-Za-z0-9_-]{12,80}$/.test(g.id)||typeof g.subject!=='string'||!raw.operators.includes(g.subject)||typeof g.model!=='string'||!Object.hasOwn(models,g.model)||(typeof g.purpose!=='string'||!['chat','explain','fix','refactor','synthetic-smoke'].includes(g.purpose))||!integer(g.expiresAt,8640000000000000))return disabled;
    return{enabled:true,models,userCap:nano(raw.userBudgetUSD),globalCap:nano(raw.deploymentBudgetUSD),operators:raw.operators,provider:routing as unknown as Routing,maxRequestNano:nano(raw.maxRequestUSD),keyCap:nano(raw.providerKeyCapUSD),maxInputTokens:raw.maxInputTokens,maxOutputTokens:raw.maxOutputTokens,maxSerializedRequestBytes:raw.maxSerializedRequestBytes,userParallel:raw.userParallel,deploymentParallel:raw.deploymentParallel,userRequestsPerMinute:raw.userRequestsPerMinute,deploymentRequestsPerMinute:raw.deploymentRequestsPerMinute,devGrant:g as unknown as DevGrant};
  }catch{return disabled;}
}
// OpenRouter aliases are never inferred from names. Any concrete response model
// different from the request must be explicitly owner-approved in responseModels.
export function responseModelAllowed(p:Policy,requested:string,response:string){return p.models[requested]?.responseModels.includes(response)===true;}
export function livePolicy(){const p=policy();if(!p.enabled)fail('LIVE_APPROVAL_REQUIRED');if(!process.env.OPENROUTER_API_KEY)fail('PROVIDER_NOT_CONFIGURED');return p;}
export function authorizeOperator(p:Policy,subject:string){if(!p.operators.includes(subject))fail('OPERATOR_NOT_ALLOWED');}
export function providerRouting(p:Policy,model:string){const ceiling=p.models[model];return{only:p.provider.only,order:p.provider.only,data_collection:p.provider.data_collection,zdr:p.provider.zdr,allow_fallbacks:p.provider.allow_fallbacks,require_parameters:p.provider.require_parameters,max_price:{prompt:ceiling.prompt*1e6,completion:ceiling.completion*1e6,request:ceiling.request}};}
export function providerAllowed(p:Policy,name:string){return p.provider.names.includes(name);}
export function providerKey(){return process.env.OPENROUTER_API_KEY || '';}
export function expectedIssuer(){return process.env.CLERK_JWT_ISSUER_DOMAIN || '';}
// USD/token for prompt/completion/cache; USD/invocation for request.
// Positive unsupported units (image/search/reasoning/etc.) have no proven bound.
export const PRICE_KEYS=['prompt','completion','input_cache_read','input_cache_write','input_cache_write_1h','request'] as const;
export type Prices=Record<typeof PRICE_KEYS[number],number>;
export function prices(raw:unknown):Prices|null{
  if(!record(raw))return null;
  const parsed=Object.fromEntries(PRICE_KEYS.map(k=>[k,0])) as Prices;
  for(const [key,value] of Object.entries(raw)){
    // discount is endpoint metadata, never a negative cost credit in our bound.
    if(key==='discount'&&value===0)continue;
    if(typeof value!=='string'||! /^(?:0|[1-9][0-9]*)(?:[.][0-9]+)?(?:e[+-]?[0-9]+)?$/i.test(value))return null;
    const n=Number(value);if(!Number.isFinite(n)||n<0||n>1||(n===0&&value.split(/[eE]/)[0].replace(/[.0]/g,'')!==''))return null;
    if(PRICE_KEYS.includes(key as typeof PRICE_KEYS[number]))parsed[key as keyof Prices]=n;
    else if(n!==0)return null;
  }
  if(!Object.hasOwn(raw,'prompt')||!Object.hasOwn(raw,'completion'))return null;
  return parsed;
}
export type CatalogModel={id:string;name:string;context:number|null;prompt:number|null;completion:number|null;bounded:boolean;pricing:Prices|null};
export function parseCatalog(raw:unknown):CatalogModel[]{
  if(!record(raw)||!Array.isArray(raw.data)||raw.data.length>5000)fail('INVALID_CATALOG');
  const counts=new Map<string,number>();
  for(const item of raw.data)if(record(item)&&typeof item.id==='string')counts.set(item.id,(counts.get(item.id)||0)+1);
  const result:CatalogModel[]=[];
  for(const item of raw.data){
    if(!record(item))continue;const m=item;
    if(typeof m.id!=='string'||!modelId.test(m.id)||m.id.length>180||counts.get(m.id)!==1||typeof m.name!=='string'||m.name.length>240)continue;
    const pricing=prices(m.pricing);
    result.push({id:m.id,name:m.name,context:typeof m.context_length==='number'&&Number.isSafeInteger(m.context_length)&&m.context_length>0?m.context_length:null,prompt:pricing?.prompt??null,completion:pricing?.completion??null,bounded:pricing!==null,pricing});
  }
  return result;
}
export async function boundedJSON(response:Response,max:number):Promise<unknown>{
  if(!response.body)fail('INVALID_PROVIDER_RESPONSE');
  const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>max)fail('INVALID_PROVIDER_RESPONSE');chunks.push(part.value);}}
  finally{await reader.cancel().catch(()=>{});}
  const joined=new Uint8Array(size);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(joined));}catch{return fail('INVALID_PROVIDER_RESPONSE');}
}
