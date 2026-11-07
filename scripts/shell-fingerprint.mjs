// Content fingerprint of the offline shell. A changed fingerprint with an unchanged
// SHELL_VERSION means installed clients would keep stale assets (complete caches are immutable).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { SHELL_ASSETS, SHELL_VERSION } from '../js/offline-shell.js';

const root = new URL('../', import.meta.url);
const binary = asset => asset.endsWith('.png');

export function shellFingerprint(read = asset => readFileSync(new URL(asset, root))) {
  const hash = createHash('sha256');
  for (const asset of [...SHELL_ASSETS].sort()) {
    let bytes = read(asset);
    if (!binary(asset)) {
      // Git may check text out with CRLF on Windows; fingerprint the LF form.
      let text = bytes.toString('utf8').replace(/\r\n/g, '\n');
      if (asset === 'js/offline-shell.js') text = text.replace(SHELL_VERSION, '<SHELL_VERSION>');
      bytes = Buffer.from(text, 'utf8');
    }
    hash.update(asset).update('\0').update(bytes).update('\0');
  }
  return { version: SHELL_VERSION, assetCount: SHELL_ASSETS.length, sha256: hash.digest('hex') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(shellFingerprint(), null, 2));
}
