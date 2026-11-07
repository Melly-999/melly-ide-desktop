import { mkdir, readFile, writeFile, copyFile, mkdtemp } from 'node:fs/promises';
import { dirname, resolve, relative, sep, join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {readPublicAuthEnv} from './auth/local-public-config.mjs';
import {authConfigFromEnv,publicConfigModule,AUTH_RUNTIME_ASSETS} from './auth/public-config.mjs';
import {validateAuthConfig} from '../js/auth/config.js';
import { SHELL_ASSETS, SHELL_VERSION } from '../js/offline-shell.js';
const root = fileURLToPath(new URL('../', import.meta.url));
export const PREVIEW_ASSETS = Object.freeze([...SHELL_ASSETS, ...AUTH_RUNTIME_ASSETS, 'sw.js']);
export async function buildPrivatePreview(output, {authConfig=authConfigFromEnv(process.env)}={}) {
  const check=validateAuthConfig(authConfig, authConfig?.convexUrl);
  if(!check.ready && check.reason!=='OWNER_SETUP_REQUIRED')throw new Error(check.reason);
  const version=check.ready?`v${BigInt('0x'+createHash('sha256').update(SHELL_VERSION+JSON.stringify(authConfig)).digest('hex').slice(0,16)).toString()}-20261022`:SHELL_VERSION;
  const target = output ? resolve(output) : await mkdtemp(join(tmpdir(), 'melly-private-preview-'));
  const rel = relative(root, target);
  if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))) {
    throw new Error('Preview must be outside the repository.');
  }
  // An explicit destination must be new; never blend generations or overwrite an operator preview.
  if (output) await mkdir(target, { recursive:false });
  const manifest = { version, authConfigured:check.ready, assets:[] };
  for (const asset of PREVIEW_ASSETS) {
    if (!/^(?:index\.html|manifest\.webmanifest|sw\.js|(?:js|styles|images|runtime)\/[a-zA-Z0-9_./-]+)$/.test(asset) || asset.includes('..')) throw new Error('Unsafe preview inventory entry');
    let bytes = await readFile(join(root, asset));
    if(asset==='js/auth/public-config.js')bytes=Buffer.from(publicConfigModule(authConfig));
    if(asset==='js/offline-shell.js' && version!==SHELL_VERSION)bytes=Buffer.from(bytes.toString('utf8').replace(SHELL_VERSION,version));
    const dest = join(target, asset); await mkdir(dirname(dest), {recursive:true}); await writeFile(dest,bytes);
    const copied = await readFile(dest), sha256 = createHash('sha256').update(bytes).digest('hex');
    if (createHash('sha256').update(copied).digest('hex') !== sha256) throw new Error('Preview copy verification failed');
    manifest.assets.push({ path:asset, bytes:bytes.length, sha256 });
  }
  // Evidence goes beside the served directory, never inside the app's static inventory.
  await writeFile(target + '.manifest.json', JSON.stringify(manifest,null,2) + '\n');
  return { path:target, manifest };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const publicEnv = await readPublicAuthEnv(join(root,'.env.local'));
  const result = await buildPrivatePreview(process.argv[2],{authConfig:authConfigFromEnv(publicEnv)});
  console.log(JSON.stringify({path:result.path,version:result.manifest.version,authConfigured:result.manifest.authConfigured,files:result.manifest.assets.length}));
}
