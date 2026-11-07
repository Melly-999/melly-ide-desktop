#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod agent_cli;
mod diagnostics;
mod exec_broker;
mod git_inspect;
mod local_folder;
mod preview;
mod scoped_fs;
mod terminal_gate;

/// Every Melly command is reserved for the trusted main window. This is enforced here in
/// addition to Tauri's capability ACL (the preview window matches no capability).
pub fn invoke_allowed(webview_label: &str) -> bool {
    webview_label == "main"
}

fn main() {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        local_folder::folder_open,
        local_folder::folder_list,
        local_folder::folder_read,
        local_folder::folder_save,
        local_folder::folder_version,
        local_folder::folder_restore_interrupted,
        local_folder::folder_discard_interrupted,
        local_folder::folder_close,
        local_folder::workspace_index::folder_index,
        local_folder::workspace_index::folder_search,
        local_folder::recent::folder_recent,
        local_folder::recent::folder_forget,
        local_folder::folder_resume,
        git_inspect::git_status,
        git_inspect::git_diff,
        git_inspect::git_diff_summary,
        preview::preview_capability,
        preview::preview_mount_files,
        preview::preview_mount_folder,
        preview::preview_open,
        preview::preview_resize,
        preview::preview_close,
        preview::preview_events,
        terminal_gate::terminal_capability,
        terminal_gate::terminal_start,
        diagnostics::app_diagnostics,
        exec_broker::exec_capability,
        exec_broker::exec_enable,
        exec_broker::exec_disable,
        exec_broker::exec_set_concurrency,
        exec_broker::exec_request,
        exec_broker::exec_start,
        exec_broker::exec_poll,
        exec_broker::exec_cancel,
        exec_broker::exec_runs,
        exec_broker::exec_audit,
        exec_broker::exec_reconcile,
        exec_broker::agent_detect,
        exec_broker::agent_probe
    ];
    tauri::Builder::default()
        .manage(local_folder::FolderState::default())
        .manage(preview::PreviewState::default())
        .manage(exec_broker::Broker::default())
        .register_uri_scheme_protocol(preview::SCHEME, preview::protocol)
        .invoke_handler(move |invoke| {
            if !invoke_allowed(invoke.message.webview_ref().label()) {
                diagnostics::note_rejected(invoke.message.webview_ref().label());
                invoke.resolver.reject("Melly IDE commands are available only to the main window.");
                return true;
            }
            handler(invoke)
        })
        .run(tauri::generate_context!())
        .expect("Melly IDE desktop could not start");
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_main_window_may_invoke() {
        assert!(super::invoke_allowed("main"));
        for label in ["preview", "Main", "main ", "", "preview-main"] {
            assert!(!super::invoke_allowed(label), "{label}");
        }
    }
}
