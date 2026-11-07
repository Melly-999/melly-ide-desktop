import {validateRequest,buildMessages} from './contracts.js';

export function clientTransport(getAuth) {
  const call=(method,args={})=>{
    const auth=getAuth();if(auth?.state.convex!=='confirmed' || !auth.client?.ai)throw new Error('SIGN_IN_REQUIRED');
    return auth.client.ai(method,args);
  };
  const remove=async()=>{
    let removed=0;
    for(let batches=1;batches<=100;batches++){
      const result=await call('removeHistory');
      if(!Number.isSafeInteger(result?.removed) || result.removed<0 || typeof result.complete!=='boolean')throw new Error('INVALID_HISTORY_RESULT');
      removed+=result.removed;
      if(result.complete)return{removed,complete:true,batches};
      if(result.removed===0)throw new Error('HISTORY_DELETION_INCOMPLETE');
    }
    throw new Error('HISTORY_DELETION_INCOMPLETE');
  };
  return{catalog:()=>call('catalog'),usage:()=>call('usage'),complete:request=>call('complete',{request}),remove};
}
const errorCode = error => {
  const allowed=['POLICY_CHANGED','OPERATOR_NOT_ALLOWED','PROVIDER_NOT_ALLOWED','GRANT_CONSUMED','GRANT_NOT_ALLOWED','REQUEST_COST_LIMIT','INPUT_TOKEN_LIMIT','PROVIDER_KEY_CAP_UNVERIFIED','NO_COMPLIANT_ENDPOINT','UNAUTHENTICATED','SIGN_IN_REQUIRED','PROVIDER_NOT_CONFIGURED','LIVE_APPROVAL_REQUIRED','MODEL_NOT_ALLOWED','MODEL_MISMATCH','PROVIDER_METADATA_MISMATCH','PROVIDER_VERIFICATION_UNAVAILABLE','PRICE_UNKNOWN','STALE_CATALOG','BUDGET_EXHAUSTED','RATE_LIMITED','JOB_ALREADY_RUNNING','DUPLICATE_REQUEST','TIMEOUT','NETWORK_UNAVAILABLE','PROVIDER_401','PROVIDER_403','PROVIDER_429','PROVIDER_5XX','INVALID_PROVIDER_RESPONSE','MALFORMED_PROPOSAL','UNBOUND_PROPOSAL','OUTPUT_TOKEN_LIMIT','CONTEXT_LIMIT','REQUEST_SIZE_LIMIT'];
  const text=typeof error?.data==='string'?error.data:error?.message || '';
  return allowed.find(code=>text===code || text.includes('Uncaught ConvexError: '+code)) || 'REQUEST_FAILED';
};
export class AIController {
  constructor({getAuth,getScope,transport,env=globalThis,onProposal=()=>{}}) {
    Object.assign(this,{getAuth,getScope,env,onProposal});this.transport=transport || clientTransport(getAuth);
    this.listeners=new Set();this.messages=[];this.jobs=[];this.preview=null;this.model='';this.catalog=null;this.usage=null;this.generation=0;this.notice='Provider not configured / Live provider test pending';
    this.authPrincipal=null;this.draft='';this.scope=getScope();
    this.offline=()=>this.scopeChanged();env.addEventListener?.('offline',this.offline);
    this.loadDraft();this.bindAuth();
  }
  bindAuth(){this.unsubscribeAuth?.();const auth=this.getAuth();this.unsubscribeAuth=auth?.subscribe(state=>{
    const principal=state.convex==='confirmed'?state.profile?.principal:null;
    if(principal!==this.authPrincipal){this.scopeChanged();this.messages=[];this.jobs=[];this.catalog=null;this.usage=null;this.authPrincipal=principal;this.model='';this.loadDraft();this.notice=principal?'Live provider test pending. Load models to check DEV readiness.':'Sign in / Zaloguj się to use AI. Local files remain on this device.';this.emit();}
  });}
  subscribe(fn){this.listeners.add(fn);fn();return()=>this.listeners.delete(fn);}
  emit(){for(const fn of this.listeners)fn();}
  key(){return 'melly-ai01-draft-v1:'+encodeURIComponent(this.authPrincipal || 'guest');}
  loadDraft(){try{this.draft=this.env.localStorage?.getItem(this.key()) || (!this.authPrincipal?this.env.localStorage?.getItem('melly-assistant-draft-v1'):'') || '';}catch{this.draft='';}}
  saveDraft(text){this.draft=text.slice(0,8000);try{this.env.localStorage?.setItem(this.key(),this.draft);}catch{this.notice='Draft in memory only';}}
  ready(){return this.env.navigator?.onLine!==false && this.getAuth()?.state.convex==='confirmed' && !!this.getAuth()?.state.profile;}
  selectModel(model){if(this.model!==model){this.scopeChanged();this.model=model;this.emit();}}
  scopeChanged(){this.cancel();this.scope=this.getScope();}
  cancel(){++this.generation;this.cancelWait?.();this.cancelWait=null;this.preview=null;if(this.active){this.active.status='cancelled';this.active.finishedAt=Date.now();this.active=null;this.notice='Cancelled locally. Provider processing/billing may continue; reservation remains until settlement.';}this.emit();}
  async refresh(){
    if(!this.ready()){this.notice='Sign in and go online / Zaloguj się i włącz sieć';this.emit();return;}
    const generation=this.generation,principal=this.authPrincipal;this.notice='Checking permission / Sprawdzanie uprawnień';this.emit();
    try{const [catalog,usage]=await Promise.all([this.transport.catalog(),this.transport.usage()]);if(generation!==this.generation || principal!==this.authPrincipal)return;this.catalog=catalog;this.usage=usage;this.notice=catalog.ready?'DEV configured · Live provider test pending':catalog.reason || 'Provider not configured';}
    catch(error){if(generation===this.generation)this.notice=errorCode(error);}
    this.emit();
  }
  prepare(prompt,kind='chat',files=[]){
    if(!this.ready())throw new Error('SIGN_IN_REQUIRED');if(this.active)throw new Error('JOB_ALREADY_RUNNING');
    const request=validateRequest({requestId:globalThis.crypto.randomUUID(),model:this.model,kind,prompt,files,maxOutputTokens:Math.min(1024,this.catalog?.limits?.maxOutputTokens??1024)});
    this.preview={request,messages:buildMessages(request),scope:this.getScope(),principal:this.authPrincipal,snapshots:files.map(f=>({...f}))};this.notice='Preview only. Confirm Send to share the exact messages below.';this.emit();return this.preview;
  }
  async confirm(){
    const preview=this.preview;if(!preview || !this.ready() || preview.scope!==this.getScope() || preview.principal!==this.authPrincipal)throw new Error('CONSENT_EXPIRED');
    this.preview=null;const generation=++this.generation,scope=this.getScope(),principal=this.authPrincipal,model=this.model;
    const job={id:preview.request.requestId,kind:preview.request.kind,model,status:'checking',startedAt:Date.now(),scope,tests:'Not run'};
    this.jobs.unshift(job);this.jobs=this.jobs.slice(0,50);this.active=job;this.notice='Checking permission / Sprawdzanie uprawnień';this.emit();
    let timeout;
    const current=()=>generation===this.generation && scope===this.getScope() && principal===this.authPrincipal && model===this.model && this.ready();
    try{
      job.status='running';this.notice='Running · non-streaming / W toku';this.emit();
      const result=await Promise.race([this.transport.complete(preview.request),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('TIMEOUT')),35000);this.cancelWait=()=>reject(new Error('CANCELLED'));})]);
      if(!current()){job.status='cancelled';return;}
      if(!['provider','mock'].includes(result?.mode) || typeof result.text!=='string' || result.text.length>64000)throw new Error('INVALID_PROVIDER_RESPONSE');
      if(result.mode==='provider' && (result.verification?.status!=='verified' || typeof result.verification.responseModel!=='string' || typeof result.verification.generationId!=='string' || typeof result.verification.provider!=='string'))throw new Error('PROVIDER_VERIFICATION_UNAVAILABLE');
      if(result.proposal)this.onProposal(result.proposal,preview.snapshots,result.mode);
      const actualModel=result.verification?.responseModel || model,provider=result.verification?.provider || null;
      this.messages.push({text:result.text,mode:result.mode,kind:preview.request.kind,model:actualModel,requestedModel:model,provider});this.messages=this.messages.slice(-30);
      job.status='complete';this.notice=result.mode==='mock'?'TEST ADAPTER — NOT LIVE PROVIDER':`Verified OpenRouter generation · ${actualModel} via ${provider}. Tests: Not run.`;
    }catch(error){if(current()){job.status='failed';job.error=errorCode(error);this.notice=job.error+' · no automatic retry; outcome may be uncertain.';}}
    finally{clearTimeout(timeout);job.finishedAt=Date.now();if(this.active===job){this.active=null;this.cancelWait=null;}this.emit();}
  }
  dispose(){this.cancel();this.unsubscribeAuth?.();this.env.removeEventListener?.('offline',this.offline);this.listeners.clear();}
}
