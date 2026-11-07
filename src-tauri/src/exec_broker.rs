//! MEGA-08 trusted execution broker: the only Melly module that creates processes.
//! A run is one executable + argument array (never a shell line), bound to a single-use
//! approval that is minted only after a native Windows dialog owned by the main window.
//! Every policy is enforced here, not in the renderer. Containment is a Windows Job Object
//! (process-tree cleanup, bounded process count), not a sandbox: a run has the owner's
//! Windows permissions and may use the network. See MEGA-08 ARCHITECTURE-AND-ADR.md.
use crate::scoped_fs;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    ffi::OsString,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub type Result<T> = std::result::Result<T, String>;

const MAX_ARGS: usize = 64;
const MAX_ARG: usize = 4096;
pub const MAX_TASK: usize = 32 * 1024;
const RING_BYTES: usize = 256 * 1024;
const LINE_FLUSH: usize = 4096;
const POLL_BYTES: usize = 64 * 1024;
const MAX_RUNS: usize = 32;
const MAX_AUDIT: usize = 500;
const MAX_APPROVALS: usize = 64;
const COMMAND_TTL: Duration = Duration::from_secs(60);
const AGENT_TTL: Duration = Duration::from_secs(15 * 60);
pub const JOB_PROCESS_LIMIT: u32 = 64;
const SNAPSHOT_LIMIT: usize = 20_000;
const MAX_CHANGES: usize = 500;
const DRAIN: Duration = Duration::from_secs(5);
pub const EXECUTABLE_EXTENSIONS: [&str; 4] = ["exe", "com", "cmd", "bat"];
/// Permission-bypass spellings no Melly-built or owner-typed argument may contain.
pub const FORBIDDEN: [&str; 6] = ["dangerously", "bypass", "skip-permissions", "approve-for-me", "danger-full-access", "yolo"];
const AGENT_PROGRAMS: [&str; 2] = ["claude", "codex"];
const MINIMAL_ENV: [&str; 16] = [
    "SystemRoot", "windir", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "HOMEDRIVE", "HOMEPATH", "USERNAME", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
];

pub fn coded(code: &str, text: &str) -> String {
    format!("{code}: {text}")
}
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn random_hex() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---------- requests and normalized specifications ----------

fn env_inherit() -> String {
    "inherit".into()
}
fn command_timeout() -> u64 {
    600
}
fn agent_timeout() -> u64 {
    1800
}

/// What the renderer may ask for. Unknown fields (for example an "approved" flag) are ignored.
#[derive(Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExecRequest {
    #[serde(rename_all = "camelCase")]
    Command {
        session_id: String,
        program: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: String,
        #[serde(default = "env_inherit")]
        env_scope: String,
        #[serde(default = "command_timeout")]
        timeout_secs: u64,
    },
    #[serde(rename_all = "camelCase")]
    Agent {
        session_id: String,
        provider: String,
        profile: String,
        #[serde(default)]
        model: String,
        task: String,
        #[serde(default)]
        cwd: String,
        #[serde(default = "agent_timeout")]
        timeout_secs: u64,
        job_id: String,
        attempt: u32,
    },
}
impl ExecRequest {
    fn session_id(&self) -> &str {
        match self {
            ExecRequest::Command { session_id, .. } | ExecRequest::Agent { session_id, .. } => session_id,
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Disclosure {
    pub source_edits: String,
    pub subprocesses: String,
    pub network: String,
    pub external_effects: String,
    pub containment: String,
    pub native_policy: String,
}
pub fn command_disclosure() -> Disclosure {
    Disclosure {
        source_edits: "Possible — the program runs with your Windows account permissions and can change any file you can.".into(),
        subprocesses: format!("Possible — contained in a Windows Job Object (at most {JOB_PROCESS_LIMIT} processes); all are terminated on cancel, timeout or exit."),
        network: "Possible — Melly does not block network access.".into(),
        external_effects: "Possible — Melly does not prevent effects outside this folder.".into(),
        containment: "Windows Job Object for process cleanup only. Not a sandbox.".into(),
        native_policy: "No shell: one executable and an argument array, run once.".into(),
    }
}

/// The exact, native-resolved specification shown in the approval dialog and hashed.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Normalized {
    pub kind: &'static str,
    pub session_id: String,
    pub workspace_key: String,
    pub workspace_name: String,
    pub cwd: String,
    pub executable: String,
    pub executable_size: u64,
    pub executable_modified: u64,
    pub args: Vec<String>,
    pub env_scope: String,
    pub timeout_secs: u64,
    pub stdin_sha256: Option<String>,
    pub stdin_bytes: usize,
    pub provider: Option<String>,
    pub provider_version: Option<String>,
    pub profile: Option<String>,
    pub model: Option<String>,
    pub job_id: Option<String>,
    pub attempt: Option<u32>,
    pub disclosure: Disclosure,
}
/// Deterministic, length-prefixed encoding: every approved field is bound by the hash.
fn canonical(n: &Normalized) -> String {
    let mut out = String::new();
    {
        let mut put = |key: &str, value: &str| {
            out.push_str(&format!("{key}={}:{value}\n", value.len()));
        };
        put("v", "mega08-spec-1");
        put("kind", n.kind);
        put("session", &n.session_id);
        put("workspace", &n.workspace_key);
        put("cwd", &n.cwd);
        put("exe", &n.executable);
        put("exe.size", &n.executable_size.to_string());
        put("exe.modified", &n.executable_modified.to_string());
        put("argc", &n.args.len().to_string());
        for arg in &n.args {
            put("arg", arg);
        }
        put("env", &n.env_scope);
        put("timeout", &n.timeout_secs.to_string());
        put("stdin", n.stdin_sha256.as_deref().unwrap_or("-"));
        put("stdin.bytes", &n.stdin_bytes.to_string());
        put("provider", n.provider.as_deref().unwrap_or("-"));
        put("provider.version", n.provider_version.as_deref().unwrap_or("-"));
        put("profile", n.profile.as_deref().unwrap_or("-"));
        put("model", n.model.as_deref().unwrap_or("-"));
        put("job", n.job_id.as_deref().unwrap_or("-"));
        put("attempt", &n.attempt.map(|a| a.to_string()).unwrap_or_else(|| "-".into()));
    }
    out
}
pub fn spec_hash(n: &Normalized) -> String {
    sha256_hex(canonical(n).as_bytes())
}

/// Spawn inputs that never leave Rust.
pub struct Plan {
    pub normalized: Normalized,
    pub hash: String,
    exe: PathBuf,
    root: PathBuf,
    stdin: Option<Vec<u8>>,
}

pub trait Workspaces {
    fn root(&self, session_id: &str) -> Result<PathBuf>;
}
impl Workspaces for crate::local_folder::FolderState {
    fn root(&self, session_id: &str) -> Result<PathBuf> {
        self.with_root(session_id, |root| Ok(root.to_path_buf())).map_err(|e| coded("STALE_WORKSPACE", &e))
    }
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest.to_string()),
        _ => path,
    }
}
fn extension(name: &str) -> Option<String> {
    Path::new(name).extension().map(|e| e.to_string_lossy().to_ascii_lowercase())
}
pub fn identity(path: &Path) -> Result<(u64, u64)> {
    let metadata = fs::metadata(path).map_err(|_| coded("EXECUTABLE_REFUSED", "The executable is missing or unreadable."))?;
    if !metadata.is_file() {
        return Err(coded("EXECUTABLE_REFUSED", "The executable is not a regular file."));
    }
    let modified = metadata.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0);
    Ok((metadata.len(), modified))
}

