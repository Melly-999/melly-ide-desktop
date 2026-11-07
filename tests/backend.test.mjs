import test from 'node:test';
import assert from 'node:assert/strict';
import {defineTestApp} from 'convex-test';
import schema from '../convex/schema.ts';
import * as workspaces from '../convex/workspaces.ts';
import * as tasks from '../convex/tasks.ts';
import * as memory from '../convex/memory.ts';
const {api,createTest}=defineTestApp({schema}).defineModules({workspaces,tasks,memory});
async function setup(){const t=createTest();const a=t.withIdentity({subject:'a',issuer:'https://identity.test'}), b=t.withIdentity({subject:'b',issuer:'https://identity.test'});const [orgA]=await a.mutation(api.workspaces.initializeAccount,{}),[orgB]=await b.mutation(api.workspaces.initializeAccount,{});const project=await a.mutation(api.workspaces.createProject,{organization:orgA,name:'Project A'});return {t,a,b,orgA,orgB,project};}
test('Convex emulator: unauthenticated and cross-tenant reads/writes are denied',async()=>{
 const {t,a,b,orgA,project}=await setup();await assert.rejects(()=>t.query(api.workspaces.listProjects,{organization:orgA}),/UNAUTHENTICATED/);
 await assert.rejects(()=>b.query(api.workspaces.listProjects,{organization:orgA}),/FORBIDDEN/);await assert.rejects(()=>b.query(api.workspaces.listMetadata,{project}),/FORBIDDEN/);
 await assert.rejects(()=>b.mutation(api.workspaces.syncMetadata,{project,localId:'l',name:'bad',expectedRevision:0,operationId:'bad'}),/FORBIDDEN/);
 assert.equal((await a.query(api.workspaces.listProjects,{organization:orgA})).length,1);
});
test('Convex emulator: claimed user/role/entitlement are rejected by argument validators',async()=>{
 const {a,orgA}=await setup();for(const field of ['userId','role','entitlement','tenantId'])await assert.rejects(()=>a.mutation(api.workspaces.createProject,{organization:orgA,name:'bad',[field]:'owner'}));
 assert.equal((await a.query(api.workspaces.entitlement,{organization:orgA})).tier,'free');
});
test('Convex emulator: metadata idempotency, conflicting revision and unrelated tenant',async()=>{
 const {a,project}=await setup();const args={project,localId:'local',name:'Metadata',expectedRevision:0,operationId:'op-1'};
 const first=await a.mutation(api.workspaces.syncMetadata,args);assert.equal(first.revision,1);assert.deepEqual(await a.mutation(api.workspaces.syncMetadata,args),first);
 await assert.rejects(()=>a.mutation(api.workspaces.syncMetadata,{...args,name:'Changed payload'}),/IDEMPOTENCY_KEY_REUSED/);
 const conflict=await a.mutation(api.workspaces.syncMetadata,{...args,operationId:'op-2'});assert.deepEqual(conflict,{ok:false,conflict:true,actual:1});
 assert.equal((await a.query(api.workspaces.listMetadata,{project}))[0].name,'Metadata');
});
test('Convex emulator: viewer cannot write, and project membership cannot bypass tenant membership',async()=>{
 const {t,a,b,orgA,project}=await setup();
 await t.run(async ctx=>{const users=await ctx.db.query('users').collect();const user=users.find(u=>u.identity.endsWith('|b'));await ctx.db.insert('memberships',{organization:orgA,user:user._id,role:'viewer'});await ctx.db.insert('projectMemberships',{project,user:user._id,role:'owner'});});
 await assert.rejects(()=>b.mutation(api.tasks.submit,{project,instruction:'run'}),/FORBIDDEN/);
 assert.equal((await b.query(api.workspaces.listMetadata,{project})).length,0);
});
test('Convex emulator: approval is bound to pending task/revision and never executes',async()=>{
 const {a,b,project}=await setup();const task=await a.mutation(api.tasks.submit,{project,instruction:'Review local changes'});
 await assert.rejects(()=>b.mutation(api.tasks.decide,{task,expectedRevision:0,decision:'approved'}),/FORBIDDEN/);
 await assert.rejects(()=>a.mutation(api.tasks.decide,{task,expectedRevision:7,decision:'approved'}),/STALE_APPROVAL/);
 assert.deepEqual(await a.mutation(api.tasks.decide,{task,expectedRevision:0,decision:'approved'}),{status:'approved',execution:'DISCONNECTED'});
 await assert.rejects(()=>a.mutation(api.tasks.decide,{task,expectedRevision:0,decision:'approved'}),/STALE_APPROVAL/);
});
test('Convex emulator: memory tenant isolation, explicit sharing consent and revocation',async()=>{
 const {a,b,orgA,orgB,project}=await setup();const args={organization:orgA,project,scope:'shared',operation:'read',target:'klaus'};
 await assert.rejects(()=>a.query(api.memory.authorize,args),/CONSENT_REQUIRED/);await assert.rejects(()=>b.query(api.memory.authorize,args),/FORBIDDEN/);
 await a.mutation(api.memory.consent,{project,target:'klaus',allowed:true});const grant=await a.query(api.memory.authorize,args);assert.equal(grant.projectId,project);
 await assert.rejects(()=>a.query(api.memory.authorize,{...args,target:'mellycore'}),/CONSENT_REQUIRED/);
 await a.mutation(api.memory.consent,{project,target:'klaus',allowed:false});await assert.rejects(()=>a.query(api.memory.authorize,args),/CONSENT_REQUIRED/);
 await assert.rejects(()=>b.query(api.memory.authorize,{...args,organization:orgB,scope:'project'}),/FORBIDDEN/);
});
