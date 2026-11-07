//! MEGA-08 Claude Code / Codex CLI adapters. Detection only resolves the binary on PATH and
//! never runs it. A probe (only while execution is enabled) runs the fixed `--version` and help
//! commands through the broker's contained runner. Launch arguments are built here, natively,
//! from flags confirmed in that installed CLI's own help text; the task text goes on stdin.
//! No permission-bypass flag is ever produced (asserted again by the broker for every arg).
use crate::exec_broker::{self, coded, Broker, Disclosure, ProviderPlan, Result};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: &'static str,
    pub label: &'static str,
    pub source_edits: bool,
    pub summary: &'static str,
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    /// not-installed | installed (not checked) | ready | unsupported | error
    pub state: &'static str,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub profiles: Vec<Profile>,
    pub model_flag: bool,
    pub missing: Vec<String>,
    pub error: Option<String>,
    pub probed_at: Option<u64>,
    pub notes: Vec<&'static str>,
    /// MEGA-08.2: profiles with `source_edits` are offered only when this is true (owner contract).
    pub writable_enabled: bool,
    #[serde(skip)]
    identity: Option<(u64, u64)>,
}

struct ProfileSpec {
    profile: Profile,
    needs: &'static str,
    mode: &'static str,
    /// Claude `--tools` allowlist (MEGA-08.2): `--restricted` alone still exposed Task, WebSearch,
    /// EnterWorktree, Cron*, Skill and more in the 2.1.310 `init` event.
    tools: &'static str,
}
struct Spec {
    id: &'static str,
    name: &'static str,
    program: &'static str,
    version_args: &'static [&'static str],
    help_args: &'static [&'static str],
    required: &'static [&'static str],
    profiles: &'static [ProfileSpec],
    model_token: &'static str,
    notes: &'static [&'static str],
}
const CLAUDE: Spec = Spec {
    id: "claude",
    name: "Claude Code",
    program: "claude",
    version_args: &["--version"],
    help_args: &["--help"],
    required: &["-p, --print", "--output-format", "stream-json", "--verbose", "--permission-mode", "--permission-prompts", "\"none\"", "--restricted", "--strict-mcp-config", "--no-session-persistence", "--tools <tools"],
    profiles: &[
        ProfileSpec {
            profile: Profile { id: "plan", label: "Read-only plan", source_edits: false, summary: "Permission mode plan with only Read, Glob and Grep: reads and proposes, edits nothing." },
            needs: "plan",
            mode: "plan",
            tools: "Read,Glob,Grep",
        },
        ProfileSpec {
            profile: Profile { id: "edit", label: "Edit files in this folder", source_edits: true, summary: "Permission mode acceptEdits with only Read, Glob, Grep, Edit and Write: edits in the working directory are accepted." },
            needs: "acceptEdits",
            mode: "acceptEdits",
            tools: "Read,Glob,Grep,Edit,Write",
        },
    ],
    model_token: "--model <model>",
    notes: &[
        "Runs non-interactively (-p); anything that would need a permission prompt is denied automatically (--permission-prompts none).",
        "--tools allowlist: plan exposes only Read, Glob and Grep (verified in the 2.1.310 init event); no Bash, PowerShell, Task, WebSearch, WebFetch, worktree, cron or skill tools.",
        "--restricted ignores user, project and local settings files (project hooks are not loaded) and confines file tools to the working directory; --strict-mcp-config loads no MCP servers.",
        "Approving the start covers the whole session: Claude's own permission mode, not Melly, decides each later tool call.",
        "Claude Code skips its own workspace-trust dialog in -p mode; Melly's native approval is shown instead.",
    ],
};
const CODEX: Spec = Spec {
    id: "codex",
    name: "Codex CLI",
    program: "codex",
    version_args: &["--version"],
    help_args: &["exec", "--help"],
    required: &["--json", "-s, --sandbox", "read-only", "workspace-write", "-C, --cd", "read from stdin", "--color"],
    profiles: &[
        ProfileSpec {
            profile: Profile { id: "read-only", label: "Read-only sandbox", source_edits: false, summary: "codex exec --sandbox read-only: model-generated commands run without per-action prompts; writes are denied, reads are not confined." },
            needs: "read-only",
            mode: "read-only",
            tools: "",
        },
        ProfileSpec {
            profile: Profile { id: "workspace-write", label: "Workspace-write sandbox", source_edits: true, summary: "codex exec --sandbox workspace-write: edits and commands inside the workspace (and temp), enforced by Codex's sandbox." },
            needs: "workspace-write",
            mode: "workspace-write",
            tools: "",
        },
    ],
    model_token: "-m, --model",
    notes: &[
        "codex exec is non-interactive: model-generated commands run without per-action prompts inside the Codex sandbox. Approving the start covers all of them.",
        "MEGA-08.2 native probe of the Windows restricted-token sandbox (codex sandbox, no model): read-only denies writes everywhere but allows reading any file the account can read; workspace denies writes outside the workspace and temp; loopback network was reachable in both.",
        "Your Codex configuration (model, MCP servers, features) is used unchanged.",
        "Codex refuses folders that are not Git repositories; Melly never passes --skip-git-repo-check.",
    ],
};
const SPECS: [&Spec; 2] = [&CLAUDE, &CODEX];
fn spec(id: &str) -> Result<&'static Spec> {
    SPECS.iter().copied().find(|s| s.id == id).ok_or_else(|| coded("PROVIDER_REFUSED", "Unknown agent provider."))
}
fn empty(spec: &Spec, state: &'static str) -> Provider {
    Provider {
        id: spec.id,
        name: spec.name,
        state,
        executable: None,
        version: None,
        profiles: vec![],
        model_flag: false,
        missing: vec![],
        error: None,
        probed_at: None,
        notes: spec.notes.to_vec(),
        writable_enabled: false,
        identity: None,
    }
}

