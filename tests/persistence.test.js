import test from 'node:test';
import assert from 'node:assert/strict';

import { initialFiles } from '../js/data/samples.js';
import { MobileCodeEditor } from '../js/editor.js';
import { AgentChat } from '../js/chat.js';
import {
  createFileRecord,
  FILE_STORE_RECORD_VERSION,
  validateFileRecord
} from '../js/storage/file-store.js';

class MemoryFileStore {
  constructor(records = [], options = {}) {
    this.records = new Map(records.map(record => [record.filename, { ...record }]));
    this.options = options;
    this.writes = [];
  }

  async init() {
    return this.options.initResult || { ok: true };
  }

  async loadFiles(allowedFilenames) {
    if (this.options.loadResult) return this.options.loadResult;
    const allowed = new Set(allowedFilenames);
    const files = {};
    const issues = [];
    for (const candidate of this.records.values()) {
      const validated = validateFileRecord(candidate);
      if (!validated.ok) {
        issues.push(validated);
      } else if (allowed.has(validated.record.filename)) {
        files[validated.record.filename] = validated.record;
      }
    }
    return { ok: true, files, issues };
  }

  async saveFile(request) {
    this.writes.push({ ...request });
    if (this.options.saveResult) return this.options.saveResult;
    const record = createFileRecord(request.filename, request.content, request.revision, '2026-10-21T12:00:00.000Z');
    this.records.set(request.filename, record);
    return { ok: true, record };
  }
}

class DeferredFileStore extends MemoryFileStore {
  constructor(records = []) {
    super(records);
    this.pending = [];
  }

  saveFile(request) {
    this.writes.push({ ...request });
    return new Promise(resolve => {
      this.pending.push({ request: { ...request }, resolve });
    });
  }

  resolveNext(result = null) {
    const pending = this.pending.shift();
    assert.ok(pending, 'a save must be pending');
    const record = createFileRecord(
      pending.request.filename,
      pending.request.content,
      pending.request.revision,
      '2026-10-21T12:00:00.000Z'
    );
    this.records.set(record.filename, record);
    pending.resolve(result || { ok: true, record });
  }
}

class ManualScheduler {
  constructor() {
    this.nextId = 1;
    this.callbacks = new Map();
  }