/// Resolves a bare program name on PATH × (.exe .com .cmd .bat). Relative PATH entries are
/// ignored, so the working directory is never searched implicitly.
pub fn resolve_program(name: &str, path: Option<&OsString>) -> Result<PathBuf> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c));
    if !valid {
        return Err(coded("EXECUTABLE_REFUSED", "Use a program name such as node or npm, or a path inside the folder."));
    }
    let given = extension(name).filter(|e| EXECUTABLE_EXTENSIONS.contains(&e.as_str()));
    let candidates: Vec<String> = match &given {
        Some(_) => vec![name.to_string()],
        None => EXECUTABLE_EXTENSIONS.iter().map(|e| format!("{name}.{e}")).collect(),
    };
    let search = path.cloned().or_else(|| std::env::var_os("PATH")).unwrap_or_default();
    for dir in std::env::split_paths(&search) {
        if !dir.is_absolute() {
            continue;
        }
        for candidate in &candidates {
            let full = dir.join(candidate);
            if fs::metadata(&full).map(|m| m.is_file()).unwrap_or(false) {
                let canonical = fs::canonicalize(&full).map(strip_verbatim).unwrap_or(full);
                return Ok(canonical);
            }
        }
    }
    Err(coded("EXECUTABLE_REFUSED", &format!("{name} was not found on PATH (.exe, .com, .cmd or .bat).")))
}

pub fn validate_args(args: &[String]) -> Result<()> {
    if args.len() > MAX_ARGS {
        return Err(coded("ARGS_REFUSED", &format!("At most {MAX_ARGS} arguments.")));
    }
    for arg in args {
        if arg.len() > MAX_ARG || arg.contains('\0') {
            return Err(coded("ARGS_REFUSED", &format!("Each argument must be at most {MAX_ARG} characters without NUL.")));
        }
        let lower = arg.to_ascii_lowercase();
        if FORBIDDEN.iter().any(|f| lower.contains(f)) {
            return Err(coded("ARGS_REFUSED", "Permission-bypass arguments are never run by Melly."));
        }
    }
    Ok(())
}

pub struct ProviderPlan {
    pub executable: PathBuf,
    pub version: String,
    pub args: Vec<String>,
    pub disclosure: Disclosure,
}

fn pinned_dir(root: &Path, cwd: &str) -> Result<(PathBuf, Vec<fs::File>)> {
    let (path, guards) = scoped_fs::open_pinned(root, cwd).map_err(|e| coded("CWD_REFUSED", &e))?;
    let is_dir = guards.last().and_then(|g| g.metadata().ok()).map(|m| m.is_dir()).unwrap_or(false);
    if !is_dir {
        return Err(coded("CWD_REFUSED", "The working directory must be a folder inside the open workspace."));
    }
    Ok((path, guards))
}
fn workspace_program(root: &Path, program: &str) -> Result<PathBuf> {
    let relative = program.replace('\\', "/");
    if relative.contains(':') || relative.starts_with('/') {
        return Err(coded("EXECUTABLE_REFUSED", "Absolute, drive, UNC and device paths are not accepted. Use a program name or a path inside the folder."));
    }
    if !extension(&relative).is_some_and(|e| EXECUTABLE_EXTENSIONS.contains(&e.as_str())) {
        return Err(coded("EXECUTABLE_REFUSED", "Only .exe, .com, .cmd and .bat files can be run."));
    }
    let (path, guards) = scoped_fs::open_pinned(root, &relative).map_err(|e| coded("EXECUTABLE_REFUSED", &e))?;
    if !guards.last().and_then(|g| g.metadata().ok()).map(|m| m.is_file()).unwrap_or(false) {
        return Err(coded("EXECUTABLE_REFUSED", "The program path is not a file."));
    }
    Ok(path)
}

impl Broker {
    /// Native normalization. Repeated identically at start; any difference changes the hash.
    pub fn normalize(&self, workspaces: &dyn Workspaces, request: &ExecRequest) -> Result<Plan> {
        if !self.enabled() {
            return Err(coded("DISABLED", "Command and agent execution is disabled for this session. Enable it first."));
        }
        let root = workspaces.root(request.session_id())?;
        let workspace_key = sha256_hex(root.to_string_lossy().to_lowercase().as_bytes());
        let workspace_name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let cwd = match request {
            ExecRequest::Command { cwd, .. } | ExecRequest::Agent { cwd, .. } => cwd.replace('\\', "/"),
        };
        let cwd = cwd.trim_matches('/').to_string();
        pinned_dir(&root, &cwd)?;
        match request {
            ExecRequest::Command { session_id, program, args, env_scope, timeout_secs, .. } => {
                if !["inherit", "minimal"].contains(&env_scope.as_str()) {
                    return Err(coded("ARGS_REFUSED", "Environment scope must be inherit or minimal."));
                }
                if !(1..=3600).contains(timeout_secs) {
                    return Err(coded("ARGS_REFUSED", "Timeout must be 1–3600 seconds."));
                }
                validate_args(args)?;
                let program = program.trim();
                let stem = program.rsplit(['/', '\\']).next().unwrap_or(program).split('.').next().unwrap_or("").to_ascii_lowercase();
                if AGENT_PROGRAMS.contains(&stem.as_str()) {
                    return Err(coded("AGENT_VIA_ADAPTER", "Run Claude Code and Codex from Agents so Melly applies its permission profile."));
                }
                let exe = if program.contains(['/', '\\']) {
                    workspace_program(&root, program)?
                } else {
                    resolve_program(program, None)?
                };
                let (size, modified) = identity(&exe)?;
                let normalized = Normalized {
                    kind: "command",
                    session_id: session_id.clone(),
                    workspace_key,
                    workspace_name,
                    cwd,
                    executable: exe.to_string_lossy().into_owned(),
                    executable_size: size,
                    executable_modified: modified,
                    args: args.clone(),
                    env_scope: env_scope.clone(),
                    timeout_secs: *timeout_secs,
                    stdin_sha256: None,
                    stdin_bytes: 0,
                    provider: None,
                    provider_version: None,
                    profile: None,
                    model: None,
                    job_id: None,
                    attempt: None,
                    disclosure: command_disclosure(),
                };
                let hash = spec_hash(&normalized);
                Ok(Plan { normalized, hash, exe, root, stdin: None })
            }
            ExecRequest::Agent { session_id, provider, profile, model, task, timeout_secs, job_id, attempt, .. } => {
                if task.trim().is_empty() || task.len() > MAX_TASK {
                    return Err(coded("ARGS_REFUSED", &format!("The task must be 1–{MAX_TASK} bytes.")));
                }
                if !(60..=7200).contains(timeout_secs) {
                    return Err(coded("ARGS_REFUSED", "Agent timeout must be 60–7200 seconds."));
                }
                let job_ok = !job_id.is_empty() && job_id.len() <= 64 && job_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
                if !job_ok || *attempt == 0 || *attempt > 100 {
                    return Err(coded("ARGS_REFUSED", "A job id and attempt number are required."));
                }
                let cwd_abs = if cwd.is_empty() { root.clone() } else { root.join(&cwd) };
                let plan = self.with_registry(|registry| registry.plan(provider, profile, model, &cwd_abs))?;
                validate_args(&plan.args)?;
                let (size, modified) = identity(&plan.executable)?;
                let normalized = Normalized {
                    kind: "agent",
                    session_id: session_id.clone(),
                    workspace_key,
                    workspace_name,
                    cwd,
                    executable: plan.executable.to_string_lossy().into_owned(),
                    executable_size: size,
                    executable_modified: modified,
                    args: plan.args,
                    env_scope: "inherit".into(),
                    timeout_secs: *timeout_secs,
                    stdin_sha256: Some(sha256_hex(task.as_bytes())),
                    stdin_bytes: task.len(),
                    provider: Some(provider.clone()),
                    provider_version: Some(plan.version),
                    profile: Some(profile.clone()),
                    model: (!model.is_empty()).then(|| model.clone()),
                    job_id: Some(job_id.clone()),
                    attempt: Some(*attempt),
                    disclosure: plan.disclosure,
                };
                let hash = spec_hash(&normalized);
                Ok(Plan { normalized, hash, exe: plan.executable, root, stdin: Some(task.as_bytes().to_vec()) })
            }
        }
    }
}

// ---------- approvals ----------

