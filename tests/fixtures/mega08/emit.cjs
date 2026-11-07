// MOCK fixture for MEGA-08 broker tests. Deterministic, local, no network. Usage: node emit.cjs <mode>
'use strict';
const {spawn} = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const mode = process.argv[2];
const sleeper = ['-e', 'setTimeout(() => {}, 120000)'];
switch (mode) {
  case 'streams':
    process.stdout.write('MOCK out-1\n');
    process.stderr.write('MOCK err-1\n');
    process.stdout.write('MOCK out-2 żółć 日本語 ✓\n');
    break;
  case 'exit3':
    process.stdout.write('MOCK failing\n');
    process.exitCode = 3;
    break;
  case 'sleep':
    process.stdout.write('MOCK sleeping\n');
    setTimeout(() => {}, 120000);
    break;
  case 'tree': {
    const child = spawn(process.execPath, sleeper, {stdio: 'ignore'});
    process.stdout.write(`MOCK child=${child.pid}\n`);
    setTimeout(() => {}, 120000);
    break;
  }
  case 'orphan': {
    // Detached + unref: the child outlives this process but stays inside the Job Object.
    const child = spawn(process.execPath, sleeper, {stdio: 'ignore', detached: true});
    child.unref();
    process.stdout.write(`MOCK child=${child.pid}\n`);
    // Exit shortly after, leaving the child behind for the broker to clean up.
    setTimeout(() => process.exit(0), 1500);
    break;
  }
  case 'flood': {
    const line = 'MOCK ' + 'x'.repeat(94) + '\n';
    for (let i = 0; i < 12000; i++) process.stdout.write(line);
    break;
  }
  case 'secret':
    // Synthetic credential shapes only; none of these is a real key.
    process.stdout.write('MOCK key sk-ant-api03-FAKEFAKEFAKEFAKEFAKE0000\n');
    process.stdout.write('MOCK Authorization: Bearer FAKEtoken0123456789abcdefFAKE\n');
    process.stdout.write('MOCK password=hunter2-not-real-0000\n');
    process.stdout.write('MOCK commit 0123456789abcdef0123456789abcdef01234567\n');
    break;
  case 'stdin': {
    const chunks = [];
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => {
      const data = Buffer.concat(chunks);
      process.stdout.write(`MOCK stdin bytes=${data.length} sha256=${crypto.createHash('sha256').update(data).digest('hex')}\n`);
    });
    break;
  }
  case 'write':
    fs.writeFileSync('mega08-out.txt', 'MOCK written by a synthetic run\n');
    process.stdout.write('MOCK wrote mega08-out.txt\n');
    break;
  case 'env':
    process.stdout.write(`MOCK env-count=${Object.keys(process.env).length} has-path=${'PATH' in process.env || 'Path' in process.env}\n`);
    break;
  default:
    process.stderr.write(`MOCK unknown mode ${mode}\n`);
    process.exitCode = 2;
}
