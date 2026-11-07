import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHELL_ASSETS, SHELL_VERSION, shellCacheName, shellURLs, inspectShell, shellRequestKey
} from '../js/offline-shell.js';
import { installShell, activateShell, serveShell } from '../sw.js';
import { supportsOffline, OfflineShellStatus, queryShell } from '../js/offline.js';

const scope = 'https://melly.test/ide/';
const root = fileURLToPath(new URL('../', import.meta.url));
function fakeStorage(options = {}) {
  const data = new Map(); const deleted = []; const requests = [];
  const storage = {
    data, deleted, requests,
    async keys() { return [...data.keys()]; },
    async delete(name) { deleted.push(name); return data.delete(name); },
    async open(name) {
      if (!data.has(name)) data.set(name, new Map());
      const records = data.get(name);
      return {
        async match(key) { return records.get(typeof key === 'string' ? key : key.url)?.clone(); },
        async addAll(batch) {
          requests.push(...batch);
          if (options.fail) throw new TypeError('Essential asset unavailable');
          for (const request of batch) {
            const url = request.url;
            const type = options.badType ? 'text/html' : url.endsWith('.webmanifest') ? 'application/manifest+json' : url.endsWith('.png') ? 'image/png' : url.endsWith('.css') ? 'text/css' : url.endsWith('.js') ? 'text/javascript' : 'text/html';
            records.set(url, new Response('bundled resource', { headers: {'content-type':type} }));
          }
        }
      };
    }
  };
  return storage;
}
test('T1.1 inventory contains the complete actual entry/module/stylesheet graph', () => {
  const found = new Set(['index.html']); const visit = name => {
    const source = readFileSync(resolve(root, name), 'utf8');
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
      if (!match[1].startsWith('.')) continue;
      const child = resolve(root, dirname(name), match[1]).slice(root.length).replaceAll('\\', '/');
      if (!found.has(child)) { found.add(child); visit(child); }
    }
  };
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"<>]+)"/g)) {
    if (/^(?:data:|https?:)/.test(match[1])) continue;
    found.add(match[1]); if (match[1].endsWith('.js')) visit(match[1]);
  }
  for (const icon of JSON.parse(readFileSync(resolve(root, 'manifest.webmanifest'), 'utf8')).icons) found.add(icon.src);
  assert.deepEqual([...SHELL_ASSETS].sort(), [...found].sort());
  assert.equal(new Set(SHELL_ASSETS).size, SHELL_ASSETS.length);
  for (const name of SHELL_ASSETS) {
    assert.ok(readFileSync(resolve(root, name)).length > 0);
    assert.doesNotMatch(name, /(?:\.env|credentials|tests\/|https?:)/);
  }
  assert.match(html, /images\/melly-48\.png/);
  assert.doesNotMatch(html, /data:image\/svg/);
});
test('T1.1 complete installation confirms every resource without credentials', async () => {
  const storage = fakeStorage(); await installShell(storage, scope);
  const status = await inspectShell(storage, scope);
  assert.equal(status.ready, true); assert.equal(status.assetCount, SHELL_ASSETS.length);
  assert.deepEqual(status.missing, []);
  for (const request of storage.requests) {
    assert.equal(request.credentials, 'omit'); assert.equal(request.cache, 'reload'); assert.equal(request.redirect, 'error');
  }
});
test('T1.1 failed install deletes only its incomplete candidate and retains older working cache', async () => {
  const storage = fakeStorage({fail:true});
  const old = shellCacheName(scope, 'v0-20261021'); storage.data.set(old, new Map([['sentinel','keep']]));
  storage.data.set('unrelated-cache', new Map());
  await assert.rejects(installShell(storage, scope), /Essential asset/);
  assert.deepEqual(storage.deleted, [shellCacheName(scope)]);
  assert.equal(storage.data.get(old).get('sentinel'), 'keep');
  assert.equal((await inspectShell(storage, scope)).ready, false);
});
test('T1.1 HTML fallback in place of a module or stylesheet is rejected', async () => {
  const storage = fakeStorage({badType:true});
  await assert.rejects(installShell(storage, scope), /Incomplete or invalid/);
  assert.equal((await inspectShell(storage, scope)).ready, false);
});
test('T1.1 same-version reinstall cannot replace a complete immutable cache', async () => {
  const storage = fakeStorage(); await installShell(storage, scope); const count = storage.requests.length;
  await installShell(storage, scope); assert.equal(storage.requests.length, count); assert.deepEqual(storage.deleted, []);
});
test('T1.1 missing entry cannot be reported ready', async () => {
  const storage = fakeStorage(); await installShell(storage, scope);
  const missing = shellURLs(scope).at(-1); storage.data.get(shellCacheName(scope)).delete(missing);
  assert.deepEqual((await inspectShell(storage, scope)).missing, [missing]);
});
test('T1.1 activation cleans only strictly named caches for this application scope', async () => {
  const storage = fakeStorage(); await installShell(storage, scope);
  const old = shellCacheName(scope, 'v0-20261021');
  const retained = ['unrelated-cache', shellCacheName('https://melly.test/other/'), shellCacheName(scope) + ':user-data'];
  for (const name of [old, ...retained]) storage.data.set(name, new Map());
  await activateShell(storage, scope);
  assert.deepEqual(storage.deleted, [old]); for (const name of retained) assert.ok(storage.data.has(name));
  assert.notEqual(shellCacheName(scope), shellCacheName(scope, 'v2-20261022'));
});
test('T1.1 incomplete activation never cleans the previous cache', async () => {
  const storage = fakeStorage(); storage.data.set(shellCacheName(scope, 'v0-20261021'), new Map());
  await assert.rejects(activateShell(storage, scope), /incomplete/); assert.deepEqual(storage.deleted, []);
});
test('T1.1 offline entry navigation and known modules use the same cached generation', async () => {
  const storage = fakeStorage(); await installShell(storage, scope);
  const request = {method:'GET',mode:'navigate',url:scope + '?view=editor'};
  assert.equal(shellRequestKey(request, scope), scope+'index.html');
  assert.equal(await (await serveShell(request, storage, scope)).text(), 'bundled resource');
  assert.equal((await serveShell(new Request(scope+'js/app.js'), storage, scope)).status, 200);
});
test('T1.1 external, non-shell, non-GET and range requests are not intercepted', async () => {
  const storage = fakeStorage();
  for (const request of [new Request('https://other.test/api'),new Request(scope+'api/private'),new Request(scope+'js/app.js?user=secret'),new Request(scope+'index.html',{method:'POST'}),new Request(scope+'js/app.js',{headers:{Range:'bytes=0-10'}})]) {
    assert.equal(await serveShell(request, storage, scope), null);
  }
  assert.deepEqual(await storage.keys(), []);
});
test('T1.1 missing cached assets fail closed instead of falling back to mixed network files', async () => {
  const response = await serveShell(new Request(scope+'js/app.js'), fakeStorage(), scope);
  assert.equal(response.status, 503);
});

