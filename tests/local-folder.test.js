import test from 'node:test';
import assert from 'node:assert/strict';
import {MobileCodeEditor} from '../js/editor.js';
import {LocalFolder, FOLDER_UNAVAILABLE} from '../js/local-folder.js';
const makeEditor=()=>{
  const previous=globalThis.document; globalThis.document={getElementById:()=>null};
  try { return new MobileCodeEditor('unused',{files:{'src/zażółć.ts':'\r\n  日本語 🟣\rCR\nLF'},readOnly:true}); }
  finally {globalThis.document=previous;}
};
test('disk preview preserves UTF-8 and line endings in memory without storage initialization',async()=>{
  const editor=makeEditor();editor.fileStore={init(){throw Error('must not access IndexedDB');}};
  assert.equal((await editor.initializePersistence()).ok,true);
  assert.equal(editor.getActiveContent(),'\r\n  日本語 🟣\rCR\nLF');
});
test('disk previews reject every save boundary and mutation without changing revisions',async()=>{
  const editor=makeEditor(), before=structuredClone(editor.files), revisions={...editor.fileRevisions};
  assert.equal(editor.updateFileContent(editor.activeFilename,'changed'),false);
  assert.equal((await editor.saveFile()).code,'read_only');
  assert.equal((await editor.queueSave(editor.activeFilename,'autosave')).code,'read_only');
  assert.equal((await editor.performSave({})).code,'read_only');
  editor.scheduleAutosave(editor.activeFilename);editor.insertText('changed');editor.captureLiveEditorContent();editor.runCurrentCode();
  assert.deepEqual(editor.files,before);assert.deepEqual(editor.fileRevisions,revisions);assert.deepEqual(editor.autosaveTimers,{});
});
test('disk source cannot enter AI/review snapshots or proposals',()=>{const e=makeEditor();assert.equal(e.getFileSnapshot(),null);assert.equal(e.applyReviewedChange({}).reason,'read_only');});
test('ordinary workspace editors still edit and maintain revisions',()=>{const e=makeEditor();e.readOnly=false;e.container=null;assert.equal(e.updateFileContent(e.activeFilename,'edited',{skipAutosave:true}),true);assert.equal(e.fileRevisions[e.activeFilename],1);});
test('native bridge is optional and browser fallback is explicit',()=>{const folder=new LocalFolder({},null);assert.equal(folder.invoke,null);assert.equal(folder.session,null);assert.match(FOLDER_UNAVAILABLE,/Windows desktop app/);});
test('canceled selection never creates folder state',async()=>{
 const previous=globalThis.document; const controls={disabled:false};globalThis.document={getElementById:()=>controls};
 try {const f=new LocalFolder({},async()=>null);let message='';f.message=text=>message=text;await f.open();assert.equal(f.session,null);assert.equal(f.busy,false);assert.match(message,/canceled/);assert.equal(controls.disabled,false);}finally{globalThis.document=previous;}
});
test('IPC failure remains an error and never supplies sample disk content',async()=>{
 const previous=globalThis.document;globalThis.document={getElementById:()=>({})};
 try{const f=new LocalFolder({},async()=>{throw Error('IPC unavailable');});let message='';f.message=text=>message=text;await f.open();assert.equal(f.session,null);assert.equal(f.tabs.size,0);assert.match(message,/IPC unavailable/);}finally{globalThis.document=previous;}
});
