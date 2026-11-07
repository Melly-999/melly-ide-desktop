import { ConvexError, v } from 'convex/values';
import { query } from './_generated/server.js';
declare const process: {env: Record<string,string | undefined>};

// Read-only identity probe: no project/source synchronization or client-owned IDs.
export const identity = query({
  args:{},
  returns:v.object({principal:v.string(),subject:v.string(),issuer:v.string(),displayName:v.union(v.string(),v.null()),plan:v.literal('free'),syncEnabled:v.literal(false)}),
  handler:async ctx=>{
    const user=await ctx.auth.getUserIdentity();
    if(!user)throw new ConvexError('UNAUTHENTICATED');
    const expected=process.env.CLERK_JWT_ISSUER_DOMAIN;
    if(!expected || !/^https:\/\/[a-z0-9-]+\.clerk\.accounts\.dev$/.test(expected))throw new ConvexError('AUTH_DEV_CONFIG_REQUIRED');
    if(user.issuer!==expected || !user.subject || !user.tokenIdentifier)throw new ConvexError('UNAUTHORIZED_IDENTITY');
    return {principal:user.tokenIdentifier,subject:user.subject,issuer:user.issuer,displayName:typeof user.name==='string'?user.name.slice(0,100):null,plan:'free' as const,syncEnabled:false as const};
  }
});