fn semver(text: &str) -> bool {
    let core = text.split(['-', '+']).next().unwrap_or("");
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 6 && p.chars().all(|c| c.is_ascii_digit()))
}
/// Strict version parsing; anything unexpected is reported, never guessed.
pub fn parse_version(id: &str, output: &str) -> Option<String> {
    let line = output.lines().map(str::trim).find(|l| !l.is_empty())?;
    let mut words = line.split_whitespace();
    let version = match id {
        "claude" => {
            let version = words.next()?;
            (words.collect::<Vec<_>>().join(" ") == "(Claude Code)").then_some(version)?
        }
        "codex" => {
            (words.next()? == "codex-cli").then_some(())?;
            let version = words.next()?;
            words.next().is_none().then_some(version)?
        }
        _ => return None,
    };
    semver(version).then(|| version.to_string())
}
/// Values listed as `(choices: "a", "b")` after a flag in the help text.
pub fn choices(help: &str, flag: &str) -> Vec<String> {
    let Some(at) = help.find(flag) else { return vec![] };
    let rest = &help[at..];
    let Some(open) = rest.find("(choices:") else { return vec![] };
    let Some(close) = rest[open..].find(')') else { return vec![] };
    rest[open..open + close].split('"').skip(1).step_by(2).map(str::to_string).collect()
}
pub struct Capabilities {
    pub profiles: Vec<Profile>,
    pub model_flag: bool,
    pub missing: Vec<String>,
}
pub fn capabilities(id: &str, help: &str) -> Result<Capabilities> {
    let spec = spec(id)?;
    let missing: Vec<String> = spec.required.iter().filter(|token| !help.contains(*token)).map(|t| t.to_string()).collect();
    let modes = if id == "claude" { choices(help, "--permission-mode") } else { vec![] };
    let profiles = spec
        .profiles
        .iter()
        .filter(|p| if id == "claude" { modes.iter().any(|m| m == p.needs) } else { help.contains(p.needs) })
        .map(|p| p.profile.clone())
        .collect();
    Ok(Capabilities { profiles, model_flag: help.contains(spec.model_token), missing })
}