struct Approval {
    token: String,
    spec_hash: String,
    session_id: String,
    expires: Instant,
    used: bool,
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Approved {
    pub approval_id: String,
    pub token: String,
    pub spec_hash: String,
    pub expires_in_secs: u64,
    pub normalized: Normalized,
}

// ---------- output ring with redaction ----------

#[derive(Serialize, Clone, Debug)]
pub struct Chunk {
    pub seq: u64,
    pub stream: &'static str,
    pub text: String,
}
#[derive(Default)]
struct Ring {
    chunks: VecDeque<Chunk>,
    bytes: usize,
    next: u64,
    dropped: u64,
    pending: [Vec<u8>; 2],
    pem: [bool; 2],
}
impl Ring {
    fn push(&mut self, stream: usize, data: &[u8]) {
        self.pending[stream].extend_from_slice(data);
        loop {
            let pending = &self.pending[stream];
            let cut = match pending.iter().position(|b| *b == b'\n') {
                Some(at) => at + 1,
                None if pending.len() >= LINE_FLUSH => match std::str::from_utf8(&pending[..LINE_FLUSH]) {
                    Ok(_) => LINE_FLUSH,
                    Err(e) if e.valid_up_to() > 0 => e.valid_up_to(),
                    Err(_) => LINE_FLUSH,
                },
                None => break,
            };
            let line: Vec<u8> = self.pending[stream].drain(..cut).collect();
            self.line(stream, &line);
        }
    }
    fn finish(&mut self, stream: usize) {
        if !self.pending[stream].is_empty() {
            let line = std::mem::take(&mut self.pending[stream]);
            self.line(stream, &line);
        }
    }
    fn line(&mut self, stream: usize, bytes: &[u8]) {
        let text = redact(&String::from_utf8_lossy(bytes), &mut self.pem[stream]);
        self.bytes += text.len();
        self.chunks.push_back(Chunk { seq: self.next, stream: ["stdout", "stderr"][stream], text });
        self.next += 1;
        while self.bytes > RING_BYTES {
            match self.chunks.pop_front() {
                Some(c) => {
                    self.bytes -= c.text.len();
                    self.dropped += c.text.len() as u64;
                }
                None => break,
            }
        }
    }
}

const PREFIXES: [(&str, usize); 14] = [
    ("sk-ant-", 16), ("sk-proj-", 16), ("sk-", 20), ("github_pat_", 20), ("ghp_", 20), ("gho_", 20), ("ghs_", 20), ("ghu_", 20),
    ("glpat-", 16), ("xoxb-", 10), ("xoxp-", 10), ("xoxa-", 10), ("AKIA", 12), ("AIza", 20),
];
const KEYS: [&str; 7] = ["api_key", "api-key", "apikey", "token", "secret", "password", "passwd"];
fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}
fn newline(line: &str) -> &'static str {
    if line.ends_with('\n') {
        "\n"
    } else {
        ""
    }
}
/// Redacts credential-shaped text. Conservative by design: some false positives are accepted.
pub fn redact(line: &str, pem: &mut bool) -> String {
    if line.contains("-----BEGIN") && line.contains("PRIVATE KEY") {
        *pem = !line.contains("-----END");
        return format!("[REDACTED PRIVATE KEY]{}", newline(line));
    }
    if *pem {
        if line.contains("-----END") {
            *pem = false;
        }
        return format!("[REDACTED]{}", newline(line));
    }
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    'scan: while i < chars.len() {
        let boundary = i == 0 || !token_char(chars[i - 1]);
        if boundary {
            for (prefix, min) in PREFIXES {
                let p: Vec<char> = prefix.chars().collect();
                if chars[i..].starts_with(&p) {
                    let mut j = i + p.len();
                    while j < chars.len() && token_char(chars[j]) {
                        j += 1;
                    }
                    if j - i - p.len() >= min {
                        out.push_str("[REDACTED]");
                        i = j;
                        continue 'scan;
                    }
                }
            }
            let rest: String = chars[i..chars.len().min(i + 7)].iter().collect();
            if rest.eq_ignore_ascii_case("bearer ") {
                let mut j = i + 7;
                while j < chars.len() && (token_char(chars[j]) || ".=+/".contains(chars[j])) {
                    j += 1;
                }
                if j - i - 7 >= 16 {
                    out.push_str("Bearer [REDACTED]");
                    i = j;
                    continue 'scan;
                }
            }
            for key in KEYS {
                let k: Vec<char> = key.chars().collect();
                let candidate: String = chars[i..chars.len().min(i + k.len())].iter().collect();
                if candidate.eq_ignore_ascii_case(key) {
                    let mut j = i + k.len();
                    while j < chars.len() && (chars[j] == '"' || chars[j] == '\'' || chars[j] == ' ') {
                        j += 1;
                    }
                    if j < chars.len() && (chars[j] == ':' || chars[j] == '=') {
                        j += 1;
                        while j < chars.len() && (chars[j] == ' ' || chars[j] == '"' || chars[j] == '\'') {
                            j += 1;
                        }
                        let start = j;
                        while j < chars.len() && !chars[j].is_whitespace() && !"\"',;".contains(chars[j]) {
                            j += 1;
                        }
                        if j - start >= 8 {
                            out.extend(&chars[i..start]);
                            out.push_str("[REDACTED]");
                            i = j;
                            continue 'scan;
                        }
                    }
                }
            }
            // Long mixed-case alphanumeric runs (base64/JWT-like). Lowercase hex (Git ids) is kept.
            let mut j = i;
            while j < chars.len() && (token_char(chars[j]) || chars[j] == '+' || chars[j] == '=') {
                j += 1;
            }
            if j - i >= 40 {
                let run = &chars[i..j];
                if run.iter().any(|c| c.is_ascii_uppercase()) && run.iter().any(|c| c.is_ascii_lowercase()) && run.iter().any(|c| c.is_ascii_digit()) {
                    out.push_str("[REDACTED]");
                    i = j;
                    continue 'scan;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

// ---------- Windows Job Object containment ----------

#[cfg(windows)]
mod win {
    use super::{coded, Result, JOB_PROCESS_LIMIT};
    use std::{os::windows::io::AsRawHandle, process::Child};
    use windows::core::PCWSTR;
    use windows::Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE, HWND, WAIT_TIMEOUT},
        System::{
            Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32},
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
                QueryInformationJobObject, SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{
                GetProcessTimes, OpenProcess, OpenThread, ResumeThread, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
                PROCESS_SYNCHRONIZE, THREAD_SUSPEND_RESUME,
            },
        },
        UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONWARNING, MB_SETFOREGROUND, MB_YESNO},
    };
    pub const CREATE_FLAGS: u32 = 0x0000_0004 | 0x0800_0000; // CREATE_SUSPENDED | CREATE_NO_WINDOW

    /// Owned Job Object handle; closing it kills any process still in the job.
    pub struct Job(isize);
    impl Job {
        pub fn new() -> Result<Job> {
            unsafe {
                let handle = CreateJobObjectW(None, PCWSTR::null()).map_err(|_| coded("SPAWN_FAILED", "Windows Job Object unavailable."))?;
                let job = Job(handle.0 as isize);
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
                limits.BasicLimitInformation.ActiveProcessLimit = JOB_PROCESS_LIMIT;
                SetInformationJobObject(
                    job.handle(),
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .map_err(|_| coded("SPAWN_FAILED", "Windows Job Object limits could not be set."))?;
                Ok(job)
            }
        }
        fn handle(&self) -> HANDLE {
            HANDLE(self.0 as *mut _)
        }
        pub fn assign(&self, child: &Child) -> bool {
            unsafe { AssignProcessToJobObject(self.handle(), HANDLE(child.as_raw_handle() as *mut _)).is_ok() }
        }
        pub fn terminate(&self) -> bool {
            unsafe { TerminateJobObject(self.handle(), 1).is_ok() }
        }
        pub fn active(&self) -> Option<u32> {
            let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            unsafe {
                QueryInformationJobObject(
                    Some(self.handle()),
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut _,
                    std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    None,
                )
                .ok()?;
            }
            Some(info.ActiveProcesses)
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.handle());
            }
        }
    }
    /// Resumes the only thread of a process created suspended (after job assignment).
    pub fn resume(pid: u32) -> bool {
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) else { return false };
            let mut entry = THREADENTRY32 { dwSize: std::mem::size_of::<THREADENTRY32>() as u32, ..Default::default() };
            let mut resumed = false;
            let mut ok = Thread32First(snapshot, &mut entry).is_ok();
            while ok {
                if entry.th32OwnerProcessID == pid {
                    if let Ok(thread) = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) {
                        resumed |= ResumeThread(thread) != u32::MAX;
                        let _ = CloseHandle(thread);
                    }
                }
                ok = Thread32Next(snapshot, &mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
            resumed
        }
    }
    fn filetime(t: FILETIME) -> u64 {
        ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
    }
    pub fn creation_time_of(child: &Child) -> u64 {
        creation(HANDLE(child.as_raw_handle() as *mut _)).unwrap_or(0)
    }
    fn creation(process: HANDLE) -> Option<u64> {
        let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        unsafe { GetProcessTimes(process, &mut c, &mut e, &mut k, &mut u).ok()? };
        Some(filetime(c))
    }
    /// "alive" only when a process with this pid AND creation time is still running.
    pub fn process_state(pid: u32, created: u64) -> &'static str {
        unsafe {
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) else { return "gone" };
            let same = creation(process) == Some(created);
            let running = WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
            let _ = CloseHandle(process);
            if same && running {
                "alive"
            } else {
                "gone"
            }
        }
    }
    pub fn confirm(owner: usize, title: &str, body: &str) -> bool {
        let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
        let body: Vec<u16> = body.encode_utf16().chain(Some(0)).collect();
        unsafe {
            MessageBoxW(Some(HWND(owner as *mut _)), PCWSTR(body.as_ptr()), PCWSTR(title.as_ptr()), MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2 | MB_SETFOREGROUND)
                == IDYES
        }
    }
}

