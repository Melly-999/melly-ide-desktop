// MOCK Claude Code CLI for MEGA-08 tests. Never contacts a model. Prints a version and help text
// containing the flags Melly verifies, and in -p mode reads the task from stdin and emits
// stream-json-shaped MOCK events. The task chooses the behaviour: MODE=fail|malformed|slow|edit.
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
if (args[0] === '--version') { process.stdout.write(process.env.MELLY_FAKE_VERSION || '9.9.9 (Claude Code)\n'); process.exit(0); }
if (args[0] === '--help') {
  process.stdout.write(`MOCK Usage: claude [options] [prompt]
  -p, --print   Print response and exit
  --output-format <format>  (choices: "text", "json", "stream-json")
  --verbose
  --permission-mode <mode>  Permission mode (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")
  --permission-prompts <target>  "host" or "none"
  --restricted
  --strict-mcp-config
  --no-session-persistence
  --tools <tools...>  Specify the list of available tools from the built-in set
  --model <model>  Model for the current session
`);
  process.exit(0);
}
if (!args.includes('-p')) { process.stderr.write('MOCK interactive mode is not supported\n'); process.exit(64); }
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const task = Buffer.concat(chunks).toString('utf8');
  const mode = (/MODE=(\w+)/.exec(task) || [])[1] || 'ok';
  out({type: 'system', subtype: 'init', session_id: 'mock-session', model: 'MOCK', permissionMode: args[args.indexOf('--permission-mode') + 1], mock: true});
  if (mode === 'malformed') { process.stdout.write('MOCK this is not json\n{"type":"assistant","message":\n'); process.exit(0); }
  out({type: 'assistant', message: {content: [{type: 'text', text: `MOCK received ${task.length} bytes`}, {type: 'tool_use', id: 't1', name: 'Read', input: {file_path: 'README.md'}}]}});
  out({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 't1', content: 'MOCK file text'}]}});
  if (mode === 'edit') fs.writeFileSync('mock-agent-edit.txt', 'MOCK edit\n');
  if (mode === 'slow') { setTimeout(() => {}, 120000); return; }
  if (mode === 'fail') {
    out({type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, result: 'MOCK failure', permission_denials: [{tool_name: 'Bash'}]});
    process.exit(1);
  }
  out({type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'MOCK done', permission_denials: [{tool_name: 'WebFetch'}], duration_ms: 12});
  process.exit(0);
});