fn valid_model(model: &str) -> bool {
    !model.is_empty() && model.len() <= 80 && model.chars().all(|c| c.is_ascii_alphanumeric() || "._:/-[]".contains(c))
}
fn disclosure(id: &str, profile: &str) -> Disclosure {
    let containment = format!(
        "The CLI runs in a Windows Job Object (max {} processes) with your Windows permissions. Not an OS sandbox.",
        exec_broker::JOB_PROCESS_LIMIT
    );
    match (id, profile) {
        ("claude", "plan") => Disclosure {
            source_edits: "No — permission mode plan; only Read, Glob and Grep are available (--tools).".into(),
            subprocesses: "No — no Bash, PowerShell, Task or other tool that starts processes (--tools allowlist). Claude Code itself is one contained process tree.".into(),
            network: "Yes — the CLI contacts its model provider. WebSearch and WebFetch are not available (--tools).".into(),
            external_effects: "Model-provider API usage only. No MCP servers (--strict-mcp-config); user, project and local settings files are ignored (--restricted). Read, Glob and Grep may reach files outside the folder that your account can read: Claude Code's own path rules apply and are not verified by Melly.".into(),
            containment,
            native_policy: "--permission-mode plan --tools Read,Glob,Grep --permission-prompts none --restricted --strict-mcp-config --no-session-persistence".into(),
        },
        ("claude", _) => Disclosure {
            source_edits: "Yes — Edit and Write inside the working directory are accepted (acceptEdits).".into(),
            subprocesses: "No — only Read, Glob, Grep, Edit and Write are available (--tools).".into(),
            network: "Yes — the CLI contacts its model provider. WebSearch and WebFetch are not available.".into(),
            external_effects: "Model-provider API usage only. No MCP servers (--strict-mcp-config).".into(),
            containment,
            native_policy: "--permission-mode acceptEdits --tools Read,Glob,Grep,Edit,Write --permission-prompts none --restricted --strict-mcp-config --no-session-persistence".into(),
        },
        ("codex", "read-only") => Disclosure {
            source_edits: "No — Codex's Windows sandbox denied every write in Melly's native probe (read-only profile).".into(),
            subprocesses: "Yes — Codex runs model-generated commands WITHOUT asking again, inside its read-only sandbox.".into(),
            network: "Yes — the CLI contacts its model provider; sandboxed commands could reach the network in Melly's probe (loopback).".into(),
            external_effects: "Reads are NOT confined: sandboxed commands can read any file your account can read. Features or MCP servers in your Codex configuration also apply.".into(),
            containment,
            native_policy: "codex exec --json --sandbox read-only (no approval-bypass flags)".into(),
        },
        _ => Disclosure {
            source_edits: "Yes — writes inside the workspace and the temp folder; writes elsewhere were denied in Melly's native probe.".into(),
            subprocesses: "Yes — Codex runs model-generated commands WITHOUT asking again, inside its workspace-write sandbox.".into(),
            network: "Yes — the CLI contacts its model provider; sandboxed commands could reach the network in Melly's probe (loopback).".into(),
            external_effects: "Reads are NOT confined; features or MCP servers in your Codex configuration also apply.".into(),
            containment,
            native_policy: "codex exec --json --sandbox workspace-write (no approval-bypass flags)".into(),
        },
    }
}
/// Native launch arguments. The task text is never an argument; it is written to stdin.
pub fn launch_args(id: &str, profile: &str, model: &str, cwd: &Path) -> Result<Vec<String>> {
    let spec = spec(id)?;
    let chosen = spec.profiles.iter().find(|p| p.profile.id == profile).ok_or_else(|| coded("PROFILE_REFUSED", "Unknown permission profile."))?;
    let mode = chosen.mode;
    let mut args: Vec<String> = match id {
        "claude" => ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", mode, "--tools", chosen.tools, "--permission-prompts", "none", "--restricted", "--strict-mcp-config", "--no-session-persistence"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        _ => vec!["exec".into(), "--json".into(), "--color".into(), "never".into(), "--sandbox".into(), mode.into(), "-C".into(), cwd.to_string_lossy().into_owned()],
    };
    if !model.is_empty() {
        args.push(if id == "claude" { "--model" } else { "-m" }.into());
        args.push(model.into());
    }
    if id == "codex" {
        args.push("-".into());
    }
    exec_broker::validate_args(&args)?;
    Ok(args)
}