function clientFixture(options = {}) {
  const listeners = new Map(); const calls = [];
  const active = {state:'activated'};
  const registration = {active, waiting:null, installing:null, addEventListener:(key,fn)=>listeners.set(key,fn)};
  const element = {dataset:{},textContent:'',title:''};
  const env = {isSecureContext:true,navigator:{serviceWorker:{controller:null,register:async(...args)=>{calls.push(args);return registration},addEventListener(){}}},addEventListener(){},setTimeout:()=>0,clearTimeout(){}};
  const client = new OfflineShellStatus(element, {env,baseURL:scope,probe:async()=>({ready:true,version:SHELL_VERSION}),...options});
  return {client,element,env,registration,calls,listeners};
}
test('T1.1 unsupported and insecure environments never attempt registration', async () => {
  assert.equal(supportsOffline({isSecureContext:false,navigator:{serviceWorker:{register(){}}}}),false);
  assert.equal(supportsOffline({isSecureContext:true,navigator:{}}),false);
  const f=clientFixture();f.env.isSecureContext=false;await f.client.start();
  assert.equal(f.element.dataset.state,'unsupported');assert.equal(f.calls.length,0);assert.equal(f.element.dataset.ready,'false');
});
test('T1.1 registration uses module-relative script, explicit matching scope and fresh update fetches', async () => {
  const f=clientFixture();await f.client.start();
  assert.deepEqual(f.calls, [[scope+'sw.js',{scope,type:'module',updateViaCache:'none'}]]);
  assert.equal(f.element.dataset.state,'ready');assert.match(f.element.textContent,/File saves are separate/);
});
test('T1.1 readiness requires a positive cache probe for the expected version', async () => {
  for(const [report,state] of [[{ready:false,version:SHELL_VERSION},'failed'],[{ready:true,version:'v0-20261021'},'mismatch']]) {
    const f=clientFixture({probe:async()=>report});await f.client.start();
    assert.equal(f.element.dataset.state,state);assert.equal(f.element.dataset.ready,'false');
  }
});
test('T1.1 a waiting update is announced without activating or reloading an editor', async () => {
  const f=clientFixture();f.registration.waiting={};await f.client.start();
  assert.equal(f.element.dataset.state,'update');assert.match(f.element.textContent,/Save your files.*close all/);
  assert.equal(f.element.dataset.ready,'true');
});
test('T1.1 installation failure, registration rejection and cache probe failure stay truthful', async () => {
  const f=clientFixture();f.env.navigator.serviceWorker.register=async()=>{throw new Error('Registration denied')};
  await f.client.start();assert.equal(f.element.dataset.state,'failed');assert.equal(f.element.title,'Registration denied');
  const g=clientFixture({probe:async()=>{throw new Error('Cache read denied')}});await g.client.start();assert.equal(g.element.dataset.ready,'false');
});
test('T1.1 a failed replacement can preserve confirmed readiness of the existing shell', async () => {
  const f=clientFixture();await f.client.start();f.client.failedUpdate=true;await f.client.refresh();
  assert.equal(f.element.dataset.state,'update-failed');assert.equal(f.element.dataset.ready,'true');
});
test('T1.1 out-of-order probes cannot overwrite a newer failed-readiness result', async () => {
  const f=clientFixture();await f.client.start();let first;
  f.client.probe=()=>new Promise(resolve=>{first=resolve});const pending=f.client.refresh();
  f.client.probe=async()=>({ready:false,version:SHELL_VERSION});await f.client.refresh();
  first({ready:true,version:SHELL_VERSION});await pending;assert.equal(f.element.dataset.state,'failed');
});
test('T1.1 worker confirmation protocol rejects silence and accepts a real reply', async () => {
  const reply = await queryShell({postMessage(data,ports){ports[0].postMessage({type:data.type,ready:true,version:SHELL_VERSION})}});
  assert.equal(reply.ready,true);
  await assert.rejects(queryShell({postMessage(){}},globalThis,10),/timed out/);
});
test('T1.1 shell code has no editor-data mutation or forced update path', () => {
  for(const name of ['sw.js','js/offline-shell.js','js/offline.js']) {
    const source=readFileSync(resolve(root,name),'utf8');
    assert.doesNotMatch(source,/\b(?:indexedDB|localStorage)\b|skipWaiting\s*\(|clients\.claim\s*\(|location\.reload\s*\(/);
  }
});