  schedule(callback) {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  cancel(id) {
    this.callbacks.delete(id);
  }

  runAll() {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    callbacks.forEach(callback => callback());
  }
}

function createEditor(options = {}) {
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => null, activeElement: null };
  try {
    return new MobileCodeEditor('editorContainer', options);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

function createChat(editor, onApply = review => editor.applyReviewedChange(review)) {
  const container = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => container, activeElement: null };
  try {
    const chat = new AgentChat('chatContainer', {
      getFileSnapshot: filename => editor.getFileSnapshot(filename),
      onApplyCode: onApply
    });
    chat.init();
    return chat;
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

const flushPromises = () => new Promise(resolve => setImmediate(resolve));

test('T1 - file records preserve exact content and reject invalid schemas', () => {
  const exact = 'line one\n\u0000 unicode: zażółć 🚀\nline three';
  const valid = createFileRecord('main.js', exact, 7, '2026-10-21T12:00:00.000Z');
  assert.equal(valid.schemaVersion, FILE_STORE_RECORD_VERSION);
  assert.deepEqual(validateFileRecord(valid), { ok: true, record: valid });
  assert.equal(validateFileRecord({ ...valid, content: 42 }).code, 'corrupt_record');
  assert.equal(validateFileRecord({ ...valid, schemaVersion: 999 }).code, 'unsupported_schema_version');
});

test('T1 - successful save round trip restores exact content after reload', async () => {
  const store = new MemoryFileStore();
  const first = createEditor({ fileStore: store });
  await first.initializePersistence();
  const content = `${initialFiles['main.js']}\n// exact persisted edit 🚀`;
  first.updateFileContent('main.js', content);

  const saved = await first.saveFile('main.js');
  assert.equal(saved.ok, true);
  assert.equal(saved.acknowledged, true);
  assert.equal(first.isFileDirty('main.js'), false);
  assert.equal(first.getSaveState('main.js').status, 'saved');

  const reloaded = createEditor({ fileStore: store });
  await reloaded.initializePersistence();
  assert.equal(reloaded.files['main.js'], content);
  assert.equal(reloaded.getSaveState('main.js').status, 'saved');
});

test('T1 - files persist independently without overwriting another record', async () => {
  const store = new MemoryFileStore();
  const editor = createEditor({ fileStore: store });
  await editor.initializePersistence();
  editor.updateFileContent('main.js', 'main-only');
  editor.updateFileContent('NetworkService.swift', 'swift-only');
  await editor.saveFile('main.js');
  await editor.saveFile('NetworkService.swift');

  assert.equal(store.records.get('main.js').content, 'main-only');
  assert.equal(store.records.get('NetworkService.swift').content, 'swift-only');
  assert.equal(store.records.size, 2);
});

test('T1 - failed transaction preserves dirty in-memory content and never reports saved', async () => {
  const store = new MemoryFileStore([], {
    saveResult: {
      ok: false,
      code: 'quota_exceeded',
      message: 'Browser storage quota was exceeded. Free local storage space and retry Save.'
    }
  });
  const editor = createEditor({ fileStore: store });
  await editor.initializePersistence();
  editor.updateFileContent('main.js', 'unsaved but retained');

  const result = await editor.saveFile('main.js');
  assert.equal(result.ok, false);
  assert.equal(editor.files['main.js'], 'unsaved but retained');
  assert.equal(editor.isFileDirty('main.js'), true);
  assert.equal(editor.getSaveState('main.js').status, 'failed');
  assert.notEqual(editor.getSaveState('main.js').status, 'saved');
});

test('T1 - unavailable storage retains editing but exposes an unavailable state', async () => {
  const store = new MemoryFileStore([], {
    initResult: {
      ok: false,
      code: 'storage_unavailable',
      message: 'Browser-local storage is unavailable.'
    }
  });
  const editor = createEditor({ fileStore: store });
  const initialized = await editor.initializePersistence();
  editor.updateFileContent('main.js', 'memory survives');
  const saved = await editor.saveFile('main.js');

  assert.equal(initialized.ok, false);
  assert.equal(saved.ok, false);
  assert.equal(editor.files['main.js'], 'memory survives');
  assert.equal(editor.getSaveState('main.js').status, 'unavailable');
  assert.equal(store.writes.length, 0);
});

test('T1 - corrupt stored data is not loaded or silently overwritten', async () => {
  const corrupt = {
    schemaVersion: FILE_STORE_RECORD_VERSION,
    filename: 'main.js',
    content: 42,
    revision: 3,
    updatedAt: '2026-10-21T12:00:00.000Z'
  };
  const store = new MemoryFileStore([corrupt]);
  const scheduler = new ManualScheduler();
  const editor = createEditor({
    fileStore: store,
    schedule: callback => scheduler.schedule(callback),
    cancelSchedule: id => scheduler.cancel(id)
  });
  const initialized = await editor.initializePersistence();

  assert.equal(initialized.issues[0].code, 'corrupt_record');
  assert.equal(editor.files['main.js'], initialFiles['main.js']);
  assert.equal(editor.getSaveState('main.js').status, 'recovery');
  editor.updateFileContent('main.js', 'new in-memory edit');
  scheduler.runAll();
  await flushPromises();
  assert.equal(store.writes.length, 0, 'autosave must not overwrite a corrupt record');
});

test('T1 - unsupported record version pauses autosave until explicit replacement', async () => {
  const unsupported = createFileRecord('main.js', 'future content', 4, '2026-10-21T12:00:00.000Z');
  unsupported.schemaVersion = FILE_STORE_RECORD_VERSION + 1;
  const store = new MemoryFileStore([unsupported]);
  const scheduler = new ManualScheduler();
  const editor = createEditor({
    fileStore: store,
    schedule: callback => scheduler.schedule(callback),
    cancelSchedule: id => scheduler.cancel(id)
  });
  await editor.initializePersistence();
  editor.updateFileContent('main.js', 'owner-approved replacement');
  scheduler.runAll();
  await flushPromises();
  assert.equal(store.writes.length, 0);

  const explicit = await editor.saveFile('main.js', 'explicit');
  assert.equal(explicit.ok, true);
  assert.equal(store.records.get('main.js').content, 'owner-approved replacement');
  assert.equal(editor.getSaveState('main.js').status, 'saved');
});

test('T1 - autosave debounce coalesces keystrokes and persists the latest revision', async () => {
  const store = new MemoryFileStore();
  const scheduler = new ManualScheduler();
  const editor = createEditor({
    fileStore: store,
    autosaveDelay: 650,
    schedule: callback => scheduler.schedule(callback),
    cancelSchedule: id => scheduler.cancel(id)
  });
  await editor.initializePersistence();
  editor.updateFileContent('main.js', 'a');
  editor.updateFileContent('main.js', 'ab');
  editor.updateFileContent('main.js', 'abc');

  assert.equal(scheduler.callbacks.size, 1);
  assert.equal(store.writes.length, 0);
  scheduler.runAll();
  await flushPromises();
  await editor.waitForPendingSaves('main.js');
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].content, 'abc');
  assert.equal(editor.getSaveState('main.js').status, 'saved');
});

test('T1 - per-file queue serializes an older autosave before a newer explicit save', async () => {
  const store = new DeferredFileStore();
  const scheduler = new ManualScheduler();
  const editor = createEditor({
    fileStore: store,
    schedule: callback => scheduler.schedule(callback),
    cancelSchedule: id => scheduler.cancel(id)
  });
  await editor.initializePersistence();
  editor.updateFileContent('main.js', 'older autosave');
  scheduler.runAll();
  await flushPromises();
  assert.equal(store.writes.length, 1);

  editor.updateFileContent('main.js', 'newer explicit save');
  const explicit = editor.saveFile('main.js', 'explicit');
  await flushPromises();
  assert.equal(store.writes.length, 1, 'newer write must wait for the older transaction');

  store.resolveNext();
  await flushPromises();
  assert.equal(store.writes.length, 2);
  assert.equal(store.writes[1].content, 'newer explicit save');
  assert.equal(editor.getSaveState('main.js').status, 'saving');
  store.resolveNext();
  const result = await explicit;

  assert.equal(result.ok, true);
  assert.equal(result.acknowledged, true);
  assert.equal(store.records.get('main.js').content, 'newer explicit save');
  assert.equal(editor.getSaveState('main.js').status, 'saved');
});

test('T1 - dirty state follows the latest successfully persisted content', async () => {
  const store = new MemoryFileStore();
  const editor = createEditor({ fileStore: store });
  await editor.initializePersistence();
  assert.equal(editor.isFileDirty('main.js'), false);
  editor.updateFileContent('main.js', 'revision one');
  assert.equal(editor.isFileDirty('main.js'), true);
  await editor.saveFile('main.js');
  assert.equal(editor.isFileDirty('main.js'), false);
  editor.updateFileContent('main.js', 'revision two');
  assert.equal(editor.isFileDirty('main.js'), true);
});

test('T1 - approved proposal enters autosave and survives a new editor instance', async () => {
  const store = new MemoryFileStore();
  const scheduler = new ManualScheduler();
  const editor = createEditor({
    fileStore: store,
    schedule: callback => scheduler.schedule(callback),
    cancelSchedule: id => scheduler.cancel(id)
  });
  await editor.initializePersistence();
  const chat = createChat(editor);
  chat.startReview('msg-1');
  const approved = chat.pendingReview.proposedContent;
  chat.approveReview();
  assert.match(chat.reviewNotice, /Local autosave may now persist it/);

  scheduler.runAll();
  await flushPromises();
  await editor.waitForPendingSaves('NetworkService.swift');
  assert.equal(store.records.get('NetworkService.swift').content, approved);

  const reloaded = createEditor({ fileStore: store });
  await reloaded.initializePersistence();
  assert.equal(reloaded.files['NetworkService.swift'], approved);
});

test('T1 - opening, rejecting, and canceling reviews create no storage write', async () => {
  const store = new MemoryFileStore();
  const scheduler = new ManualScheduler();
  const editor = createEditor({
    fileStore: store,
    schedule: callback => scheduler.schedule(callback),
    cancelSchedule: id => scheduler.cancel(id)
  });
  await editor.initializePersistence();
  const before = { ...editor.files };
  const chat = createChat(editor);

  chat.startReview('msg-1');
  chat.rejectReview();
  chat.startReview('msg-1');
  chat.cancelReview();
  scheduler.runAll();
  await flushPromises();

  assert.deepEqual(editor.files, before);
  assert.equal(store.writes.length, 0);
});