#[derive(Default)]
pub struct Registry {
    pub path_override: Option<OsString>,
    /// MEGA-08.2: writable agent profiles stay refused until the owner accepts the writable-agent
    /// security contract. No command sets this; only tests (MOCK CLIs) do.
    pub allow_writable: bool,
    providers: BTreeMap<&'static str, Provider>,
}
impl Registry {
    /// Resolves each CLI on PATH. Runs nothing. A changed binary loses its earlier check.
    pub fn detect(&mut self) -> Vec<Provider> {
        for spec in SPECS {
            let resolved = exec_broker::resolve_program(spec.program, self.path_override.as_ref()).ok();
            let identity = resolved.as_deref().and_then(|p| exec_broker::identity(p).ok());
            let current = self.providers.get(spec.id);
            let unchanged = current.is_some_and(|c| c.identity.is_some() && c.identity == identity && c.executable.as_deref() == resolved.as_deref().and_then(|p| p.to_str()));
            if unchanged {
                continue;
            }
            let mut provider = empty(spec, if resolved.is_some() { "installed" } else { "not-installed" });
            provider.executable = resolved.map(|p| p.to_string_lossy().into_owned());
            provider.identity = identity;
            self.providers.insert(spec.id, provider);
        }
        let writable = self.allow_writable;
        SPECS.iter().filter_map(|s| self.providers.get(s.id).cloned()).map(|mut p| { p.writable_enabled = writable; p }).collect()
    }
    pub fn plan(&mut self, id: &str, profile: &str, model: &str, cwd: &Path) -> Result<ProviderPlan> {
        spec(id)?;
        let provider = self.providers.get(id).filter(|p| p.state == "ready").ok_or_else(|| coded("PROBE_REQUIRED", "Detect and check this agent CLI first."))?;
        let executable = PathBuf::from(provider.executable.clone().unwrap_or_default());
        if exec_broker::identity(&executable).ok() != provider.identity {
            return Err(coded("IDENTITY_CHANGED", "The CLI binary changed since it was checked. Check it again."));
        }
        let Some(chosen) = provider.profiles.iter().find(|p| p.id == profile) else {
            return Err(coded("PROFILE_REFUSED", "This permission profile is not supported by the installed CLI."));
        };
        if chosen.source_edits && !self.allow_writable {
            return Err(coded("PROFILE_GATED", "Writable agent profiles are disabled until the owner accepts the writable-agent security contract."));
        }
        if !model.is_empty() && (!provider.model_flag || !valid_model(model)) {
            return Err(coded("MODEL_REFUSED", "Model selection is not supported by this CLI or the name has unsupported characters."));
        }
        Ok(ProviderPlan { args: launch_args(id, profile, model, cwd)?, executable, version: provider.version.clone().unwrap_or_default(), disclosure: disclosure(id, profile) })
    }
    fn record(&mut self, mut provider: Provider) -> Provider {
        provider.writable_enabled = self.allow_writable;
        self.providers.insert(provider.id, provider.clone());
        provider
    }
}

/// Runs the fixed version and help probes of one CLI while execution is enabled.
pub fn probe(broker: &Broker, id: &str) -> Result<Provider> {
    let spec = spec(id)?;
    if !broker.enabled() {
        return Err(coded("DISABLED", "Enable execution for this session before checking agent CLIs."));
    }
    let detected = broker.with_registry(|registry| registry.detect().into_iter().find(|p| p.id == id));
    let Some(mut provider) = detected.filter(|p| p.executable.is_some()) else {
        return Ok(empty(spec, "not-installed"));
    };
    let exe = PathBuf::from(provider.executable.clone().unwrap_or_default());
    let outcome = (|| -> Result<()> {
        let (_, version_out, version_err) = exec_broker::run_fixed(&exe, spec.version_args, PROBE_TIMEOUT)?;
        let version = parse_version(id, &version_out).or_else(|| parse_version(id, &version_err));
        let Some(version) = version else {
            return Err(coded("VERSION_UNRECOGNIZED", "The CLI's --version output was not recognized; it is not used."));
        };
        provider.version = Some(version);
        let (_, help_out, help_err) = exec_broker::run_fixed(&exe, spec.help_args, PROBE_TIMEOUT)?;
        let found = capabilities(id, &format!("{help_out}\n{help_err}"))?;
        provider.profiles = found.profiles;
        provider.model_flag = found.model_flag;
        provider.missing = found.missing;
        Ok(())
    })();
    provider.probed_at = SystemTime::now().duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64);
    provider.state = match &outcome {
        Err(_) => "error",
        Ok(()) if provider.missing.is_empty() && !provider.profiles.is_empty() => "ready",
        Ok(()) => "unsupported",
    };
    provider.error = outcome.err();
    if provider.identity != exec_broker::identity(&exe).ok() {
        provider.state = "error";
        provider.error = Some(coded("IDENTITY_CHANGED", "The CLI binary changed during the check."));
    }
    broker.note("probe", None, id, provider.error.as_deref().unwrap_or(provider.state));
    Ok(broker.with_registry(|registry| registry.record(provider)))
}

