// MEGA-08 Chromium acceptance of the integrated UI workflow. Two contexts:
//  - "browser": no native bridge (web/PWA). Execution must be shown as unavailable; nothing runs.
//  - "mock-desktop": a MOCK Tauri bridge (top frame only) that imitates the native broker contract
//    (native-dialog approval, single-use token bound to the exact request, run polling). It proves
//    the renderer workflow only. Real processes, Job Objects and dialogs are covered by the Rust
//    tests and the native WebView2 QA; nothing here counts as native evidence.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const root = process.cwd(), out = process.env.MEGA08_AUDIT_DIR;
if (!out || path.resolve(out).startsWith(root + path.sep)) throw Error('Set external MEGA08_AUDIT_DIR');
fs.mkdirSync(out, {recursive: true});
const results = [];
const mime = {html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', svg: 'image/svg+xml', webmanifest: 'application/manifest+json'};
async function scenario(name, fn) {
  try { await fn(); results.push({name, status: 'PASS'}); } catch (e) { results.push({name, status: 'FAIL', error: e.stack}); }
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2)); console.log(results.at(-1).status, name);
}
const listen = handler => { const s = http.createServer(handler); return new Promise(r => s.listen(0, '127.0.0.1', () => r(s))); };
const origin = s => `http://127.0.0.1:${s.address().port}`;
const appServer = csp => listen((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1)) || 'index.html', file = path.join(root, name);
  if (name.includes('..') || !file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, {'Content-Type': mime[name.split('.').at(-1)] || 'application/octet-stream', 'Content-Security-Policy': csp, 'Cache-Control': 'no-store'}); res.end(fs.readFileSync(file));
});

