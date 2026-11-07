export const EMPTY_AUTH_CONFIG = Object.freeze({environment:'development', convexUrl:'', clerkPublishableKey:'', clerkIssuer:'', dedicatedAppConfirmed:false, tokenMode:'integration'});

// Public build settings only. A valid config enables an SDK, never grants an identity.
export function validateAuthConfig(value, approvedDevUrl = '') {
  const fields = Object.keys(EMPTY_AUTH_CONFIG);
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !fields.includes(key))) return {ready:false, reason:'INVALID_PUBLIC_CONFIG'};
  if (!value.clerkPublishableKey && !value.clerkIssuer) return {ready:false, reason:'OWNER_SETUP_REQUIRED'};
  if (value.environment !== 'development' || value.convexUrl !== approvedDevUrl || typeof approvedDevUrl !== 'string' || !/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)?\.convex\.cloud$/.test(approvedDevUrl) || value.dedicatedAppConfirmed !== true) return {ready:false, reason:'DEDICATED_DEV_CONFIG_REQUIRED'};
  if (!/^pk_test_[A-Za-z0-9+/=_-]+$/.test(value.clerkPublishableKey || '') || !['integration','template'].includes(value.tokenMode)) return {ready:false, reason:'INVALID_DEV_CONFIG'};
  try {
    const issuer = new URL(value.clerkIssuer);
    if (issuer.protocol !== 'https:' || issuer.origin !== value.clerkIssuer || !/^[a-z0-9-]+\.clerk\.accounts\.dev$/.test(issuer.hostname)) return {ready:false, reason:'INVALID_DEV_ISSUER'};
    const encoded = value.clerkPublishableKey.slice('pk_test_'.length).replaceAll('-','+').replaceAll('_','/');
    if (atob(encoded) !== issuer.hostname + '$') return {ready:false, reason:'KEY_ISSUER_MISMATCH'};
    return {ready:true, config:Object.freeze({...value})};
  } catch { return {ready:false, reason:'INVALID_DEV_CONFIG'}; }
}

export function publicConfigModule(config) { return 'export const PUBLIC_AUTH_CONFIG = ' + JSON.stringify(config) + ';\n'; }
export function parsePublicConfigModule(source) {
  const prefix = 'export const PUBLIC_AUTH_CONFIG = ';
  if (!source.startsWith(prefix) || !/;\s*$/.test(source)) throw new Error('Invalid public auth module');
  const config = JSON.parse(source.slice(prefix.length).replace(/;\s*$/, ''));
  // The caller reads the owner-generated static module, never a request parameter.
  const checked = validateAuthConfig(config, config?.convexUrl);
  if (!checked.ready && checked.reason !== 'OWNER_SETUP_REQUIRED') throw new Error(checked.reason);
  return config;
}
