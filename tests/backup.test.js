import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackup,parseBackup,recoveryBackup,FILE_LIMIT,BACKUP_LIMIT,applyBackup} from '../js/backup.js';
const data=()=>({format:'melly-ide-workspace',schemaVersion:1,exportedAt:'2026-10-22T12:00:00Z',files:[{filename:'main.js',content:'Zażółć 🟣\n\n',revision:1,updatedAt:'2026-10-22T12:00:00Z'}],settings:{activeFilename:'main.js'}});
test('T1.2 exact Unicode and trailing newline round trip excludes arbitrary settings',()=>{
 const editor={captureLiveEditorContent(){},files:{'main.js':'Zażółć 🟣\n\n','NetworkService.swift':'swift\n'},fileRevisions:{'main.js':1,'NetworkService.swift':2},activeFilename:'main.js',apiKey:'excluded'};
 const text=createBackup(editor);const parsed=parseBackup(text);assert.equal(parsed.files[0].content,editor.files['main.js']);assert.equal(parsed.files[1].content,'swift\n');assert.ok(!text.includes('apiKey'));assert.deepEqual(parsed.settings,{activeFilename:'main.js'});
});
for(const [name,mutate] of [
 ['unsupported schema',d=>d.schemaVersion=9],['duplicate filename',d=>d.files.push({...d.files[0]})],
 ['path traversal',d=>d.files[0].filename='../.env'],['unknown fields',d=>d.settings.token='blocked'],
 ['invalid revision',d=>d.files[0].revision=-1],['invalid timestamp',d=>d.exportedAt='bad'],
 ['invalid content',d=>d.files[0].content={}],['oversized file',d=>d.files[0].content='x'.repeat(FILE_LIMIT+1)],
 ['known credential',d=>d.files[0].content='const api_key = "private-test-value";']
])test('T1.2 rejects '+name,()=>{const d=data();mutate(d);assert.throws(()=>parseBackup(JSON.stringify(d)));});
test('T1.2 invalid JSON and oversized backup rejected',()=>{assert.throws(()=>parseBackup('{bad'),/Invalid JSON/);assert.throws(()=>parseBackup(' '.repeat(BACKUP_LIMIT+1)),/2 MiB/);});
test('T1.2 recovery exports canonical raw fields only and cannot masquerade as an import',()=>{
 const text=recoveryBackup([{filename:'main.js',schemaVersion:99,content:'recover me\n',token:'excluded'},{filename:'.env',content:'excluded'}]);
 assert.ok(!text.includes('excluded'));assert.equal(JSON.parse(text).records[0].schemaVersion,99);assert.throws(()=>parseBackup(text));
});
test('T1.2 keep existing makes zero storage calls',async()=>{assert.deepEqual(await applyBackup({},null,[]),{ok:true,kept:true});});
