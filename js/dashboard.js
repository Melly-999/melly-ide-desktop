import { AssistantScreen } from './assistant.js';
import { readLayout } from './workspace/commands.js';
// Presentation owns navigation only; workspace/editor remain the owners of source and revisions.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const routes = new Set(['dashboard', 'code', 'tasks', 'review', 'studio', 'hub', 'onboarding', 'assistant', 'account', 'devcenter']);
export function initialRoute(hash, saved) {
  const explicit = hash.replace(/^#/, '');
  return routes.has(explicit) ? explicit : (['code', 'studio', 'review'].includes(saved) ? saved : 'dashboard');
}
export class PremiumShell {
  constructor(app) { this.app = app; this.route = 'dashboard'; this.selections = new WeakMap(); this.visits = this.readVisits(); this.lastActiveId = null; }
  init() {
    const wrapper = document.getElementById('appWrapper');
    wrapper.insertAdjacentHTML('afterbegin', `
      <section id="viewDashboard" class="view-screen premium-page" lang="en" hidden>
        <div class="page-heading"><div><h1 tabindex="-1">Hello World</h1><p>Build. Review. Ship.</p></div></div>
        <button class="dashboard-composer" data-route="assistant"><span aria-hidden="true">✦</span><span>Ask Melly anything…<small>AI not connected</small></span><b aria-hidden="true">↑</b></button>
        <div class="dashboard-grid">
          <section class="surface continue-card"><div class="card-kicker"><span class="live-dot"></span> CONTINUE EDITING <span class="keycap">LOCAL</span></div><div id="dashboardContinue"></div></section>
          <section class="surface quick-card"><h2>Start something</h2><p>A small step. A real project.</p><div class="quick-actions"><button data-quick="open"><span>⌘</span> Open project <b>↗</b></button><button data-quick="resume"><span>↳</span> Resume editing <b>↗</b></button><button data-quick="github"><span>⑂</span> Browse public GitHub <b>↗</b></button><button data-quick="import"><span>↓</span> Import backup <b>↗</b></button></div></section>
          <section class="surface recent-card"><div class="section-heading"><h2>Recent Projects</h2><button data-quick="new" class="quiet-button">+ New</button></div><div id="dashboardProjects"></div></section>
          <section class="surface activity-card"><div class="section-heading"><h2>Agent Task Queue</h2><span class="connection-pill">NOT CONNECTED</span></div><p>Connect an agent service to start a task.</p><button data-route="tasks" class="quiet-button">Connect agents</button></section>
          <section class="surface approval-card"><h2>Pending Reviews</h2><div id="dashboardApprovals"></div></section>
          <section class="surface connections-card"><h2>Services</h2><dl id="dashboardConnections"></dl><p class="fine-print">Local saves, offline access and cloud sync are separate. No source is uploaded automatically.</p></section>
        </div><footer class="dashboard-footer">MELLY IDE <span>Private by default. Review before you apply.</span></footer>
      </section>
      <section id="viewTasks" class="view-screen premium-page" lang="en" hidden><div class="section-heading"><div><h1 tabindex="-1">Agents &amp; Tools</h1><p>Build your workspace, one connection at a time.</p></div><button class="quiet-button" data-route="assistant" aria-label="Open agent chat">Chat ↗</button></div><div class="tool-filters" role="group" aria-label="Filter tools">${['All','Agents','Development','Integrations'].map((t,i)=>`<button class="quiet-button" data-filter="${t}" aria-pressed="${i===0}">${t}</button>`).join('')}</div><div id="agentToolsGrid" class="agent-tools-grid"></div><p class="fine-print">No authorized task service or agent runtime is connected. Local tools and labeled demos are available from Help and local tools.</p></section>
      <section id="viewAssistant" class="view-screen premium-page assistant-page" lang="en" hidden></section>
      <section id="viewReview" class="view-screen premium-page" lang="en" hidden><div class="page-eyebrow">HUMAN APPROVAL REQUIRED</div><h1 tabindex="-1">Review</h1><p id="reviewContext" class="review-context"></p><div id="reviewHost"></div></section>`);
    this.assistant = new AssistantScreen(document.getElementById('viewAssistant'), kind => this.configure(kind));
    this.assistant.init();
    this.initTools();
    this.initConfigDialog();
    this.chatHome = document.getElementById('chatContainer').parentElement;
    const studio = document.getElementById('viewStudio');
    studio.insertAdjacentHTML('afterbegin', `<div class="workbench-toolbar"><div><span class="live-dot"></span><strong id="activeWorkspaceLabel">Local workspace</strong><span class="workbench-caption"> / Code</span></div><div><button id="explorerToggle" aria-controls="workspaceExplorer" aria-expanded="false">Files & projects</button><button data-route="assistant">Chat</button><button data-route="review">Review</button></div></div>`);
    studio.insertAdjacentHTML('beforeend', '<section class="code-inspector" aria-label="Code inspection"><div class="inspection-tabs" role="group" aria-label="Inspect active file"><button data-inspect="suggestion" aria-pressed="true">AI suggestion</button><button data-inspect="diff" aria-pressed="false">Diff</button><button data-inspect="tests" aria-pressed="false">Tests</button><button data-inspect="files" aria-pressed="false">Files</button></div><div id="inspectionContent" role="region" aria-label="Inspection result" aria-live="polite"></div></section>');
    document.querySelectorAll('[data-inspect]').forEach(button => button.addEventListener('click', () => this.inspect(button.dataset.inspect)));
    this.app.workspace.root.id = 'workspaceExplorer';
    this.app.workspace.root.setAttribute('tabindex', '-1');
    document.body.insertAdjacentHTML('beforeend', `<nav class="primary-navigation" aria-label="Main navigation"><button data-route="dashboard"><span aria-hidden="true">⌂</span><span data-label="dashboard">Dashboard</span></button><button data-route="code"><span aria-hidden="true">&lt;/&gt;</span><span data-label="code">Code</span></button><button data-route="tasks"><span aria-hidden="true">◇</span><span data-label="tasks">Tasks</span></button><button data-route="review"><span aria-hidden="true">✓</span><span data-label="review">Review</span></button></nav>`);
    document.addEventListener('click', event => {
      const route = event.target.closest('[data-route]');
      if (route) this.app.switchView(route.dataset.route);
      const config = event.target.closest('[data-config]');
      if (config) this.configure(config.dataset.config);
      const quick = event.target.closest('[data-quick]');
      if (quick) this.quick(quick.dataset.quick);
      const project = event.target.closest('[data-open-project]');
      if (project) void this.openProject(project.dataset.openProject);
    });
    document.getElementById('explorerToggle').addEventListener('click', () => this.toggleExplorer());
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && studio.classList.contains('explorer-open')) { this.toggleExplorer(false); document.getElementById('explorerToggle').focus(); }
    });
    window.addEventListener('hashchange', () => { if (routes.has(location.hash.slice(1))) this.app.switchView(location.hash.slice(1)); });
    window.addEventListener('workspace-changed', () => this.refresh());
    const observer = new MutationObserver(() => { if (this.route === 'dashboard') this.refresh(); });
    for (const id of ['editorContainer', 'chatContainer', 'offlineShellStatus']) observer.observe(document.getElementById(id), {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['data-ready','data-state']});
    const resize = () => {
      const viewport = window.visualViewport;
      document.documentElement.style.setProperty('--visual-height', (viewport?.height || innerHeight) + 'px');
      const keyboard = !!viewport && innerHeight - viewport.height > 150 && /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
      document.body.classList.toggle('keyboard-open', keyboard);
    };
    window.visualViewport?.addEventListener('resize', resize);
    document.addEventListener('focusout', resize);
    resize();
    this.refresh();
  }
  initTools() {
    const tools = [
      ['✦','AI Agents','Create a task with an authorized agent.','Not connected','Agents','ai'],
      ['◈','Skills','Manage reusable local instructions.','Local library','Development','skills'],
      ['▣','Projects','Open your files and working copies.','On this device','Development','projects'],
      ['ϟ','Automations','Plan scheduled workflows.','Demo only','Agents','automations'],
      ['⌁','MCP & Integrations','Connect tools with explicit permissions.','Not connected','Integrations','mcp'],
      ['≋','Voice','Talk to Melly with your permission.','Coming later','Agents','voice'],
      ['›_','Terminal','Gated local terminal foundation.','Execution disabled','Development','terminal'],
      ['◉','Live Preview','Isolated HTML/CSS/JS preview.','Desktop isolated · browser static','Development','preview'],
      ['◇','Multi-model AI','Choose a model for the task.','Not connected','Agents','ai'],
      ['⑂','GitHub','Browse public source and real revisions.','Public read available','Integrations','github'],
      ['⌘','Commands','Manage local prompt presets.','Local library','Development','commands']
    ];
    const grid = document.getElementById('agentToolsGrid');
    grid.innerHTML = tools.map(([icon,title,description,state,group,action]) => `<button class="agent-tool" data-tool="${action}" data-category="${group}"><span class="tool-icon" aria-hidden="true">${icon}</span><span><strong>${title}</strong><small>${description}</small><em>${state}</em></span><span aria-hidden="true">›</span></button>`).join('');
    grid.addEventListener('click', event => {
      const button = event.target.closest('[data-tool]'); if (!button) return;
      const action = button.dataset.tool;
      if (action === 'projects') this.quick('open');
      else if (action === 'github') this.quick('github');
      else if (['skills','commands','automations','mcp'].includes(action)) { this.app.switchView('hub'); this.app.hub.container.querySelector(`[data-action="${action}"]`).click(); }
      else if (['preview','terminal','git','agents'].includes(action) && this.app.devCenter) this.app.devCenter.open(action);
      else this.configure(action);
    });
    document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
      document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
      grid.querySelectorAll('[data-category]').forEach(card => { card.hidden = button.dataset.filter !== 'All' && card.dataset.category !== button.dataset.filter; });
    }));
  }
  initConfigDialog() {
    document.body.insertAdjacentHTML('beforeend', '<dialog id="connectionDialog" aria-labelledby="connectionTitle"><form method="dialog"><button class="quiet-button dialog-close" aria-label="Close connection details">Close</button></form><h2 id="connectionTitle"></h2><p id="connectionDescription"></p><p class="fine-print">Local files and backups remain available without an account.</p></dialog>');
    this.configDialog = document.getElementById('connectionDialog');
  }
  configure(kind) {
    if (kind === 'account' && this.app.account) { this.app.account.open(this.app.auth?.state.clerkSignedIn||this.app.auth?.state.setupRequired?'account':'sign-in'); return; }
    const copy = {
      account: ['Account · sign-in unavailable', 'Cloud sign-in is not connected. Account access and project synchronization require the separate authorized Clerk / Convex setup. No credentials are requested here.'],
      ai: ['Connect AI', 'AI-01 local controls are implemented. Sign in and load models in Chat to check DEV readiness. Provider not configured / Live provider test pending until owner-approved DEV sync, key, models and budget. No prompt is sent from this dialog.'],
      pro: ['Melly Pro · coming soon', 'Subscriptions not available yet. Billing and entitlements are not connected. The preview describes planned capabilities; it grants no paid access and collects no payment details.'],
      voice: ['Voice · coming later', 'Microphone access and a real transcription provider are not connected. No audio is recorded.'],
      terminal: ['Remote Terminal · not connected', 'No remote execution environment is connected. A future terminal requires an isolated runtime and explicit permissions.'],
      preview: ['Live Preview · coming later', 'No application runtime is connected. The local editor and public GitHub source browser are available.']
    };
    const [title, description] = copy[kind] || copy.ai;
    document.getElementById('connectionTitle').textContent = title;
    document.getElementById('connectionDescription').textContent = description;
    this.configDialog.showModal();
  }
  refreshAI() {
    const ai=this.app.ai;if(!ai)return;
    let host=document.getElementById('ai01TaskQueue');if(!host){host=document.createElement('section');host.id='ai01TaskQueue';host.className='surface ai01-jobs';document.getElementById('agentToolsGrid').before(host);}
    host.innerHTML='<h2>AI task queue</h2><p>Current authenticated session · metadata only · Tests: Not run</p>'+ (ai.jobs.length?ai.jobs.map(j=>`<div class="ai01-job"><strong>${escape(j.kind)} · ${escape(j.status)}</strong><small>${escape(j.model)} · ${escape(new Date(j.startedAt).toLocaleString())} → ${j.finishedAt?escape(new Date(j.finishedAt).toLocaleString()):'in progress'} · ${escape(j.error||'')} · ${escape(j.tests)}</small></div>`).join(''):'<p>No AI jobs executed in this session.</p>');
    const remote=ai.usage?.jobs || [];
    if(remote.length)host.insertAdjacentHTML('beforeend','<h3>Server task metadata · last usage refresh</h3>'+remote.map(j=>`<div class="ai01-job"><strong>${escape(j.model)} · ${escape(j.status)}</strong><small>${escape(new Date(j.startedAt).toLocaleString())} · ${escape(j.error || '')} · conservative cost ${(j.chargedNano/1e9).toFixed(6)}</small></div>`).join(''));
    const banner=document.querySelector('.dashboard-composer small');if(banner)banner.textContent=ai.catalog?.ready?'DEV configured · live test pending':'AI not connected · DEV approval required';
    const activity=document.querySelector('.activity-card');activity.querySelector('.connection-pill').textContent=ai.active?'RUNNING':ai.jobs.length?'LOCAL SESSION':'NOT CONNECTED';activity.querySelector('p').textContent=ai.jobs.length?ai.jobs.length+' AI requests in this session. See Tasks for outcomes.':'No AI request executed in this session.';
    if(this.route==='dashboard')this.refresh();
  }
  inspect(kind) {
    this.inspection = kind;
    const host = document.getElementById('inspectionContent');
    document.querySelectorAll('[data-inspect]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.inspect === kind)));
    if (kind === 'files') { this.toggleExplorer(true); host.textContent = 'Select a file in Files & projects.'; return; }
    if (kind === 'tests') { host.innerHTML = '<h3>Not run</h3><p>No test runner is connected to this workspace.</p>'; return; }
    if (kind === 'diff') {
      this.app.workspace.showDiff();
      host.replaceChildren();
      const pre = document.createElement('pre'); pre.tabIndex = 0; pre.setAttribute('aria-label', 'Active source diff'); pre.textContent = document.getElementById('workspaceDiffText').textContent; host.append(pre); return;
    }
    const review = this.app.chat.pendingReview;
    host.innerHTML = review ? `<h3>Change awaiting review</h3><p>${escape(review.targetFilename)} · ${escape(review.status)}</p><button class="primary-button" data-route="review">Review change</button>` : '<h3>AI provider not connected</h3><p>No AI suggestion is pending.</p><button class="quiet-button" data-config="ai">Connect AI</button>';
  }

  initialView() { let saved; try { saved = sessionStorage.getItem('melly-view-v1'); } catch {} return initialRoute(location.hash, saved); }
  prepare(route) {
    if (!routes.has(route)) route = 'dashboard';
    const textarea = document.getElementById('editorTextarea');
    if (textarea && this.app.currentView === 'studio') {
      this.app.editor.captureLiveEditorContent();
      this.selections.set(this.app.editor, {file:this.app.editor.activeFilename, start:textarea.selectionStart, end:textarea.selectionEnd, scroll:textarea.scrollTop});
    }
    this.route = route;
    try { sessionStorage.setItem('melly-view-v1', route); } catch { /* Storage denial must not prevent local navigation. */ }
    const chat = document.getElementById('chatContainer');
    const host = route === 'review' ? document.getElementById('reviewHost') : this.chatHome;
    if (chat.parentElement !== host) host.append(chat);
    document.getElementById('viewStudio').classList.toggle('code-focus', route === 'code');
    // MEGA-09: a desktop-width explorer keeps the open/closed state the person chose last.
    const desktop = matchMedia('(min-width:1100px)').matches, remembered = readLayout().explorerOpen;
    this.toggleExplorer(desktop && remembered !== false);
    this.refresh();
    if (route === 'code') this.inspect(this.inspection || 'suggestion');
    return route === 'code' ? 'studio' : route;
  }
  afterNavigate() {
    document.querySelectorAll('.primary-navigation [data-route]').forEach(button => {
      const active = (this.route === 'assistant' && button.dataset.route === 'tasks') || button.dataset.route === this.route || (this.route === 'studio' && button.dataset.route === 'code');
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
    });
    if (this.route === 'code') {
      const textarea = document.getElementById('editorTextarea'), saved = this.selections.get(this.app.editor);
      if (textarea) { textarea.focus({preventScroll:true}); if (saved?.file === this.app.editor.activeFilename) { textarea.setSelectionRange(saved.start, saved.end); textarea.scrollTop = saved.scroll; } }
    } else if (['dashboard', 'tasks', 'assistant', 'account'].includes(this.route)) {
      document.querySelector(this.route === 'dashboard' ? '#viewDashboard h1' : this.route === 'assistant' ? '#viewAssistant h1' : this.route === 'account' ? '#viewAccount h1' : '#viewTasks h1')?.focus({preventScroll:true});
    } else if (this.route === 'review') {
      (document.getElementById('changeReviewTitle') || document.querySelector('#viewReview h1'))?.focus({preventScroll:true});
    } else if (this.route === 'devcenter') {
      this.app.devCenter?.activated(); document.querySelector('#viewDevCenter h1')?.focus({preventScroll:true});
    }
  }
  toggleExplorer(force) {
    const studio = document.getElementById('viewStudio');
    const desktop = matchMedia('(min-width:1100px)').matches;
    const open = force ?? (desktop ? studio.classList.contains('explorer-collapsed') : !studio.classList.contains('explorer-open'));
    studio.classList.toggle('explorer-collapsed', desktop && !open);
    studio.classList.toggle('explorer-open', open);
    document.getElementById('explorerToggle').setAttribute('aria-expanded', String(open));
    if (open && force === undefined) document.getElementById('workspaceProject').focus();
  }
  async openProject(id) {
    await this.app.workspace.perform(async () => {
      if (id !== this.app.workspace.state.activeProjectId) await this.app.workspace.activate(id);
      this.app.switchView('code');
    });
  }
  quick(action) {
    this.app.switchView('code');
    if (action === 'resume') return;
    this.toggleExplorer(true);
    if (action === 'new') document.getElementById('workspaceNewProject').click();
    if (action === 'import') document.getElementById('workspaceImport').click();
    if (action === 'github') {
      const input = document.getElementById('githubRepository');
      input.closest('details').open = true; input.focus();
    }
  }
  readVisits() {
    try {
      const entries = JSON.parse(localStorage.getItem('melly-project-visits-v1') || '[]');
      return Array.isArray(entries) ? entries.filter(e => e && typeof e.id === 'string' && e.id.length <= 200 && Number.isFinite(e.at)).sort((a,b) => b.at - a.at).slice(0,50) : [];
    } catch { return this.visits || []; }
  }
  recordVisit(workspace) {
    const id = workspace.state.activeProjectId;
    if (id === this.lastActiveId) return;
    this.lastActiveId = id;
    if (!workspace.project(id)) return;
    this.visits = [{id, at:Date.now()}, ...this.readVisits().filter(e => e.id !== id && workspace.project(e.id))].slice(0,50);
    try { localStorage.setItem('melly-project-visits-v1', JSON.stringify(this.visits)); } catch { /* Optional navigation metadata must never block editing. */ }
  }
  refresh() {
    const workspace = this.app.workspace, editor = this.app.editor;
    if (!workspace) return;
    this.recordVisit(workspace);
    const project = workspace.project(), file = editor.activeFilename;
    const name = project?.name || 'Legacy samples';
    const save = editor.getSaveState?.();
    document.getElementById('activeWorkspaceLabel').textContent = name;
    document.getElementById('dashboardContinue').innerHTML = `<h2>${escape(file || 'No file selected')}</h2><p class="continue-path">${escape(name)}</p><div class="continue-meta"><span>${escape(save?.status === 'saved' ? 'Saved locally' : save?.status === 'default' ? 'Bundled sample · not saved' : save?.status || 'No active file')}</span><span>${project ? 'Browser workspace' : 'Original sample storage'}</span></div><button class="primary-button" data-route="code" ${file ? '' : 'disabled'}>Resume editing <span>↗</span></button>`;
    const projects = [...workspace.state.projects].sort((a,b) => {
      const rank = id => id === workspace.state.activeProjectId ? -1 : (this.visits.findIndex(e => e.id === id) < 0 ? 999 : this.visits.findIndex(e => e.id === id));
      return rank(a.id) - rank(b.id);
    });
    document.getElementById('dashboardProjects').innerHTML = projects.length ? projects.map(p => `<button class="project-row" data-open-project="${escape(p.id)}"><span class="project-icon" aria-hidden="true">⌘</span><span><strong>${escape(p.name)}</strong><small>${escape(p.activePath || 'Empty project')} · ${p.entries.filter(e=>e.kind==='file').length} files</small></span><span aria-hidden="true">↗</span></button>`).join('') : '<p class="empty-copy">No local projects yet. Create one or import a backup.</p>';
    const pending = this.app.chat.pendingReview;
    const reviewProject = pending?.workspaceId ? workspace.project(pending.workspaceId)?.name || 'Unavailable project' : 'Legacy samples';
    document.getElementById('dashboardApprovals').innerHTML = pending ? `<p>${escape(reviewProject)} / ${escape(pending.targetFilename)} · revision ${Number(pending.baseRevision)} · ${escape(pending.status)}</p><p class="fine-print">${pending.sourceMode ? escape(pending.sourceMode)+' proposal' : 'SIMULATED proposal'} · actual local guarded review. Switching project can invalidate this review; guards are rechecked on approval.</p><button data-route="review" class="quiet-button">Open guarded review →</button>` : '<p class="empty-copy">Nothing waiting for your approval.</p><button data-route="review" class="quiet-button">Open review</button>';
    document.getElementById('reviewContext').textContent = pending ? `${reviewProject} / ${pending.targetFilename} · base revision ${pending.baseRevision} · ${pending.status}. Approval rechecks project, buffer and revision.` : 'No pending approval. Open a proposal in the demo workbench to try guarded local review; no AI provider is connected.';
    const offline = document.getElementById('offlineShellStatus');
    const statuses = [['Local file', save?.status || 'No active file'], ['Offline shell', offline?.dataset.state === 'desktop' ? 'Desktop bundle · cache not used' : offline?.dataset.ready === 'true' ? 'Ready on this origin' : 'Not ready'], ['Public GitHub', workspace.remote ? 'Metadata loaded · read only' : 'Available on request'], ['Convex sync', 'Not connected'], ['Cortex memory', 'Not connected'], ['OpenRouter', 'Not connected'], ['MellyCore', 'Not connected'], ['Account', this.app.auth?.state.clerkSignedIn ? (this.app.auth.state.convex === 'confirmed' ? 'Identity confirmed · sync off' : 'Clerk signed in · identity unconfirmed') : 'Guest · cloud sign-in required']];
    document.getElementById('dashboardConnections').innerHTML = statuses.map(([label,status]) => `<div><dt>${label}</dt><dd>${escape(status)}</dd></div>`).join('');
  }
  language(lang) {
    const labels = lang === 'pl' ? {dashboard:'Pulpit', code:'Kod', tasks:'Zadania', review:'Przegląd', devcenter:'Dev'} : {dashboard:'Dashboard', code:'Code', tasks:'Tasks', review:'Review', devcenter:'Dev'};
    document.querySelectorAll('[data-label]').forEach(el => { el.textContent = labels[el.dataset.label]; });
  }
}
