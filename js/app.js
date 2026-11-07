import { LocalFolder } from './local-folder.js';
import { Diagnostics, BUILD } from './diagnostics.js';
import { DevCenter } from './devcenter/ui.js';
import { WorkspaceCommands } from './workspace/commands.js';
import { AIController } from './ai/controller.js';
import { AuthSession } from './auth/session.js';
import { PUBLIC_AUTH_CONFIG } from './auth/public-config.js';
import { AccountScreen } from './auth/account.js';
import { PremiumShell } from './dashboard.js';
import { RealWorkspace } from './workspace/ui.js';
import { WorkspaceBackupUI } from './backup-ui.js';
import { OfflineShellStatus } from './offline.js';
import { localizeControls } from './ui-language.js';
import { OnboardingCarousel } from './onboarding.js';
import { MobileCodeEditor } from './editor.js';
import { AgentChat } from './chat.js';
import { MellyHub } from './hub.js';

class AppController {
  constructor() {
    this.currentView = 'onboarding'; // 'onboarding' | 'hub' | 'studio'
    this.currentLang = 'en'; // 'en' | 'pl'
    this.editor = null;
    this.chat = null;
    this.hub = null;
    this.onboarding = null;
  }

  init() {
    this.diagnostics = new Diagnostics({build: BUILD});
    this.diagnostics.record('app', 'START', {source: globalThis.__TAURI__?.core?.invoke ? 'desktop' : 'browser'});
    this.initComponents();
    this.shell = new PremiumShell(this);
    this.shell.init();
    this.localFolder = new LocalFolder(this);
    this.localFolder.init();
    this.devCenter = new DevCenter(this);
    this.devCenter.init();
    this.commands = new WorkspaceCommands(this);
    this.commands.init();
    this.auth = new AuthSession(PUBLIC_AUTH_CONFIG, {approvedDevUrl: PUBLIC_AUTH_CONFIG.convexUrl});
    this.account = new AccountScreen(this,this.auth);
    this.account.init();
    this.ai = new AIController({getAuth:()=>this.auth,getScope:()=>this.editor.workspaceId || 'legacy',onProposal:(proposal,snapshots,mode)=>{
      this.chat.receiveAIProposal(proposal,snapshots,mode,this.auth.state.profile?.principal);
      this.switchView('review');
    }});
    this.chat.connectAI(this.ai,this);
    this.shell.assistant.connectAI(this.ai,this);
    this.ai.subscribe(()=>{
      if(this.chat.pendingReview?.sourceMode && this.chat.pendingReview.aiPrincipal!==this.ai.authPrincipal){this.chat.pendingReview=null;this.chat.reviewNotice='AI review cleared after account change.';this.chat.renderAndAttach();}
      this.shell.refreshAI?.();
    });
    window.addEventListener('workspace-changed',()=>{if(this.ai.scope!==this.ai.getScope())this.ai.scopeChanged();});
    void this.auth.start();
    const measureHeader = () => document.documentElement.style.setProperty('--app-header-height', document.querySelector('.app-master-header').getBoundingClientRect().height + 'px');
    this.headerObserver = new ResizeObserver(measureHeader);
    this.headerObserver.observe(document.querySelector('.app-master-header'));
    measureHeader();
    this.attachNavEvents();
    const problemReport = document.getElementById('problemReport');
    document.getElementById('problemReportTemplate').value = [
      'Melly IDE ' + BUILD.version, '', 'What happened?', '', 'Steps to reproduce:', '', 'What did you expect?'
    ].join('\n');
    problemReport.addEventListener('keydown', event => {
      if (event.key === 'Escape') event.stopPropagation();
    });
    document.getElementById('openProblemReport').addEventListener('click', () => problemReport.showModal());
    this.switchView(this.shell.initialView());
    this.applyLanguage(this.currentLang);
    this.offlineShell = new OfflineShellStatus(document.getElementById('offlineShellStatus'));
    void this.offlineShell.start();
  }

