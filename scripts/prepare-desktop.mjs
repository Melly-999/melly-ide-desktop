import {copyFile, lstat, mkdir, readdir, writeFile} from 'node:fs/promises';
import {dirname, join, posix, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EMPTY_AUTH_CONFIG, publicConfigModule} from '../js/auth/config.js';
import {SHELL_ASSETS} from '../js/offline-shell.js';

const root = fileURLToPath(new URL('../', import.meta.url));
export const DESKTOP_ASSETS = Object.freeze([...SHELL_ASSETS, 'sw.js']);
const allowedFiles = new Set(DESKTOP_ASSETS);
const allowedDirectories = new Set();
for (const asset of DESKTOP_ASSETS) {
  for (let parent = posix.dirname(asset); parent !== '.'; parent = posix.dirname(parent)) {
    allowedDirectories.add(parent);
  }
}

async function validateStaging(directory, prefix = '') {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const relative = prefix + entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory() && allowedDirectories.has(relative)) {
      await validateStaging(absolute, relative + '/');
    } else if (!entry.isFile() || !allowedFiles.has(relative) || (await lstat(absolute)).nlink !== 1) {
      throw new Error('Unexpected desktop staging entry: ' + relative + '. Use a fresh desktop-dist directory.');
    }
  }
}

export async function prepareDesktop(source = root, target = join(root, 'desktop-dist')) {
  await mkdir(target, {recursive: true});
  if (!(await lstat(target)).isDirectory()) throw new Error('Desktop staging must be a real directory.');
  // Tauri embeds the entire directory. Reject stale SDKs and unexpected files before writing.
  await validateStaging(target);
  for (const asset of DESKTOP_ASSETS) {
    const output = join(target, asset);
    await mkdir(dirname(output), {recursive: true});
    if (asset === 'js/auth/public-config.js') {
      await writeFile(output, publicConfigModule(EMPTY_AUTH_CONFIG));
    } else {
      await copyFile(join(source, asset), output);
    }
  }
  await validateStaging(target);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareDesktop();
  console.log('Prepared ' + DESKTOP_ASSETS.length + ' offline-first desktop assets. Private-preview SDK excluded.');
}
