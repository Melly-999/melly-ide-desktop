import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {emptyWorkspace, createProject, addEntry, renameEntry, deleteEntry, validateWorkspace, lineDiff, exportWorkspace, importProjects, validPath, recoveryWorkspace} from '../js/workspace/model.js';
import {PublicGitHub} from '../js/workspace/github.js';
import {MetadataQueue} from '../js/workspace/sync.js';
test('workspace: project isolation, nested folders, rename, delete, revisions and original source', () => {
  const p = createProject('One'), q = createProject('Two'); addEntry(p, 'src/lib/code.js', 'file', 'const original = 1;\n');
  const file = p.entries.find(e => e.path.endsWith('code.js')); file.content = 'const modified = 2;\n'; file.revision++;
  renameEntry(p, 'src', 'app'); assert.equal(p.activePath, 'app/lib/code.js'); assert.equal(file.baseContent, 'const original = 1;\n');
  assert.equal(q.entries.length, 1); deleteEntry(p, 'app'); assert.equal(p.entries.length, 1);
  validateWorkspace({...emptyWorkspace(), projects:[p,q]});
});
test('workspace: traversal, prototype, collisions, invalid parents and invalid schema fail closed', () => {
  for (const path of ['../secret','.','/root','a//b','a\\b','__proto__','a/constructor','a/../b','a\n.js']) assert.equal(validPath(path), false, path);
  const p = createProject('One'); addEntry(p,'src','folder'); assert.throws(()=>addEntry(p,'main.js','file'),/exists/);
  assert.throws(()=>renameEntry(p,'src','src/child'),/itself/); assert.throws(()=>addEntry(p,'main.js/child','file'),/parent/);
  assert.throws(()=>validateWorkspace({...emptyWorkspace(),schemaVersion:99}));
});
test('workspace: v2 round trip preserves content, source revisions and imports only new IDs', () => {
  const p = createProject('One'); addEntry(p,'src/ü.js','file','// Zażółć 🟣\n');
  const state={...emptyWorkspace(),projects:[p]}; const text=exportWorkspace(state), [copy]=importProjects(text);
  assert.notEqual(copy.id,p.id); assert.deepEqual(copy.entries,p.entries); assert.equal(JSON.parse(text).schemaVersion,2);
});
test('workspace: legacy v1 backup becomes a new project; secrets and oversize are denied', () => {
  const legacy={format:'melly-ide-workspace',schemaVersion:1,exportedAt:new Date().toISOString(),files:[{filename:'main.js',content:'legacy\n',revision:5,updatedAt:new Date().toISOString()}],settings:{activeFilename:'main.js'}};
  const [p]=importProjects(JSON.stringify(legacy)); assert.equal(p.entries[0].content,'legacy\n'); assert.equal(p.entries[0].revision,5);
  p.entries[0].content='const password = "hidden-password";'; assert.throws(()=>exportWorkspace({...emptyWorkspace(),projects:[p]}),/credential/);
  assert.throws(()=>importProjects(' '.repeat(2*1024*1024+1)),/exceeds/);
});
test('workspace: real unified diff distinguishes insert, delete, empty file and final newline', () => {
  assert.match(lineDiff('one\n','two\n','a.js'),/@@ -1,1 \+1,1 @@\n-one\n\+two/);
  assert.match(lineDiff('','x'),/@@ -0,0 \+1,1 @@/); assert.match(lineDiff('x','x\n'),/No newline at end of file/);
  assert.equal(lineDiff('same','same'),'No changes against the saved original revision.');
});
test('workspace: unsupported schema recovery excludes unknown credentials and detects secrets in actual content', () => {
 const raw={schemaVersion:99,providerToken:'never-export',projects:[{name:'Recover',token:'never-export',entries:[{path:'main.js',kind:'file',content:'// recover',credential:'never-export'}]}]};
 const text=recoveryWorkspace(raw);assert.ok(text.includes('// recover'));assert.ok(!text.includes('never-export'));
 raw.projects[0].entries[0].content='const password="private-value"';assert.throws(()=>recoveryWorkspace(raw),/credential/);
});
test('GitHub fixture: requests omit credentials, verify blob digest and reject binary/rate limit/truncation', async () => {
  const content='// Unicode 🟣\n', raw=Buffer.from(content), sha=createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${raw.length}\0`),raw])).digest('hex');
  const calls=[]; const api=new PublicGitHub(async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({sha,encoding:'base64',size:raw.length,content:raw.toString('base64')}));});
  const file=await api.file('octocat/Hello-World','a'.repeat(40),{path:'src/a.js',sha,size:raw.length}); assert.equal(file.content,content); assert.equal(calls[0].options.credentials,'omit');
  await assert.rejects(()=>api.file('octocat/Hello-World','a'.repeat(40),{path:'a',sha:'b'.repeat(40),size:1}),/integrity|Unsupported/);
  const limited=new PublicGitHub(async()=>new Response('',{status:403})); await assert.rejects(()=>limited.browse('a/b'),/rate limit/);
  let count=0; const tree=new PublicGitHub(async()=>new Response(JSON.stringify(++count===1?{sha:'a'.repeat(40),tree:{sha:'b'.repeat(40)}}:{truncated:true})));
  await assert.rejects(()=>tree.tree('a/b','a'.repeat(40)),/too large/);
});
test('sync fixture: durable queue retries same operation, binds account, detects conflict and requires consent', async () => {
  let records=[],attempts=0,seen=[];
  const queue=new MetadataQueue({load:async()=>structuredClone(records),save:async value=>{records=structuredClone(value)},transport:async op=>{seen.push(op.operationId);if(++attempts===1)throw new Error('offline');return {ok:true,revision:1}}});
  const op=await queue.enqueue({subject:'user-a',project:'project-a',localId:'local',name:'Metadata only',expectedRevision:0});
  await assert.rejects(()=>queue.flush({subject:'user-a',approved:false}),/approval/);
  await queue.flush({subject:'user-b',approved:true}); assert.equal(attempts,0);
  await assert.rejects(()=>queue.flush({subject:'user-a',approved:true}),/offline/); assert.equal(records[0].operationId,op.operationId);
  await queue.flush({subject:'user-a',approved:true}); assert.equal(records.length,0); assert.equal(seen[0],seen[1]);
  queue.transport=async()=>({ok:false,conflict:true,actual:4}); await queue.enqueue({subject:'a',project:'p',localId:'l',name:'n',expectedRevision:0});await queue.flush({subject:'a',approved:true});assert.equal(records[0].state,'conflict');assert.equal(queue.status,'conflict');
});
test('sync fixture: concurrent enqueues preserve every durable operation', async () => {
 let records=[];
 const queue=new MetadataQueue({load:async()=>structuredClone(records),save:async value=>{await new Promise(r=>setTimeout(r,2));records=structuredClone(value)},transport:async()=>({ok:true})});
 await Promise.all(['a','b','c'].map(localId=>queue.enqueue({subject:'u',project:'p',localId,name:localId,expectedRevision:0})));
 assert.deepEqual(records.map(r=>r.localId),['a','b','c']);
});
