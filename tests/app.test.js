import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initialFiles } from '../js/data/samples.js';
import { skillsManager } from '../js/modules/skills.js';
import { projectsManager } from '../js/modules/projects.js';
import { mcpManager, McpManager } from '../js/modules/mcp.js';
import { automationsManager, AutomationsManager } from '../js/modules/automations.js';
import {
  getRunResult,
  getMcpTestResult,
  EXECUTION_UNAVAILABLE_MESSAGE
} from '../js/modules/simulation.js';
import { commandsManager } from '../js/modules/commands.js';
import { screenAwarenessManager } from '../js/modules/screen-awareness.js';
import { MobileCodeEditor } from '../js/editor.js';
import { AgentChat } from '../js/chat.js';
import { FILE_STORE_DB_NAME } from '../js/storage/file-store.js';

test('Initial Sample Files Integrity', () => {
  assert.ok(initialFiles['main.js'], 'main.js must exist');
  assert.ok(initialFiles['main.js'].includes('requestAnimationFrame'), 'main.js should contain animation loop');
  assert.ok(initialFiles['NetworkService.swift'], 'NetworkService.swift must exist');
  assert.ok(initialFiles['NetworkService.swift'].includes('subscript(safe'), 'Swift file should define safe subscript');
});

test('SkillsManager - Reusable Instructions', () => {
  const initialCount = skillsManager.getAll().length;
  assert.ok(initialCount > 0, 'Should load default skills');

  const newSkill = skillsManager.add({
    name: 'Unit Test Skill',
    rules: ['Always assert return values', 'Mock network calls']
  });

  assert.equal(newSkill.name, 'Unit Test Skill');
  assert.equal(skillsManager.getAll().length, initialCount + 1);

  const instructions = skillsManager.getActiveInstructions();
  assert.ok(instructions.includes('Unit Test Skill'));
  assert.ok(instructions.includes('Mock network calls'));
});

test('ProjectsManager - Shared Memory', () => {
  const proj = projectsManager.add({
    name: 'Test Project',
    description: 'A test project for unit assertions',
    memory: 'Use strict TypeScript types.'
  });

  assert.equal(proj.name, 'Test Project');
  assert.equal(proj.memory, 'Use strict TypeScript types.');

  const updated = projectsManager.updateMemory(proj.id, 'Updated memory context.');
  assert.equal(updated.memory, 'Updated memory context.');
});

test('McpManager - Model Context Protocol', () => {
  const servers = mcpManager.getAll();
  assert.ok(servers.length >= 4, 'Should load default MCP servers');
  
  const githubMcp = servers.find(s => s.name.includes('GitHub'));
  assert.ok(githubMcp, 'GitHub MCP server must be present');
  // No MCP client exists, so nothing may ever be reported as connected.
  assert.equal(githubMcp.status, 'unverified');

  const custom = mcpManager.add({
    name: 'Postgres MCP',
    url: 'http://localhost:5432/mcp'
  });
  assert.equal(custom.status, 'unverified');

  const toggled = mcpManager.toggleStatus(custom.id);
  assert.equal(toggled.status, 'disabled');
});

test('AutomationsManager - Scheduled Prompts', () => {
  const autos = automationsManager.getAll();
  assert.ok(autos.length >= 3, 'Should have preset automations');

  const first = autos[0];
  const execution = automationsManager.runNow(first.id);
  assert.ok(execution, 'Execution result should not be null');
  // There is no scheduler or runner: a "run" must never claim execution.
  assert.equal(execution.executed, false);
  assert.equal(execution.status, 'simulated');
  assert.ok(execution.output.includes('SIMULATED'));
  assert.ok(!/executed successfully|errors found/i.test(execution.output));
  assert.ok(automationsManager.get(first.id).lastRun.startsWith('Simulated'));
});

