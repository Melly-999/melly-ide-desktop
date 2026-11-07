//! MEGA-04 terminal capability gate. This build compiles no process launcher at all:
//! shipped MEGA-04 sources never reference the process API, so no shell can start from the UI.
//! A future launcher must implement `ProcessLauncher` and ship only after explicit owner
//! approval of the execution capability and its scope (see TERMINAL-CAPABILITY-GATES.md).
use serde::{Deserialize, Serialize};

pub const NATIVE_EXECUTION_COMPILED: bool = false;
const REASON: &str = "Native terminal execution is not authorized in this build. The owner has not approved the process-execution capability or its scope; no shell or command can start.";

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCapability {
    pub available: bool,
    pub execution: &'static str,
    pub approval_required: bool,
    pub reason: &'static str,
}
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // Read by a future, separately approved launcher only.
pub struct StartRequest {
    pub cwd_label: String,
    pub approved_by_user: bool,
}
/// Interface for a later, separately approved launcher. Not implemented in MEGA-04.
pub trait ProcessLauncher {
    fn capability(&self) -> TerminalCapability;
    fn start(&self, request: &StartRequest) -> Result<String, String>;
}
pub struct DisabledLauncher;
impl ProcessLauncher for DisabledLauncher {
    fn capability(&self) -> TerminalCapability {
        TerminalCapability { available: false, execution: "disabled", approval_required: true, reason: REASON }
    }
    fn start(&self, _: &StartRequest) -> Result<String, String> {
        Err(REASON.into())
    }
}

#[tauri::command]
pub fn terminal_capability() -> TerminalCapability {
    DisabledLauncher.capability()
}
#[tauri::command]
pub fn terminal_start(request: StartRequest) -> Result<String, String> {
    DisabledLauncher.start(&request)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launcher_is_disabled_even_with_user_approval() {
        assert!(!NATIVE_EXECUTION_COMPILED);
        let capability = terminal_capability();
        assert!(!capability.available && capability.approval_required && capability.execution == "disabled");
        let approved = StartRequest { cwd_label: "synthetic".into(), approved_by_user: true };
        assert!(terminal_start(approved).unwrap_err().contains("not authorized"));
    }
    #[test]
    fn no_process_api_in_shipped_sources() {
        for (name, source) in [
            ("terminal_gate.rs", include_str!("terminal_gate.rs")),
            ("git_inspect.rs", include_str!("git_inspect.rs")),
            ("preview.rs", include_str!("preview.rs")),
            ("scoped_fs.rs", include_str!("scoped_fs.rs")),
        ] {
            let shipped = source.split(&["mod ", "tests {"].concat()).next().unwrap();
            let needle = ["std::", "process"].concat();
            assert!(!shipped.contains(&needle) && !shipped.contains("Command::new"), "{name} references process execution");
        }
    }
}
