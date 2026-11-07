// This small build boundary is bundled to sdk.js; the app stays vanilla JavaScript.
import { Clerk } from '@clerk/clerk-js';
import { ConvexClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
export function createClerk(key) { return new Clerk(key); }
export function createIdentityClient(url) {
  const client = new ConvexClient(url, {unsavedChangesWarning:false, logger:false});
  const identity = makeFunctionReference('account:identity');
  return {setAuth:(fetchToken,onChange)=>client.setAuth(fetchToken,onChange), readIdentity:()=>client.query(identity,{}), ai:(method,args)=>{const ref=makeFunctionReference('ai:'+method);return ['catalog','complete'].includes(method)?client.action(ref,args):method==='removeHistory'?client.mutation(ref,args):client.query(ref,args);}, close:()=>client.close()};
}

globalThis.__MELLY_AUTH_SDK__ = {createClerk,createIdentityClient};
