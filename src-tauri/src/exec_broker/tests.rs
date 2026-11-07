//! MEGA-08 native broker tests: real Windows processes, Job Objects and pipes, driven only with
//! disposable %TEMP% workspaces and the MOCK fixtures in tests/fixtures/mega08. Consent is
//! synthetic here: `approve()` is called directly in place of the native dialog's Yes.
use super::*;

struct Fixture {
    root: PathBuf,
    id: String,
    extra: Vec<PathBuf>,
}
impl Workspaces for Fixture {
    fn root(&self, session_id: &str) -> Result<PathBuf> {
        if session_id == self.id {
            Ok(self.root.clone())
        } else {
            Err(coded("STALE_WORKSPACE", "Folder session expired or closed."))
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        for extra in &self.extra {
            let _ = fs::remove_dir_all(extra);
        }
    }
}
fn fixture() -> Fixture {
    let root = std::env::temp_dir().join(format!("melly-mega08-ws-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("sub")).unwrap();
    Fixture { root, id: uuid::Uuid::new_v4().to_string(), extra: vec![] }
}
fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("fixtures").join("mega08")
}
fn emit() -> String {
    fixtures().join("emit.cjs").to_string_lossy().into_owned()
}
fn enabled() -> Broker {
    let broker = Broker::default();
    broker.set_enabled(true);
    broker
}
fn command(f: &Fixture, program: &str, args: &[&str]) -> ExecRequest {
    ExecRequest::Command {
        session_id: f.id.clone(),
        program: program.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        cwd: String::new(),
        env_scope: "inherit".into(),
        timeout_secs: 60,
    }
}
fn node(f: &Fixture, mode: &str) -> ExecRequest {
    command(f, "node", &[&emit(), mode])
}
fn agent(f: &Fixture, provider: &str, profile: &str, task: &str, job: &str, attempt: u32) -> ExecRequest {
    ExecRequest::Agent {
        session_id: f.id.clone(),
        provider: provider.into(),
        profile: profile.into(),
        model: String::new(),
        task: task.into(),
        cwd: String::new(),
        timeout_secs: 120,
        job_id: job.into(),
        attempt,
    }
}
fn approve(b: &Broker, f: &Fixture, r: &ExecRequest) -> Approved {
    let plan = b.normalize(f, r).unwrap();
    b.approve(&plan, "test")
}
fn run(b: &Broker, f: &Fixture, r: &ExecRequest) -> RunView {
    let a = approve(b, f, r);
    b.start(f, r, &a.approval_id, &a.token, "test").unwrap()
}
fn code(error: &str) -> &str {
    error.split(':').next().unwrap()
}
fn output(b: &Broker, id: &str, cursor: &mut u64, text: &mut String) -> RunView {
    let poll = b.poll(id, *cursor).unwrap();
    for chunk in &poll.chunks {
        text.push_str(&format!("{}|{}", chunk.stream, chunk.text));
    }
    *cursor = poll.next_cursor;
    poll.run
}
fn finish(b: &Broker, id: &str) -> (RunView, String) {
    let until = Instant::now() + Duration::from_secs(60);
    let (mut cursor, mut text) = (0, String::new());
    loop {
        let view = output(b, id, &mut cursor, &mut text);
        if !matches!(view.state, "running" | "cancelling") {
            let view = output(b, id, &mut cursor, &mut text);
            return (view, text);
        }
        assert!(Instant::now() < until, "run did not finish");
        thread::sleep(Duration::from_millis(20));
    }
}
fn wait_for(b: &Broker, id: &str, needle: &str) -> String {
    let until = Instant::now() + Duration::from_secs(30);
    let (mut cursor, mut text) = (0, String::new());
    while !text.contains(needle) {
        output(b, id, &mut cursor, &mut text);
        assert!(Instant::now() < until, "no {needle} in {text}");
        thread::sleep(Duration::from_millis(20));
    }
    text
}
fn alive(pid: u32) -> bool {
    use windows::Win32::{
        Foundation::{CloseHandle, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    unsafe {
        match OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            Ok(h) => {
                let running = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
                let _ = CloseHandle(h);
                running
            }
            Err(_) => false,
        }
    }
}
/// Holds a process handle so a later check cannot be confused by PID reuse.
struct Pinned(isize);
impl Pinned {
    fn new(pid: u32) -> Pinned {
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        Pinned(unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }.expect("process must be alive to pin").0 as isize)
    }
    fn exited(&self) -> bool {
        use windows::Win32::{Foundation::{HANDLE, WAIT_OBJECT_0}, System::Threading::WaitForSingleObject};
        unsafe { WaitForSingleObject(HANDLE(self.0 as *mut _), 3000) == WAIT_OBJECT_0 }
    }
}
impl Drop for Pinned {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(self.0 as *mut _));
        }
    }
}
fn child_pid(text: &str) -> u32 {
    text.split("child=").nth(1).unwrap().split(|c: char| !c.is_ascii_digit()).next().unwrap().parse().unwrap()
}
/// Disposable PATH directory with `.cmd` shims for the MOCK CLIs.
fn fake_path(f: &mut Fixture, shims: &[(&str, String)]) -> OsString {
    let dir = std::env::temp_dir().join(format!("melly-mega08-path-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir).unwrap();
    for (name, body) in shims {
        fs::write(dir.join(format!("{name}.cmd")), body).unwrap();
    }
    f.extra.push(dir.clone());
    dir.into_os_string()
}
fn shim(script: &str) -> String {
    let node = resolve_program("node", None).unwrap();
    format!("@\"{}\" \"{}\" %*\r\n", node.display(), fixtures().join(script).display())
}
fn ready_agents(f: &mut Fixture) -> Broker {
    let b = gated_agents(f);
    // MOCK CLIs only: tests exercise the writable profiles that ship disabled (owner contract pending).
    b.with_registry(|r| r.allow_writable = true);
    for id in ["claude", "codex"] {
        let p = crate::agent_cli::probe(&b, id).unwrap();
        assert_eq!(p.state, "ready", "{id}: {:?} {:?}", p.error, p.missing);
        assert_eq!(p.version.as_deref(), Some("9.9.9"));
    }
    b
}
fn gated_agents(f: &mut Fixture) -> Broker {
    let b = enabled();
    let path = fake_path(f, &[("claude", shim("fake-claude.cjs")), ("codex", shim("fake-codex.cjs"))]);
    b.with_registry(|r| r.path_override = Some(path));
    b
}
/// Shipped source only: drops every `#[cfg(test)]` / `#[cfg(all(test …` item by brace matching.
fn strip_tests(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    loop {
        let next = ["#[cfg(test)]", "#[cfg(all(test"].iter().filter_map(|m| rest.find(m)).min();
        let Some(at) = next else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..at]);
        let item = &rest[at..];
        let (Some(open), Some(semi)) = (item.find('{'), item.find(';').or(Some(usize::MAX))) else {
            return out;
        };
        if semi < open {
            rest = &item[semi + 1..];
            continue;
        }
        let mut depth = 0usize;
        let mut end = item.len();
        for (i, c) in item[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + i + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        rest = &item[end.min(item.len())..];
    }
}

// ---------- capability and approval binding ----------

#[test]
fn execution_starts_disabled_and_nothing_normalizes() {
    let f = fixture();
    let b = Broker::default();
    assert!(!b.capability().enabled && !b.capability().interactive_shell);
    assert_eq!(code(&b.normalize(&f, &node(&f, "streams")).err().unwrap()), "DISABLED");
    assert_eq!(code(&crate::agent_cli::probe(&b, "claude").unwrap_err()), "DISABLED");
    b.set_enabled(true);
    assert!(b.normalize(&f, &node(&f, "streams")).is_ok());
    b.set_enabled(false);
    assert_eq!(code(&b.normalize(&f, &node(&f, "streams")).err().unwrap()), "DISABLED");
}

#[test]
fn approved_run_streams_stdout_stderr_unicode_and_exit_code() {
    let f = fixture();
    let b = enabled();
    let view = run(&b, &f, &node(&f, "streams"));
    assert!(view.pid > 0 && view.process_created > 0 && view.state == "running");
    let (done, text) = finish(&b, &view.id);
    assert_eq!((done.state, done.exit_code, done.tree_verified), ("exited", Some(0), true));
    assert!(text.contains("stdout|MOCK out-1\n") && text.contains("stderr|MOCK err-1\n"), "{text}");
    assert!(text.contains("żółć 日本語 ✓"), "{text}");
    let audit = b.audit_log();
    assert!(["approved", "started", "exited"].iter().all(|e| audit.iter().any(|a| a.event == *e)));
    assert!(audit.iter().all(|a| !a.executable_name.contains('\\') && a.spec_hash.len() <= 16));
}

#[test]
fn nonzero_exit_is_reported_not_success() {
    let f = fixture();
    let b = enabled();
    let (done, _) = finish(&b, &run(&b, &f, &node(&f, "exit3")).id);
    assert_eq!((done.state, done.exit_code), ("exited", Some(3)));
}

#[test]
fn denied_or_forged_approvals_start_nothing() {
    let f = fixture();
    let b = enabled();
    let request = node(&f, "streams");
    // Denial: the dialog said No, so approve() was never called and no token exists.
    assert_eq!(code(&b.start(&f, &request, "made-up", "made-up", "test").unwrap_err()), "APPROVAL_INVALID");
    let a = approve(&b, &f, &request);
    assert_eq!(code(&b.start(&f, &request, &a.approval_id, &"0".repeat(64), "test").unwrap_err()), "APPROVAL_INVALID");
    assert!(b.runs().is_empty());
    // A failed forgery does not burn the real approval.
    let view = b.start(&f, &request, &a.approval_id, &a.token, "test").unwrap();
    finish(&b, &view.id);
}

#[test]
fn expired_and_replayed_approvals_are_refused() {
    let f = fixture();
    let b = enabled();
    let request = node(&f, "streams");
    let a = approve(&b, &f, &request);
    b.expire_all();
    assert_eq!(code(&b.start(&f, &request, &a.approval_id, &a.token, "test").unwrap_err()), "APPROVAL_EXPIRED");
    let a = approve(&b, &f, &request);
    finish(&b, &b.start(&f, &request, &a.approval_id, &a.token, "test").unwrap().id);
    assert_eq!(code(&b.start(&f, &request, &a.approval_id, &a.token, "test").unwrap_err()), "APPROVAL_REPLAY");
    assert_eq!(b.runs().len(), 1);
}

#[test]
fn changed_arguments_cwd_or_executable_invalidate_the_approval() {
    let f = fixture();
    let b = enabled();
    let approved = node(&f, "streams");
    let changed_args = node(&f, "exit3");
    let a = approve(&b, &f, &approved);
    assert_eq!(code(&b.start(&f, &changed_args, &a.approval_id, &a.token, "test").unwrap_err()), "SPEC_MISMATCH");
    assert_eq!(code(&b.start(&f, &approved, &a.approval_id, &a.token, "test").unwrap_err()), "APPROVAL_REPLAY", "mismatch must invalidate");

    let mut moved = node(&f, "streams");
    if let ExecRequest::Command { cwd, .. } = &mut moved {
        *cwd = "sub".into();
    }
    let a = approve(&b, &f, &approved);
    assert_eq!(code(&b.start(&f, &moved, &a.approval_id, &a.token, "test").unwrap_err()), "SPEC_MISMATCH");

    let mut other = node(&f, "streams");
    if let ExecRequest::Command { env_scope, .. } = &mut other {
        *env_scope = "minimal".into();
    }
    let a = approve(&b, &f, &approved);
    assert_eq!(code(&b.start(&f, &other, &a.approval_id, &a.token, "test").unwrap_err()), "SPEC_MISMATCH");

    // Same program path, but the file itself changes after approval (identity is hashed).
    fs::create_dir(f.root.join("tools")).unwrap();
    fs::write(f.root.join("tools/hello.cmd"), "@echo MOCK hello\r\n").unwrap();
    let tool = command(&f, "tools/hello.cmd", &[]);
    let a = approve(&b, &f, &tool);
    thread::sleep(Duration::from_millis(30));
    fs::write(f.root.join("tools/hello.cmd"), "@echo MOCK swapped program\r\n").unwrap();
    assert_eq!(code(&b.start(&f, &tool, &a.approval_id, &a.token, "test").unwrap_err()), "SPEC_MISMATCH");
    let renamed = command(&f, "where", &["node"]);
    let a = approve(&b, &f, &tool);
    assert_eq!(code(&b.start(&f, &renamed, &a.approval_id, &a.token, "test").unwrap_err()), "SPEC_MISMATCH");
    assert!(b.runs().is_empty(), "nothing may start");
}

#[test]
fn stale_and_cross_workspace_requests_are_refused() {
    let f = fixture();
    let g = fixture();
    let b = enabled();
    let request = node(&f, "streams");
    let a = approve(&b, &f, &request);
    // Same request presented against a workspace view where that session no longer exists.
    assert_eq!(code(&b.start(&g, &request, &a.approval_id, &a.token, "test").unwrap_err()), "STALE_WORKSPACE");
    // An approval for workspace F replayed with a request for workspace G.
    let a = approve(&b, &f, &request);
    let other = node(&g, "streams");
    assert_eq!(code(&b.start(&g, &other, &a.approval_id, &a.token, "test").unwrap_err()), "STALE_WORKSPACE");
    assert!(b.runs().is_empty());
}

#[test]
fn traversal_absolute_paths_and_junction_escapes_are_refused() {
    let f = fixture();
    let b = enabled();
    for cwd in ["../", "sub/../..", "..\\x", "C:/Windows", "\\\\server\\share", "nul", "sub/./x"] {
        let mut r = node(&f, "streams");
        if let ExecRequest::Command { cwd: c, .. } = &mut r {
            *c = cwd.into();
        }
        assert_eq!(code(&b.normalize(&f, &r).err().unwrap()), "CWD_REFUSED", "{cwd}");
    }
    for program in ["C:\\Windows\\System32\\cmd.exe", "\\\\server\\x.exe", "../evil.cmd", "sub/../../evil.cmd", "tools/readme.txt", "cmd /c echo", "node;calc"] {
        let err = b.normalize(&f, &command(&f, program, &[])).err().unwrap();
        assert_eq!(code(&err), "EXECUTABLE_REFUSED", "{program}: {err}");
    }
    let outside = std::env::temp_dir().join(format!("melly-mega08-outside-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("evil.cmd"), "@echo MOCK outside\r\n").unwrap();
    let status = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(f.root.join("link")).arg(&outside).output().unwrap();
    assert!(status.status.success(), "junction fixture");
    let mut through = node(&f, "streams");
    if let ExecRequest::Command { cwd, .. } = &mut through {
        *cwd = "link".into();
    }
    assert_eq!(code(&b.normalize(&f, &through).err().unwrap()), "CWD_REFUSED");
    assert_eq!(code(&b.normalize(&f, &command(&f, "link/evil.cmd", &[])).err().unwrap()), "EXECUTABLE_REFUSED");
    let _ = fs::remove_dir(f.root.join("link"));
    let _ = fs::remove_dir_all(&outside);
}

#[test]
fn agent_clis_and_bypass_arguments_never_run_as_plain_commands() {
    let f = fixture();
    let b = enabled();
    for program in ["claude", "claude.exe", "codex", "codex.cmd", "Codex"] {
        assert_eq!(code(&b.normalize(&f, &command(&f, program, &[])).err().unwrap()), "AGENT_VIA_ADAPTER", "{program}");
    }
    for arg in ["--dangerously-skip-permissions", "--permission-mode=bypassPermissions", "--sandbox=danger-full-access", "--approve-for-me", "--yolo"] {
        assert_eq!(code(&b.normalize(&f, &command(&f, "node", &[arg])).err().unwrap()), "ARGS_REFUSED", "{arg}");
    }
    let many: Vec<String> = (0..65).map(|i| i.to_string()).collect();
    let refs: Vec<&str> = many.iter().map(|s| s.as_str()).collect();
    assert_eq!(code(&b.normalize(&f, &command(&f, "node", &refs)).err().unwrap()), "ARGS_REFUSED");
    assert_eq!(code(&b.normalize(&f, &command(&f, "node", &["a\0b"])).err().unwrap()), "ARGS_REFUSED");
}

// ---------- lifecycle: cancel, timeout, overflow, cleanup ----------

#[test]
fn cancellation_terminates_the_whole_process_tree() {
    let f = fixture();
    let b = enabled();
    let view = run(&b, &f, &node(&f, "tree"));
    let (parent, child) = (Pinned::new(view.pid), Pinned::new(child_pid(&wait_for(&b, &view.id, "child="))));
    let cancelled = b.request_cancel(&view.id).unwrap();
    assert_eq!(cancelled.state, "cancelled");
    assert!(cancelled.cancel_requested && cancelled.tree_verified);
    assert!(parent.exited() && child.exited(), "parent and child must be gone");
    assert!(b.audit_log().iter().any(|a| a.event == "cancelled"));
}

#[test]
fn timeout_stops_the_run_and_is_reported_as_timed_out() {
    let f = fixture();
    let b = enabled();
    let mut request = node(&f, "sleep");
    if let ExecRequest::Command { timeout_secs, .. } = &mut request {
        *timeout_secs = 1;
    }
    let (done, _) = finish(&b, &run(&b, &f, &request).id);
    assert_eq!((done.state, done.timed_out, done.tree_verified), ("timed-out", true, true));
    assert!(done.elapsed_ms >= 1000 && done.elapsed_ms < 15000);
}

#[test]
fn output_is_bounded_and_overflow_is_reported() {
    let f = fixture();
    let b = enabled();
    let (done, _) = finish(&b, &run(&b, &f, &node(&f, "flood")).id);
    assert_eq!(done.exit_code, Some(0));
    assert!(done.output_bytes <= RING_BYTES && done.dropped_bytes > 0, "{} {}", done.output_bytes, done.dropped_bytes);
    assert!(b.poll(&done.id, 0).unwrap().missed);
}

#[test]
fn descendants_left_after_exit_are_terminated_through_the_job() {
    let f = fixture();
    let b = enabled();
    let view = run(&b, &f, &node(&f, "orphan"));
    let child = Pinned::new(child_pid(&wait_for(&b, &view.id, "child=")));
    let (done, _) = finish(&b, &view.id);
    assert_eq!((done.state, done.exit_code), ("exited", Some(0)));
    assert!(done.leftover_terminated >= 1 && done.tree_verified, "{done:?}");
    assert!(child.exited(), "the detached descendant must be terminated through the job");
}

#[test]
fn secrets_are_redacted_in_output_but_git_ids_are_kept() {
    let f = fixture();
    let b = enabled();
    let (_, text) = finish(&b, &run(&b, &f, &node(&f, "secret")).id);
    assert!(!text.contains("FAKEFAKEFAKE") && !text.contains("FAKEtoken") && !text.contains("hunter2"), "{text}");
    assert!(text.matches("[REDACTED]").count() >= 3);
    assert!(text.contains("0123456789abcdef0123456789abcdef01234567"));
}

#[test]
fn minimal_environment_and_workspace_change_attribution() {
    let f = fixture();
    let b = enabled();
    let mut minimal = node(&f, "env");
    if let ExecRequest::Command { env_scope, .. } = &mut minimal {
        *env_scope = "minimal".into();
    }
    let (_, text) = finish(&b, &run(&b, &f, &minimal).id);
    let count: usize = text.split("env-count=").nth(1).unwrap().split(' ').next().unwrap().parse().unwrap();
    assert!(count <= MINIMAL_ENV.len() + 4 && text.contains("has-path=true"), "{text}");
    let (done, _) = finish(&b, &run(&b, &f, &node(&f, "write")).id);
    let changes = done.changes.unwrap();
    assert_eq!(changes.added, ["mega08-out.txt"]);
    assert!(changes.modified.is_empty() && changes.removed.is_empty() && changes.complete);
    assert_eq!(changes.attribution, "exclusive-melly-window");
    assert!(changes.notes.iter().any(|n| n.contains("other programs")));
}

// ---------- queue limits, restart and reconciliation ----------

#[test]
fn concurrency_limit_refuses_without_burning_the_approval() {
    let f = fixture();
    let b = enabled();
    let first = run(&b, &f, &node(&f, "sleep"));
    let second = node(&f, "streams");
    let a = approve(&b, &f, &second);
    assert_eq!(code(&b.start(&f, &second, &a.approval_id, &a.token, "test").unwrap_err()), "BUSY");
    b.request_cancel(&first.id).unwrap();
    let view = b.start(&f, &second, &a.approval_id, &a.token, "test").unwrap();
    assert_eq!(finish(&b, &view.id).0.exit_code, Some(0));
    assert!(b.set_concurrency(3).is_err() && b.set_concurrency(0).is_err());
}

#[test]
fn restart_has_no_runs_and_reconciles_by_pid_and_creation_time() {
    let f = fixture();
    let old = enabled();
    let (done, _) = finish(&old, &run(&old, &f, &node(&f, "streams")).id);
    let fresh = Broker::default();
    assert_eq!(code(&fresh.poll(&done.id, 0).unwrap_err()), "NOT_FOUND");
    assert!(fresh.runs().is_empty() && !fresh.enabled(), "a restart never re-runs or re-enables anything");
    let gone = ReconcileRecord { run_id: done.id.clone(), pid: done.pid, process_created: done.process_created };
    assert_eq!(fresh.reconcile(&[gone]).unwrap()[0].status, "gone");
    let mut stray = std::process::Command::new(resolve_program("node", None).unwrap()).args(["-e", "setTimeout(()=>{},60000)"]).spawn().unwrap();
    let created = super::win::creation_time_of(&stray);
    let alive_record = ReconcileRecord { run_id: "x".into(), pid: stray.id(), process_created: created };
    let reused_pid = ReconcileRecord { run_id: "y".into(), pid: stray.id(), process_created: created + 1 };
    let results = fresh.reconcile(&[alive_record, reused_pid]).unwrap();
    assert_eq!((results[0].status, results[1].status), ("alive-unmanaged", "gone"));
    assert!(alive(stray.id()), "reconcile never kills anything");
    let _ = stray.kill();
    let _ = stray.wait();
    let managed = ReconcileRecord { run_id: done.id.clone(), pid: done.pid, process_created: done.process_created };
    assert_eq!(old.reconcile(&[managed]).unwrap()[0].status, "managed");
}

// ---------- Claude Code / Codex adapters with MOCK CLIs ----------

#[test]
fn missing_cli_and_unrecognized_version_fail_closed() {
    let mut f = fixture();
    let b = enabled();
    let empty = fake_path(&mut f, &[]);
    b.with_registry(|r| r.path_override = Some(empty));
    assert!(b.with_registry(|r| r.detect()).iter().all(|p| p.state == "not-installed" && p.executable.is_none()));
    assert_eq!(crate::agent_cli::probe(&b, "claude").unwrap().state, "not-installed");
    assert_eq!(code(&b.normalize(&f, &agent(&f, "claude", "plan", "hi", "job-1", 1)).err().unwrap()), "PROBE_REQUIRED");
    let bad = format!("@if \"%1\"==\"--version\" (echo MOCK nonsense version) else ({})", shim("fake-claude.cjs").trim_start_matches('@').trim_end());
    let path = fake_path(&mut f, &[("claude", bad)]);
    b.with_registry(|r| r.path_override = Some(path));
    let probed = crate::agent_cli::probe(&b, "claude").unwrap();
    assert_eq!(probed.state, "error");
    assert_eq!(code(probed.error.as_deref().unwrap()), "VERSION_UNRECOGNIZED");
    assert_eq!(code(&b.normalize(&f, &agent(&f, "claude", "plan", "hi", "job-1", 1)).err().unwrap()), "PROBE_REQUIRED");
    assert_eq!(code(&crate::agent_cli::probe(&b, "gemini").unwrap_err()), "PROVIDER_REFUSED");
}

#[test]
fn mock_claude_job_runs_with_fail_closed_flags_and_stdin_task() {
    let mut f = fixture();
    let b = ready_agents(&mut f);
    let task = "MOCK task: summarize README. MODE=edit";
    let request = agent(&f, "claude", "edit", task, "job-claude", 1);
    let plan = b.normalize(&f, &request).unwrap();
    let n = &plan.normalized;
    assert!(n.args.windows(2).any(|w| w == ["--permission-prompts", "none"]) && n.args.contains(&"--restricted".to_string()));
    assert!(!n.args.iter().any(|a| a.contains(task)), "the task is never on the command line");
    assert_eq!(n.stdin_sha256.as_deref(), Some(sha256_hex(task.as_bytes()).as_str()));
    let text = approval_text(n, Some(task));
    assert!(text.contains("Not an OS sandbox") && text.contains("acceptEdits") && text.contains("MOCK task"));
    let a = b.approve(&plan, "agents");
    let view = b.start(&f, &request, &a.approval_id, &a.token, "agents").unwrap();
    let (done, out) = finish(&b, &view.id);
    assert_eq!((done.state, done.exit_code, done.kind), ("exited", Some(0), "agent"));
    assert!(out.contains("\"subtype\":\"success\"") && out.contains(&format!("MOCK received {} bytes", task.len())), "{out}");
    let changes = done.changes.unwrap();
    assert_eq!(changes.added, ["mock-agent-edit.txt"]);
    // Retrying the same attempt is refused even with a fresh approval.
    let again = approve(&b, &f, &request);
    assert_eq!(code(&b.start(&f, &request, &again.approval_id, &again.token, "agents").unwrap_err()), "DUPLICATE_ATTEMPT");
}

#[test]
fn writable_profiles_are_gated_by_default() {
    // MEGA-08.2: the shipped registry never enables writable agents; plan/read-only stay available.
    let mut f = fixture();
    let b = gated_agents(&mut f);
    assert!(!b.with_registry(|r| r.allow_writable));
    for id in ["claude", "codex"] {
        let p = crate::agent_cli::probe(&b, id).unwrap();
        assert_eq!(p.state, "ready", "{id}");
        assert!(!p.writable_enabled, "{id}");
    }
    assert!(b.with_registry(|r| r.detect()).iter().all(|p| !p.writable_enabled));
    for (id, profile) in [("claude", "edit"), ("codex", "workspace-write")] {
        assert_eq!(code(&b.normalize(&f, &agent(&f, id, profile, "MODE=edit", "job-gated", 1)).err().unwrap()), "PROFILE_GATED", "{id} {profile}");
    }
    let plan = b.normalize(&f, &agent(&f, "claude", "plan", "hi", "job-plan", 1)).unwrap();
    assert!(plan.normalized.args.windows(2).any(|w| w == ["--tools", "Read,Glob,Grep"]), "{:?}", plan.normalized.args);
    assert!(plan.normalized.args.windows(2).any(|w| w == ["--permission-mode", "plan"]));
    let codex = b.normalize(&f, &agent(&f, "codex", "read-only", "hi", "job-ro", 1)).unwrap();
    assert!(codex.normalized.args.windows(2).any(|w| w == ["--sandbox", "read-only"]));
    assert!(!codex.normalized.args.iter().any(|a| a.contains("bypass") || a == "--full-auto" || a.contains("danger")));
}

#[test]
fn mock_agent_failure_malformed_output_and_cancellation() {
    let mut f = fixture();
    let b = ready_agents(&mut f);
    let (failed, _) = finish(&b, &run(&b, &f, &agent(&f, "codex", "read-only", "MODE=fail", "job-codex", 1)).id);
    assert_eq!((failed.state, failed.exit_code), ("exited", Some(1)));
    let (malformed, out) = finish(&b, &run(&b, &f, &agent(&f, "claude", "plan", "MODE=malformed", "job-m", 1)).id);
    assert_eq!(malformed.exit_code, Some(0));
    assert!(out.contains("MOCK this is not json"), "raw lines are kept for the renderer's tolerant parser");
    let slow = run(&b, &f, &agent(&f, "codex", "workspace-write", "MODE=slow", "job-slow", 1));
    wait_for(&b, &slow.id, "command_execution");
    let cancelled = b.request_cancel(&slow.id).unwrap();
    assert_eq!((cancelled.state, cancelled.tree_verified), ("cancelled", true));
}

#[test]
fn agent_runs_lock_their_workspace() {
    let mut f = fixture();
    let b = ready_agents(&mut f);
    b.set_concurrency(2).unwrap();
    let slow = run(&b, &f, &agent(&f, "claude", "plan", "MODE=slow", "job-lock", 1));
    let other = node(&f, "streams");
    let a = approve(&b, &f, &other);
    assert_eq!(code(&b.start(&f, &other, &a.approval_id, &a.token, "test").unwrap_err()), "WORKSPACE_LOCKED");
    let second_agent = agent(&f, "codex", "read-only", "x", "job-lock-2", 1);
    let a2 = approve(&b, &f, &second_agent);
    assert_eq!(code(&b.start(&f, &second_agent, &a2.approval_id, &a2.token, "test").unwrap_err()), "WORKSPACE_LOCKED");
    b.request_cancel(&slow.id).unwrap();
    assert_eq!(finish(&b, &b.start(&f, &other, &a.approval_id, &a.token, "test").unwrap().id).0.exit_code, Some(0));
}

#[test]
fn changed_cli_binary_requires_a_new_check() {
    let mut f = fixture();
    let b = ready_agents(&mut f);
    let request = agent(&f, "claude", "plan", "hello", "job-id", 1);
    assert!(b.normalize(&f, &request).is_ok());
    let dir = PathBuf::from(b.path_override().unwrap());
    thread::sleep(Duration::from_millis(30));
    fs::write(dir.join("claude.cmd"), shim("fake-claude.cjs") + "@rem MOCK changed\r\n").unwrap();
    assert_eq!(code(&b.normalize(&f, &request).err().unwrap()), "IDENTITY_CHANGED");
}

// ---------- pure helpers and source invariants ----------

#[test]
fn redaction_rules() {
    let mut pem = false;
    let r = |s: &str, pem: &mut bool| redact(s, pem);
    assert_eq!(r("key=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV\n", &mut pem), "key=[REDACTED]\n");
    assert_eq!(r("token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", &mut pem), "token: [REDACTED]");
    assert_eq!(r("Authorization: Bearer abcdefghijklmnop12345", &mut pem), "Authorization: Bearer [REDACTED]");
    assert_eq!(r("PASSWORD = \"correct-horse-battery\"", &mut pem), "PASSWORD = \"[REDACTED]\"");
    assert_eq!(r("aws AKIAABCDEFGHIJKLMNOP", &mut pem), "aws [REDACTED]");
    assert_eq!(r("jwt eyJhbGciOiJIUzI1NiJ9AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", &mut pem), "jwt [REDACTED]");
    assert_eq!(r("-----BEGIN RSA PRIVATE KEY-----\n", &mut pem), "[REDACTED PRIVATE KEY]\n");
    assert!(pem);
    assert_eq!(r("MIIEowIBAAKCAQEA\n", &mut pem), "[REDACTED]\n");
    assert_eq!(r("-----END RSA PRIVATE KEY-----\n", &mut pem), "[REDACTED]\n");
    assert!(!pem);
    for keep in ["tokens: 5", "commit 0123456789abcdef0123456789abcdef01234567", "src/components/Button.tsx:12", "npm test passed (12 tests)", "risk-sk-low"] {
        assert_eq!(r(keep, &mut pem), keep);
    }
}

#[test]
fn spec_hash_binds_every_field() {
    let f = fixture();
    let b = enabled();
    let base = b.normalize(&f, &node(&f, "streams")).unwrap().normalized;
    let h = spec_hash(&base);
    let variants: Vec<Box<dyn Fn(&mut Normalized)>> = vec![
        Box::new(|n| n.args.push("x".into())),
        Box::new(|n| n.args[0].push(' ')),
        Box::new(|n| n.cwd = "sub".into()),
        Box::new(|n| n.executable.push('x')),
        Box::new(|n| n.executable_size += 1),
        Box::new(|n| n.executable_modified += 1),
        Box::new(|n| n.env_scope = "minimal".into()),
        Box::new(|n| n.timeout_secs += 1),
        Box::new(|n| n.workspace_key.push('0')),
        Box::new(|n| n.session_id.push('0')),
        Box::new(|n| n.model = Some("m".into())),
        Box::new(|n| n.attempt = Some(2)),
        Box::new(|n| n.stdin_sha256 = Some("00".into())),
    ];
    for (i, change) in variants.iter().enumerate() {
        let mut n = base.clone();
        change(&mut n);
        assert_ne!(spec_hash(&n), h, "variant {i}");
    }
    // Length prefixes prevent boundary-shift collisions between adjacent arguments.
    let (mut a, mut c) = (base.clone(), base.clone());
    a.args = vec!["ab".into(), "c".into()];
    c.args = vec!["a".into(), "bc".into()];
    assert_ne!(spec_hash(&a), spec_hash(&c));
}

#[test]
fn process_creation_exists_only_in_the_broker() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let needle = ["std::", "process"].concat();
    let mut scanned = 0;
    for entry in fs::read_dir(&src).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().map(|e| e != "rs").unwrap_or(true) {
            continue;
        }
        let shipped = strip_tests(&fs::read_to_string(&path).unwrap());
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        scanned += 1;
        if name == "exec_broker.rs" {
            assert_eq!(shipped.matches("Command::new(").count(), 1, "exactly one spawn site");
            let shells = ["new(\"cmd", "cmd.exe\"", "powershell", "pwsh", "\"/c\"", "\"/C\"", "\"-Command\""];
            assert!(!shells.iter().any(|s| shipped.contains(s)), "no shell is ever constructed");
        } else {
            assert!(!shipped.contains("Command::new") && !shipped.contains(&needle), "{name} must not create processes");
        }
    }
    assert!(scanned >= 9);
}
