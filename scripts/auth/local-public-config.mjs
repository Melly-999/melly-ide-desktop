// CLI-only input boundary. Never export arbitrary .env fields to the browser bundle.
import {readFile} from 'node:fs/promises';

export const PUBLIC_AUTH_ENV_NAMES=Object.freeze([
  'CLERK_PUBLISHABLE_KEY','CLERK_JWT_ISSUER_DOMAIN','MELLY_CONVEX_URL',
  'MELLY_CLERK_APP_OWNER_CONFIRMED','MELLY_CLERK_TOKEN_MODE'
]);

export function parsePublicAuthEnv(source) {
  const result={};
  for(const line of source.replace(/^\uFEFF/,'').split(/\r?\n/)) {
    const entry=line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if(!entry||!PUBLIC_AUTH_ENV_NAMES.includes(entry[1]))continue;
    const [,name,raw]=entry;
    if(Object.hasOwn(result,name))throw new Error('Duplicate public authentication setting: '+name);
    if(raw.startsWith('"')||raw.startsWith("'")) {
      const quoted=raw.match(/^(['"])(.*?)\1\s*(?:#.*)?$/);
      if(!quoted)throw new Error('Malformed public authentication setting: '+name);
      result[name]=quoted[2];
    } else result[name]=raw.replace(/\s+#.*$/,'').trim();
  }
  return result;
}

export async function readPublicAuthEnv(file,env=process.env) {
  let local={};
  try { local=parsePublicAuthEnv(await readFile(file,'utf8')); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  for(const name of PUBLIC_AUTH_ENV_NAMES)if(Object.hasOwn(env,name))local[name]=env[name];
  return local;
}
