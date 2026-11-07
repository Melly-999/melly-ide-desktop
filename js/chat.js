import { AIPanel } from './ai/panel.js';
import { validateProposal } from './ai/contracts.js';
import { lineDiff } from './workspace/model.js';
import { localizeControls } from './ui-language.js';
import { skillsManager } from './modules/skills.js';
import { agentsManager } from './modules/agents.js';
import { projectsManager } from './modules/projects.js';
import { SIMULATED_LABEL, simulatedReplyHeader } from './modules/simulation.js';

export class AgentChat {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.onApplyCode = options.onApplyCode || (() => {});
    this.getFileSnapshot = options.getFileSnapshot || (() => null);
    this.messages = [];
    this.isExpandedCode = false;
    this.pendingReview = null;
    this.reviewNotice = '';
  }

  init() {
    if (!this.container) return;
    this.loadDefaultDialogue();
    this.render();
    this.attachEvents();
  }

  loadDefaultDialogue() {
    // Seed the local simulated conversation preview.
    this.messages = [
      {
        id: 'msg-1',
        sender: 'ai',
        hasCodeCard: true,
        targetFilename: 'NetworkService.swift',
        codeLinesCount: 22,
        codeSnippetShort: `subscript(safe i: Int) -> Element {
}
[1, 2, 3][safe: 10] // -> nil, not a crash

// Retry logic
func retry<T>(_ times: Int, _ work: () throws -> T) rethrows -> T {
    var lastError: Error?
    for _ in 0..<times {
        do { return try work() } catch {`,
        codeSnippetFull: `extension Collection {
    subscript(safe i: Index) -> Element? {
        return indices.contains(i) ? self[i] : nil
    }
}

// Example usage:
// [1, 2, 3][safe: 10] // -> nil, not a crash

// Retry logic with backoff
func retry<T>(
    _ times: Int,
    delay: TimeInterval = 0.5,
    _ work: () throws -> T
) rethrows -> T {
    var lastError: Error?
    for attempt in 0..<times {
        do {
            return try work()
        } catch {
            lastError = error
            if attempt < times - 1 {
                Thread.sleep(forTimeInterval: delay)
            }
        }
    }
    throw lastError!
}`,
        text: `${simulatedReplyHeader('Assistant')}\n\nSwift's beauty comes from its **type safety**, **protocol-oriented design**, **expressive pattern matching**, and modern **concurrency**. Want me to go deeper on any of these — SwiftUI, Combine, or something else? 🚀`
      }
    ];
  }

  connectAI(controller,app) {
    this.ai=controller;this.aiApp=app;
    this.aiUnsubscribe?.();this.aiUnsubscribe=controller.subscribe(()=>this.renderAndAttach());
  }
  receiveAIProposal(raw,snapshots,mode,principal) {
    const proposal=validateProposal(JSON.stringify(raw),snapshots),base=snapshots.find(s=>s.path===proposal.path),current=this.getFileSnapshot(proposal.path);
    if(!current || current.revision!==base.revision || current.content!==base.content || current.workspaceToken!==base.workspaceToken || current.workspaceId!==base.workspaceId)throw new Error('UNBOUND_PROPOSAL');
    if(this.pendingReview)throw new Error('REVIEW_ALREADY_PENDING');
    this.pendingReview={proposalId:crypto.randomUUID(),targetFilename:proposal.path,baseContent:base.content,baseRevision:base.revision,proposedContent:proposal.content,dirty:current.dirty,status:'pending',...(base.workspaceId?{workspaceId:base.workspaceId,workspaceToken:base.workspaceToken}:{}),sourceMode:mode,aiPrincipal:principal,explanation:proposal.explanation,diagnostics:proposal.diagnostics};
    this.reviewNotice='Proposed change only. Tests: Not run.';this.renderAndAttach();
  }
  render() {
    this.aiPanel?.dispose();
    const activeAgent = agentsManager.getActive();

    this.container.innerHTML = `
      <div class="agent-chat-shell" data-ai-review="${this.pendingReview?.sourceMode ? 'true' : 'false'}" ${this.ai?'data-live-ai="true"':''}>
        ${this.ai?'<div data-ai-panel></div>':''}
        <div class="chat-agent-banner">
          <div class="agent-avatar-badge">
            <span class="agent-pulse"></span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2 2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"></path><rect x="4" y="8" width="16" height="12" rx="2"></rect><path d="M9 13v2"></path><path d="M15 13v2"></path></svg>
          </div>
          <div class="agent-banner-info">
            <span class="agent-banner-name">${escapeHtml(activeAgent ? activeAgent.name : 'Demo persona')}</span>
            <span class="agent-banner-sub">SIMULATED · ${escapeHtml(activeAgent ? activeAgent.role : 'Demo assistant')}</span>
          </div>
          <button class="clear-chat-btn" id="clearChatBtn" title="Reset chat">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"></path><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        </div>

        <div class="chat-scroll-area" id="chatScrollArea">
          ${this.messages.map(m => this.renderMessage(m)).join('')}
        </div>

        ${this.renderReviewPanel()}

        ${this.reviewNotice ? `<div class="review-notice" role="status">${escapeHtml(this.reviewNotice)}</div>` : ''}

        <!-- Chat input bar: + | prompt | mic | send -->
        <div class="chat-input-bar">
          <button class="chat-btn-plus" id="chatAttachBtn" title="Add file or context">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          </button>
          
          <div class="chat-input-wrapper">
            <input 
              type="text" 
              class="chat-text-input" 
              id="chatTextInput" 
              placeholder="Ask anything..." 
              autocomplete="off"
            />
          </div>

          <button class="chat-btn-mic" id="chatMicBtn" title="Voice dictation (SIMULATED: inserts a fixed sentence, records no audio)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
          </button>

          <button class="chat-btn-send" id="chatSendBtn" title="Send prompt">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4l-8 8h5v8h6v-8h5z"></path></svg>
          </button>
        </div>
      </div>
    `;
  }

  renderMessage(msg) {
    if (msg.sender === 'user') {
      return `
        <div class="chat-bubble-row user-row">
          <div class="chat-bubble user-bubble">
            <p>${escapeHtml(msg.text)}</p>
          </div>
        </div>
      `;
    }

    const codeToDisplay = this.isExpandedCode ? msg.codeSnippetFull : msg.codeSnippetShort;

    return `
      <div class="chat-bubble-row ai-row">
        <div class="chat-bubble ai-bubble">
          ${msg.hasCodeCard ? `
            <!-- Code proposal preview -->
            <div class="chat-code-card">
              <pre class="chat-code-block"><code>${escapeHtml(codeToDisplay)}</code></pre>
              <button class="btn-toggle-code">
                ${this.isExpandedCode ? 'Show condensed snippet' : `Show all ${msg.codeLinesCount || 22} lines`}
              </button>
            </div>
          ` : ''}

          <div class="chat-text-content">
            ${formatMarkdown(msg.text)}
          </div>

          <div class="chat-action-footer">
            <button class="action-icon-btn copy-msg-btn" title="Copy response" data-text="${escapeAttr(msg.text)}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
            <span class="ai-badge-chip">AI · ${SIMULATED_LABEL}</span>
            ${msg.codeSnippetFull ? `
              <span class="proposal-target">Target: ${escapeHtml(msg.targetFilename || 'unavailable')}</span>
              <button class="apply-to-editor-btn" data-message-id="${escapeAttr(msg.id)}">
                Review Change
              </button>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }

  renderReviewPanel() {
    const review = this.pendingReview;
    if (!review) return '';

    const isStale = review.status === 'stale';
    const warning = review.dirty
      ? `Warning: ${review.targetFilename} has unsaved in-memory changes. Approval will replace the complete currently displayed buffer shown below.`
      : `Approval will replace the complete ${review.targetFilename} in-memory buffer shown below.`;

    return `
      <section class="change-review-panel" role="region" aria-labelledby="changeReviewTitle" aria-describedby="changeReviewWarning">
        <div class="change-review-heading">
          <div>
            <span class="ai-badge-chip">AI · ${review.sourceMode ? escapeHtml(review.sourceMode) : SIMULATED_LABEL}</span>
            <h3 id="changeReviewTitle" tabindex="-1">Review proposed change</h3>
          </div>
          <strong class="review-target">Target: ${escapeHtml(review.targetFilename)}</strong>
        </div>
        <p id="changeReviewWarning" class="review-warning${review.dirty ? ' has-unsaved' : ''}">${escapeHtml(warning)}</p>
        ${review.sourceMode ? `<p>${escapeHtml(review.sourceMode==='mock'?'TEST ADAPTER — NOT LIVE PROVIDER':'OpenRouter proposal')} · ${escapeHtml(review.explanation)} · Tests: Not run.</p><pre class="ai01-diff" tabindex="0" aria-label="Proposed source diff">${escapeHtml(lineDiff(review.baseContent,review.proposedContent,review.targetFilename))}</pre>` : ''}
        ${isStale ? `
          <p class="review-error" role="alert">Stale review rejected: the target buffer changed after this preview was generated. Cancel this review and create a new preview.</p>
        ` : ''}
        <div class="review-comparison" aria-label="Complete before and after comparison">
          <div class="review-version review-current">
            <h4>Current content${review.dirty ? ' · UNSAVED' : ''}</h4>
            <pre tabindex="0" aria-label="Complete current content"><code>${escapeHtml(review.baseContent)}</code></pre>
          </div>
          <div class="review-version review-proposed">
            <h4>Proposed content · ${review.sourceMode ? escapeHtml(review.sourceMode) : SIMULATED_LABEL}</h4>
            <pre tabindex="0" aria-label="Complete proposed content"><code>${escapeHtml(review.proposedContent)}</code></pre>
          </div>
        </div>
        <div class="review-controls">
          <button class="review-btn review-approve" id="reviewApproveBtn" ${isStale ? 'disabled' : ''}>Approve</button>
          <button class="review-btn review-reject" id="reviewRejectBtn">Reject</button>
          <button class="review-btn review-cancel" id="reviewCancelBtn">Cancel</button>
        </div>
      </section>
    `;
  }

  startReview(messageId) {
    const message = this.messages.find(item => item.id === messageId);
    if (!message?.codeSnippetFull || !message.targetFilename) {
      this.pendingReview = null;
      this.reviewNotice = 'Review unavailable: this proposal has no valid target file.';
      this.renderAndAttach();
      return;
    }

    const snapshot = this.getFileSnapshot(message.targetFilename);
    if (!snapshot || snapshot.filename !== message.targetFilename) {
      this.pendingReview = null;
      this.reviewNotice = `Review unavailable: ${message.targetFilename} is not an editor file.`;
      this.renderAndAttach();
      return;
    }

    this.reviewOriginId = messageId;
    this.pendingReview = {
      proposalId: message.id,
      targetFilename: message.targetFilename,
      baseContent: snapshot.content,
      baseRevision: snapshot.revision,
      ...(snapshot.workspaceId ? {workspaceId: snapshot.workspaceId, workspaceToken: snapshot.workspaceToken} : {}),
      proposedContent: message.codeSnippetFull,
      dirty: snapshot.dirty,
      status: 'pending'
    };
    this.reviewNotice = '';
    this.renderAndAttach();
  }

  approveReview() {
    if (!this.pendingReview || this.pendingReview.status !== 'pending') return;

    if(this.pendingReview.sourceMode && (!this.ai?.ready() || this.pendingReview.aiPrincipal!==this.ai.authPrincipal)){this.pendingReview.status='stale';this.renderAndAttach();return;}
    const result = this.onApplyCode({ ...this.pendingReview });
    if (result?.applied) {
      const filename = this.pendingReview.targetFilename;
      this.pendingReview = null;
      this.reviewNotice = `Approved change applied to ${filename}. Local autosave may now persist it; it was not executed, committed or synchronized to GitHub.`;
    } else if (result?.reason === 'stale_review') {
      this.pendingReview.status = 'stale';
    } else {
      this.pendingReview = null;
      this.reviewNotice = `Change not applied (${result?.reason || 'guard rejected the request'}).`;
    }
    this.renderAndAttach();
  }

  rejectReview() {
    if (!this.pendingReview) return;
    const filename = this.pendingReview.targetFilename;
    this.pendingReview = null;
    this.reviewNotice = `Rejected proposal for ${filename}. No editor content changed.`;
    this.renderAndAttach();
  }

  cancelReview() {
    if (!this.pendingReview) return;
    const filename = this.pendingReview.targetFilename;
    this.pendingReview = null;
    this.reviewNotice = `Canceled review for ${filename}. No editor content changed.`;
    this.renderAndAttach();
  }

  renderAndAttach() {
    const hadReviewFocus = !!this.container?.querySelector('.change-review-panel')?.contains(globalThis.document?.activeElement);
    this.render();
    this.attachEvents();
    localizeControls(this.container);
    if (this.pendingReview) {
      const target = this.pendingReview.status === 'stale' ? '#reviewCancelBtn' : '#changeReviewTitle';
      this.container?.querySelector(target)?.focus();
    } else if (hadReviewFocus) {
      const trigger = [...(this.container?.querySelectorAll('.apply-to-editor-btn') || [])]
        .find(button => button.dataset.messageId === this.reviewOriginId);
      (trigger || this.container?.querySelector('#chatTextInput'))?.focus();
    }
  }

  attachEvents() {
    localizeControls(this.container);
    const input = this.container.querySelector('#chatTextInput');
    const sendBtn = this.container.querySelector('#chatSendBtn');
    const micBtn = this.container.querySelector('#chatMicBtn');
    const attachBtn = this.container.querySelector('#chatAttachBtn');
    const clearBtn = this.container.querySelector('#clearChatBtn');
    const toggleLinesBtns = this.container.querySelectorAll('.btn-toggle-code');
    const applyBtns = this.container.querySelectorAll('.apply-to-editor-btn');
    const copyBtns = this.container.querySelectorAll('.copy-msg-btn');
    const approveBtn = this.container.querySelector('#reviewApproveBtn');
    const rejectBtn = this.container.querySelector('#reviewRejectBtn');
    const cancelBtn = this.container.querySelector('#reviewCancelBtn');

    if (!this.ai && input && sendBtn) {
      const handleSend = () => {
        const val = input.value.trim();
        if (!val) return;
        this.sendMessage(val);
        input.value = '';
      };

      sendBtn.addEventListener('click', handleSend);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleSend();
      });
    }

    if (!this.ai && micBtn) {
      micBtn.addEventListener('click', () => {
        micBtn.classList.toggle('recording');
        if (micBtn.classList.contains('recording')) {
          input.value = 'Explain the retry logic and add SwiftUI demo view';
          setTimeout(() => {
            micBtn.classList.remove('recording');
            if (sendBtn) sendBtn.click();
          }, 1200);
        }
      });
    }

    if (!this.ai && attachBtn) {
      attachBtn.addEventListener('click', () => {
        const files = ['main.js', 'NetworkService.swift'];
        const chosen = prompt(`Attach active file to context:\nAvailable: ${files.join(', ')}`, 'NetworkService.swift');
        if (chosen) {
          if (input) input.value = `Review and optimize ${chosen} with strict safety checks.`;
        }
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.pendingReview = null;
        this.reviewNotice = '';
        this.loadDefaultDialogue();
        this.renderAndAttach();
      });
    }

    if(this.ai) {
      this.aiPanel=new AIPanel(this.container.querySelector('[data-ai-panel]'),this.ai,this.aiApp,{input,submit:sendBtn,onGuest:()=>this.aiApp.shell.configure('ai')});
      micBtn.disabled=true;micBtn.title='Voice not connected; no recording';
      attachBtn.onclick=()=>{this.aiPanel.filesOpen=true;this.aiPanel.render();this.container.querySelector('[data-ai-context]')?.focus();};
      for(const [el,label]of[[input,'AI prompt / Wiadomość AI'],[sendBtn,'Preview request / Podgląd'],[attachBtn,'Choose explicit file context / Wybierz pliki']])el.setAttribute('aria-label',label);
    }
    toggleLinesBtns.forEach(toggleLinesBtn => {
      toggleLinesBtn.addEventListener('click', () => {
        this.isExpandedCode = !this.isExpandedCode;
        this.renderAndAttach();
      });
    });

    applyBtns.forEach(applyBtn => {
      applyBtn.addEventListener('click', () => {
        this.startReview(applyBtn.dataset.messageId);
      });
    });

    approveBtn?.addEventListener('click', () => this.approveReview());
    rejectBtn?.addEventListener('click', () => this.rejectReview());
    cancelBtn?.addEventListener('click', () => this.cancelReview());

    copyBtns.forEach(b => {
      b.addEventListener('click', () => {
        const t = b.dataset.text;
        if (t) {
          navigator.clipboard?.writeText(t);
          b.style.color = '#30D158';
          setTimeout(() => { b.style.color = ''; }, 1200);
        }
      });
    });
  }

  sendMessage(text,{demo=false}={}) {
    if(this.ai && !demo){this.ai.saveDraft(text);this.renderAndAttach();this.container.querySelector('#chatTextInput')?.focus();return;}
    this.messages.push({
      id: 'msg-' + Date.now(),
      sender: 'user',
      text
    });

    this.render();
    this.attachEvents();
    this.scrollToBottom();

    // Generate intelligent AI reply based on active Skills, MCP, and Agents
    setTimeout(() => {
      this.generateAiReply(text);
    }, 600);
  }

  generateAiReply(userPrompt) {
    const activeSkillText = skillsManager.getActiveInstructions();
    const activeAgent = agentsManager.getActive();
    const lower = userPrompt.toLowerCase();

    let replyText = '';
    let codeFull = null;
    let targetFilename = null;

    if (lower.includes('swift') || lower.includes('retry') || lower.includes('subscript')) {
      replyText = `${simulatedReplyHeader(activeAgent.name)}\n\nSample Swift snippet chosen because your prompt mentioned swift, retry or subscript. Nothing was reviewed, compiled or tested.`;
      codeFull = `// Enhanced Swift Retry with async/await
func retryAsync<T>(
    attempts: Int = 3,
    delay: Double = 0.5,
    operation: @Sendable () async throws -> T
) async throws -> T {
    for i in 1...attempts {
        do { return try await operation() }
        catch {
            if i == attempts { throw error }
            try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }
    fatalError("Unreachable")
}`;
      targetFilename = 'NetworkService.swift';
    } else if (lower.includes('js') || lower.includes('animation') || lower.includes('main.js') || lower.includes('loop')) {
      replyText = `${simulatedReplyHeader(activeAgent.name)}\n\nSample JavaScript snippet chosen because your prompt mentioned js, animation or loop. Nothing was run or tested, and no performance claim is made.`;
      codeFull = `export const smoothStep = (time, lastTime, speed) => {
  const delta = (time - lastTime) / 1000;
  return (speed * delta) % 360;
};`;
      targetFilename = 'main.js';
    } else {
      replyText = `${simulatedReplyHeader(activeAgent.name)}\n\nNo keyword matched, so no sample snippet is shown. Skills, project memory and MCP servers were not consulted, and no code was checked.`;
    }

    this.messages.push({
      id: 'msg-' + Date.now(),
      sender: 'ai',
      hasCodeCard: !!codeFull,
      codeLinesCount: codeFull ? codeFull.split('\n').length : 0,
      codeSnippetShort: codeFull ? codeFull.split('\n').slice(0, 7).join('\n') : '',
      codeSnippetFull: codeFull,
      targetFilename,
      text: replyText
    });

    this.render();
    this.attachEvents();
    this.scrollToBottom();
  }

  scrollToBottom() {
    const area = this.container.querySelector('#chatScrollArea');
    if (area) {
      area.scrollTop = area.scrollHeight;
    }
  }
}

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return escapeHtml(str)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMarkdown(text) {
  if (!text) return '';
  let formatted = escapeHtml(text);
  // bold **text**
  formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // code `code`
  formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
  // newlines
  formatted = formatted.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>');
  return `<p>${formatted}</p>`;
}