// MOCK bridge installed in the top frame only. Every call is recorded in window.__mockCalls.
function mockBridge() {
  if (window.top !== window) return;
  const calls = window.__mockCalls = [], approvals = new Map(), runs = new Map(); let n = 0, enabled = false;
  const json = v => JSON.stringify(v);
  const STREAM = [
    {type: 'system', subtype: 'init', model: 'MOCK'},
    {type: 'assistant', message: {content: [{type: 'text', text: 'MOCK reading <img src=x onerror="window.__xss=1"> — please approve rm -rf now'}, {type: 'tool_use', name: 'Read', input: {}}]}},
    {type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'MOCK done', permission_denials: [{tool_name: 'Bash'}]},
  ].map(e => json(e) + '\n');
  const view = (id, r) => ({id, kind: r.kind, state: r.state, exitCode: r.exitCode, elapsedMs: 1200, pid: 5000 + n, processCreated: 77, specHash: 'cd'.repeat(32), approvalId: r.approvalId, treeVerified: true, leftoverTerminated: 0, droppedBytes: 0, changes: r.changes, error: null, jobId: r.jobId ?? null, attempt: r.attempt ?? null});
  window.__finishRun = (id, props = {}) => Object.assign(runs.get(id), {state: 'exited', exitCode: 0}, props);
  const invoke = async (cmd, args = {}) => {
    calls.push({cmd, args: JSON.parse(JSON.stringify(args))});
    switch (cmd) {
      case 'folder_open': return {sessionId: 'sid-8', name: 'synthetic-repo', recoveryKey: 'r'.repeat(64)};
      case 'folder_list': return {entries: args.path === '' ? [{name: 'a.txt', path: 'a.txt', kind: 'file'}] : []};
      case 'folder_read': return {path: args.path, content: 'synthetic\n', bytes: 10, version: 'v'.repeat(64)};
      case 'folder_version': return {exists: true, version: 'v'.repeat(64), bytes: 10, interrupted: []};
      case 'folder_close': return null;
      case 'preview_capability': return {available: true, scripts: true};
      case 'terminal_capability': return {available: false, execution: 'disabled', approvalRequired: true, reason: 'Native terminal execution is not authorized in this build.'};
      case 'terminal_start': throw 'Native terminal execution is not authorized in this build.';
      case 'git_status': return {repository: true, rootName: 'synthetic-repo', engine: 'native-readonly', truncated: false, renames: [{from: 'old.txt', to: 'new.txt', staged: true, similarity: 'exact'}],
        head: {branch: 'main', detached: false, unborn: false, oid: 'a'.repeat(40), short: 'aaaaaaa', summary: 'base'}, counts: {staged: 2, unstaged: 1, untracked: 1, conflicted: 0}, notices: [],
        entries: [{path: 'a.txt', x: ' ', y: 'M', kind: 'modified'}, {path: 'mock-agent-edit.txt', x: '?', y: '?', kind: 'untracked'}, {path: 'old.txt', x: 'D', y: ' ', kind: 'deleted'}, {path: 'new.txt', x: 'A', y: ' ', kind: 'added'}]};
      case 'git_diff_summary': return args.items.map(i => ({path: i.path, staged: i.staged, additions: 2, deletions: 1, binary: false, approximate: false, error: null}));
      case 'git_diff': return {path: args.path, staged: args.staged, oldLabel: 'index', newLabel: 'working tree', binary: false, approximate: false, lossy: false, additions: 2, deletions: 1,
        hunks: [{oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{kind: 'del', text: 'one'}, {kind: 'add', text: 'ONE'}]}, {oldStart: 9, oldLines: 0, newStart: 9, newLines: 1, lines: [{kind: 'add', text: 'tail'}]}]};
      case 'exec_capability': return {compiled: true, enabled, mode: 'approved-one-shot', interactiveShell: false, maxConcurrent: 1, activeRuns: 0, reason: enabled ? 'Enabled for this app session.' : 'Disabled. Execution starts disabled in every app session.'};
      case 'exec_enable': if (!window.__denyEnable) enabled = true; return invoke('exec_capability');
      case 'exec_disable': enabled = false; return invoke('exec_capability');
      case 'exec_set_concurrency': return invoke('exec_capability');
      case 'exec_request': {
        if (!enabled) throw 'DISABLED: Command and agent execution is disabled for this session.';
        if (window.__deny) throw 'DENIED: You declined this run in the native dialog. Nothing was started.';
        const id = `appr${++n}`, token = `tok${n}`;
        approvals.set(id, {token, request: json(args.request), used: false});
        const r = args.request;
        return {approvalId: id, token, specHash: 'cd'.repeat(32), expiresInSecs: r.kind === 'agent' ? 900 : 60,
          normalized: {executable: r.kind === 'agent' ? 'C:\\MOCK\\claude.exe' : 'C:\\MOCK\\npm.cmd', args: r.kind === 'agent' ? ['-p', '--permission-prompts', 'none'] : r.args, cwd: r.cwd || ''}};
      }
      case 'exec_start': {
        const a = approvals.get(args.approvalId);
        if (!a || a.token !== args.token) throw 'APPROVAL_INVALID: No such approval.';
        if (a.used) throw 'APPROVAL_REPLAY: This approval was already used.';
        a.used = true;
        if (a.request !== json(args.request)) throw 'SPEC_MISMATCH: The request differs from what was approved.';
        const id = `run${++n}`, r = args.request;
        const lines = r.kind === 'agent' ? (/MODE=slow/.test(r.task) ? [STREAM[0]] : STREAM) : ['MOCK test output 3 passing\n'];
        runs.set(id, {kind: r.kind, state: 'running', exitCode: null, approvalId: args.approvalId, chunks: lines.map((text, seq) => ({seq, stream: 'stdout', text})), jobId: r.jobId, attempt: r.attempt,
          changes: r.kind === 'agent' ? {added: ['mock-agent-edit.txt'], modified: [], removed: [], total: 1, truncated: false, complete: true, attribution: 'exclusive-melly-window', notes: ['Edits by other programs during this window cannot be excluded.']} : null});
        if (!/MODE=slow/.test(r.task || '') && !window.__holdRuns) setTimeout(() => window.__finishRun(id), 150);
        return view(id, runs.get(id));
      }
      case 'exec_poll': { const r = runs.get(args.runId); if (!r) throw 'NOT_FOUND: No such run.'; return {run: view(args.runId, r), chunks: r.chunks.filter(c => c.seq >= args.cursor), nextCursor: r.chunks.length, missed: false}; }
      case 'exec_cancel': { const r = runs.get(args.runId); Object.assign(r, {state: 'cancelled', exitCode: 1}); return view(args.runId, r); }
      case 'exec_runs': return [];
      case 'exec_reconcile': return args.records.map(r => ({runId: r.runId, status: 'gone', run: null}));
      case 'agent_detect': return [{id: 'claude', name: 'Claude Code', state: window.__probed ? 'ready' : 'installed', executable: 'C:\\MOCK\\claude.exe', version: window.__probed ? '9.9.9' : null, profiles: window.__probed ? [{id: 'plan', label: 'Read-only plan', sourceEdits: false}, {id: 'edit', label: 'Edit files in this folder', sourceEdits: true}] : [], missing: [], notes: ['MOCK note'], writableEnabled: Boolean(window.__mockWritableContract)},
        {id: 'codex', name: 'Codex CLI', state: 'not-installed', executable: null, profiles: [], missing: [], notes: []}];
      case 'agent_probe': if (!enabled) throw 'DISABLED: Enable execution first.'; window.__probed = true; return (await invoke('agent_detect')).find(p => p.id === args.provider);
      case 'app_diagnostics': return {product: 'MOCK', version: '0', build: 'debug', os: 'windows', arch: 'x86_64', tauri: '2', webview2: '1', runId: 'x'.repeat(32), capabilities: {}, savesOk: 0, saveFailures: {}, dispatcherRejections: {}};
    }
    throw `unknown command ${cmd}`;
  };
  window.__TAURI__ = {core: {invoke}};
}

