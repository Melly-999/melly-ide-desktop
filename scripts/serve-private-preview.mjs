// Operator-started loopback server. Does not configure Tailscale or expose the source tree.
import { createServer } from 'node:http';
import {readFileSync} from 'node:fs';
import {parsePublicConfigModule,authCSP} from './auth/public-config.mjs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREVIEW_ASSETS } from './build-private-preview.mjs';
const allowed = new Set(PREVIEW_ASSETS);
const mime = {html:'text/html',js:'text/javascript',css:'text/css',png:'image/png',webmanifest:'application/manifest+json',txt:'text/plain'};
export function previewServer(directory) {
  const config=parsePublicConfigModule(readFileSync(join(directory,'js/auth/public-config.js'),'utf8'));
  const policy=authCSP(config);
  return createServer(async (req,res) => {
    const raw = req.url.split('?')[0];
    const asset = raw === '/' ? 'index.html' : raw.slice(1);
    if (!['GET','HEAD'].includes(req.method) || !allowed.has(asset)) { res.writeHead(404).end(); return; }
    try {
      const body = await readFile(join(directory,asset));
      res.writeHead(200, {'Content-Type':mime[asset.split('.').at(-1)], 'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer', 'Content-Security-Policy':policy});
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404).end(); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Supply the sanitized preview directory.');
  const server = previewServer(resolve(process.argv[2]));
  server.listen(Number(process.env.PORT || 4181),'127.0.0.1',()=>console.log(`Private preview on http://127.0.0.1:${server.address().port}`));
}