test('CommandsManager - One-Press Prompts', () => {
  const cmds = commandsManager.getAll();
  const explain = cmds.find(c => c.name === 'Explain Code');
  assert.ok(explain, 'Explain Code command must exist');
  assert.ok(explain.prompt.includes('Explain how this code works'));
});

test('ScreenAwarenessManager - Visual Inspection', () => {
  const analysis = screenAwarenessManager.analyzeScreen('data:image/png;base64,mock', 'Check UI contrast');
  // The image is never inspected, so there must be no findings or verdicts.
  assert.equal(analysis.status, 'not_performed');
  assert.equal(analysis.simulated, true);
  assert.equal(analysis.detectedComponents.length, 0);
  assert.ok(analysis.aiFeedback.includes('SIMULATED'));
  assert.equal(analysis.suggestedFix, null);
});

// ---------------------------------------------------------------------------
// T0 safety baseline regression tests
// ---------------------------------------------------------------------------

const JS_ROOT = fileURLToPath(new URL('../js/', import.meta.url));

function listJsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

// Runs fn with a fake localStorage that returns `payload` for any key.
function withStoredPayload(payload, fn) {
  globalThis.localStorage = { getItem: () => JSON.stringify(payload), setItem: () => {} };
  try {
    return fn();
  } finally {
    delete globalThis.localStorage;
  }
}

