import test from 'node:test';
import assert from 'node:assert/strict';
import {initialRoute} from '../js/dashboard.js';
test('new session starts at Dashboard instead of onboarding',()=>assert.equal(initialRoute('',null),'dashboard'));
test('explicit supported links override an in-progress view',()=>{assert.equal(initialRoute('#tasks','code'),'tasks');assert.equal(initialRoute('#code','review'),'code');});
test('in-progress Code and Review survive reload without persisting arbitrary routes',()=>{for(const route of ['code','studio','review'])assert.equal(initialRoute('',route),route);assert.equal(initialRoute('','tasks'),'dashboard');});
test('untrusted or unknown links are not interpreted as navigation or execution',()=>{assert.equal(initialRoute('#javascript:alert(1)',null),'dashboard');assert.equal(initialRoute('#unknown','code'),'code');});

import {isPackagedDesktop, OfflineShellStatus} from '../js/offline.js';
test('native bundle status cannot be mistaken for confirmed browser offline cache',async()=>{
 const element={dataset:{},textContent:'',title:''};
 const env={__TAURI_INTERNALS__:{},location:{origin:'http://tauri.localhost'},navigator:{serviceWorker:{register(){throw new Error('must not register on the virtual host');}}}};
 await new OfflineShellStatus(element,{env}).start();
 assert.equal(element.dataset.state,'desktop');assert.equal(element.dataset.ready,'false');
 assert.equal(isPackagedDesktop({...env,location:{origin:'https://example.com'}}),false);
 assert.equal(isPackagedDesktop({location:{origin:'http://tauri.localhost'}}),false);
});
