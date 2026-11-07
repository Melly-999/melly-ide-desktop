// Emulator identities are fixtures; these tests do not validate a Clerk JWT or live DEV deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import {defineTestApp} from 'convex-test';
import schema from '../convex/schema.ts';
import * as account from '../convex/account.ts';
const {api,createTest}=defineTestApp({schema}).defineModules({account});
const issuer='https://melly-auth01-fixture.clerk.accounts.dev';
process.env.CLERK_JWT_ISSUER_DOMAIN=issuer;
test('AUTH01 emulator: anonymous identity probe is denied',async()=>{await assert.rejects(()=>createTest().query(api.account.identity,{}),/UNAUTHENTICATED/);});
test('AUTH01 emulator: A/B identities are server-owned and there is no record selector or update endpoint',async()=>{
 const t=createTest(),a=t.withIdentity({issuer,subject:'A',name:'Fixture A'}),b=t.withIdentity({issuer,subject:'B',name:'Fixture B'});
 const pa=await a.query(api.account.identity,{}),pb=await b.query(api.account.identity,{});
 assert.equal(pa.subject,'A');assert.equal(pb.subject,'B');assert.notEqual(pa.principal,pb.principal);assert.equal(pa.plan,'free');assert.equal(pa.syncEnabled,false);
 for(const id of ['userId','ownerId','principal','email','role','plan','profileId'])await assert.rejects(()=>b.query(api.account.identity,{[id]:pa.principal}));
 assert.deepEqual(await a.query(api.account.identity,{}),pa);assert.deepEqual(await b.query(api.account.identity,{}),pb);
 assert.equal(await t.run(async ctx=>(await ctx.db.query('users').collect()).length),0,'read-only probe does not provision accounts or synchronize data');
});
test('AUTH01 emulator: wrong issuer, empty subject and missing DEV issuer fail closed',async()=>{
 const t=createTest();await assert.rejects(()=>t.withIdentity({issuer:'https://foreign.test',subject:'A'}).query(api.account.identity,{}),/UNAUTHORIZED_IDENTITY/);
 await assert.rejects(()=>t.withIdentity({issuer,subject:''}).query(api.account.identity,{}),/UNAUTHORIZED_IDENTITY/);
 delete process.env.CLERK_JWT_ISSUER_DOMAIN;try{await assert.rejects(()=>t.withIdentity({issuer,subject:'A'}).query(api.account.identity,{}),/AUTH_DEV_CONFIG_REQUIRED/);}finally{process.env.CLERK_JWT_ISSUER_DOMAIN=issuer;}
});
