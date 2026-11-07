import { AIPanel } from './ai/panel.js';
// Presentation boundary for a future authorized streaming provider. No provider is active.
export class AssistantScreen {
  constructor(container, onConfigure) { this.container = container; this.onConfigure = onConfigure; }
  init() {
    this.container.innerHTML = `<div class="assistant-heading"><img src="images/melly-192.png" alt="" width="40" height="40"><div><h1 tabindex="-1">Melly Agent</h1><p>AI provider not connected</p></div><button class="quiet-button" id="assistantModels">Models</button></div>
      <div class="assistant-conversation" role="log" aria-label="Conversation"><div class="assistant-welcome"><span aria-hidden="true">✦</span><div><h2>Your next idea starts here.</h2><p>Write a prompt or choose a starting point. Connect an AI provider to receive a response. Your draft stays on this device.</p></div></div></div>
      <div class="assistant-actions">${['Brainstorm','Summarize','Draft','Translate','Debug code','Write tests'].map(t=>`<button class="quiet-button" data-prompt="${t}">${t}</button>`).join('')}</div>
      <section class="pro-preview"><div class="pro-title"><span aria-hidden="true">♔</span><div><h2>Melly Pro</h2><p>Planned features · subscriptions unavailable</p></div><img src="images/melly-192.png" alt="" width="64" height="64"></div><ul><li>Multi-model assistance with usage and cost limits</li><li>Project sync and permissions for agent workflows</li><li>Expanded tools and integrations</li></ul><button id="assistantUpgrade" class="primary-button">Explore Pro <span aria-hidden="true">↗</span></button></section>
      <form id="assistantForm" class="assistant-composer"><label class="visually-hidden" for="assistantDraft">Message Melly</label><textarea id="assistantDraft" rows="2" placeholder="Message Melly…" maxlength="20000"></textarea><button class="primary-button" type="submit" aria-label="Connect AI to send message">↑</button></form><p id="assistantNotice" role="status" class="fine-print">AI provider not connected. No prompt is sent.</p>`;
    this.draft = this.container.querySelector('#assistantDraft');
    try { this.draft.value = localStorage.getItem('melly-assistant-draft-v1') || ''; } catch { /* Editing still works without optional draft storage. */ }
    this.draft.addEventListener('input', () => this.saveDraft());
    this.container.querySelector('#assistantForm').addEventListener('submit', event => { event.preventDefault(); this.saveDraft(); if(this.aiPanel)this.aiPanel.prepare();else this.onConfigure('ai'); });
    this.container.querySelector('#assistantModels').addEventListener('click', () => this.aiPanel ? this.aiPanel.controller.refresh() : this.onConfigure('ai'));
    this.container.querySelector('#assistantUpgrade').addEventListener('click', () => this.onConfigure('pro'));
    this.container.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { this.draft.value = button.dataset.prompt + ': ' + this.draft.value; this.saveDraft(); this.draft.focus(); }));
  }
  connectAI(controller,app) {
    this.aiPanel?.dispose();
    this.draft.value=controller.draft;
    const root=document.createElement('div');root.className='ai01-host';
    this.container.querySelector('.assistant-conversation').after(root);
    this.aiPanel=new AIPanel(root,controller,app,{input:this.draft,onGuest:()=>this.onConfigure('ai')});
    this.draft.addEventListener('input',()=>controller.saveDraft(this.draft.value));
    this.container.querySelector('#assistantForm button').setAttribute('aria-label','Preview AI request / Podgląd wiadomości');
    this.container.querySelector('#assistantNotice').textContent='Preview before sharing. No prompt is sent until Confirm Send. Live provider test pending.';
  }
  saveDraft() {
    if(this.aiPanel){this.aiPanel.controller.saveDraft(this.draft.value);return;}
    try { localStorage.setItem('melly-assistant-draft-v1', this.draft.value); }
    catch { this.container.querySelector('#assistantNotice').textContent = 'Draft is in memory only. Browser storage is unavailable. No prompt was sent.'; }
  }
}