/// Job Object reference shared with cancel so the tree can be terminated without the run lock.
#[cfg(windows)]
type JobRef = win::Job;
#[cfg(not(windows))]
struct JobRef;
#[cfg(not(windows))]
impl JobRef {
    fn terminate(&self) -> bool {
        false
    }
    fn active(&self) -> Option<u32> {
        Some(0)
    }
}

struct Spawned {
    child: Child,
    job: JobRef,
    pid: u32,
    created: u64,
}
#[cfg(windows)]
fn spawn(exe: &Path, args: &[String], cwd: &Path, minimal_env: bool, stdin: bool) -> Result<Spawned> {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new(exe);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(if stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(win::CREATE_FLAGS);
    if minimal_env {
        command.env_clear();
        for key in MINIMAL_ENV {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
    }
    let mut child = command.spawn().map_err(|e| coded("SPAWN_FAILED", &format!("The program could not start (OS code {:?}).", e.raw_os_error())))?;
    let pid = child.id();
    let abort = |child: &mut Child, message: &str| {
        let _ = child.kill();
        let _ = child.wait();
        coded("SPAWN_FAILED", message)
    };
    let job = match win::Job::new() {
        Ok(job) => job,
        Err(e) => return Err(abort(&mut child, &e)),
    };
    if !job.assign(&child) {
        return Err(abort(&mut child, "The process could not be placed in a Windows Job Object; it was stopped before running."));
    }
    let created = win::creation_time_of(&child);
    if !win::resume(pid) {
        job.terminate();
        let _ = child.wait();
        return Err(coded("SPAWN_FAILED", "The suspended process could not be resumed; it was terminated."));
    }
    Ok(Spawned { child, job, pid, created })
}
#[cfg(not(windows))]
fn spawn(_: &Path, _: &[String], _: &Path, _: bool, _: bool) -> Result<Spawned> {
    Err(coded("UNSUPPORTED", "Execution is available in the Windows desktop app only."))
}

fn reader(mut pipe: impl Read + Send + 'static, sink: impl Fn(&[u8]) + Send + 'static) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        while let Ok(n) = pipe.read(&mut buffer) {
            if n == 0 {
                break;
            }
            sink(&buffer[..n]);
        }
    })
}
fn join_bounded(handles: Vec<thread::JoinHandle<()>>, limit: Duration) -> bool {
    let until = Instant::now() + limit;
    while handles.iter().any(|h| !h.is_finished()) && Instant::now() < until {
        thread::sleep(Duration::from_millis(20));
    }
    let done = handles.iter().all(|h| h.is_finished());
    for h in handles.into_iter().filter(|h| h.is_finished()) {
        let _ = h.join();
    }
    done
}
fn pipes(child: &mut Child) -> [Option<Box<dyn Read + Send>>; 2] {
    [child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>), child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>)]
}

/// Fixed, read-only probe of a provider binary (`--version`, help). Contained like a run,
/// never in a workspace, no stdin, bounded output. Not recorded as a run.
pub fn run_fixed(exe: &Path, args: &[&str], timeout: Duration) -> Result<(Option<i32>, String, String)> {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    validate_args(&args)?;
    let Spawned { mut child, job, .. } = spawn(exe, &args, &std::env::temp_dir(), false, false)?;
    let out = Arc::new(Mutex::new((Vec::<u8>::new(), Vec::<u8>::new())));
    let mut readers = vec![];
    for (index, pipe) in pipes(&mut child).into_iter().enumerate() {
        if let Some(pipe) = pipe {
            let out = out.clone();
            readers.push(reader(pipe, move |bytes| {
                if let Ok(mut o) = out.lock() {
                    let target = if index == 0 { &mut o.0 } else { &mut o.1 };
                    if target.len() < 512 * 1024 {
                        target.extend_from_slice(bytes);
                    }
                }
            }));
        }
    }
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() >= deadline => break None,
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(_) => break None,
        }
    };
    job.terminate();
    let _ = child.wait();
    join_bounded(readers, DRAIN);
    let (stdout, stderr) =
        out.lock().map(|o| (String::from_utf8_lossy(&o.0).into_owned(), String::from_utf8_lossy(&o.1).into_owned())).unwrap_or_default();
    match status {
        Some(status) => Ok((status.code(), stdout, stderr)),
        None => Err(coded("TIMEOUT", "The probe did not finish in time and was stopped.")),
    }
}

// ---------- workspace change snapshots ----------

type Snapshot = (BTreeMap<String, (u64, u64)>, bool);
fn snapshot(root: &Path) -> Snapshot {
    let mut files = BTreeMap::new();
    let complete = scoped_fs::walk(root, SNAPSHOT_LIMIT, &mut |item| {
        if item.relative == ".git" {
            return false;
        }
        if item.metadata.is_file() {
            let modified = item.metadata.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0);
            files.insert(item.relative.to_string(), (item.metadata.len(), modified));
        }
        true
    })
    .unwrap_or(false);
    (files, complete)
}
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
    pub total: usize,
    pub truncated: bool,
    pub complete: bool,
    pub attribution: &'static str,
    pub notes: Vec<String>,
}
fn compare(before: &Snapshot, after: &Snapshot, saves: u64, overlapped: bool) -> Changes {
    let mut changes = Changes { complete: before.1 && after.1, ..Default::default() };
    for (path, meta) in &after.0 {
        match before.0.get(path) {
            None => changes.added.push(path.clone()),
            Some(old) if old != meta => changes.modified.push(path.clone()),
            _ => {}
        }
    }
    for path in before.0.keys().filter(|p| !after.0.contains_key(*p)) {
        changes.removed.push(path.clone());
    }
    changes.total = changes.added.len() + changes.modified.len() + changes.removed.len();
    for list in [&mut changes.added, &mut changes.modified, &mut changes.removed] {
        if list.len() > MAX_CHANGES {
            list.truncate(MAX_CHANGES);
            changes.truncated = true;
        }
    }
    changes.attribution = if saves == 0 && !overlapped { "exclusive-melly-window" } else { "uncertain" };
    if saves > 0 {
        changes.notes.push(format!("{saves} file save(s) were made in Melly during this run; those files may not be the run's changes."));
    }
    if overlapped {
        changes.notes.push("Another Melly run used this workspace during this run.".into());
    }
    if !changes.complete {
        changes.notes.push(format!("The workspace exceeds {SNAPSHOT_LIMIT} items; the change summary is partial."));
    }
    changes.notes.push("Edits by other programs during this window cannot be excluded.".into());
    changes
}

