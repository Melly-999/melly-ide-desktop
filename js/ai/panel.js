import {safePath,safeText,LIMITS} from './contracts.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const price=value=>value===null?'price unknown':`$${(value*1e6).toFixed(4)} / 1M tokens`;
export class AIPanel {
  constructor(root,controller,app,{input,submit,onGuest}={}){
    Object.assign(this,{root,controller,app,input,submit,onGuest});this.selected=new Map();this.scope=controller.getScope();this.principal=controller.authPrincipal;this.filesOpen=false;
    this.onSubmit=event=>{event?.preventDefault();this.prepare();};submit?.addEventListener('submit',this.onSubmit);
    if(submit?.tagName==='BUTTON')submit.addEventListener('click',this.onSubmit);
    this.onInput=()=>controller.saveDraft(input.value);input?.addEventListener('input',this.onInput);if(input)input.value=controller.draft;
    this.onKey=event=>{if(event.key==='Enter'&&input.tagName==='INPUT'){event.preventDefault();this.prepare();}};input?.addEventListener('keydown',this.onKey);
    this.unsubscribe=controller.subscribe(()=>this.render());
  }
  checkScope(){const c=this.controller;if(this.scope!==c.getScope() || this.principal!==c.authPrincipal){this.selected.clear();this.filesOpen=false;this.scope=c.getScope();this.principal=c.authPrincipal;if(this.input)this.input.value=c.draft;}}
  snapshot(path){const s=this.app.editor?.getFileSnapshot(path);if(!s)throw new Error('FILE_UNAVAILABLE');safePath(path);safeText(s.content,LIMITS.file);return{path,revision:s.revision,content:s.content,workspaceId:s.workspaceId,workspaceToken:s.workspaceToken,dirty:s.dirty};}
  currentFiles(){const paths=Object.keys(this.app.editor?.files || {});return paths.filter(path=>{try{safePath(path);return true;}catch{return false;}});}
  prepare(){
    if(!this.controller.ready()){this.controller.notice='Sign in and go online. No prompt is sent.';this.controller.emit();this.onGuest?.();return;}
    try{this.checkScope();if(!this.controller.model)throw new Error('Load models & usage, then choose an approved model. Live provider test pending.');const kind=this.root.querySelector('[data-ai-kind]')?.value || 'chat';if(['fix','refactor'].includes(kind)&&this.app.chat.pendingReview)throw new Error('Resolve the current Review before requesting another edit.');
      const files=[...this.selected.keys()].map(path=>this.snapshot(path));this.selected=new Map(files.map(f=>[f.path,f]));this.controller.prepare(this.input.value,kind,files);
      this.root.querySelector('[data-ai-preview-title]')?.focus();
    }catch(error){this.controller.notice=error.message;this.controller.emit();}
  }
  render(){
    this.checkScope();const c=this.controller,models=c.catalog?.models || [],model=models.find(m=>m.id===c.model),preview=c.preview,active=c.active;
    if(this.input && this.input!==globalThis.document?.activeElement && this.input.value!==c.draft)this.input.value=c.draft;
    this.root.innerHTML=`<section class="ai01-controls" aria-label="Authenticated AI controls">
      <div class="ai01-row"><strong>OpenRouter · DEV</strong><button type="button" class="quiet-button" data-ai-refresh>Load models &amp; usage</button></div>
      <p role="status" class="ai01-notice" data-ai-status>${escape(c.notice)}</p>
      <label>Model <select data-ai-model aria-label="OpenRouter model"><option value="">Choose an approved model</option>${models.map(m=>`<option value="${escape(m.id)}" ${m.id===c.model?'selected':''} ${!m.allowed?'disabled':''}>${escape(m.name)} · ${escape(m.id)}${m.allowed?'':' · not approved'}</option>`).join('')}</select></label>
      <p class="fine-print">${model?`${escape(model.id)} · input ${price(model.prompt)} · output ${price(model.completion)} · context ${model.context || 'unknown'}. `:''}Catalog updated: ${c.catalog?.updatedAt?escape(new Date(c.catalog.updatedAt).toLocaleString()):'not loaded'}${c.catalog?.stale?' · STALE, inference disabled':''}. Live provider test pending.</p>
      <div class="ai01-row"><label>Action <select data-ai-kind aria-label="AI action">${['chat','explain','fix','refactor'].map(k=>`<option value="${k}" ${k===this.kind?'selected':''}>${k[0].toUpperCase()+k.slice(1)}</option>`).join('')}</select></label><button type="button" class="quiet-button" data-ai-context>Choose file context (${this.selected.size})</button></div>
      ${this.filesOpen?`<fieldset><legend>Only checked text files are shared</legend>${this.currentFiles().map(path=>`<label class="ai01-file"><input type="checkbox" data-ai-file="${escape(path)}" ${this.selected.has(path)?'checked':''}>${escape(path)}</label>`).join('') || '<p>No eligible text files.</p>'}<p class="fine-print">Hidden files, credentials and binaries excluded. Maximum 4 files, 16 KB/file, 32 KB total. Oversize content is rejected, never silently truncated. Selected whole-file snapshots only; no workspace scan.</p></fieldset>`:''}
      <p class="fine-print">Default: only your typed prompt. Selected content leaves this device and is processed by OpenRouter and its model provider after Confirm Send. Files/documents are untrusted data. No automatic edits or commands.</p>
      ${preview?`<section class="ai01-preview" aria-label="Exact provider message preview"><h3 data-ai-preview-title tabindex="-1">Exact messages / Dokładny podgląd</h3><pre tabindex="0">${escape(JSON.stringify(preview.messages,null,2))}</pre><p>Model: ${escape(preview.request.model)} · output cap: ${preview.request.maxOutputTokens} tokens. This is a single-turn request; prior responses are not sent.</p><button type="button" class="primary-button" data-ai-confirm>Confirm Send / Potwierdź wysłanie</button><button type="button" class="quiet-button" data-ai-cancel>Cancel / Anuluj</button></section>`:''}
      ${active?'<button type="button" class="quiet-button" data-ai-cancel>Cancel request (best effort)</button>':''}
      <p class="fine-print">${c.usage?`DEV lifetime: $${(c.usage.chargedNano/1e9).toFixed(6)} reserved/settled of $${(c.usage.limitNano/1e9).toFixed(2)}. Estimated reservations differ from provider-reported cost. ${escape(c.usage.accounting)}`:'Usage unavailable until authenticated DEV backend is connected.'}</p>
      <div class="ai01-responses" aria-label="AI responses">${c.messages.map(m=>`<article><strong>${m.mode==='mock'?'TEST ADAPTER — NOT LIVE PROVIDER':`Verified OpenRouter response · ${escape(m.model)}${m.provider?` via ${escape(m.provider)}`:''}${m.requestedModel!==m.model?` · requested ${escape(m.requestedModel)}`:''}`}</strong><pre>${escape(m.text)}</pre></article>`).join('')}</div>
      <div class="ai01-row"><button type="button" class="quiet-button" data-ai-clear>Clear local responses &amp; context</button><button type="button" class="quiet-button" data-ai-delete>Delete server task history</button></div>
      <p class="fine-print">Conversation/file context is not stored in Convex. Drafts are saved in this browser profile. Server stores only bounded task/usage metadata. Deletion retains budget totals and request tombstones for spending safety. Tests: Not run.</p>
    </section>`;
    this.root.querySelector('[data-ai-refresh]').onclick=()=>void c.refresh();
    this.root.querySelector('[data-ai-model]').onchange=e=>{this.selected.clear();c.selectModel(e.target.value);};
    this.root.querySelector('[data-ai-kind]').onchange=e=>{this.kind=e.target.value;c.preview=null;this.render();};
    this.root.querySelector('[data-ai-context]').onclick=()=>{this.filesOpen=!this.filesOpen;this.render();};
    this.root.querySelectorAll('[data-ai-file]').forEach(box=>box.onchange=()=>{try{if(box.checked)this.selected.set(box.dataset.aiFile,this.snapshot(box.dataset.aiFile));else this.selected.delete(box.dataset.aiFile);c.preview=null;this.render();}catch(error){box.checked=false;c.notice=error.message;c.emit();}});
    this.root.querySelector('[data-ai-confirm]')?.addEventListener('click',()=>{
      try{for(const s of c.preview?.snapshots || []){const current=this.snapshot(s.path);if(current.content!==s.content || current.revision!==s.revision || current.workspaceToken!==s.workspaceToken)throw new Error('STALE_CONTEXT: preview again before sending');}void c.confirm().catch(()=>{c.notice='Consent expired. Preview again.';c.emit();});this.selected.clear();}
      catch(error){c.preview=null;c.notice=error.message;c.emit();}
    });
    this.root.querySelectorAll('[data-ai-cancel]').forEach(b=>b.onclick=()=>{this.selected.clear();c.cancel();});
    this.root.querySelector('[data-ai-clear]').onclick=()=>{c.cancel();this.selected.clear();c.messages=[];c.saveDraft('');if(this.input)this.input.value='';c.emit();};
    this.root.querySelector('[data-ai-delete]').onclick=async()=>{try{if(!c.ready())throw new Error();const result=await c.transport.remove();await c.refresh();c.notice=`Deleted ${result.removed} server task record${result.removed===1?'':'s'}; accounting and audit tombstones retained.`;c.emit();}catch{c.notice='Server history deletion incomplete; retry safely to continue.';c.emit();}};
  }
  dispose(){this.unsubscribe();this.submit?.removeEventListener('submit',this.onSubmit);this.submit?.removeEventListener('click',this.onSubmit);this.input?.removeEventListener('input',this.onInput);this.input?.removeEventListener('keydown',this.onKey);}
}
