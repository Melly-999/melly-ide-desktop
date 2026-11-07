import {WorkspaceDialog} from './dialog.js';
import {BACKUP_LIMIT, createBackup, parseBackup, recoveryBackup, previewBackup, applyBackup} from './backup.js';

export class WorkspaceBackupUI {
  constructor(container, editor, options = {}) { this.isActive = options.isActive || (() => true); this.container=container; this.editor=editor; this.dialog=new WorkspaceDialog(); this.busy=false; }
  init() {
    this.container.insertAdjacentHTML('beforeend', `
      <section class="workspace-backup" lang="en" aria-labelledby="backupHeading">
        <h2 id="backupHeading">Legacy samples backup & recovery (v1)</h2>
        <p>Download current editor buffers, including unsaved edits. Only supported files and the active-file preference are included. LocalStorage, MCP, prompts and credentials are excluded. Check your code for secrets before exporting.</p>
        <button id="backupExport">Export workspace</button>
        <label class="backup-file-label" for="backupInput">Import .mellyide.json backup</label>
        <input id="backupInput" type="file" accept=".json,.mellyide.json,application/json">
        <button id="backupRecovery">Export recovery fields</button>
        <p id="backupStatus" role="status" aria-live="polite">A download does not prove that a backup can be restored. Test it separately.</p>
      </section>
      <div id="backupOverlay" class="hub-modal-overlay" style="display:none" lang="en">
        <section id="backupDialog" class="hub-modal-window" role="dialog" aria-modal="true" aria-labelledby="backupTitle" tabindex="-1">
          <div class="modal-header"><h3 id="backupTitle">Preview workspace import</h3><button id="backupCancel" aria-label="Cancel import">✕</button></div>
          <div class="modal-body"><p>Unchecked files are kept. Check only the records you explicitly approve replacing. Existing content, including unsaved edits, will be replaced for those files.</p><div id="backupPreview"></div>
          <button id="backupApply">Replace selected files</button><button id="backupKeep">Keep existing files</button><p id="backupError" role="alert"></p></div>
        </section>
      </div>`);
    const q=s=>this.container.querySelector(s);
    this.status=q('#backupStatus'); this.overlay=q('#backupOverlay'); this.panel=q('#backupDialog');
    q('#backupExport').onclick=()=>this.run(async()=>{await this.editor.initializePersistence();this.download(createBackup(this.editor),'workspace');});
    q('#backupRecovery').onclick=()=>this.run(async()=>{
      const stored=await this.editor.fileStore.readBackupRecords(); if (!stored.ok) throw new Error(stored.message);
      this.download(recoveryBackup(stored.records),'recovery');
      this.status.textContent='Recovery fields offered for download. Unknown records/fields were excluded. This diagnostic format cannot be directly imported; original data was not changed.';
    });
    q('#backupInput').onchange=e=>this.run(async()=>{
      const file=e.target.files[0]; e.target.value=''; if (!file) return;
      if (file.size>BACKUP_LIMIT) throw new Error('Backup exceeds 2 MiB.');
      this.preview=await previewBackup(this.editor,parseBackup(await file.text()));
      const list=q('#backupPreview'); list.replaceChildren();
      for (const record of this.preview.data.files) {
        const before=this.preview.snapshots[record.filename];
        const row=document.createElement('label'); row.className='backup-choice';
        const check=document.createElement('input'); check.type='checkbox'; check.value=record.filename;
        const text=document.createElement('span'); text.textContent=`${record.filename}: ${before.content===record.content?'identical':'CONFLICT — different content'}${before.dirty?' · unsaved edits':''}${this.editor.recoveryRequired[record.filename]?' · stored recovery state':''}. ${record.content.length} characters.`;
        row.append(check,text);list.append(row); const details=document.createElement('details'); const summary=document.createElement('summary'); summary.textContent='Compare current and incoming content'; details.append(summary); for(const [label,content] of [['Current buffer',before.content],['Incoming backup',record.content]]) { const heading=document.createElement('h4');heading.textContent=label;const pre=document.createElement('pre');pre.tabIndex=0;pre.setAttribute('aria-label',label+' for '+record.filename);pre.textContent=content;details.append(heading,pre); } list.append(details);
      }
      q('#backupError').textContent=''; this.dialog.open(this.overlay,this.panel);
    });
    q('#backupCancel').onclick=()=>this.close(); q('#backupKeep').onclick=()=>this.close();
    this.overlay.onclick=e=>{if(e.target===this.overlay&&!this.busy)this.close();};
    q('#backupApply').onclick=()=>this.run(async()=>{
      const selected=[...q('#backupPreview').querySelectorAll('input:checked')].map(el=>el.value);
      const result=await applyBackup(this.editor,this.preview,selected);
      this.dialog.close();this.preview=null;
      this.status.textContent=result.kept?'Kept existing files. No records imported.':`Imported ${result.count} selected file(s) in one completed local transaction. Other records were preserved.`;
    });
  }
  close() {if(this.busy)return;this.dialog.close();this.preview=null;this.status.textContent='Import canceled. No records imported.';}
  async run(action) {
    if(this.busy)return;
    if (!this.isActive()) { this.status.textContent='Select the legacy project in Editor & Review to use its v1 backup. Use Export projects v2 for new projects.'; return; }
    this.busy=true;
    const controls=[...this.container.querySelectorAll('.workspace-backup button,.workspace-backup input,#backupDialog button')];
    controls.forEach(el=>el.disabled=true);
    // Prevent Escape dismissal while the short atomic write is in progress.
    const block=e=>{if(e.key==='Escape'&&this.dialog.active){e.preventDefault();e.stopImmediatePropagation();}};
    window.addEventListener('keydown',block,true);
    try {await action();} catch(error) {
      const target=this.dialog.active?this.container.querySelector('#backupError'):this.status;
      target.textContent=error.message||'Backup operation failed. No import was acknowledged.';
    } finally {this.busy=false;controls.forEach(el=>el.disabled=false);window.removeEventListener('keydown',block,true);}
  }
  download(text,kind) {
    const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const link=document.createElement('a');
    link.href=url;link.download=`melly-ide-${kind}-${new Date().toISOString().replace(/[:.]/g,'-')}.mellyide.json`;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    this.status.textContent='Backup offered to your browser for download. Check the downloaded file; successful future restoration is not yet verified.';
  }
}