// ---------- runs, audit and the broker ----------

struct Run {
    id: String,
    kind: &'static str,
    surface: String,
    spec_hash: String,
    approval_id: String,
    workspace_key: String,
    executable_name: String,
    arg_count: usize,
    job_id: Option<String>,
    attempt: Option<u32>,
    provider: Option<String>,
    started_at: u64,
    started: Instant,
    ended_at: Option<u64>,
    elapsed_ms: Option<u64>,
    pid: u32,
    created: u64,
    state: &'static str,
    exit_code: Option<i64>,
    cancel_requested: bool,
    timed_out: bool,
    leftover_terminated: u32,
    tree_verified: bool,
    error: Option<String>,
    output: Ring,
    overlapped: bool,
    changes: Option<Changes>,
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    pub id: String,
    pub kind: &'static str,
    pub surface: String,
    pub spec_hash: String,
    pub approval_id: String,
    pub workspace_key: String,
    pub executable_name: String,
    pub arg_count: usize,
    pub job_id: Option<String>,
    pub attempt: Option<u32>,
    pub provider: Option<String>,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub elapsed_ms: u64,
    pub pid: u32,
    pub process_created: u64,
    pub state: &'static str,
    pub exit_code: Option<i64>,
    pub cancel_requested: bool,
    pub timed_out: bool,
    pub leftover_terminated: u32,
    pub tree_verified: bool,
    pub error: Option<String>,
    pub output_bytes: usize,
    pub dropped_bytes: u64,
    pub changes: Option<Changes>,
}
impl Run {
    fn view(&self) -> RunView {
        RunView {
            id: self.id.clone(),
            kind: self.kind,
            surface: self.surface.clone(),
            spec_hash: self.spec_hash.clone(),
            approval_id: self.approval_id.clone(),
            workspace_key: self.workspace_key.chars().take(12).collect(),
            executable_name: self.executable_name.clone(),
            arg_count: self.arg_count,
            job_id: self.job_id.clone(),
            attempt: self.attempt,
            provider: self.provider.clone(),
            started_at: self.started_at,
            ended_at: self.ended_at,
            elapsed_ms: self.elapsed_ms.unwrap_or_else(|| self.started.elapsed().as_millis() as u64),
            pid: self.pid,
            process_created: self.created,
            state: self.state,
            exit_code: self.exit_code,
            cancel_requested: self.cancel_requested,
            timed_out: self.timed_out,
            leftover_terminated: self.leftover_terminated,
            tree_verified: self.tree_verified,
            error: self.error.clone(),
            output_bytes: self.output.bytes,
            dropped_bytes: self.output.dropped,
            changes: self.changes.clone(),
        }
    }
    fn active(&self) -> bool {
        matches!(self.state, "running" | "cancelling")
    }
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub at: u64,
    pub event: &'static str,
    pub id: String,
    pub kind: &'static str,
    pub surface: String,
    pub workspace: String,
    pub spec_hash: String,
    pub executable_name: String,
    pub arg_count: usize,
    pub pid: Option<u32>,
    pub exit_code: Option<i64>,
    pub code: Option<String>,
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub compiled: bool,
    pub enabled: bool,
    pub platform: &'static str,
    pub mode: &'static str,
    pub interactive_shell: bool,
    pub approval: &'static str,
    pub containment: &'static str,
    pub max_concurrent: usize,
    pub active_runs: usize,
    pub reason: String,
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Poll {
    pub run: RunView,
    pub chunks: Vec<Chunk>,
    pub next_cursor: u64,
    pub missed: bool,
}
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileRecord {
    pub run_id: String,
    pub pid: u32,
    pub process_created: u64,
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileResult {
    pub run_id: String,
    pub status: &'static str,
    pub run: Option<RunView>,
}

struct Inner {
    enabled: bool,
    max_concurrent: usize,
    approvals: HashMap<String, Approval>,
    runs: VecDeque<Run>,
    audit: VecDeque<AuditEntry>,
    attempts: HashSet<String>,
    registry: crate::agent_cli::Registry,
}
type Jobs = Arc<Mutex<HashMap<String, Arc<JobRef>>>>;
pub struct Broker {
    inner: Arc<Mutex<Inner>>,
    jobs: Jobs,
    dialog_open: AtomicBool,
}
impl Default for Broker {
    fn default() -> Self {
        Broker {
            inner: Arc::new(Mutex::new(Inner {
                enabled: false,
                max_concurrent: 1,
                approvals: HashMap::new(),
                runs: VecDeque::new(),
                audit: VecDeque::new(),
                attempts: HashSet::new(),
                registry: crate::agent_cli::Registry::default(),
            })),
            jobs: Arc::default(),
            dialog_open: AtomicBool::new(false),
        }
    }
}
#[allow(clippy::too_many_arguments)]
fn audit(inner: &mut Inner, event: &'static str, id: &str, normalized: Option<&Normalized>, surface: &str, pid: Option<u32>, exit_code: Option<i64>, code: Option<&str>) {
    inner.audit.push_back(AuditEntry {
        at: now_ms(),
        event,
        id: id.to_string(),
        kind: normalized.map(|n| n.kind).unwrap_or("-"),
        surface: surface.chars().take(40).collect(),
        workspace: normalized.map(|n| n.workspace_key.chars().take(8).collect()).unwrap_or_default(),
        spec_hash: normalized.map(|n| spec_hash(n).chars().take(16).collect()).unwrap_or_default(),
        executable_name: normalized.and_then(|n| Path::new(&n.executable).file_name().map(|f| f.to_string_lossy().into_owned())).unwrap_or_default(),
        arg_count: normalized.map(|n| n.args.len()).unwrap_or(0),
        pid,
        exit_code,
        code: code.map(|c| c.split(':').next().unwrap_or("").to_string()),
    });
    while inner.audit.len() > MAX_AUDIT {
        inner.audit.pop_front();
    }
}

impl Broker {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    pub fn enabled(&self) -> bool {
        self.lock().enabled
    }
    #[cfg(test)]
    pub fn path_override(&self) -> Option<OsString> {
        self.lock().registry.path_override.clone()
    }
    pub fn with_registry<T>(&self, f: impl FnOnce(&mut crate::agent_cli::Registry) -> T) -> T {
        f(&mut self.lock().registry)
    }
    pub fn capability(&self) -> Capability {
        let inner = self.lock();
        Capability {
            compiled: true,
            enabled: inner.enabled,
            platform: if cfg!(windows) { "windows" } else { "unsupported" },
            mode: "approved-one-shot",
            interactive_shell: false,
            approval: "native Windows dialog per run; single-use token bound to the exact specification",
            containment: "Windows Job Object (process-tree cleanup, max 64 processes). Not a sandbox.",
            max_concurrent: inner.max_concurrent,
            active_runs: inner.runs.iter().filter(|r| r.active()).count(),
            reason: if inner.enabled {
                "Enabled for this app session. Every run still needs its own native approval.".into()
            } else {
                "Disabled. Execution starts disabled in every app session until you enable it in a native dialog.".into()
            },
        }
    }
    pub fn set_enabled(&self, enabled: bool) {
        let mut inner = self.lock();
        inner.enabled = enabled;
        if !enabled {
            inner.approvals.clear();
        }
        audit(&mut inner, if enabled { "enabled" } else { "disabled" }, "-", None, "main", None, None, None);
    }
    pub fn set_concurrency(&self, max: usize) -> Result<()> {
        if !(1..=2).contains(&max) {
            return Err(coded("ARGS_REFUSED", "Concurrency must be 1 or 2."));
        }
        self.lock().max_concurrent = max;
        Ok(())
    }
    pub fn note(&self, event: &'static str, plan: Option<&Normalized>, surface: &str, error: &str) {
        let mut inner = self.lock();
        audit(&mut inner, event, "-", plan, surface, None, None, Some(error));
    }
    /// Mints a single-use approval. Called only after a native consent returned Yes.
    pub fn approve(&self, plan: &Plan, surface: &str) -> Approved {
        let mut inner = self.lock();
        let now = Instant::now();
        inner.approvals.retain(|_, a| !a.used && a.expires > now);
        while inner.approvals.len() >= MAX_APPROVALS {
            let oldest = inner.approvals.iter().min_by_key(|(_, a)| a.expires).map(|(k, _)| k.clone());
            match oldest {
                Some(key) => inner.approvals.remove(&key),
                None => break,
            };
        }
        let ttl = if plan.normalized.kind == "agent" { AGENT_TTL } else { COMMAND_TTL };
        let id = random_hex();
        let token = format!("{}{}", random_hex(), random_hex());
        inner.approvals.insert(
            id.clone(),
            Approval { token: token.clone(), spec_hash: plan.hash.clone(), session_id: plan.normalized.session_id.clone(), expires: now + ttl, used: false },
        );
        audit(&mut inner, "approved", &id, Some(&plan.normalized), surface, None, None, None);
        Approved { approval_id: id, token, spec_hash: plan.hash.clone(), expires_in_secs: ttl.as_secs(), normalized: plan.normalized.clone() }
    }
    fn consume(inner: &mut Inner, approval_id: &str, token: &str, plan: &Plan) -> Result<()> {
        let Some(approval) = inner.approvals.get_mut(approval_id) else {
            return Err(coded("APPROVAL_INVALID", "No such approval. Request approval again."));
        };
        if approval.used {
            return Err(coded("APPROVAL_REPLAY", "This approval was already used. Each run needs a new approval."));
        }
        if Instant::now() >= approval.expires {
            inner.approvals.remove(approval_id);
            return Err(coded("APPROVAL_EXPIRED", "The approval expired before the run started. Request approval again."));
        }
        if !ct_eq(&approval.token, token) {
            return Err(coded("APPROVAL_INVALID", "The approval token does not match."));
        }
        if approval.session_id != plan.normalized.session_id {
            approval.used = true;
            return Err(coded("STALE_WORKSPACE", "The approval belongs to another workspace session."));
        }
        if !ct_eq(&approval.spec_hash, &plan.hash) {
            approval.used = true;
            return Err(coded("SPEC_MISMATCH", "The request differs from what was approved. The approval was invalidated."));
        }
        approval.used = true;
        Ok(())
    }
    #[cfg(test)]
    pub fn expire_all(&self) {
        for approval in self.lock().approvals.values_mut() {
            approval.expires = Instant::now() - Duration::from_millis(1);
        }
    }

    /// Re-normalizes, checks limits, consumes the approval and spawns inside a Job Object.
    pub fn start(&self, workspaces: &dyn Workspaces, request: &ExecRequest, approval_id: &str, token: &str, surface: &str) -> Result<RunView> {
        let plan = match self.normalize(workspaces, request) {
            Ok(plan) => plan,
            Err(e) => {
                // An approval presented with a request that no longer normalizes is invalidated.
                if let Some(a) = self.lock().approvals.get_mut(approval_id) {
                    a.used = true;
                }
                self.note("start-refused", None, surface, &e);
                return Err(e);
            }
        };
        let (_cwd, _pins) = pinned_dir(&plan.root, &plan.normalized.cwd)?;
        let cwd_abs = if plan.normalized.cwd.is_empty() { plan.root.clone() } else { plan.root.join(&plan.normalized.cwd) };
        let attempt_key = plan.normalized.job_id.as_ref().map(|j| format!("{j}#{}", plan.normalized.attempt.unwrap_or(0)));
        {
            let mut inner = self.lock();
            let refused = (|| {
                let active = inner.runs.iter().filter(|r| r.active()).count();
                if active >= inner.max_concurrent {
                    return Err(coded("BUSY", &format!("{active} run(s) active; the limit is {}.", inner.max_concurrent)));
                }
                let locked = inner.runs.iter().any(|r| r.active() && r.workspace_key == plan.normalized.workspace_key && (r.kind == "agent" || plan.normalized.kind == "agent"));
                if locked {
                    return Err(coded("WORKSPACE_LOCKED", "An agent run is exclusive in its workspace; another run is active there."));
                }
                if let Some(key) = &attempt_key {
                    if inner.attempts.contains(key) {
                        return Err(coded("DUPLICATE_ATTEMPT", "This job attempt was already started. Retry creates a new attempt."));
                    }
                }
                Broker::consume(&mut inner, approval_id, token, &plan)?;
                if let Some(key) = &attempt_key {
                    inner.attempts.insert(key.clone());
                }
                Ok(())
            })();
            if let Err(e) = refused {
                audit(&mut inner, "start-refused", approval_id, Some(&plan.normalized), surface, None, None, Some(&e));
                return Err(e);
            }
        }
        let before = snapshot(&plan.root);
        let saves_at_start = crate::diagnostics::saves_ok();
        let Spawned { mut child, job, pid, created } = match spawn(&plan.exe, &plan.normalized.args, &cwd_abs, plan.normalized.env_scope == "minimal", plan.stdin.is_some()) {
            Ok(spawned) => spawned,
            Err(e) => {
                let mut inner = self.lock();
                audit(&mut inner, "failed", approval_id, Some(&plan.normalized), surface, None, None, Some(&e));
                return Err(e);
            }
        };
        let id = random_hex();
        let mut run = Run {
            id: id.clone(),
            kind: plan.normalized.kind,
            surface: surface.chars().take(40).collect(),
            spec_hash: plan.hash.clone(),
            approval_id: approval_id.to_string(),
            workspace_key: plan.normalized.workspace_key.clone(),
            executable_name: Path::new(&plan.normalized.executable).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
            arg_count: plan.normalized.args.len(),
            job_id: plan.normalized.job_id.clone(),
            attempt: plan.normalized.attempt,
            provider: plan.normalized.provider.clone(),
            started_at: now_ms(),
            started: Instant::now(),
            ended_at: None,
            elapsed_ms: None,
            pid,
            created,
            state: "running",
            exit_code: None,
            cancel_requested: false,
            timed_out: false,
            leftover_terminated: 0,
            tree_verified: false,
            error: None,
            output: Ring::default(),
            overlapped: false,
            changes: None,
        };
        let job = Arc::new(job);
        self.jobs.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone(), job.clone());
        let view;
        {
            let mut inner = self.lock();
            for other in inner.runs.iter_mut().filter(|r| r.active() && r.workspace_key == run.workspace_key) {
                other.overlapped = true;
                run.overlapped = true;
            }
            view = run.view();
            inner.runs.push_back(run);
            while inner.runs.len() > MAX_RUNS {
                match inner.runs.iter().position(|r| !r.active()) {
                    Some(at) => {
                        inner.runs.remove(at);
                    }
                    None => break,
                }
            }
            audit(&mut inner, "started", &id, Some(&plan.normalized), surface, Some(pid), None, None);
        }
        let mut readers = vec![];
        if let (Some(mut pipe), Some(bytes)) = (child.stdin.take(), plan.stdin.clone()) {
            readers.push(thread::spawn(move || {
                let _ = pipe.write_all(&bytes);
            }));
        }
        for (index, pipe) in pipes(&mut child).into_iter().enumerate() {
            if let Some(pipe) = pipe {
                let inner = self.inner.clone();
                let id = id.clone();
                readers.push(reader(pipe, move |bytes| {
                    let mut inner = inner.lock().unwrap_or_else(|p| p.into_inner());
                    if let Some(run) = inner.runs.iter_mut().find(|r| r.id == id) {
                        run.output.push(index, bytes);
                    }
                }));
            }
        }
        let context = Supervised {
            inner: self.inner.clone(),
            jobs: self.jobs.clone(),
            id,
            timeout: Duration::from_secs(plan.normalized.timeout_secs),
            root: plan.root.clone(),
            before,
            saves_at_start,
            normalized: plan.normalized.clone(),
            surface: surface.to_string(),
        };
        thread::spawn(move || supervise(context, child, job, readers));
        Ok(view)
    }
    pub fn poll(&self, run_id: &str, cursor: u64) -> Result<Poll> {
        let inner = self.lock();
        let run = inner.runs.iter().find(|r| r.id == run_id).ok_or_else(|| coded("NOT_FOUND", "No such run in this app session."))?;
        let first = run.output.chunks.front().map(|c| c.seq).unwrap_or(run.output.next);
        let mut chunks = vec![];
        let mut bytes = 0;
        for chunk in run.output.chunks.iter().filter(|c| c.seq >= cursor) {
            if bytes + chunk.text.len() > POLL_BYTES && !chunks.is_empty() {
                break;
            }
            bytes += chunk.text.len();
            chunks.push(chunk.clone());
        }
        let next_cursor = chunks.last().map(|c| c.seq + 1).unwrap_or(cursor.max(first));
        Ok(Poll { run: run.view(), chunks, next_cursor, missed: cursor < first })
    }
    pub fn request_cancel(&self, run_id: &str) -> Result<RunView> {
        {
            let mut inner = self.lock();
            let run = inner.runs.iter_mut().find(|r| r.id == run_id).ok_or_else(|| coded("NOT_FOUND", "No such run in this app session."))?;
            if !run.active() {
                return Ok(run.view());
            }
            run.cancel_requested = true;
            run.state = "cancelling";
        }
        let job = self.jobs.lock().unwrap_or_else(|p| p.into_inner()).get(run_id).cloned();
        if let Some(job) = job {
            job.terminate();
        }
        let until = Instant::now() + DRAIN + DRAIN;
        loop {
            let view = self.lock().runs.iter().find(|r| r.id == run_id).map(|r| r.view());
            match view {
                Some(view) if view.state == "cancelling" && Instant::now() < until => thread::sleep(Duration::from_millis(25)),
                Some(view) => return Ok(view),
                None => return Err(coded("NOT_FOUND", "No such run.")),
            }
        }
    }
    pub fn runs(&self) -> Vec<RunView> {
        self.lock().runs.iter().map(|r| r.view()).collect()
    }
    pub fn audit_log(&self) -> Vec<AuditEntry> {
        self.lock().audit.iter().cloned().collect()
    }
    pub fn reconcile(&self, records: &[ReconcileRecord]) -> Result<Vec<ReconcileResult>> {
        if records.len() > 50 {
            return Err(coded("ARGS_REFUSED", "At most 50 records."));
        }
        let inner = self.lock();
        Ok(records
            .iter()
            .map(|record| {
                if let Some(run) = inner.runs.iter().find(|r| r.id == record.run_id) {
                    return ReconcileResult { run_id: record.run_id.clone(), status: "managed", run: Some(run.view()) };
                }
                #[cfg(windows)]
                let status = if record.pid == 0 { "unknown" } else { win::process_state(record.pid, record.process_created) };
                #[cfg(not(windows))]
                let status = "unknown";
                ReconcileResult { run_id: record.run_id.clone(), status: if status == "alive" { "alive-unmanaged" } else { status }, run: None }
            })
            .collect())
    }
}

struct Supervised {
    inner: Arc<Mutex<Inner>>,
    jobs: Jobs,
    id: String,
    timeout: Duration,
    root: PathBuf,
    before: Snapshot,
    saves_at_start: u64,
    normalized: Normalized,
    surface: String,
}
fn supervise(context: Supervised, mut child: Child, job: Arc<JobRef>, readers: Vec<thread::JoinHandle<()>>) {
    let Supervised { inner, jobs, id, timeout, root, before, saves_at_start, normalized, surface } = context;
    let deadline = Instant::now() + timeout;
    let mut terminated = false;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        let cancel = inner.lock().map(|i| i.runs.iter().any(|r| r.id == id && r.cancel_requested)).unwrap_or(true);
        if (cancel || Instant::now() >= deadline) && !terminated {
            timed_out = !cancel;
            terminated = job.terminate();
        }
        thread::sleep(Duration::from_millis(40));
    };
    // The main process is gone; anything left in the job is a descendant of this run.
    let leftover = job.active().unwrap_or(0);
    if leftover > 0 {
        job.terminate();
    }
    let until = Instant::now() + DRAIN;
    let mut drained = job.active() == Some(0);
    while !drained && Instant::now() < until {
        thread::sleep(Duration::from_millis(20));
        drained = job.active() == Some(0);
    }
    let pipes_closed = join_bounded(readers, DRAIN);
    let after = snapshot(&root);
    let saves = crate::diagnostics::saves_ok().saturating_sub(saves_at_start);
    jobs.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
    let mut inner = inner.lock().unwrap_or_else(|p| p.into_inner());
    let Some(run) = inner.runs.iter_mut().find(|r| r.id == id) else { return };
    run.output.finish(0);
    run.output.finish(1);
    run.exit_code = status.and_then(|s| s.code()).map(i64::from);
    run.leftover_terminated = leftover;
    run.tree_verified = drained;
    run.timed_out = timed_out;
    run.ended_at = Some(now_ms());
    run.elapsed_ms = Some(run.started.elapsed().as_millis() as u64);
    run.state = if run.cancel_requested {
        "cancelled"
    } else if timed_out {
        "timed-out"
    } else if status.is_some() {
        "exited"
    } else {
        "failed"
    };
    if !drained {
        run.error = Some(coded("TREE_UNCONFIRMED", "The main process ended, but Melly could not confirm that every child process stopped."));
    } else if !pipes_closed {
        run.error = Some(coded("PIPES_OPEN", "Output pipes stayed open after the process tree stopped; output may be incomplete."));
    }
    run.changes = Some(compare(&before, &after, saves, run.overlapped));
    let (pid, exit) = (run.pid, run.exit_code);
    let event = match run.state {
        "cancelled" => "cancelled",
        "timed-out" => "timed-out",
        "exited" => "exited",
        _ => "failed",
    };
    audit(&mut inner, event, &id, Some(&normalized), &surface, Some(pid), exit, None);
}

