import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceDialog } from '../js/dialog.js';
import { localizeControls, saveStateLabel } from '../js/ui-language.js';

function fixture() {
  const previous = globalThis.document;
  const listeners = new Map();
  const doc = {activeElement:null,documentElement:{lang:'en'},addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:key=>listeners.delete(key)};
  globalThis.document = doc;
  const el = () => ({inert:false,isConnected:true,style:{},focus(){doc.activeElement=this},getClientRects:()=>[{}],closest:()=>null});
  const origin=el(), header=el(), alreadyInert=el(), overlay=el(), dialog=el(), first=el(), last=el();
  alreadyInert.inert=true;
  const body={children:[header,alreadyInert,overlay],parentElement:null};
  overlay.parentElement=body;
  dialog.querySelectorAll=()=>[first,last];
  dialog.contains=e=>[dialog,first,last].includes(e);
  doc.activeElement=origin;
  const manager=new WorkspaceDialog();
  return {doc,manager,origin,header,alreadyInert,overlay,dialog,first,last,listeners,cleanup(){manager.close();if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}};
}
test('UI-02 modal moves focus, makes background inert, and restores original inert state',()=>{
  const f=fixture();try{
    f.manager.open(f.overlay,f.dialog);
    assert.equal(f.doc.activeElement,f.dialog);assert.equal(f.header.inert,true);
    f.manager.close();assert.equal(f.doc.activeElement,f.origin);assert.equal(f.header.inert,false);assert.equal(f.alreadyInert.inert,true);
    assert.equal(f.listeners.size,0);
  }finally{f.cleanup()}
});
test('UI-02 Escape closes the modal and restores its trigger',()=>{
  const f=fixture();try{
    f.manager.open(f.overlay,f.dialog);let prevented=false;
    f.listeners.get('keydown')({key:'Escape',preventDefault(){prevented=true},stopPropagation(){}});
    assert.equal(prevented,true);assert.equal(f.overlay.style.display,'none');assert.equal(f.doc.activeElement,f.origin);
  }finally{f.cleanup()}
});
test('UI-02 Tab and Shift+Tab wrap within modal controls',()=>{
  const f=fixture();try{
    f.manager.open(f.overlay,f.dialog);
    const key=(shiftKey=false)=>f.listeners.get('keydown')({key:'Tab',shiftKey,preventDefault(){}});
    key(true);assert.equal(f.doc.activeElement,f.last);
    key();assert.equal(f.doc.activeElement,f.first);
    key(true);assert.equal(f.doc.activeElement,f.last);
  }finally{f.cleanup()}
});
test('UI-02 programmatic background focus returns inside modal',()=>{
  const f=fixture();try{
    f.manager.open(f.overlay,f.dialog);f.header.focus();f.listeners.get('focusin')({target:f.header});
    assert.equal(f.doc.activeElement,f.first);
  }finally{f.cleanup()}
});
test('UI-02 refreshing modal content retains original trigger ownership',()=>{
  const f=fixture();try{
    f.manager.open(f.overlay,f.dialog);f.first.focus();f.manager.open(f.overlay,f.dialog,f.last);
    f.manager.close();assert.equal(f.doc.activeElement,f.origin);
  }finally{f.cleanup()}
});
test('UI-02 localization is optional in DOM-free safety tests',()=>{
  const previous=globalThis.document;delete globalThis.document;
  try{assert.doesNotThrow(()=>localizeControls(null));assert.equal(saveStateLabel('saved','SAVED LOCALLY'),'SAVED LOCALLY');}
  finally{if(previous!==undefined)globalThis.document=previous;}
});
test('UI-02 localized controls change names and state without replacing content',()=>{
  const attrs={};const editor={value:'const preserve = 1;',setAttribute:(key,value)=>attrs[key]=value};
  const root={querySelector:selector=>selector==='#editorTextarea'?editor:null,querySelectorAll:()=>[]};
  localizeControls(root,'pl');assert.equal(attrs['aria-label'],'Edytor kodu');assert.equal(editor.value,'const preserve = 1;');
  localizeControls(root,'en');assert.equal(attrs['aria-label'],'Code editor');
});
test('UI-02 Polish save statuses preserve failure and recovery distinctions',()=>{
  const f=fixture();try{
    f.doc.documentElement.lang='pl';
    assert.equal(saveStateLabel('saved','SAVED LOCALLY'),'ZAPISANO LOKALNIE');
    assert.equal(saveStateLabel('failed','SAVE FAILED'),'BŁĄD ZAPISU');
    assert.equal(saveStateLabel('recovery','RECOVERY NEEDED'),'WYMAGANE ODZYSKIWANIE');
  }finally{f.cleanup()}
});