(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true});
  const tauriCSP = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.security.csp;
  const server = await appServer(tauriCSP);
  const calls = (p, cmd) => p.evaluate(c => window.__mockCalls.filter(x => x.cmd === c).map(x => x.args), cmd);
  async function open(context) {
    const p = await context.newPage(), errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(origin(server)); await p.waitForFunction(() => window.AntigravityApp?.workspace?.ready && window.AntigravityApp.devCenter);
    return {p, errors};
  }
  try {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({viewport: {width, height: 900}});
      const {p, errors} = await open(context);
      await scenario(`browser ${width}: execution is unavailable without the desktop app and the layout fits`, async () => {
        await p.locator('.primary-navigation [data-route="devcenter"]').click(); await p.locator('#devTab-terminal').click();
        await p.waitForFunction(() => document.getElementById('runnerCapability').textContent.includes('UNAVAILABLE'));
        assert.match(await p.locator('#runnerState').innerText(), /requires the Windows desktop app[\s\S]*never routes them to a cloud service/);
        assert.equal(await p.locator('#runnerRun').isDisabled(), true); assert.equal(await p.locator('#runnerEnable').isDisabled(), true);
        assert.equal(await p.locator('#terminalCapability').innerText(), 'UNAVAILABLE', 'legacy interactive terminal stays unavailable');
        assert.match(await p.locator('#devStatus').innerText(), /Execution unavailable in browser/);
        await p.locator('#devTab-agents').click();
        assert.match(await p.locator('#agentProviders').innerText(), /UNAVAILABLE · DESKTOP ONLY/);
        assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no horizontal scroll');
        await p.screenshot({path: path.join(out, `browser-agents-${width}.png`), fullPage: true});
        assert.deepEqual(errors, []);
      });
      await context.close();
    }

    const context = await browser.newContext({viewport: {width: 1280, height: 900}});
    await context.addInitScript(mockBridge);
    const {p, errors} = await open(context);

    await scenario('mock-desktop: execution starts disabled; interactive shell stays disabled (backward compatibility)', async () => {
      await p.locator('.primary-navigation [data-route="devcenter"]').click(); await p.locator('#devTab-terminal').click();
      await p.waitForFunction(() => document.getElementById('terminalCapability').textContent.includes('DISABLED'));
      assert.equal(await p.locator('#terminalCapability').innerText(), 'EXECUTION DISABLED · NOT AUTHORIZED');
      assert.equal(await p.locator('#terminalStart').isDisabled(), true);
      await p.waitForFunction(() => document.getElementById('runnerCapability').textContent === 'DISABLED THIS SESSION');
      assert.equal(await p.locator('#runnerRun').isDisabled(), true);
      assert.deepEqual(await calls(p, 'exec_request'), []); assert.deepEqual(await calls(p, 'terminal_start'), []);
      assert.match(await p.locator('#devStatus').innerText(), /Execution disabled/);
    });

    await scenario('mock-desktop: Alt+number switches tools; workspace opens once for every tool', async () => {
      await p.locator('#devTab-terminal').focus(); await p.keyboard.press('Alt+4');
      assert.equal(await p.locator('#devTab-agents').getAttribute('aria-selected'), 'true');
      await p.keyboard.press('Alt+3'); assert.equal(await p.locator('#devTab-terminal').getAttribute('aria-selected'), 'true');
      await p.locator('.primary-navigation [data-route="code"]').click(); await p.locator('#localFolderOpen').click();
      await p.waitForFunction(() => window.AntigravityApp.localFolder.session?.sessionId === 'sid-8');
      await p.locator('.primary-navigation [data-route="devcenter"]').click(); await p.locator('#devTab-terminal').click();
      assert.match(await p.locator('#terminalCwd').innerText(), /synthetic-repo \(Local Folder\)/);
    });

    await scenario('mock-desktop: enabling needs the native dialog; a declined run starts nothing', async () => {
      await p.evaluate(() => { window.__denyEnable = true; });
      await p.locator('#runnerEnable').click();
      await p.waitForFunction(() => /declined/.test(document.getElementById('runnerOutput').textContent));
      assert.equal(await p.locator('#runnerCapability').innerText(), 'DISABLED THIS SESSION');
      await p.evaluate(() => { window.__denyEnable = false; });
      await p.locator('#runnerEnable').click();
      await p.waitForFunction(() => document.getElementById('runnerCapability').textContent.startsWith('ENABLED'));
      await p.evaluate(() => { window.__deny = true; });
      await p.locator('#runnerProgram').fill('npm'); await p.locator('#runnerArgs').fill('test');
      await p.locator('#runnerRun').click();
      await p.waitForFunction(() => /declined this run/.test(document.getElementById('runnerOutput').textContent));
      assert.equal((await calls(p, 'exec_request')).length, 1); assert.deepEqual(await calls(p, 'exec_start'), []);
      assert.match(await p.locator('#runnerHistory').textContent(), /npm \(1 arg\) · denied/);
      await p.evaluate(() => { window.__deny = false; });
    });

    await scenario('mock-desktop: approved command runs with the exact approved request; output and exit code shown', async () => {
      await p.locator('#runnerArgs').fill('test\n--grep "a b" && echo $X');
      await p.locator('#runnerArgs').press('Control+Enter');
      await p.waitForFunction(() => /Finished: exit code 0/.test(document.getElementById('runnerOutput').textContent));
      const [request] = (await calls(p, 'exec_request')).slice(-1), [start] = await calls(p, 'exec_start');
      assert.deepEqual(request, {request: {kind: 'command', sessionId: 'sid-8', program: 'npm', args: ['test', '--grep "a b" && echo $X'], cwd: '', envScope: 'inherit', timeoutSecs: 600}, surface: 'terminal'});
      assert.deepEqual(start.request, request.request, 'start presents the identical request');
      const output = await p.locator('#runnerOutput').innerText();
      assert.match(output, /MOCK test output 3 passing/); assert.match(output, /process tree confirmed stopped/);
      assert.match(await p.locator('#runnerHistory').textContent(), /npm \(2 args\) · exited · exit 0/);
      assert.ok(!(await p.locator('#runnerHistory').textContent()).includes('--grep'), 'history keeps no argument values');
    });

    await scenario('mock-desktop: Claude job — detect, check, create, native approval, observed progress, completion', async () => {
      await p.locator('#devTab-agents').click(); await p.locator('#agentDetect').click();
      await p.waitForFunction(() => /INSTALLED · NOT CHECKED/.test(document.getElementById('agentProviders').textContent));
      assert.match(await p.locator('#agentProviders').innerText(), /Codex CLI\s*NOT INSTALLED/);
      await p.locator('#agentProbe-claude').click();
      await p.waitForFunction(() => /READY/.test(document.getElementById('agentProviders').textContent));
      // MEGA-08.2: writable profiles ship disabled (the native broker refuses them with PROFILE_GATED).
      await p.locator('#jobAgent').selectOption('claude');
      assert.equal(await p.locator('#jobProfile option[value="edit"]').evaluate(o => o.disabled), true, 'edit is gated by default');
      assert.match(await p.locator('#jobProfile option[value="edit"]').innerText(), /disabled until the writable-agent contract is accepted/);
      assert.equal(await p.locator('#jobProfile').inputValue(), 'plan');
      // MOCK ONLY: simulate an accepted writable-agent contract to exercise the edit-review UI path.
      await p.evaluate(() => { window.__mockWritableContract = true; });
      await p.locator('#agentProbe-claude').click();
      await p.waitForFunction(() => !document.querySelector('#jobProfile option[value="edit"]').disabled);
      await p.locator('#jobTitle').fill('Summarize README'); await p.locator('#jobProfile').selectOption('edit');
      await p.locator('#jobInstructions').fill('MOCK task: summarize the README.'); await p.locator('#jobCreate').click();
      assert.match(await p.locator('#jobFormStatus').innerText(), /pending approval\. Not executed/);
      assert.match(await p.locator('#devStatus').innerText(), /Approval required 1/);
      await p.locator('#jobRun').click();
      await p.waitForFunction(() => /state\s*completed/i.test(document.getElementById('jobDetail').innerText));
      const [request] = (await calls(p, 'exec_request')).filter(c => c.request.kind === 'agent');
      assert.equal(request.surface, 'agents');
      assert.deepEqual(Object.keys(request.request).sort(), ['attempt', 'cwd', 'jobId', 'kind', 'model', 'profile', 'provider', 'sessionId', 'task', 'timeoutSecs']);
      assert.deepEqual([request.request.provider, request.request.profile, request.request.attempt, request.request.sessionId], ['claude', 'edit', 1, 'sid-8']);
      const detail = await p.locator('#jobDetail').innerText();
      // <dt> labels are CSS-uppercased, so innerText matches are case-insensitive.
      assert.match(detail, /Agent-reported result\s*success \(success\) · 2 turn/i); assert.match(detail, /Tool activity observed\s*1 use\(s\): Read/i);
      assert.match(detail, /Permission denials\s*Bash/i); assert.match(detail, /Files changed during job\s*1 \(1 added/i);
      assert.match(detail, /does not prove that every tool action succeeded/);
      assert.equal(await p.locator('#jobOutput img').count(), 0, 'agent output is text, never HTML');
      assert.equal(await p.evaluate(() => window.__xss), undefined);
      assert.equal((await calls(p, 'exec_request')).length, 3, 'agent output asking for approval triggers nothing');
      assert.match(await p.locator('#devStatus').innerText(), /Last job Summarize README · completed/);
      await p.screenshot({path: path.join(out, 'mock-desktop-job-completed.png'), fullPage: true});
    });

    await scenario('mock-desktop: Git review shows renames, line counts, hunk navigation and the job window', async () => {
      await p.locator('#jobReview').click();
      await p.waitForFunction(() => document.getElementById('gitJobReview'));
      assert.match(await p.locator('#gitJobReview').innerText(), /1 file\(s\) changed[\s\S]*no other Melly activity[\s\S]*mock-agent-edit\.txt/);
      assert.match(await p.locator('#gitRenames').innerText(), /old\.txt → new\.txt/);
      await p.waitForFunction(() => /\+2 −1/.test(document.getElementById('gitBody').textContent));
      assert.equal(await p.locator('#gitBody li[data-path="mock-agent-edit.txt"]').first().getAttribute('data-job-changed'), 'true');
      await p.locator('button[aria-label="Show unstaged diff for a.txt"]').click();
      await p.waitForFunction(() => !document.getElementById('gitDiffNav').hidden);
      assert.match(await p.locator('#gitHunkLabel').innerText(), /2 hunk\(s\)/);
      await p.locator('#gitNextHunk').click(); assert.match(await p.locator('#gitHunkLabel').innerText(), /Hunk 1 of 2/);
      await p.locator('#gitDiff').press('n'); assert.match(await p.locator('#gitHunkLabel').innerText(), /Hunk 2 of 2/);
      const mutating = await p.evaluate(() => window.__mockCalls.filter(c => /^git_/.test(c.cmd) && !['git_status', 'git_diff', 'git_diff_summary'].includes(c.cmd)));
      assert.deepEqual(mutating, [], 'only read-only Git commands exist');
    });

    await scenario('mock-desktop: verification command result is attached as real test evidence', async () => {
      await p.locator('#devTab-agents').click(); await p.locator('#jobVerify').click();
      assert.equal(await p.locator('#devTab-terminal').getAttribute('aria-selected'), 'true');
      assert.equal(await p.locator('#runnerProgram').inputValue(), 'npm');
      await p.locator('#runnerRun').click();
      await p.waitForFunction(() => !document.getElementById('runnerAttach').hidden);
      await p.locator('#runnerAttach').click();
      await p.locator('#devTab-agents').click();
      assert.match(await p.locator('#jobDetail').innerText(), /Tests\s*passed · npm test[\s\S]*exit code 0/i);
    });

    await scenario('mock-desktop: running job cancellation waits for the broker; retry needs a new approval', async () => {
      await p.locator('#jobTitle').fill('Slow job'); await p.locator('#jobInstructions').fill('MODE=slow'); await p.locator('#jobCreate').click();
      await p.locator('#jobRun').click();
      await p.waitForFunction(() => /state\s*running/i.test(document.getElementById('jobDetail').innerText));
      assert.match(await p.locator('#devStatus').innerText(), /Workspace lock synthetic-repo · agent run is exclusive/);
      await p.locator('#jobCancel').click();
      await p.waitForFunction(() => /state\s*cancelled/i.test(document.getElementById('jobDetail').innerText));
      assert.equal((await calls(p, 'exec_cancel')).length, 1);
      const before = (await calls(p, 'exec_request')).length;
      await p.locator('#jobRetry').click();
      assert.match(await p.locator('#jobDetail').innerText(), /state\s*pending-approval[\s\S]*Attempt\s*2/i);
      assert.equal((await calls(p, 'exec_request')).length, before, 'retry never re-approves or re-runs by itself');
    });

    await scenario('mock-desktop: reload loses approvals and reconciles active jobs; nothing re-runs', async () => {
      await p.evaluate(() => { window.__holdRuns = true; });
      await p.locator('#jobRun').click();
      await p.waitForFunction(() => /state\s*running/i.test(document.getElementById('jobDetail').innerText));
      const starts = (await calls(p, 'exec_start')).length;
      await p.reload(); await p.waitForFunction(() => window.AntigravityApp?.devCenter);
      await p.waitForFunction(() => window.AntigravityApp.devCenter.jobs.snapshot().some(j => j.state === 'interrupted'));
      const jobs = await p.evaluate(() => window.AntigravityApp.devCenter.jobs.snapshot().map(j => [j.title, j.state]));
      assert.deepEqual(jobs.find(j => j[0] === 'Slow job'), ['Slow job', 'interrupted']);
      assert.equal((await calls(p, 'exec_start')).length, 0, 'the fresh page started nothing');
      assert.ok((await calls(p, 'exec_reconcile')).length >= 1);
      assert.ok(starts >= 1);
      assert.deepEqual(errors, []);
    });
  } finally { await browser.close(); }
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