// ---------- Tauri commands (main window only) ----------

fn main_only(window: &tauri::WebviewWindow) -> Result<()> {
    if crate::invoke_allowed(window.label()) {
        Ok(())
    } else {
        Err(coded("WINDOW_REFUSED", "Execution is available only to the main window."))
    }
}
async fn consent(window: &tauri::WebviewWindow, broker: &Broker, title: &'static str, body: String) -> Result<bool> {
    if broker.dialog_open.swap(true, Ordering::SeqCst) {
        return Err(coded("BUSY", "A Melly approval dialog is already open."));
    }
    #[cfg(windows)]
    let owner = window.hwnd().map(|h| h.0 as usize).unwrap_or(0);
    #[cfg(not(windows))]
    let owner = 0usize;
    let (tx, rx) = std::sync::mpsc::channel();
    let posted = window.run_on_main_thread(move || {
        #[cfg(windows)]
        let answer = win::confirm(owner, title, &body);
        #[cfg(not(windows))]
        let answer = {
            let _ = (owner, title, body);
            false
        };
        let _ = tx.send(answer);
    });
    if posted.is_err() {
        broker.dialog_open.store(false, Ordering::SeqCst);
        return Err(coded("DIALOG_FAILED", "The native approval dialog could not open."));
    }
    let answer = tauri::async_runtime::spawn_blocking(move || rx.recv()).await;
    broker.dialog_open.store(false, Ordering::SeqCst);
    match answer {
        Ok(Ok(yes)) => Ok(yes),
        _ => Err(coded("DIALOG_FAILED", "The native approval dialog closed unexpectedly.")),
    }
}
fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        format!("{}… (+{} more characters; the full value is bound by the approval hash)", text.chars().take(max).collect::<String>(), text.chars().count() - max)
    }
}
/// Exact text of the native approval dialog for a normalized specification.
pub fn approval_text(n: &Normalized, task: Option<&str>) -> String {
    let mut lines = vec![];
    let d = &n.disclosure;
    if n.kind == "agent" {
        lines.push(format!("Agent: {} {} · profile {}", n.provider.as_deref().unwrap_or("?"), n.provider_version.as_deref().unwrap_or(""), n.profile.as_deref().unwrap_or("?")));
        lines.push(format!("Model: {}", n.model.as_deref().unwrap_or("CLI default")));
    }
    lines.push(format!("Workspace: {}   Working directory: {}", n.workspace_name, if n.cwd.is_empty() { "(folder root)" } else { &n.cwd }));
    lines.push(format!("Executable: {}", n.executable));
    if n.args.is_empty() {
        lines.push("Arguments: (none)".into());
    } else {
        lines.push(format!("Arguments ({}):", n.args.len()));
        for (i, arg) in n.args.iter().enumerate().take(24) {
            lines.push(format!("  [{}] {}", i + 1, clip(arg, 240)));
        }
        if n.args.len() > 24 {
            lines.push(format!("  … {} more argument(s) shown in Melly; all are bound by the approval hash.", n.args.len() - 24));
        }
    }
    if let Some(task) = task {
        let digest: String = n.stdin_sha256.as_deref().unwrap_or("").chars().take(16).collect();
        lines.push(format!("Task (sent on standard input, {} bytes, SHA-256 {digest}…):", n.stdin_bytes));
        lines.push(format!("  {}", clip(task, 600).replace('\n', "\n  ")));
    }
    let env = if n.env_scope == "minimal" { "minimal system variables" } else { "inherits your Windows environment (values not shown or stored)" };
    lines.push(format!("Environment: {env}   Timeout: {} s", n.timeout_secs));
    lines.push(String::new());
    lines.push(format!("Source edits: {}", d.source_edits));
    lines.push(format!("Subprocesses: {}", d.subprocesses));
    lines.push(format!("Network: {}", d.network));
    lines.push(format!("External effects: {}", d.external_effects));
    lines.push(format!("Containment: {}", d.containment));
    lines.push(format!("Policy: {}", d.native_policy));
    lines.push(String::new());
    lines.push(format!("Specification SHA-256: {}…", spec_hash(n).chars().take(24).collect::<String>()));
    lines.push("Approve this single run? The approval is single-use and expires.".into());
    lines.join("\n")
}