  initComponents() {
    // 1. Onboarding Carousel
    this.onboarding = new OnboardingCarousel('onboardingContainer', {
      onFinish: () => this.switchView('hub')
    });
    this.onboarding.init();

    // 2. Melly IDE workspace
    this.hub = new MellyHub('hubContainer', {
      onSelectFeature: (target, prompt) => {
        if (target === 'chat') {
          this.switchView('studio');
          if (prompt && this.chat) {
            this.chat.reviewNotice = 'SIMULATED · Preset sent to demo chat. No command was executed.';
            this.chat.renderAndAttach();
            document.getElementById('chatTextInput')?.focus();
            setTimeout(() => {
              this.chat.sendMessage(prompt,{demo:true});
            }, 300);
          }
        }
      }
    });
    this.hub.init();

    // 3. Mobile Code Editor
    this.editor = new MobileCodeEditor('editorContainer');
    this.editor.init();

    // 4. AI Agent Chat
    this.chat = new AgentChat('chatContainer', {
      getFileSnapshot: filename => this.editor?.getFileSnapshot(filename) || null,
      onApplyCode: review => this.editor?.applyReviewedChange(review)
        || { applied: false, reason: 'editor_unavailable' }
    });
    this.chat.init();
    this.backup = new WorkspaceBackupUI(document.getElementById('hubContainer'), this.editor, {isActive: () => !this.workspace || this.editor === this.workspace.legacy});
    this.backup.init();
    this.workspace = new RealWorkspace(this);
    void this.workspace.init();

    // Custom events
    window.addEventListener('ai-lookup-request', (e) => {
      const term = e.detail?.text || '';
      this.switchView('studio');
      setTimeout(() => {
        this.chat.sendMessage(`Explain and check best practices for: "${term}"`);
      }, 300);
    });
  }

  switchView(viewName) {
    if(this.ai && this.currentView!==viewName && !['review','studio','code','assistant'].includes(viewName))this.ai.scopeChanged();
    viewName = this.shell?.prepare(viewName) || viewName;
    if (viewName !== 'account') this.account?.hide();
    this.currentView = viewName;
    const views = {
      dashboard: document.getElementById('viewDashboard'),
      tasks: document.getElementById('viewTasks'),
      review: document.getElementById('viewReview'),
      assistant: document.getElementById('viewAssistant'),
      account: document.getElementById('viewAccount'),
      devcenter: document.getElementById('viewDevCenter'),
      onboarding: document.getElementById('viewOnboarding'),
      hub: document.getElementById('viewHub'),
      studio: document.getElementById('viewStudio')
    };

    Object.entries(views).forEach(([name, el]) => {
      if (el) {
        if (name === viewName) {
          el.hidden = false;
          el.style.display = 'block';
          el.classList.add('active-view');
        } else {
          el.hidden = true;
          el.style.display = 'none';
          el.classList.remove('active-view');
        }
      }
    });

    // Update nav buttons
    document.querySelectorAll('.app-nav-btn[data-view]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    this.shell?.afterNavigate();
  }

  attachNavEvents() {
    const navButtons = document.querySelectorAll('.app-nav-btn[data-view]');
    navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        this.switchView(btn.dataset.view);
        document.getElementById('moreMenu').open = false;
      });
    });

    // Viewport frame mode toggle (Desktop wide vs Mobile phone frame)
    const viewportToggle = document.getElementById('toggleDeviceFrame');
    const appWrapper = document.getElementById('appWrapper');
    if (viewportToggle && appWrapper) {
      viewportToggle.addEventListener('click', () => {
        appWrapper.classList.toggle('mobile-frame-mode');
        const isFrame = appWrapper.classList.contains('mobile-frame-mode');
        viewportToggle.setAttribute('aria-pressed', String(isFrame));
        this.applyLanguage(this.currentLang);
      });
    }

    // Language switcher
    const langBtn = document.getElementById('toggleLanguage');
    if (langBtn) {
      langBtn.addEventListener('click', () => {
        this.currentLang = this.currentLang === 'en' ? 'pl' : 'en';
        langBtn.innerText = this.currentLang.toUpperCase();
        this.applyLanguage(this.currentLang);
      });
    }
  }

  applyLanguage(lang) {
    document.documentElement.lang = lang;
    this.shell?.language(lang);
    localizeControls(document, lang);
    this.editor?.updateSaveStatus();
    const translations = {
      en: {
        navOnboarding: 'Help',
        navHub: 'Local tools & backup',
        navStudio: 'Demo workbench · simulated'
      },
      pl: {
        navOnboarding: 'Pomoc',
        navHub: 'Lokalne narzędzia i kopie',
        navStudio: 'Warsztat demo · symulacja'
      }
    };
    const t = translations[lang] || translations.en;
    const bOnb = document.querySelector('.app-nav-btn[data-view="onboarding"]');
    const bHub = document.querySelector('.app-nav-btn[data-view="hub"]');
    const bStu = document.querySelector('.app-nav-btn[data-view="studio"]');
    if (bOnb) bOnb.innerText = t.navOnboarding;
    if (bHub) bHub.innerText = t.navHub;
    if (bStu) bStu.innerText = t.navStudio;
  }
}

// Bootstrap on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  const app = new AppController();
  app.init();
  window.AntigravityApp = app;
});
