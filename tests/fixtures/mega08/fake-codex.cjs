// MOCK Codex CLI for MEGA-08 tests. Never contacts a model. Prints a version and `exec --help`
// text containing the flags Melly verifies; `exec ... -` reads the task from stdin and emits
// JSONL-shaped MOCK events. The task chooses the behaviour: MODE=fail|malformed|slow.
'use strict';
const args = process.argv.slice(2);
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
if (args[0] === '--version') { process.stdout.write('codex-cli 9.9.9\n'); process.exit(0); }
if (args[0] === 'exec' && args[1] === '--help') {
  process.stdout.write(`MOCK Run Codex non-interactively
Arguments:
  [PROMPT]  If not provided as an argument (or if \`-\` is used), instructions are read from stdin
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>  [possible values: read-only, workspace-write, danger-full-access]
  -C, --cd <DIR>
      --color <COLOR>
      --json  Print events to stdout as JSONL
`);
  process.exit(0);
}
if (args[0] !== 'exec' || args.at(-1) !== '-') { process.stderr.write('MOCK unsupported invocation\n'); process.exit(64); }
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const task = Buffer.concat(chunks).toString('utf8');
  const mode = (/MODE=(\w+)/.exec(task) || [])[1] || 'ok';
  out({type: 'thread.started', thread_id: 'mock-thread', mock: true});
  out({type: 'turn.started'});
  if (mode === 'malformed') { process.stdout.write('MOCK not json at all\n'); process.exit(0); }
  out({type: 'item.started', item: {id: 'i1', type: 'command_execution', command: 'MOCK ls', status: 'in_progress'}});
  out({type: 'item.completed', item: {id: 'i1', type: 'command_execution', command: 'MOCK ls', exit_code: 0, status: 'completed'}});
  if (mode === 'slow') { setTimeout(() => {}, 120000); return; }
  if (mode === 'fail') { out({type: 'turn.failed', error: {message: 'MOCK failure'}}); process.exit(1); }
  out({type: 'item.completed', item: {id: 'i2', type: 'agent_message', text: `MOCK received ${task.length} bytes`}});
  out({type: 'turn.completed', usage: {input_tokens: 1, output_tokens: 1}});
  process.exit(0);
});