#[tauri::command]
pub fn exec_capability(window: tauri::WebviewWindow, broker: tauri::State<'_, Broker>) -> Result<Capability> {
    main_only(&window)?;
    Ok(broker.capability())
}
#[tauri::command]
pub async fn exec_enable(window: tauri::WebviewWindow, broker: tauri::State<'_, Broker>) -> Result<Capability> {
    main_only(&window)?;
    if broker.enabled() {
        return Ok(broker.capability());
    }
    let body = "Enable command and agent execution in Melly IDE for this app session?\n\n\
        • Each command or agent job still needs its own approval in a dialog like this one.\n\
        • Approved programs run with your Windows account permissions. They are NOT sandboxed: they can change files you can change and can use the network.\n\
        • Melly contains each run in a Windows Job Object so cancel, timeout and exit stop the whole process tree.\n\
        • Execution is disabled again when Melly restarts.\n\
        • The Live Preview window and project content can never run commands."
        .to_string();
    if consent(&window, &broker, "Melly IDE — Enable execution", body).await? {
        broker.set_enabled(true);
    } else {
        broker.note("enable-denied", None, "main", "DENIED");
    }
    Ok(broker.capability())
}
#[tauri::command]
pub fn exec_disable(window: tauri::WebviewWindow, broker: tauri::State<'_, Broker>) -> Result<Capability> {
    main_only(&window)?;
    broker.set_enabled(false);
    Ok(broker.capability())
}
#[tauri::command]
pub fn exec_set_concurrency(window: tauri::WebviewWindow, broker: tauri::State<'_, Broker>, max: usize) -> Result<Capability> {
    main_only(&window)?;
    broker.set_concurrency(max)?;
    Ok(broker.capability())
}
/// Validates the request natively and shows the native approval dialog; returns a single-use
/// approval only when the person chose Yes.
#[tauri::command]
pub async fn exec_request(
    window: tauri::WebviewWindow,
    broker: tauri::State<'_, Broker>,
    folder: tauri::State<'_, crate::local_folder::FolderState>,
    request: ExecRequest,
    surface: String,
) -> Result<Approved> {
    main_only(&window)?;
    let plan = match broker.normalize(&*folder, &request) {
        Ok(plan) => plan,
        Err(e) => {
            broker.note("request-refused", None, &surface, &e);
            return Err(e);
        }
    };
    let task = match &request {
        ExecRequest::Agent { task, .. } => Some(task.as_str()),
        _ => None,
    };
    let title = if plan.normalized.kind == "agent" { "Melly IDE — Approve agent job" } else { "Melly IDE — Approve command" };
    if !consent(&window, &broker, title, approval_text(&plan.normalized, task)).await? {
        broker.note("denied", Some(&plan.normalized), &surface, "DENIED");
        return Err(coded("DENIED", "You declined this run in the native dialog. Nothing was started."));
    }
    Ok(broker.approve(&plan, &surface))
}
#[tauri::command]
pub async fn exec_start(
    window: tauri::WebviewWindow,
    broker: tauri::State<'_, Broker>,
    folder: tauri::State<'_, crate::local_folder::FolderState>,
    request: ExecRequest,
    approval_id: String,
    token: String,
    surface: String,
) -> Result<RunView> {
    main_only(&window)?;
    broker.start(&*folder, &request, &approval_id, &token, &surface)
}
#[tauri::command]
pub fn exec_poll(window: tauri::WebviewWindow, broker: tauri::State<'_, Broker>, run_id: String, cursor: u64) -> Result<Poll> {
    main_only(&window)?;
    broker.poll(&run_id, cursor)
}
#[tauri::command]
pub async fn exec_cancel(window: tauri::WebviewWindow, broker: tauri::State<'_, Broker>, run_id: String) -> Result<RunView> {
    main_only(&window)?;
    broker.request_cancel(&run_id)
}
#[tauri::command]
pub fn exec_runs(window: tauri::WebviewWindow, broker: tauri::State<'_, Broker>) -> Result<Vec<RunView>> {
    main_only(&window)?;
    Ok(broker.runs())
}
#[tauri::command]
pub fn exec_audit(window: tauri::WebviewWindow, broker: tauri::State<'_, Broker>) -> Result<Vec<AuditEntry>> {
    main_only(&window)?;
    Ok(broker.audit_log())
}
#[tauri::command]
pub fn exec_reconcile(window: tauri::WebviewWindow, broker: tauri::State<'_, Broker>, records: Vec<ReconcileRecord>) -> Result<Vec<ReconcileResult>> {
    main_only(&window)?;
    broker.reconcile(&records)
}
#[tauri::command]
pub fn agent_detect(window: tauri::WebviewWindow, broker: tauri::State<'_, Broker>) -> Result<Vec<crate::agent_cli::Provider>> {
    main_only(&window)?;
    Ok(broker.with_registry(|registry| registry.detect()))
}
#[tauri::command]
pub async fn agent_probe(window: tauri::WebviewWindow, broker: tauri::State<'_, Broker>, provider: String) -> Result<crate::agent_cli::Provider> {
    main_only(&window)?;
    crate::agent_cli::probe(&broker, &provider)
}

#[cfg(all(test, windows))]
mod tests;