test('Unsafe execution primitives are not present anywhere in js/', () => {
  const forbidden = [
    /\bnew\s+Function\b/,
    /\bFunction\s*\(/,
    /\beval\s*\(/,
    /\bnew\s+Worker\b/,
    /\bimportScripts\b/,
    /\bimport\s*\(/,
    /\bdocument\.write\b/,
    /\bset(Timeout|Interval)\s*\(\s*['"`]/
  ];
  for (const file of listJsFiles(JS_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(source), `${file} must not match ${pattern}`);
    }
  }
});

test('No fabricated success or verification strings remain in js/', () => {
  const fabricated = [
    /Compilation passed/i,
    /Execution successful/i,
    /Connected \d+\s?ms/i,
    /executed successfully/i,
    /\d+ errors? found/i,
    /Zero UI clipping/i,
    /Verified Safe/i,
    /Saved ✓/,
    /Completed ✓/,
    /Retry mechanism verified/i
  ];
  for (const file of listJsFiles(JS_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of fabricated) {
      assert.ok(!pattern.test(source), `${file} must not match ${pattern}`);
    }
  }
});

test('getRunResult never reports execution or success', () => {
  for (const filename of ['main.js', 'NetworkService.swift', 'anything.txt']) {
    const result = getRunResult(filename);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.executed, false);
    assert.ok(result.output.includes(EXECUTION_UNAVAILABLE_MESSAGE));
    assert.equal(EXECUTION_UNAVAILABLE_MESSAGE, 'Execution unavailable — sandbox not configured');
    assert.ok(!/success|passed|verified|✓/i.test(result.output));
  }
});

test('Editor Run does not execute code and shows the unavailable state', async () => {
  const elements = {
    '#editorConsole': { style: {} },
    '#consoleOutput': { innerText: '', innerHTML: '' }
  };
  const container = { querySelector: sel => elements[sel] ?? null };
  globalThis.document = { getElementById: () => container };
  try {
    const { MobileCodeEditor } = await import('../js/editor.js');
    const editor = new MobileCodeEditor('editorContainer');

    // Hostile buffer: if anything evaluated it, this global would be set.
    editor.files['main.js'] = 'globalThis.__t0_executed = true; console.log("ran");';
    editor.activeFilename = 'main.js';
    editor.runCurrentCode();
    assert.equal(globalThis.__t0_executed, undefined, 'code must never be evaluated');
    assert.equal(elements['#editorConsole'].style.display, 'block');
    assert.ok(elements['#consoleOutput'].innerText.includes(EXECUTION_UNAVAILABLE_MESSAGE));
    assert.ok(!/success|passed|✓/i.test(elements['#consoleOutput'].innerText));

    editor.activeFilename = 'NetworkService.swift';
    editor.runCurrentCode();
    assert.ok(elements['#consoleOutput'].innerText.includes(EXECUTION_UNAVAILABLE_MESSAGE));
    assert.ok(!/Compilation|passed|verified/i.test(elements['#consoleOutput'].innerText));
  } finally {
    delete globalThis.document;
    delete globalThis.__t0_executed;
  }
});

test('MCP registry never reports connected, including stale persisted entries', () => {
  for (const server of mcpManager.getAll()) {
    assert.notEqual(server.status, 'connected');
  }
  const stale = [{ id: 'old', name: 'Old', url: 'http://x', status: 'connected', toolsCount: 3, description: '' }];
  const [loaded] = withStoredPayload(stale, () => new McpManager().getAll());
  assert.equal(loaded.status, 'unverified');
});

test('MCP test result carries no connection or latency evidence', () => {
  const result = getMcpTestResult();
  assert.equal(result.connected, false);
  assert.equal(result.status, 'not_tested');
  assert.ok(result.label.includes('SIMULATED'));
  assert.ok(!/connected \d|\d+\s?ms|✓/i.test(result.label));
});

test('Automations drop fabricated persisted last-run labels', () => {
  const stale = [{ id: 'a', name: 'A', schedule: 's', prompt: 'p', active: true, lastRun: 'Today 08:30' }];
  const [loaded] = withStoredPayload(stale, () => new AutomationsManager().getAll());
  assert.equal(loaded.lastRun, 'Never');
});

test('Chat replies are all labeled SIMULATED and make no verification claims', async () => {
  const container = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  globalThis.document = { getElementById: () => container };
  try {
    const { AgentChat } = await import('../js/chat.js');
    const chat = new AgentChat('chatContainer');
    chat.init();
    chat.generateAiReply('explain swift retry');
    chat.generateAiReply('fix my js animation loop');
    chat.generateAiReply('hello there');

    const aiMessages = chat.messages.filter(m => m.sender === 'ai');
    assert.equal(aiMessages.length, 4); // default dialogue + 3 replies
    for (const msg of aiMessages) {
      assert.ok(msg.text.includes('[SIMULATED]'), 'every AI message must be labeled');
      assert.ok(!/I have reviewed|Verified async|Checked code syntax|guarantees|Ready to commit/i.test(msg.text));
    }
    assert.ok(container.innerHTML.includes('AI · SIMULATED'), 'rendered chip must say SIMULATED');
  } finally {
    delete globalThis.document;
  }
});

// ---------------------------------------------------------------------------
// T0.1 human-in-the-loop Apply to Editor regression tests
// ---------------------------------------------------------------------------

function createHeadlessEditor() {
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => null, activeElement: null };
  try {
    return new MobileCodeEditor('editorContainer');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

function createChatHarness(editor, onApply = review => editor.applyReviewedChange(review)) {
  const container = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => container, activeElement: null };
  let chat;
  try {
    chat = new AgentChat('chatContainer', {
      getFileSnapshot: filename => editor.getFileSnapshot(filename),
      onApplyCode: onApply
    });
    chat.init();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  return { chat, container };
}

test('T0.1 - opening a review never applies code before explicit approval', () => {
  const editor = createHeadlessEditor();
  const before = editor.getFileSnapshot('NetworkService.swift');
  let applyCalls = 0;
  const { chat } = createChatHarness(editor, review => {
    applyCalls += 1;
    return editor.applyReviewedChange(review);
  });

  chat.startReview('msg-1');

  assert.equal(applyCalls, 0);
  assert.equal(editor.getFileSnapshot('NetworkService.swift').content, before.content);
  assert.equal(chat.pendingReview.targetFilename, 'NetworkService.swift');
  assert.equal(chat.pendingReview.baseContent, before.content);
});

test('T0.1 - Reject performs zero editor changes', () => {
  const editor = createHeadlessEditor();
  const before = editor.getFileSnapshot('NetworkService.swift');
  const { chat } = createChatHarness(editor);

  chat.startReview('msg-1');
  chat.rejectReview();

  assert.deepEqual(editor.getFileSnapshot('NetworkService.swift'), before);
  assert.equal(chat.pendingReview, null);
  assert.match(chat.reviewNotice, /Rejected.+No editor content changed/);
});

test('T0.1 - Cancel performs zero editor changes', () => {
  const editor = createHeadlessEditor();
  const before = editor.getFileSnapshot('NetworkService.swift');
  const { chat } = createChatHarness(editor);

  chat.startReview('msg-1');
  chat.cancelReview();

  assert.deepEqual(editor.getFileSnapshot('NetworkService.swift'), before);
  assert.equal(chat.pendingReview, null);
  assert.match(chat.reviewNotice, /Canceled.+No editor content changed/);
});

test('T0.1 - approval updates only the reviewed target and preserves unrelated unsaved content', () => {
  const editor = createHeadlessEditor();
  const unsavedMain = `${editor.files['main.js']}\n// unsaved user work`;
  editor.updateFileContent('main.js', unsavedMain);
  const activeBefore = editor.activeFilename;
  const mainRevisionBefore = editor.fileRevisions['main.js'];
  const { chat } = createChatHarness(editor);

  chat.startReview('msg-1');
  const proposed = chat.pendingReview.proposedContent;
  chat.approveReview();

  assert.equal(editor.files['NetworkService.swift'], proposed);
  assert.equal(editor.files['main.js'], unsavedMain);
  assert.equal(editor.fileRevisions['main.js'], mainRevisionBefore);
  assert.equal(editor.activeFilename, activeBefore);
  assert.equal(editor.isFileDirty('main.js'), true);
  assert.match(chat.reviewNotice, /Local autosave may now persist it/);
});

test('T0.1 - stale previews cannot overwrite newer target edits', () => {
  const editor = createHeadlessEditor();
  const { chat } = createChatHarness(editor);

  chat.startReview('msg-1');
  const newerEdit = `${editor.files['NetworkService.swift']}\n// newer user edit`;
  editor.updateFileContent('NetworkService.swift', newerEdit);
  chat.approveReview();

  assert.equal(editor.files['NetworkService.swift'], newerEdit);
  assert.equal(chat.pendingReview.status, 'stale');
  assert.match(chat.container.innerHTML, /Stale review rejected/);
});

test('T0.1 - snapshots capture the latest live textarea and increment revisions', () => {
  const liveTextarea = { value: initialFiles['main.js'], selectionStart: 0, selectionEnd: 0 };
  const container = {
    querySelector: selector => selector === '.editor-textarea' ? liveTextarea : null,
    querySelectorAll: () => []
  };
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => container, activeElement: null };
  try {
    const editor = new MobileCodeEditor('editorContainer');
    const first = editor.getFileSnapshot('main.js');
    assert.equal(first.revision, 0);

    liveTextarea.value += '\n// live DOM edit without an input event';
    const second = editor.getFileSnapshot('main.js');
    assert.equal(second.content, liveTextarea.value);
    assert.equal(second.revision, 1);
    assert.equal(second.dirty, true);

    const unchanged = editor.getFileSnapshot('main.js');
    assert.equal(unchanged.revision, 1, 'unchanged snapshots must not create revisions');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test('T0.1 - unsaved target warning shows complete escaped current and proposed content', () => {
  const editor = createHeadlessEditor();
  const unsafeCurrent = '<script>globalThis.currentExecuted = true</script>\ncomplete current content';
  const unsafeProposal = '</code><img src=x onerror="globalThis.proposalExecuted=true">\ncomplete proposed content';
  editor.updateFileContent('main.js', unsafeCurrent);
  const { chat, container } = createChatHarness(editor);
  chat.messages.push({
    id: 'unsafe-proposal',
    sender: 'ai',
    hasCodeCard: true,
    codeLinesCount: 2,
    codeSnippetShort: unsafeProposal,
    codeSnippetFull: unsafeProposal,
    targetFilename: 'main.js',
    text: '**[SIMULATED]** unsafe rendering regression fixture'
  });

  chat.startReview('unsafe-proposal');

  assert.equal(chat.pendingReview.dirty, true);
  assert.match(container.innerHTML, /has unsaved in-memory changes/);
  assert.ok(container.innerHTML.includes('&lt;script&gt;globalThis.currentExecuted = true&lt;/script&gt;'));
  assert.ok(container.innerHTML.includes('&lt;\/code&gt;&lt;img src=x onerror="globalThis.proposalExecuted=true"&gt;'));
  assert.ok(!container.innerHTML.includes('<script>globalThis.currentExecuted'));
  assert.ok(!container.innerHTML.includes('<img src=x onerror='));
  assert.equal(globalThis.currentExecuted, undefined);
  assert.equal(globalThis.proposalExecuted, undefined);
});

test('T0.1 - invalid and mismatched review targets fail closed', () => {
  const editor = createHeadlessEditor();
  const before = { ...editor.files };
  const result = editor.applyReviewedChange({
    targetFilename: 'not-a-project-file.js',
    baseContent: '',
    baseRevision: 0,
    proposedContent: 'untrusted proposal'
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, 'unknown_target');
  assert.deepEqual(editor.files, before);
});

test('T0.1 - generated proposals carry the intended file instead of a hardcoded target', () => {
  const editor = createHeadlessEditor();
  const { chat } = createChatHarness(editor);

  chat.generateAiReply('fix the main.js animation loop');
  chat.generateAiReply('improve the Swift retry helper');

  const proposals = chat.messages.filter(message => message.codeSnippetFull);
  assert.equal(proposals.at(-2).targetFilename, 'main.js');
  assert.equal(proposals.at(-1).targetFilename, 'NetworkService.swift');
  assert.ok(proposals.every(message => message.text.includes('[SIMULATED]')));
});

// ---------------------------------------------------------------------------
// T0.2 Melly IDE branding regression tests
// ---------------------------------------------------------------------------

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));

test('T0.2 - active product surfaces use the Melly IDE identity', () => {
  const productSurfacePaths = [
    'index.html',
    'js/app.js',
    'js/hub.js',
    'js/onboarding.js',
    'js/data/samples.js',
    'styles/main.css',
    'styles/hub.css',
    'styles/onboarding.css',
    'package.json',
    'README.md',
    'LICENSE'
  ];

  for (const relativePath of productSurfacePaths) {
    const source = readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');
    assert.doesNotMatch(source, /Raycast/i, `${relativePath} must not expose obsolete Raycast branding`);
  }

  const indexSource = readFileSync(join(REPOSITORY_ROOT, 'index.html'), 'utf8');
  const packageMetadata = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  assert.match(indexSource, /<title>Melly IDE — Review before you apply<\/title>/);
  assert.match(indexSource, />Melly IDE<\/span>/);
  assert.equal(packageMetadata.name, 'melly-ide');
});

test('T0.2 - branding removes copied assets without changing persistence namespaces', () => {
  for (let index = 1; index <= 4; index += 1) {
    assert.equal(
      existsSync(join(REPOSITORY_ROOT, `images/photo-1792111470-${index}.jpg`)),
      false,
      'obsolete screenshot-reference assets must not remain'
    );
  }

  assert.equal(FILE_STORE_DB_NAME, 'mobileide-editor');
  const storageSource = readFileSync(join(REPOSITORY_ROOT, 'js/storage/file-store.js'), 'utf8');
  assert.match(storageSource, /Melly IDE storage database/);
  assert.doesNotMatch(storageSource, /renameDatabase|deleteDatabase|clear\s*\(/);
});