#[cfg(test)]
mod tests {
    use super::*;
    const CLAUDE_HELP: &str = "  -p, --print   Print\n  --output-format <format>  (choices: \"text\", \"json\", \"stream-json\")\n  --verbose\n  --permission-mode <mode>  Permission mode\n      (choices: \"acceptEdits\", \"auto\",\n      \"bypassPermissions\", \"manual\", \"dontAsk\", \"plan\")\n  --permission-prompts <target>  \"host\" or \"none\"\n  --restricted\n  --strict-mcp-config\n  --no-session-persistence\n  --tools <tools...>  Specify the list of available tools\n  --model <model>  Model\n";
    #[test]
    fn version_parsing_is_strict() {
        assert_eq!(parse_version("claude", "2.1.310 (Claude Code)\n").as_deref(), Some("2.1.310"));
        assert_eq!(parse_version("codex", "codex-cli 0.154.0\r\n").as_deref(), Some("0.154.0"));
        for bad in ["", "Claude Code", "2.1 (Claude Code)", "2.1.310 (Something Else)", "error: unknown", "codex-cli", "codex-cli 0.1.2 extra", "x.y.z (Claude Code)"] {
            assert_eq!(parse_version("claude", bad), None, "{bad}");
            assert_eq!(parse_version("codex", bad), None, "{bad}");
        }
        assert_eq!(parse_version("other", "2.1.310 (Claude Code)"), None);
    }
    #[test]
    fn help_capabilities_and_choices() {
        assert_eq!(choices(CLAUDE_HELP, "--permission-mode"), ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
        let caps = capabilities("claude", CLAUDE_HELP).unwrap();
        assert!(caps.missing.is_empty(), "{:?}", caps.missing);
        assert_eq!(caps.profiles.iter().map(|p| p.id).collect::<Vec<_>>(), ["plan", "edit"]);
        assert!(caps.model_flag);
        let old = capabilities("claude", "-p, --print\n--output-format stream-json").unwrap();
        assert!(old.missing.contains(&"--restricted".to_string()) && old.profiles.is_empty());
        let codex = capabilities("codex", "--json\n-s, --sandbox <MODE> [possible values: read-only, workspace-write, danger-full-access]\n-C, --cd <DIR>\ninstructions are read from stdin\n--color\n-m, --model <MODEL>").unwrap();
        assert!(codex.missing.is_empty());
        assert_eq!(codex.profiles.iter().map(|p| p.id).collect::<Vec<_>>(), ["read-only", "workspace-write"]);
    }
    #[test]
    fn launch_args_never_bypass_and_keep_task_off_the_command_line() {
        let cwd = Path::new("C:\\fixture\\repo");
        for (id, profile) in [("claude", "plan"), ("claude", "edit"), ("codex", "read-only"), ("codex", "workspace-write")] {
            let args = launch_args(id, profile, "", cwd).unwrap();
            let joined = args.join(" ").to_ascii_lowercase();
            for forbidden in exec_broker::FORBIDDEN {
                assert!(!joined.contains(forbidden), "{id}/{profile}: {joined}");
            }
            assert!(!joined.contains("bypasspermissions") && !joined.contains("danger-full-access") && !joined.contains("skip-git-repo-check"));
            if id == "claude" {
                assert!(args.windows(2).any(|w| w == ["--permission-prompts", "none"]));
                assert!(args.contains(&"--restricted".into()) && args.contains(&"--strict-mcp-config".into()));
                // MEGA-08.2: explicit allowlists; never Bash, Task, WebSearch, WebFetch or worktrees.
                let tools = &args[args.iter().position(|a| a == "--tools").unwrap() + 1];
                assert_eq!(tools, if profile == "plan" { "Read,Glob,Grep" } else { "Read,Glob,Grep,Edit,Write" });
                for banned in ["Bash", "PowerShell", "Task", "WebSearch", "WebFetch", "EnterWorktree", "Skill", "Cron", "NotebookEdit"] {
                    assert!(!tools.contains(banned), "{banned}");
                }
            } else {
                assert_eq!(args.last().unwrap(), "-");
                assert!(args.windows(2).any(|w| w[0] == "--sandbox" && (w[1] == "read-only" || w[1] == "workspace-write")));
            }
        }
        assert!(launch_args("claude", "bypassPermissions", "", cwd).is_err());
        assert!(launch_args("codex", "danger-full-access", "", cwd).is_err());
        assert!(launch_args("other", "plan", "", cwd).is_err());
        let with_model = launch_args("claude", "plan", "sonnet", cwd).unwrap();
        assert!(with_model.windows(2).any(|w| w == ["--model", "sonnet"]));
        assert!(!valid_model("a b") && !valid_model("x;rm") && valid_model("gpt-5.1-codex") && valid_model("claude-fable-5-1"));
    }
}
