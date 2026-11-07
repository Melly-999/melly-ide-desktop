import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir, mkdtemp} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {diagnoseShell} from '../js/offline.js';
import {buildPrivatePreview, PREVIEW_ASSETS} from '../scripts/build-private-preview.mjs';
import {SHELL_ASSETS} from '../js/offline-shell.js';
test('UX02 original icon bytes are preserved and the new Dashboard headline is literal',async()=>{
 const source=await readFile(new URL('../images/brand/approved-orbit-option-2-original.png',import.meta.url));
 assert.equal(createHash('sha256').update(source).digest('hex'),'9e66ede4118f6157a8e5db1ba6d435294d930c3b822d9a9846bce5c9df5f1fb2');
 const screen=await readFile(new URL('../js/dashboard.js',import.meta.url),'utf8');assert.match(screen,/<h1 tabindex="-1">Hello World<\/h1>/);assert.doesNotMatch(screen,/Good morning|Good evening/);
});
test('UX02 preview builder rejects the repo and an existing destination without changing it',async()=>{
 await assert.rejects(buildPrivatePreview(fileURLToPath(new URL('../',import.meta.url))),/outside the repository/);
 const dir=await mkdtemp(join(tmpdir(),'melly-ux02-refusal-'));await assert.rejects(buildPrivatePreview(dir),/EEXIST/);assert.deepEqual(await readdir(dir),[]);
});
test('UX02 read-only diagnostics identify exact asset HTTP/MIME failures and omit credentials',async()=>{
 const results=await diagnoseShell('https://example.test/ide/',async(url,options)=>{
  assert.equal(options.method,'HEAD');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  if(url.endsWith('js/app.js')) return new Response('',{status:502,headers:{'content-type':'text/html'}});
  const type=url.endsWith('.png')?'image/png':url.endsWith('.css')?'text/css':url.endsWith('.html')?'text/html':url.endsWith('.webmanifest')?'application/manifest+json':'text/javascript';
  return new Response('',{headers:{'content-type':type}});
 });
 assert.equal(results.length,SHELL_ASSETS.length);assert.deepEqual(results.filter(r=>!r.valid),[{asset:'js/app.js',status:502,type:'text/html',valid:false}]);assert.ok(PREVIEW_ASSETS.includes('sw.js'));
});
