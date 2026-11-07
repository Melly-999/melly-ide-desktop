import { WorkspaceDialog } from './dialog.js';
import { localizeControls } from './ui-language.js';
import { projectsManager } from './modules/projects.js';
import { skillsManager } from './modules/skills.js';
import { mcpManager } from './modules/mcp.js';
import { automationsManager } from './modules/automations.js';
import { agentsManager } from './modules/agents.js';
import { commandsManager } from './modules/commands.js';
import { screenAwarenessManager } from './modules/screen-awareness.js';
import { getMcpTestResult, SIMULATED_LABEL } from './modules/simulation.js';

export class MellyHub {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.activeModal = null;
    this.dialog = new WorkspaceDialog();
    this.onSelectFeature = options.onSelectFeature || (() => {});
    this.searchQuery = '';
  }

  init() {
    if (!this.container) return;
    this.render();
    this.attachEvents();
  }

  render() {
    this.container.innerHTML = `
      <div class="melly-hub-shell">
        <!-- Melly IDE top bar -->
        <header class="melly-top-nav">
          <div class="nav-brand">
            <img class="melly-brand-mark" src="images/melly-192.png" alt="" width="36" height="36">
            <span class="nav-title">Melly IDE</span>
          </div>

          <div class="nav-actions">
            <button type="button" class="nav-search-btn" id="hubSearchTrigger" title="Quick Search (Cmd+K)" aria-label="Open quick search" aria-haspopup="dialog">
              <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            </button>
            <button type="button" class="nav-menu-btn" id="hubMenuTrigger" title="Menu (not available in this prototype)" aria-label="Menu (not available in this prototype)" aria-disabled="true">
              <svg aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="4" y1="8" x2="20" y2="8"></line><line x1="4" y1="16" x2="20" y2="16"></line></svg>
            </button>
          </div>
        </header>

        <!-- Command Palette / Search Modal (Hidden by default) -->
        <div class="command-palette-modal" id="commandPalette" style="display: none;">
          <div class="command-palette-box" tabindex="-1" role="dialog" aria-modal="true" aria-label="Quick search">
            <div class="palette-input-row">
              <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
              <input type="text" id="paletteInput" aria-label="Search commands, skills, agents, or MCP" placeholder="Search commands, skills, agents, or MCP..." autocomplete="off">
              <button type="button" class="palette-close-btn" id="paletteClose" aria-label="Close search (Esc)">Esc</button>
            </div>
            <div class="palette-results-list" id="paletteResults"></div>
          </div>
        </div>

        <div class="hub-content-scroll">
          <!-- Local and simulated workflow previews -->
          <section class="hub-section">
            <h2 class="section-heading">Prototype Safely</h2>
            
            <div class="feature-card-grid">
              <!-- Screen Awareness -->
              <button type="button" class="feature-card" data-action="screen-awareness">
                <div class="card-icon-wrap" aria-hidden="true">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7V5a2 2 0 0 1 2-2h2"></path><path d="M17 3h2a2 2 0 0 1 2 2v2"></path><path d="M21 17v2a2 2 0 0 1-2 2h-2"></path><path d="M7 21H5a2 2 0 0 1-2-2v-2"></path><circle cx="12" cy="12" r="3"></circle></svg>
                </div>
                <div class="card-content">
                  <span class="card-title">Screen Awareness</span>
                  <span class="card-subtitle">SIMULATED · no screen analysis is performed</span>
                </div>
              </button>

              <!-- Local command presets -->
              <button type="button" class="feature-card highlight-border" data-action="commands">
                <div class="card-icon-wrap highlight-icon" aria-hidden="true">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"></path></svg>
                </div>
                <div class="card-content">
                  <span class="card-title">AI Commands</span>
                  <span class="card-subtitle">SIMULATED · send a preset to demo chat</span>
                </div>
              </button>

              <!-- Extension placeholder -->
              <button type="button" class="feature-card" data-action="extensions">
                <div class="card-icon-wrap" aria-hidden="true">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
                </div>
                <div class="card-content">
                  <span class="card-title">Extensions</span>
                  <span class="card-subtitle">Not installed · integration placeholder</span>
                </div>
              </button>
            </div>
          </section>

          <!-- Browser-local workspace records -->
          <section class="hub-section">
            <h2 class="section-heading">Shape Your Workspace</h2>

            <div class="feature-card-grid">
              <!-- Projects -->
              <button type="button" class="feature-card" data-action="projects">
                <div class="card-icon-wrap" aria-hidden="true">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg>
                </div>
                <div class="card-content">
                  <span class="card-title">Projects</span>
                  <span class="card-subtitle">Keep local project notes between sessions</span>
                </div>
              </button>

              <!-- Automations -->
              <button type="button" class="feature-card" data-action="automations">
                <div class="card-icon-wrap" aria-hidden="true">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>
                </div>
                <div class="card-content">
                  <span class="card-title">Automations</span>
                  <span class="card-subtitle">SIMULATED · no background scheduler</span>
                </div>
              </button>

              <!-- Agents -->
              <button type="button" class="feature-card" data-action="agents">
                <div class="card-icon-wrap" aria-hidden="true">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="7" r="4"></circle><path d="M5.5 21a8.38 8.38 0 0 1 13 0"></path><path d="M12 11v2"></path></svg>
                </div>
                <div class="card-content">
                  <span class="card-title">Agents</span>
                  <span class="card-subtitle">SIMULATED · choose a demo persona</span>
                </div>
              </button>

              <!-- Local reusable instructions -->
              <button type="button" class="feature-card highlight-border" data-action="skills">
                <div class="card-icon-wrap highlight-icon" aria-hidden="true">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="9" height="9" rx="1"></rect><rect x="13" y="2" width="9" height="9" rx="1"></rect><rect x="2" y="13" width="9" height="9" rx="1"></rect><rect x="13" y="13" width="9" height="9" rx="1"></rect></svg>
                </div>
                <div class="card-content">
                  <span class="card-title">Skills</span>
                  <span class="card-subtitle">Store reusable local instruction records</span>
                </div>
              </button>

              <!-- MCP -->
              <button type="button" class="feature-card" data-action="mcp">
                <div class="card-icon-wrap" aria-hidden="true">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                </div>
                <div class="card-content">
                  <span class="card-title">MCP</span>
                  <span class="card-subtitle">SIMULATED · endpoints are never contacted</span>
                </div>
              </button>
            </div>
          </section>

          <!-- Product-scope reminder -->
          <div class="hub-footer-capsule">
            <span class="manual-capsule-link">Local-first · browser only</span>
          </div>
        </div>

        <!-- Detail Modal Shell -->
        <div class="hub-modal-overlay" id="hubModalOverlay" style="display: none;">
          <div class="hub-modal-window" id="hubModalWindow" role="dialog" aria-modal="true" aria-labelledby="modalTitle" tabindex="-1">
            <div class="modal-header">
              <h3 id="modalTitle">Feature Detail</h3>
              <button type="button" class="modal-close-btn" id="modalCloseBtn" aria-label="Close dialog"><span aria-hidden="true">✕</span></button>
            </div>
            <div class="modal-body" id="modalBody"></div>
          </div>
        </div>
      </div>
    `;
  }

  attachEvents() {
    const cards = this.container.querySelectorAll('.feature-card');
    const modalOverlay = this.container.querySelector('#hubModalOverlay');
    const modalClose = this.container.querySelector('#modalCloseBtn');
    const searchTrigger = this.container.querySelector('#hubSearchTrigger');
    const paletteModal = this.container.querySelector('#commandPalette');
    const paletteClose = this.container.querySelector('#paletteClose');
    const paletteInput = this.container.querySelector('#paletteInput');

    cards.forEach(card => {
      card.addEventListener('click', () => {
        const action = card.dataset.action;
        this.openFeature(action);
      });
    });

    if (modalClose && modalOverlay) {
      modalClose.addEventListener('click', () => {
        this.dialog.close();
      });
      modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) this.dialog.close();
      });
    }

    if (searchTrigger && paletteModal) {
      searchTrigger.addEventListener('click', () => {
        this.dialog.open(paletteModal, paletteModal.querySelector('[role=dialog]'), paletteInput);
        if (paletteInput) {
          paletteInput.value = '';
          paletteInput.focus();
          this.renderPaletteResults('');
        }
      });
    }

    if (paletteClose && paletteModal) {
      paletteClose.addEventListener('click', () => {
        this.dialog.close();
      });
    }

    if (paletteInput) {
      paletteInput.addEventListener('input', (e) => {
        this.renderPaletteResults(e.target.value);
      });
      paletteInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.dialog.close();
        }
      });
    }

    paletteModal?.addEventListener('click', e => { if (e.target === paletteModal) this.dialog.close(); });
    localizeControls(this.container);

    // Shortcut Cmd+K / Ctrl+K
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        if (!this.container.closest('.active-view') || this.dialog.active) return;
        e.preventDefault();
        if (paletteModal) {
          this.dialog.open(paletteModal, paletteModal.querySelector('[role=dialog]'), paletteInput);
          paletteInput?.focus();
          this.renderPaletteResults('');
        }
      }
    });
  }

  renderPaletteResults(query) {
    const resBox = this.container.querySelector('#paletteResults');
    if (!resBox) return;

    const q = (query || '').toLowerCase().trim();
    const skills = skillsManager.getAll().map(s => ({ type: 'Skill', name: s.name, action: () => this.openFeature('skills') }));
    const commands = commandsManager.getAll().map(c => ({ type: 'Command', name: c.name, action: () => this.openFeature('commands') }));
    const mcp = mcpManager.getAll().map(m => ({ type: 'MCP', name: m.name, action: () => this.openFeature('mcp') }));
    const agents = agentsManager.getAll().map(a => ({ type: 'Agent', name: a.name, action: () => this.openFeature('agents') }));

    const all = [...commands, ...skills, ...mcp, ...agents];
    const filtered = q ? all.filter(item => item.name.toLowerCase().includes(q)) : all;

    resBox.innerHTML = filtered.map(item => `
      <button type="button" class="palette-item" data-name="${escapeHtml(item.name)}">
        <span class="palette-badge ${item.type.toLowerCase()}">${item.type}</span>
        <span class="palette-name">${escapeHtml(item.name)}</span>
        <span class="palette-return" aria-hidden="true">↵</span>
      </button>
    `).join('') || '<div class="palette-empty" role="status">No matching actions found</div>';

    resBox.querySelectorAll('.palette-item').forEach(el => {
      el.addEventListener('click', () => {
        const name = el.dataset.name;
        const target = all.find(i => i.name === name);
        if (target) {
          const pal = this.container.querySelector('#commandPalette');
          if (pal) this.dialog.close();
          target.action();
        }
      });
    });
  }

  openFeature(action) {
    const overlay = this.container.querySelector('#hubModalOverlay');
    const title = this.container.querySelector('#modalTitle');
    const body = this.container.querySelector('#modalBody');
    if (!overlay || !title || !body) return;

    // Focus is moved after the requested feature has been rendered.

    if (action === 'skills') {
      title.innerText = 'Skills — Local Instruction Records';
      body.innerHTML = this.renderSkillsView();
      this.attachSkillsModalEvents();
    } else if (action === 'mcp') {
      title.innerText = 'MCP — Model Context Protocol Connections';
      body.innerHTML = this.renderMcpView();
      this.attachMcpModalEvents();
    } else if (action === 'commands') {
      title.innerText = 'AI Commands — Simulated Chat Presets';
      body.innerHTML = this.renderCommandsView();
      this.attachCommandsModalEvents();
    } else if (action === 'projects') {
      title.innerText = 'Projects — Local Notes';
      body.innerHTML = this.renderProjectsView();
      this.attachProjectsModalEvents();
    } else if (action === 'automations') {
      title.innerText = 'Automations — Scheduled AI Prompts';
      body.innerHTML = this.renderAutomationsView();
      this.attachAutomationsModalEvents();
    } else if (action === 'agents') {
      title.innerText = 'Agents — Simulated Personas';
      body.innerHTML = this.renderAgentsView();
      this.attachAgentsModalEvents();
    } else if (action === 'screen-awareness') {
      title.innerText = 'Screen Awareness — Visual UI & Code Inspector';
      body.innerHTML = this.renderScreenAwarenessView();
      this.attachScreenAwarenessModalEvents();
    } else if (action === 'extensions') {
      title.innerText = 'AI Extensions — Modular Tools';
      body.innerHTML = this.renderExtensionsView();
    }
    localizeControls(this.container);
    this.dialog.open(overlay, this.container.querySelector('#hubModalWindow'));
  }

  // View Renderers
  renderSkillsView() {
    const list = skillsManager.getAll();
    return `
      <div class="modal-section-inner">
        <p class="modal-desc">Local instruction records only. Selection is saved in this browser; these rules are not used by the SIMULATED chat or any AI inference.</p>
        <div class="item-list-box">
          ${list.map(s => `
            <div class="skill-row ${skillsManager.isActive(s.id) ? 'active' : ''}">
              <div class="skill-info">
                <strong>${escapeHtml(s.name)}</strong>
                <p>${escapeHtml(s.description)}</p>
                <div class="skill-rules-chips">
                  ${s.rules.map(r => `<span class="rule-chip">• ${escapeHtml(r)}</span>`).join('')}
                </div>
              </div>
              <div class="skill-actions">
                <button class="btn-toggle-skill ${skillsManager.isActive(s.id) ? 'active' : ''}" data-id="${s.id}">
                  ${skillsManager.isActive(s.id) ? 'Active ✓' : 'Enable'}
                </button>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="add-new-box">
          <h4>Add New Skill</h4>
          <input type="text" id="newSkillName" placeholder="Skill Name (e.g. Clean Code & Testing)" />
          <textarea id="newSkillRules" placeholder="Rules (one per line)..."></textarea>
          <button class="btn-primary-blue" id="addSkillSubmit">Create Skill</button>
        </div>
      </div>
    `;
  }

  attachSkillsModalEvents() {
    const body = this.container.querySelector('#modalBody');
    body.querySelectorAll('.btn-toggle-skill').forEach(b => {
      b.addEventListener('click', () => {
        skillsManager.toggleActive(b.dataset.id);
        this.openFeature('skills');
      });
    });

    const addBtn = body.querySelector('#addSkillSubmit');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const name = body.querySelector('#newSkillName')?.value.trim();
        const rules = body.querySelector('#newSkillRules')?.value.trim();
        if (name) {
          skillsManager.add({ name, rules: rules ? rules.split('\n') : [] });
          this.openFeature('skills');
        }
      });
    }
  }

  renderMcpView() {
    const servers = mcpManager.getAll();
    return `
      <div class="modal-section-inner">
        <p class="modal-desc"><span class="sim-badge">${SIMULATED_LABEL}</span> Local registry only. No MCP client is implemented, so nothing below is connected and no tools were discovered.</p>
        <div class="item-list-box">
          ${servers.map(m => `
            <div class="mcp-server-row">
              <div class="mcp-info">
                <div class="mcp-badge-line">
                  <span class="mcp-status-dot ${escapeHtml(m.status)}" title="${escapeHtml(m.status)} (never contacted)"></span>
                  <strong>${escapeHtml(m.name)}</strong>
                  <span class="mcp-tools-pill">${m.toolsCount} tools (declared)</span>
                </div>
                <code class="mcp-url">${escapeHtml(m.url)}</code>
                <p>${escapeHtml(m.description)}</p>
              </div>
              <div class="mcp-actions">
                <button class="btn-ping-mcp" data-id="${m.id}">Test Connection</button>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="add-new-box">
          <h4>Add MCP Server (registry only)</h4>
          <input type="text" id="newMcpName" placeholder="Server Name (e.g. Postgres MCP)" />
          <input type="text" id="newMcpUrl" placeholder="Endpoint URL (e.g. http://localhost:8080/sse)" />
          <button class="btn-primary-blue" id="addMcpSubmit">Add to Registry</button>
        </div>
      </div>
    `;
  }

  attachMcpModalEvents() {
    const body = this.container.querySelector('#modalBody');
    body.querySelectorAll('.btn-ping-mcp').forEach(b => {
      b.addEventListener('click', () => {
        // No MCP client exists: nothing is contacted, so say so instead of
        // reporting a connection or a latency.
        b.innerText = getMcpTestResult().label;
        b.style.color = '#FF9F0A';
      });
    });

    const addBtn = body.querySelector('#addMcpSubmit');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const name = body.querySelector('#newMcpName')?.value.trim();
        const url = body.querySelector('#newMcpUrl')?.value.trim();
        if (name && url) {
          mcpManager.add({ name, url, toolsCount: 4 });
          this.openFeature('mcp');
        }
      });
    }
  }

  renderCommandsView() {
    const cmds = commandsManager.getAll();
    return `
      <div class="modal-section-inner">
        <p class="modal-desc">SIMULATED · Send a saved prompt to the keyword-based demo chat. No workspace files or selections are read, and no command is executed.</p>
        <div class="commands-grid">
          ${cmds.map(c => `
            <div class="command-card-item">
              <div class="cmd-top">
                <strong>${escapeHtml(c.name)}</strong>
                <button class="btn-run-cmd" data-id="${c.id}">Send to demo chat</button>
              </div>
              <p>${escapeHtml(c.description)}</p>
              <div class="cmd-prompt-preview">"${escapeHtml(c.prompt)}"</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  attachCommandsModalEvents() {
    const body = this.container.querySelector('#modalBody');
    body.querySelectorAll('.btn-run-cmd').forEach(b => {
      b.addEventListener('click', () => {
        const cmd = commandsManager.get(b.dataset.id);
        if (cmd) {
          this.dialog.close();
          this.onSelectFeature('chat', cmd.prompt);
        }
      });
    });
  }

  renderProjectsView() {
    const projects = projectsManager.getAll();
    return `
      <div class="modal-section-inner">
        <p class="modal-desc">Browser-local project notes only. No shared chat memory, file indexing, retrieval or AI inference integration is implemented.</p>
        <div class="item-list-box">
          ${projects.map(p => `
            <div class="project-card-item">
              <div class="proj-header">
                <strong>${escapeHtml(p.name)}</strong>
                <span class="proj-time">${escapeHtml(p.updatedAt)}</span>
              </div>
              <p>${escapeHtml(p.description)}</p>
              <div class="proj-memory-box">
                <span class="memory-label">Local notes (not used by chat):</span>
                <p>${escapeHtml(p.memory)}</p>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  attachProjectsModalEvents() {}

  renderAutomationsView() {
    const automations = automationsManager.getAll();
    return `
      <div class="modal-section-inner">
        <p class="modal-desc"><span class="sim-badge">${SIMULATED_LABEL}</span> Prompt templates only. There is no scheduler or agent runtime: nothing runs automatically, and the button below only records a simulated marker.</p>
        <div class="item-list-box">
          ${automations.map(a => `
            <div class="automation-card-item">
              <div class="auto-top">
                <div>
                  <strong>${escapeHtml(a.name)}</strong>
                  <span class="auto-cron">🕒 ${escapeHtml(a.schedule)}</span>
                </div>
                <button class="btn-auto-trigger" data-id="${a.id}">Simulate Run</button>
              </div>
              <p class="auto-prompt">Prompt: "${escapeHtml(a.prompt)}"</p>
              <div class="auto-footer">
                <span>Last run: ${escapeHtml(a.lastRun)}</span>
                <span class="status-badge ${a.active ? 'active' : 'paused'}">${a.active ? 'Enabled (not scheduled)' : 'Paused'}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  attachAutomationsModalEvents() {
    const body = this.container.querySelector('#modalBody');
    body.querySelectorAll('.btn-auto-trigger').forEach(b => {
      b.addEventListener('click', () => {
        automationsManager.runNow(b.dataset.id);
        b.innerText = 'Simulated (nothing ran)';
        const lastRun = b.closest('.automation-card-item')?.querySelector('.auto-footer span');
        if (lastRun) lastRun.textContent = `Last run: ${automationsManager.get(b.dataset.id).lastRun}`;
      });
    });
  }

  renderAgentsView() {
    const agents = agentsManager.getAll();
    const active = agentsManager.getActive();
    return `
      <div class="modal-section-inner">
        <p class="modal-desc">SIMULATED · Selecting a persona changes the demo name only. Saved system prompts are not sent to a provider; no independent or autonomous agent runtime is connected.</p>
        <div class="item-list-box">
          ${agents.map(a => `
            <div class="agent-persona-card ${a.id === active.id ? 'active-persona' : ''}">
              <div class="persona-header">
                <div>
                  <strong>${escapeHtml(a.name)}</strong>
                  <span class="persona-role">${escapeHtml(a.role)}</span>
                </div>
                <button class="btn-select-persona ${a.id === active.id ? 'selected' : ''}" data-id="${a.id}">
                  ${a.id === active.id ? 'Selected demo ✓' : 'Select'}
                </button>
              </div>
              <p class="persona-prompt"><span class="sim-badge">SIMULATED · unused prompt</span> "${escapeHtml(a.systemPrompt)}"</p>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  attachAgentsModalEvents() {
    const body = this.container.querySelector('#modalBody');
    body.querySelectorAll('.btn-select-persona').forEach(b => {
      b.addEventListener('click', () => {
        agentsManager.setActive(b.dataset.id);
        this.openFeature('agents');
      });
    });
  }

  renderScreenAwarenessView() {
    return `
      <div class="modal-section-inner">
        <p class="modal-desc"><span class="sim-badge">${SIMULATED_LABEL}</span> Not implemented: no screen is captured and no vision provider is configured.</p>
        <div class="screen-awareness-box">
          <div class="screen-preview-mock">
            <div class="scan-line-anim"></div>
            <p>Viewport: <strong>${typeof window !== 'undefined' ? `${window.innerWidth} x ${window.innerHeight} px` : 'unknown'}</strong></p>
          </div>
          <button class="btn-primary-blue" id="btnAnalyzeViewport">Run Analysis (simulated)</button>
          <div class="screen-analysis-result" id="screenAnalysisResult" style="display:none;"></div>
        </div>
      </div>
    `;
  }

  attachScreenAwarenessModalEvents() {
    const body = this.container.querySelector('#modalBody');
    const analyzeBtn = body.querySelector('#btnAnalyzeViewport');
    const resultBox = body.querySelector('#screenAnalysisResult');

    if (analyzeBtn && resultBox) {
      analyzeBtn.addEventListener('click', () => {
        const analysis = screenAwarenessManager.analyzeScreen(null);
        resultBox.style.display = 'block';
        resultBox.innerHTML = `
          <h4>Analysis not performed</h4>
          <p class="ai-screen-insight">${escapeHtml(analysis.aiFeedback)}</p>
        `;
      });
    }
  }

  renderExtensionsView() {
    return `
      <div class="modal-section-inner">
        <p class="modal-desc"><span class="sim-badge">${SIMULATED_LABEL}</span> Planned integrations only. No extension system exists; none of these is installed or enabled.</p>
        <div class="item-list-box">
          <div class="ext-row">
            <strong>GitHub CLI & Pull Requests</strong>
            <span class="status-badge paused">Not installed</span>
          </div>
          <div class="ext-row">
            <strong>Figma Design Token Exporter</strong>
            <span class="status-badge paused">Not installed</span>
          </div>
          <div class="ext-row">
            <strong>Node.js Interactive REPL</strong>
            <span class="status-badge paused">Not installed</span>
          </div>
        </div>
      </div>
    `;
  }
}

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
