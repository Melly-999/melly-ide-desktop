import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {PUBLIC_AUTH_CONFIG} from '../js/auth/public-config.js';
import {authCSP,AUTH_RUNTIME_ASSETS} from '../scripts/auth/public-config.mjs';
import { SHELL_ASSETS } from '../js/offline-shell.js';
const root = new URL('../', import.meta.url);
const allowed = new Set([...SHELL_ASSETS, ...AUTH_RUNTIME_ASSETS, 'sw.js']);
const mime = {html:'text/html', js:'text/javascript', css:'text/css', svg:'image/svg+xml', png:'image/png', webmanifest:'application/manifest+json',txt:'text/plain'};
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!['GET', 'HEAD'].includes(request.method) || !allowed.has(path)) { response.writeHead(404).end(); return; }
    const body = await readFile(fileURLToPath(new URL(path, root)));
    response.writeHead(200, {'Content-Type': mime[path.split('.').at(-1)] || 'application/octet-stream', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'Content-Security-Policy':authCSP(PUBLIC_AUTH_CONFIG)});
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(400).end('Request unavailable'); }
});
server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => console.log(`Melly IDE local server: http://127.0.0.1:${server.address().port}`));
