import {EMPTY_AUTH_CONFIG,validateAuthConfig,publicConfigModule,parsePublicConfigModule} from '../../js/auth/config.js';
export {publicConfigModule,parsePublicConfigModule};
export function authConfigFromEnv(env){
  const key=env.CLERK_PUBLISHABLE_KEY||'',issuer=env.CLERK_JWT_ISSUER_DOMAIN||'';
  if(!key&&!issuer)return {...EMPTY_AUTH_CONFIG};
  const config={environment:'development',convexUrl:env.MELLY_CONVEX_URL||'',clerkPublishableKey:key,clerkIssuer:issuer,dedicatedAppConfirmed:env.MELLY_CLERK_APP_OWNER_CONFIRMED==='true',tokenMode:env.MELLY_CLERK_TOKEN_MODE||'integration'};
  const checked=validateAuthConfig(config, config.convexUrl);if(!checked.ready)throw new Error('Public auth configuration rejected: '+checked.reason);return checked.config;
}
export function authCSP(config){
  const checked=validateAuthConfig(config, config?.convexUrl),clerk=checked.ready?config.clerkIssuer:null;
  const script=["'self'"],connect=["'self'",'https://api.github.com'],img=["'self'",'data:'],worker=["'self'"],frame=["'self'"];
  if(clerk){script.push(clerk,'https://challenges.cloudflare.com','https://*.protect.clerk.com');connect.push(clerk,config.convexUrl,config.convexUrl.replace('https:','wss:'),'https://*.protect.clerk.com:*');img.push('https://img.clerk.com');worker.push('blob:');frame.push('https://challenges.cloudflare.com','https://*.protect.clerk.com');}
  return `default-src 'self'; script-src ${script.join(' ')}; style-src 'self' 'unsafe-inline'; img-src ${img.join(' ')}; connect-src ${connect.join(' ')}; worker-src ${worker.join(' ')}; frame-src ${frame.join(' ')}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`;
}
export const AUTH_RUNTIME_ASSETS=Object.freeze(['runtime/auth-sdk.js','runtime/auth-sdk.js.LEGAL.txt']);
