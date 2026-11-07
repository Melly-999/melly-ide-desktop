import test from 'node:test';
import assert from 'node:assert/strict';
import {CortexMemoryGateway,spaceId,sdkFactory} from '../server/cortex.ts';
import {adapters} from '../server/adapters.ts';
test('Cortex policy fixture: isolated spaces, review required, unsafe content and unapproved sharing denied',async()=>{
 const grant={tenantId:'t',userId:'u',projectId:'p',canWrite:true},calls=[];
 const factory=()=>({vector:{store:async(space,input)=>{calls.push({space,input});return {memoryId:'fixture'}},search:async(space)=>{calls.push({space});return []}},close(){}});
 const gateway=new CortexMemoryGateway(async request=>{if(request.scope==='shared')throw new Error('consent required');return grant},factory);
 await assert.rejects(()=>gateway.store({scope:'personal'},'Summary',false),/REVIEW_REQUIRED/);await assert.rejects(()=>gateway.store({scope:'personal'},'password="secret-value"',true),/UNSAFE/);
 await gateway.store({scope:'personal'},'Approved architecture convention',true);await gateway.search({scope:'project',projectId:'p'},'architecture');
 assert.notEqual(calls[0].space,calls[1].space);assert.notEqual(spaceId({scope:'personal'},grant),spaceId({scope:'personal'},{...grant,tenantId:'other'}));
 await assert.rejects(()=>gateway.search({scope:'project',projectId:'foreign'},'x'),/DENIED/);await assert.rejects(()=>gateway.search({scope:'shared',target:'klaus'},'x'),/consent/);
 assert.throws(()=>sdkFactory({convexUrl:'https://example.convex.cloud',authorizedDevelopmentInstance:false,serverIsolationVerified:false}),/BLOCKED/);
});
test('Cortex actual SDK: pinned package imports and no cloud client is created while disconnected',async()=>{
 const {Cortex}=await import('@cortexmemory/sdk');assert.equal(typeof Cortex,'function');
 assert.throws(()=>sdkFactory({convexUrl:'https://example.convex.cloud',authorizedDevelopmentInstance:true,serverIsolationVerified:false}),/BLOCKED/);
});
test('Cross-app adapter contracts reject execution, projection and Yuzuki sharing when disconnected',async()=>{
 for(const adapter of Object.values(adapters))assert.equal(adapter.status().connection,'disconnected');
 await assert.rejects(()=>adapters.klaus.submit({}),/DISCONNECTED/);await assert.rejects(()=>adapters.mellycore.projection(),/DISCONNECTED/);await assert.rejects(()=>adapters.yuzuki.shareApprovedContext('p','hash','consent'),/PRIVATE_SCOPE/);
});
