import type { AuthConfig } from 'convex/server';
declare const process: {env: Record<string, string | undefined>};
// No default issuer and no reuse of another application's tokens. Deployment is a separate approval.
const issuer = process.env.CLERK_JWT_ISSUER_DOMAIN;
if (issuer && !/^https:\/\/[a-z0-9-]+\.clerk\.accounts\.dev$/.test(issuer)) throw new Error('Expected the dedicated Melly IDE Clerk DEV issuer URL');
export default {providers: issuer ? [{domain: issuer, applicationID: 'convex'}] : []} satisfies AuthConfig;
