//! MEGA-07 local diagnostics: build identity, native capability status and bounded counters.
//! Nothing here records paths, file names, file contents, arguments or secrets: only stable
//! error codes and counts. Nothing is sent anywhere; the main window reads it on request.
use serde::Serialize;
use tauri::Manager;
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};

static SAVES_OK: AtomicU64 = AtomicU64::new(0);
static SAVE_FAILURES: Mutex<BTreeMap<&'static str, u64>> = Mutex::new(BTreeMap::new());
static REJECTED: Mutex<BTreeMap<&'static str, u64>> = Mutex::new(BTreeMap::new());
const SAVE_CODES: [&str; 11] =
    ["CONFLICT", "MISSING", "ACCESS_DENIED", "READ_ONLY", "LOCKED", "DISK_FULL", "EXISTS", "IO", "INTERRUPTED", "ROLLBACK_FAILED", "UNSUPPORTED"];

/// Random per-process identifier so exported reports from one run can be correlated.
pub fn run_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| uuid::Uuid::new_v4().simple().to_string())
}
/// Maps an error message to its stable code; anything unrecognised is OTHER.
pub fn save_code(error: &str) -> &'static str {
    let prefix = error.split(':').next().unwrap_or("");
    SAVE_CODES.iter().copied().find(|c| *c == prefix).unwrap_or("OTHER")
}
/// Successful explicit saves so far; MEGA-08 uses the delta to flag uncertain run attribution.
pub fn saves_ok() -> u64 {
    SAVES_OK.load(Ordering::Relaxed)
}
pub fn note_save(error: Option<&String>) {
    match error {
        None => {
            SAVES_OK.fetch_add(1, Ordering::Relaxed);
        }
        Some(e) => {
            if let Ok(mut map) = SAVE_FAILURES.lock() {
                *map.entry(save_code(e)).or_default() += 1;
            }
        }
    }
}
/// Counts invokes that reached Melly's dispatcher from a non-main webview (always rejected).
/// Tauri's ACL rejects capability-less webviews before this point, so a non-zero count would
/// mean a message passed the ACL and was stopped only by the label check.
pub fn note_rejected(label: &str) {
    let bucket = if label == crate::preview::WINDOW { "preview" } else { "other" };
    if let Ok(mut map) = REJECTED.lock() {
        *map.entry(bucket).or_default() += 1;
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    local_folder: &'static str,
    git: &'static str,
    preview: &'static str,
    terminal: &'static str,
    agents: &'static str,
    updater: &'static str,
    telemetry: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    product: String,
    identifier: String,
    version: String,
    build: &'static str,
    os: &'static str,
    arch: &'static str,
    tauri: &'static str,
    webview2: String,
    run_id: &'static str,
    capabilities: Capabilities,
    saves_ok: u64,
    save_failures: BTreeMap<&'static str, u64>,
    dispatcher_rejections: BTreeMap<&'static str, u64>,
}
/// `execution` is the MEGA-08 broker's session flag (false until enabled in a native dialog).
pub fn capabilities(execution: bool) -> Capabilities {
    Capabilities {
        local_folder: "user-selected-folder · explicit atomic save",
        git: "read-only native inspection",
        preview: "separate capability-free window · opaque sandbox",
        terminal: match (crate::terminal_gate::NATIVE_EXECUTION_COMPILED, execution) {
            (true, _) => "compiled",
            (false, false) => "disabled · interactive shell not compiled · approved one-shot runner off until enabled this session",
            (false, true) => "approved one-shot commands · enabled this session · interactive shell not compiled",
        },
        agents: if execution {
            "claude/codex CLI adapters · native approval per job · enabled this session"
        } else {
            "claude/codex CLI adapters · disabled until execution is enabled this session"
        },
        updater: "disabled",
        telemetry: "none · local diagnostics only",
    }
}

#[tauri::command]
pub fn app_diagnostics<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Report {
    let config = app.config();
    Report {
        product: config.product_name.clone().unwrap_or_default(),
        identifier: config.identifier.clone(),
        version: app.package_info().version.to_string(),
        build: if cfg!(debug_assertions) { "debug" } else { "release" },
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        tauri: tauri::VERSION,
        webview2: tauri::webview_version().unwrap_or_else(|_| "unavailable".into()),
        run_id: run_id(),
        capabilities: capabilities(app.try_state::<crate::exec_broker::Broker>().is_some_and(|b| b.enabled())),
        saves_ok: SAVES_OK.load(Ordering::Relaxed),
        save_failures: SAVE_FAILURES.lock().map(|m| m.clone()).unwrap_or_default(),
        dispatcher_rejections: REJECTED.lock().map(|m| m.clone()).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn save_codes_are_stable_and_never_carry_paths() {
        assert_eq!(save_code("CONFLICT: File changed on disk."), "CONFLICT");
        assert_eq!(save_code("LOCKED: The file is locked"), "LOCKED");
        assert_eq!(save_code("C:\\Users\\someone\\secret.txt: denied"), "OTHER");
        assert_eq!(save_code("Missing file or directory."), "OTHER");
        note_save(Some(&"ROLLBACK_FAILED: x".to_string()));
        note_save(None);
        let map = SAVE_FAILURES.lock().unwrap().clone();
        assert!(map.keys().all(|k| SAVE_CODES.contains(k) || *k == "OTHER"));
        assert!(SAVES_OK.load(Ordering::Relaxed) >= 1);
    }
    #[test]
    fn rejection_buckets_are_bounded_and_run_id_is_stable() {
        note_rejected("preview");
        note_rejected("C:/anything/else");
        let map = REJECTED.lock().unwrap().clone();
        assert!(map.keys().all(|k| ["preview", "other"].contains(k)));
        assert_eq!(run_id(), run_id());
        assert_eq!(run_id().len(), 32);
        assert!(capabilities(false).terminal.starts_with("disabled"));
        assert!(capabilities(true).terminal.contains("interactive shell not compiled"));
    }
}
