//! Read-only Windows filesystem boundary. No command accepts an absolute path.
use serde::Serialize;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
pub mod recent;
pub mod workspace_index;
const MAX_DEPTH: usize = 32;
const MAX_ENTRIES: usize = 1000;
const MAX_BYTES: u64 = 1024 * 1024;
const SESSION_TTL: Duration = Duration::from_secs(30 * 60);
type Result<T> = std::result::Result<T, String>;
#[derive(Default)]
pub struct FolderState {
    session: Mutex<Option<Session>>,
    picking: AtomicBool,
}
struct Session {
    id: String,
    root: PathBuf,
    used: Instant,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    session_id: String,
    name: String,
    recovery_key: String,
}
#[derive(Serialize, Debug)]
pub struct Entry {
    name: String,
    path: String,
    kind: &'static str,
}
#[derive(Serialize, Debug)]
pub struct Listing {
    entries: Vec<Entry>,
}
#[derive(Serialize, Debug)]
pub struct Preview {
    path: String,
    content: String,
    bytes: usize,
    version: String,
    /// Artifacts of an earlier interrupted save of this file (never acted on automatically).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    interrupted: Vec<Artifact>,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}
fn io_error(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => {
            "Missing file or directory. Refresh the folder or select it again.".into()
        }
        std::io::ErrorKind::PermissionDenied => {
            "Access denied. The item may be locked or unavailable to this Windows account.".into()
        }
        _ => format!(
            "Local filesystem request failed (OS code {:?}).",
            e.raw_os_error()
        ),
    }
}
fn parts(relative: &str) -> Result<Vec<&str>> {
    if relative.is_empty() {
        return Ok(vec![]);
    }
    if relative.len() > 2048 {
        return Err("Path is too long.".into());
    }
    let parts: Vec<_> = relative.split('/').collect();
    if parts.len() > MAX_DEPTH {
        return Err("Directory depth limit (32) reached.".into());
    }
    for part in &parts {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || *part == "."
            || *part == ".."
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
            || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err("Unsupported or unsafe relative path.".into());
        }
    }
    Ok(parts)
}
#[cfg(windows)]
fn guarded(root: &Path, relative: &str) -> Result<(PathBuf, Vec<fs::File>)> {
    guarded_share(root, relative, 1)
}
/// `last_share` applies to the final pinned item only. Saving needs FILE_SHARE_WRITE on the
/// immediate parent so the rename steps can open it; delete sharing is never granted, so no
/// pinned directory can be renamed away or swapped for a junction while it is held.
#[cfg(windows)]
fn guarded_share(root: &Path, relative: &str, last_share: u32) -> Result<(PathBuf, Vec<fs::File>)> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    // Pin every ancestor while using a path-based API. No delete/write sharing: an
    // attacker cannot replace an ancestor with a junction between check and use.
    let mut path = PathBuf::new();
    let mut chain = vec![];
    for component in root.components() {
        path.push(component);
        if path.has_root() {
            chain.push(path.clone());
        }
    }
    for part in parts(relative)? {
        path.push(part);
        chain.push(path.clone());
    }
    let last = chain.len().saturating_sub(1);
    let guards = chain
        .iter()
        .enumerate()
        .map(|(i, p)| open_guard(p, if i == last { last_share } else { 1 }))
        .collect::<Result<Vec<_>>>()?;
    fn open_guard(path: &Path, share: u32) -> Result<fs::File> {
        let file = fs::OpenOptions::new()
            .read(true)
            .share_mode(share)
            .custom_flags(0x00200000 | 0x02000000)
            .open(path)
            .map_err(io_error)?;
        let metadata = file.metadata().map_err(io_error)?;
        if metadata.file_attributes() & 0x400 != 0 || metadata.file_type().is_symlink() {
            return Err("Symlinks and Windows reparse points are not supported.".into());
        }
        if !metadata.is_file() && !metadata.is_dir() {
            return Err("Unsupported filesystem item.".into());
        }
        Ok(file)
    }
    Ok((path, guards))
}
#[cfg(not(windows))]
fn guarded(_: &Path, _: &str) -> Result<(PathBuf, Vec<fs::File>)> {
    Err("Local Folder is available in Windows Tauri only.".into())
}
fn validate_root(path: PathBuf) -> Result<PathBuf> {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::GetDriveTypeW};
        let mut components = path.components();
        if !matches!(components.next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_)))
            || !path.is_absolute()
            || path.to_string_lossy().len() > 2048
        {
            return Err(
                "Select a local drive folder. Network and device paths are unsupported.".into(),
            );
        }
        let drive: Vec<u16> = format!(
            "{}\\",
            path.components()
                .next()
                .unwrap()
                .as_os_str()
                .to_string_lossy()
        )
        .encode_utf16()
        .chain(Some(0))
        .collect();
        let kind = unsafe { GetDriveTypeW(PCWSTR(drive.as_ptr())) };
        if ![2, 3, 5, 6].contains(&kind) {
            return Err("Remote or unavailable drives are unsupported.".into());
        }
        guarded(&path, "")?;
        if !path.is_dir() {
            return Err("Select an existing directory.".into());
        }
        Ok(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Local Folder is available in Windows Tauri only.".into())
    }
}
impl FolderState {
    fn selected(&self, selected: Option<PathBuf>) -> Result<Option<Opened>> {
        let Some(root) = selected else {
            return Ok(None);
        };
        let root = validate_root(root)?;
        let id = uuid::Uuid::new_v4().to_string();
        let name = root
            .file_name()
            .unwrap_or(root.as_os_str())
            .to_string_lossy()
            .into_owned();
        let recovery_key = digest(root.to_string_lossy().to_lowercase().as_bytes());
        *self
            .session
            .lock()
            .map_err(|_| "Folder session unavailable.")? = Some(Session {
            id: id.clone(),
            root,
            used: Instant::now(),
        });
        Ok(Some(Opened {
            session_id: id,
            name,
            recovery_key,
        }))
    }
    fn with<T>(&self, id: &str, operation: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
        let mut state = self
            .session
            .lock()
            .map_err(|_| "Folder session unavailable.")?;
        if state
            .as_ref()
            .is_some_and(|s| s.used.elapsed() > SESSION_TTL)
        {
            *state = None;
        }
        let session = state
            .as_mut()
            .filter(|s| s.id == id)
            .ok_or("Folder session expired or closed. Select the folder again.")?;
        session.used = Instant::now();
        operation(&session.root)
    }
    fn list(&self, id: &str, relative: &str) -> Result<Listing> {
        self.with(id, |root| {
            let (path, _guards) = guarded(root, relative)?;
            let mut entries = vec![];
            for item in fs::read_dir(path).map_err(io_error)? {
                if entries.len() >= MAX_ENTRIES {
                    return Err(
                        "Directory contains more than 1000 items. Open a smaller subfolder.".into(),
                    );
                }
                let item = item.map_err(io_error)?;
                let name = item
                    .file_name()
                    .into_string()
                    .map_err(|_| "Unsupported filename encoding.")?;
                let relative = if relative.is_empty() {
                    name.clone()
                } else {
                    format!("{relative}/{name}")
                };
                let metadata = fs::symlink_metadata(item.path()).map_err(io_error)?;
                #[cfg(windows)]
                let reparse = {
                    use std::os::windows::fs::MetadataExt;
                    metadata.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let reparse = metadata.file_type().is_symlink();
                let kind = if reparse || parts(&relative).is_err() {
                    "blocked"
                } else if metadata.is_dir() {
                    "folder"
                } else if metadata.is_file() {
                    "file"
                } else {
                    "blocked"
                };
                entries.push(Entry {
                    name,
                    path: relative,
                    kind,
                });
            }
            entries.sort_by(|a, b| {
                (a.kind != "folder")
                    .cmp(&(b.kind != "folder"))
                    .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                    .then_with(|| a.name.cmp(&b.name))
            });
            Ok(Listing { entries })
        })
    }
    fn read(&self, id: &str, relative: &str) -> Result<Preview> {
        if parts(relative)?.is_empty() {
            return Err("Select a file.".into());
        }
        self.with(id, |root| {
            let (path, guards) = guarded(root, relative)?;
            let file = guards.last().ok_or("Select a file.")?;
            let metadata = file.metadata().map_err(io_error)?;
            if !metadata.is_file() {
                return Err("Select a regular file.".into());
            }
            if metadata.len() > MAX_BYTES {
                return Err("File exceeds the 1 MiB preview limit.".into());
            }
            let mut bytes = Vec::new();
            file.take(MAX_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(io_error)?;
            if bytes.len() as u64 > MAX_BYTES {
                return Err("File exceeds the 1 MiB preview limit.".into());
            }
            let content = String::from_utf8(bytes)
                .map_err(|_| "Unsupported encoding. Preview requires valid UTF-8.")?;
            if content
                .chars()
                .any(|c| c == '\0' || (c.is_control() && !['\n', '\r', '\t', '\u{c}'].contains(&c)))
            {
                return Err("Binary input is not supported.".into());
            }
            let (parent, name) = split_relative(relative);
            let interrupted = path.parent().map(|dir| artifacts(dir, parent, name)).unwrap_or_default();
            Ok(Preview {
                path: relative.into(),
                bytes: content.len(),
                version: digest(content.as_bytes()),
                content,
                interrupted,
                warning: None,
            })
        })
    }
    fn close(&self, id: &str) -> Result<()> {
        let mut state = self
            .session
            .lock()
            .map_err(|_| "Folder session unavailable.")?;
        if state.as_ref().is_some_and(|s| s.id == id) {
            *state = None;
        }
        Ok(())
    }
}
/// `start` (MEGA-09 resume) only pre-navigates the dialog; the person still selects the folder.
#[cfg(windows)]
fn pick(owner: usize, start: Option<PathBuf>) -> Result<Option<PathBuf>> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::HWND,
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{
                FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName,
                FOS_DONTADDTORECENT, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST,
                FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
            },
        },
    };
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|_| "Windows folder dialog could not initialize.")?;
        struct Com;
        impl Drop for Com {
            fn drop(&mut self) {
                unsafe {
                    CoUninitialize();
                }
            }
        }
        let _com = Com;
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|_| "Windows folder dialog unavailable.")?;
        dialog
            .SetOptions(
                FOS_PICKFOLDERS
                    | FOS_FORCEFILESYSTEM
                    | FOS_PATHMUSTEXIST
                    | FOS_DONTADDTORECENT
                    | FOS_NOCHANGEDIR,
            )
            .map_err(|_| "Folder dialog configuration failed.")?;
        let title: Vec<u16> = if start.is_some() { "Resume Local Folder — press Select Folder to confirm" } else { "Open Local Folder — explicit save" }
            .encode_utf16()
            .chain(Some(0))
            .collect();
        dialog
            .SetTitle(PCWSTR(title.as_ptr()))
            .map_err(|_| "Folder dialog configuration failed.")?;
        if let Some(start) = start.filter(|p| p.is_dir()) {
            let wide: Vec<u16> = start.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect();
            // Best effort: if the folder cannot be shown, the dialog opens at its default place.
            if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(wide.as_ptr()), None) {
                let _ = dialog.SetFolder(&item);
            }
        }
        if let Err(error) = dialog.Show(Some(HWND(owner as *mut _))) {
            if error.code().0 as u32 == 0x800704c7 {
                return Ok(None);
            }
            return Err("Windows folder selection failed.".into());
        }
        let item = dialog.GetResult().map_err(|_| "No folder was selected.")?;
        let value = item
            .GetDisplayName(SIGDN_FILESYSPATH)
            .map_err(|_| "Select a local filesystem folder.")?;
        let text = value
            .to_string()
            .map_err(|_| "Unsupported folder path encoding.");
        CoTaskMemFree(Some(value.0 as _));
        Ok(Some(PathBuf::from(text?)))
    }
}
#[cfg(not(windows))]
fn pick(_: usize, _: Option<PathBuf>) -> Result<Option<PathBuf>> {
    Err("Local Folder is available in Windows Tauri only.".into())
}
#[tauri::command]
pub async fn folder_open(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FolderState>,
) -> Result<Option<Opened>> {
    open_with(window, state, None).await
}
/// MEGA-09: reopens the Windows folder dialog at a recent folder (identified by its opaque key).
#[tauri::command]
pub async fn folder_resume(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FolderState>,
    key: String,
) -> Result<Option<Opened>> {
    use tauri::Manager;
    let start = recent::lookup(window.app_handle(), &key).ok_or("NOT_FOUND: This recent folder is no longer listed. Use Open Folder.")?;
    open_with(window, state, Some(start)).await
}
async fn open_with(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, FolderState>,
    start: Option<PathBuf>,
) -> Result<Option<Opened>> {
    if state.picking.swap(true, Ordering::SeqCst) {
        return Err("Folder selection is already open.".into());
    }
    #[cfg(windows)]
    let owner = window.hwnd().map(|h| h.0 as usize).unwrap_or(0);
    #[cfg(not(windows))]
    let owner = {
        let _ = window;
        0
    };
    // A modal Windows dialog belongs on the window's UI thread. This also keeps
    // keyboard focus and accessibility attached to the owning WebView window.
    use tauri::Manager;
    let (tx, rx) = std::sync::mpsc::channel();
    let app = window.app_handle().clone();
    if window
        .run_on_main_thread(move || {
            let _ = tx.send(pick(owner, start));
        })
        .is_err()
    {
        state.picking.store(false, Ordering::SeqCst);
        return Err("Folder dialog could not open on the UI thread.".into());
    }
    let selected = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|_| "Folder dialog failed.".to_string())
        .and_then(|result| result.map_err(|_| "Folder dialog closed unexpectedly.".to_string()));
    state.picking.store(false, Ordering::SeqCst);
    let selected = selected??;
    let opened = state.selected(selected.clone())?;
    if let (Some(_), Some(root)) = (&opened, selected) {
        recent::record(&app, &root);
    }
    Ok(opened)
}
#[tauri::command]
pub async fn folder_list(
    state: tauri::State<'_, FolderState>,
    session_id: String,
    path: String,
) -> Result<Listing> {
    state.list(&session_id, &path)
}
#[tauri::command]
pub async fn folder_read(
    state: tauri::State<'_, FolderState>,
    session_id: String,
    path: String,
) -> Result<Preview> {
    state.read(&session_id, &path)
}
#[tauri::command]
pub fn folder_close(state: tauri::State<'_, FolderState>, session_id: String) -> Result<()> {
    state.close(&session_id)
}
// MEGA-04: lends the validated session root to read-only sibling inspectors (Git, Live Preview).
impl FolderState {
    pub(crate) fn with_root<T>(&self, id: &str, operation: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
        self.with(id, operation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn traversal_is_rejected() {
        for path in [
            "../x", "/x", "a//b", "a/../b", "C:/x", "a\\b", "a:x", "CON.txt", "NUL", "a.", "a ",
            "x\0", "a/./b",
        ] {
            assert!(parts(path).is_err(), "{path}");
        }
    }
    #[test]
    fn valid_unicode_relative_path() {
        assert_eq!(parts("src/żółć 日本語.ts").unwrap().len(), 2);
    }
    #[test]
    fn depth_and_path_limits() {
        assert!(parts(&vec!["a"; 33].join("/")).is_err());
        assert!(parts(&"a".repeat(2049)).is_err());
    }
    #[test]
    fn invalid_session_and_cancellation() {
        let s = FolderState::default();
        assert!(s.selected(None).unwrap().is_none());
        assert!(s.read("unknown", "main.js").is_err());
        assert!(s.close("unknown").is_ok());
    }
    #[cfg(windows)]
    fn fixture() -> (FolderState, String, PathBuf) {
        let root = std::env::temp_dir().join(format!("melly-m11-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let state = FolderState::default();
        let id = state
            .selected(Some(root.clone()))
            .unwrap()
            .unwrap()
            .session_id;
        (state, id, root)
    }
    #[cfg(windows)]
    #[test]
    fn native_listing_text_limits_and_preservation() {
        let (s, id, root) = fixture();
        fs::create_dir(root.join("src")).unwrap();
        let text = "\r\n  żółć 日本語 🟣\r\nCR\rLF\n";
        fs::write(root.join("src/main.ts"), text).unwrap();
        fs::write(root.join("empty.txt"), b"").unwrap();
        fs::write(root.join("binary"), b"a\0b").unwrap();
        fs::write(root.join("invalid"), [255, 254]).unwrap();
        fs::write(root.join("large"), vec![b'a'; MAX_BYTES as usize + 1]).unwrap();
        assert_eq!(s.list(&id, "").unwrap().entries[0].name, "src");
        assert_eq!(s.list(&id, "src").unwrap().entries.len(), 1);
        assert_eq!(s.read(&id, "src/main.ts").unwrap().content, text);
        assert_eq!(s.read(&id, "empty.txt").unwrap().content, "");
        for path in ["binary", "invalid", "large", "missing", "../outside", "src"] {
            assert!(s.read(&id, path).is_err(), "{path}");
        }
        assert_eq!(fs::read(root.join("src/main.ts")).unwrap(), text.as_bytes());
        s.close(&id).unwrap();
        assert!(s.list(&id, "").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn native_expiration_and_missing_root() {
        let (s, id, root) = fixture();
        s.session.lock().unwrap().as_mut().unwrap().used =
            Instant::now() - SESSION_TTL - Duration::from_secs(1);
        assert!(s.list(&id, "").is_err());
        assert!(s.session.lock().unwrap().is_none());
        fs::remove_dir(&root).unwrap();
        assert!(s.selected(Some(root)).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn native_large_directory() {
        let (s, id, root) = fixture();
        for n in 0..=MAX_ENTRIES {
            fs::write(root.join(format!("{n}.txt")), b"").unwrap();
        }
        assert!(s.list(&id, "").unwrap_err().contains("1000"));
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn native_junction_and_sharing_refused() {
        use std::os::windows::fs::OpenOptionsExt;
        let (s, id, root) = fixture();
        fs::write(root.join("locked.txt"), b"locked").unwrap();
        let lock = fs::OpenOptions::new()
            .write(true)
            .share_mode(0)
            .open(root.join("locked.txt"))
            .unwrap();
        assert!(s.read(&id, "locked.txt").is_err());
        drop(lock);
        // A junction needs no Developer Mode. Only test-created disposable directories are used.
        let outside = std::env::temp_dir().join(format!("melly-outside-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.txt"), b"outside").unwrap();
        let junction = root.join("link");
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(s.read(&id, "link/secret.txt").is_err());
        assert!(s.list(&id, "link").is_err());
        assert_eq!(
            s.list(&id, "")
                .unwrap()
                .entries
                .iter()
                .find(|e| e.name == "link")
                .unwrap()
                .kind,
            "blocked"
        );
        fs::remove_dir(&junction).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}

// M1.2 / MEGA-07 explicit save. The original is pinned through an exclusive handle and verified
// against the editor's base version, then never rewritten in place: the new bytes go to a synced
// temporary sibling, the pinned original is renamed aside, the temporary file takes the target
// name, and only then is the aside copy deleted. Any failure before the final rename leaves the
// original bytes at the target path. A crash leaves recognisable sibling artifacts, which are
// reported on the next read and are only restored or discarded by an explicit user action.
fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
const SAVE_TAG: &str = ".melly-save-";
const BACKUP_TAG: &str = ".melly-backup-";
const MAX_ARTIFACTS: usize = 16;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    path: String,
    /// "new-content": a temporary save copy; "original": the aside copy of the previous bytes.
    kind: &'static str,
    bytes: u64,
    /// SHA-256 of the artifact bytes, empty when it could not be read safely.
    version: String,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiskVersion {
    path: String,
    exists: bool,
    version: String,
    bytes: u64,
    interrupted: Vec<Artifact>,
}

fn split_relative(relative: &str) -> (&str, &str) {
    relative.rsplit_once('/').unwrap_or(("", relative))
}
fn join_relative(parent: &str, name: &str) -> String {
    if parent.is_empty() { name.to_string() } else { format!("{parent}/{name}") }
}
fn artifact_kind(name: &str, file_name: &str) -> Option<&'static str> {
    let save = format!(".{name}{SAVE_TAG}");
    let backup = format!(".{name}{BACKUP_TAG}");
    if file_name.starts_with(&save) && file_name.ends_with(".tmp") {
        Some("new-content")
    } else if file_name.starts_with(&backup) {
        Some("original")
    } else {
        None
    }
}
fn is_artifact_name(file_name: &str) -> bool {
    file_name.starts_with('.') && (file_name.contains(SAVE_TAG) || file_name.contains(BACKUP_TAG))
}
/// Lists save artifacts of `name` in the already pinned directory `dir`. Read-only.
fn artifacts(dir: &Path, parent: &str, name: &str) -> Vec<Artifact> {
    let Ok(items) = fs::read_dir(dir) else { return vec![] };
    let mut found = vec![];
    for item in items.flatten().take(MAX_ENTRIES) {
        let Ok(file_name) = item.file_name().into_string() else { continue };
        let Some(kind) = artifact_kind(name, &file_name) else { continue };
        let (bytes, version) = read_artifact(&dir.join(&file_name));
        found.push(Artifact { path: join_relative(parent, &file_name), kind, bytes, version });
        if found.len() >= MAX_ARTIFACTS {
            break;
        }
    }
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found
}
fn read_artifact(path: &Path) -> (u64, String) {
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        let Ok(file) = fs::OpenOptions::new().read(true).share_mode(1).custom_flags(0x00200000).open(path) else {
            return (0, String::new());
        };
        let Ok(meta) = file.metadata() else { return (0, String::new()) };
        if !meta.is_file() || meta.file_attributes() & 0x400 != 0 || meta.len() > MAX_BYTES {
            return (meta.len(), String::new());
        }
        let mut bytes = Vec::new();
        if file.take(MAX_BYTES + 1).read_to_end(&mut bytes).is_err() {
            return (meta.len(), String::new());
        }
        (bytes.len() as u64, digest(&bytes))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        (0, String::new())
    }
}

/// Stable machine-readable prefixes; the UI branches on the code before the colon.
fn coded(code: &str, text: &str) -> String {
    format!("{code}: {text}")
}
fn os_code(e: &std::io::Error) -> &'static str {
    match e.raw_os_error() {
        Some(2 | 3) => "MISSING",
        Some(5) => "ACCESS_DENIED",
        Some(19) => "READ_ONLY",
        Some(32 | 33 | 1224) => "LOCKED",
        Some(39 | 112) => "DISK_FULL",
        Some(80 | 183) => "EXISTS",
        _ => match e.kind() {
            std::io::ErrorKind::NotFound => "MISSING",
            std::io::ErrorKind::PermissionDenied => "ACCESS_DENIED",
            _ => "IO",
        },
    }
}
fn save_error(e: &std::io::Error, outcome: &str) -> String {
    let code = os_code(e);
    let reason = match code {
        "MISSING" => "Missing file: it was deleted or renamed on disk. Your buffer is preserved.",
        "ACCESS_DENIED" => "Access denied by Windows permissions.",
        "READ_ONLY" => "The file or drive is read-only.",
        "LOCKED" => "The file is locked by another program (sharing violation). Close it there and retry.",
        "DISK_FULL" => "The disk is full.",
        "EXISTS" => "A file with the required name already exists.",
        _ => "Local filesystem request failed.",
    };
    coded(code, &format!("{reason} {outcome} (OS code {:?})", e.raw_os_error()))
}
fn interrupted_error() -> String {
    coded("INTERRUPTED", "Save was interrupted before it completed. Reopen the file: Melly lists the recovery artifacts and changes nothing automatically.")
}

/// Fault injection for the disposable-fixture test suite. Compiled out of every non-test build.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code)]
enum Stage {
    Open,
    TempCreate,
    TempWrite,
    BeforeReplace,
    Replace,
    Cleanup,
}
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[allow(dead_code)]
enum Inject {
    /// The step fails with an I/O error; the normal rollback path runs.
    Fail,
    /// The process "dies": return immediately, no rollback or cleanup.
    Crash,
}
#[cfg(test)]
thread_local! {
    static FAULT: std::cell::Cell<Option<(Stage, Inject)>> = const { std::cell::Cell::new(None) };
}
fn inject(stage: Stage) -> Option<Inject> {
    #[cfg(test)]
    {
        FAULT.with(|f| f.get().filter(|(s, _)| *s == stage).map(|(_, i)| i))
    }
    #[cfg(not(test))]
    {
        let _ = stage;
        None
    }
}
/// Ok(()) to continue; Err(Some(e)) for an injected failure; Err(None) for a simulated crash.
fn step(stage: Stage) -> std::result::Result<(), Option<std::io::Error>> {
    match inject(stage) {
        None => Ok(()),
        Some(Inject::Fail) => Err(Some(std::io::Error::from_raw_os_error(1117))),
        Some(Inject::Crash) => Err(None),
    }
}

#[cfg(windows)]
mod win {
    use std::{fs, os::windows::fs::OpenOptionsExt, os::windows::io::AsRawHandle, path::Path};
    use windows::Win32::{Foundation::HANDLE, Storage::FileSystem::*};
    const DELETE: u32 = 0x0001_0000;
    const READ_WRITE: u32 = 0x0012_0089 | 0x0012_0116;
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    /// Attributes that may be copied with SetFileInformationByHandle(FileBasicInfo).
    const SETTABLE: u32 = 0x1 | 0x2 | 0x4 | 0x20 | 0x80 | 0x100 | 0x1000 | 0x2000;
    fn handle(file: &fs::File) -> HANDLE {
        HANDLE(file.as_raw_handle())
    }
    fn io(e: windows::core::Error) -> std::io::Error {
        let hr = e.code().0 as u32;
        if hr & 0xFFFF_0000 == 0x8007_0000 {
            std::io::Error::from_raw_os_error((hr & 0xFFFF) as i32)
        } else {
            std::io::Error::other(e.message())
        }
    }
    /// Read/write/delete access with no sharing at all; a final reparse point is not followed.
    pub fn open_exclusive(path: &Path) -> std::io::Result<fs::File> {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .access_mode(READ_WRITE | DELETE)
            .share_mode(0)
            .custom_flags(OPEN_REPARSE_POINT)
            .open(path)
    }
    pub fn create_temp(path: &Path) -> std::io::Result<fs::File> {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .access_mode(READ_WRITE | DELETE)
            .share_mode(0)
            .attributes(FILE_ATTRIBUTE_HIDDEN.0)
            .open(path)
    }
    pub fn links(file: &fs::File) -> std::io::Result<u32> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(handle(file), &mut info) }.map_err(io)?;
        Ok(info.nNumberOfLinks)
    }
    pub fn basic(file: &fs::File) -> std::io::Result<FILE_BASIC_INFO> {
        let mut info = FILE_BASIC_INFO::default();
        unsafe { GetFileInformationByHandleEx(handle(file), FileBasicInfo, &mut info as *mut _ as _, size_of::<FILE_BASIC_INFO>() as u32) }
            .map_err(io)?;
        Ok(info)
    }
    /// Gives `file` the creation time and attributes of the original; timestamps 0 = unchanged.
    pub fn copy_identity(file: &fs::File, original: &FILE_BASIC_INFO) -> std::io::Result<()> {
        let attributes = original.FileAttributes & SETTABLE;
        let info = FILE_BASIC_INFO {
            CreationTime: original.CreationTime,
            LastAccessTime: 0,
            LastWriteTime: 0,
            ChangeTime: 0,
            FileAttributes: if attributes == 0 { 0x80 } else { attributes },
        };
        unsafe { SetFileInformationByHandle(handle(file), FileBasicInfo, &info as *const _ as _, size_of::<FILE_BASIC_INFO>() as u32) }.map_err(io)
    }
    /// Renames the open file to `target`, which must be an absolute path inside the pinned
    /// directory: FileRenameInfo resolves relative names against the process working
    /// directory, not the file's own directory. Never replaces an existing name.
    pub fn rename(file: &fs::File, target: &Path) -> std::io::Result<()> {
        use std::os::windows::ffi::OsStrExt;
        if !target.is_absolute() {
            return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
        }
        let wide: Vec<u16> = target.as_os_str().encode_wide().collect();
        let size = size_of::<FILE_RENAME_INFO>() + wide.len() * 2;
        let mut buffer = vec![0u64; size.div_ceil(8)];
        let info = buffer.as_mut_ptr() as *mut FILE_RENAME_INFO;
        unsafe {
            (*info).Anonymous.ReplaceIfExists = false;
            (*info).RootDirectory = HANDLE(std::ptr::null_mut());
            (*info).FileNameLength = (wide.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(wide.as_ptr(), std::ptr::addr_of_mut!((*info).FileName) as *mut u16, wide.len());
            SetFileInformationByHandle(handle(file), FileRenameInfo, info as *const _, size as u32).map_err(io)
        }
    }
    pub fn delete(file: &fs::File) -> std::io::Result<()> {
        let info = FILE_DISPOSITION_INFO { DeleteFile: true };
        unsafe { SetFileInformationByHandle(handle(file), FileDispositionInfo, &info as *const _ as _, size_of::<FILE_DISPOSITION_INFO>() as u32) }
            .map_err(io)
    }
}

fn valid_source(content: &str) -> bool {
    content.len() as u64 <= MAX_BYTES
        && !content.chars().any(|c| c == '\0' || (c.is_control() && !['\n', '\r', '\t', '\u{c}'].contains(&c)))
}

impl FolderState {
    fn save(&self, id: &str, relative: &str, content: &str, expected: &str) -> Result<Preview> {
        if !valid_source(content) {
            return Err(coded("UNSUPPORTED", "Save requires UTF-8 source up to 1 MiB."));
        }
        let components = parts(relative)?;
        let Some(name) = components.last().copied() else { return Err("Select an existing file.".into()) };
        if is_artifact_name(name) {
            return Err(coded("UNSUPPORTED", "Save artifacts are kept read-only. Restore or discard them from the Local Folder panel."));
        }
        if name.encode_utf16().count() > 200 {
            return Err(coded("UNSUPPORTED", "File name is too long for a safe save (200 characters)."));
        }
        self.with(id, |root| {
            #[cfg(windows)]
            {
                save_windows(root, relative, name, content, expected)
            }
            #[cfg(not(windows))]
            {
                let _ = (root, name, expected);
                Err("Disk saving requires Windows.".into())
            }
        })
    }
    fn version(&self, id: &str, relative: &str) -> Result<DiskVersion> {
        let components = parts(relative)?;
        if components.is_empty() {
            return Err("Select a file.".into());
        }
        let (parent, name) = split_relative(relative);
        self.with(id, |root| {
            let (dir, _guards) = guarded(root, parent)?;
            let interrupted = artifacts(&dir, parent, name);
            let (exists, version, bytes) = match guarded(root, relative) {
                Ok((_, guards)) => {
                    let file = guards.last().ok_or("Select a file.")?;
                    let meta = file.metadata().map_err(io_error)?;
                    if !meta.is_file() {
                        return Err("Select a regular file.".into());
                    }
                    if meta.len() > MAX_BYTES {
                        return Err("File exceeds the 1 MiB preview limit.".into());
                    }
                    let mut bytes = Vec::new();
                    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(io_error)?;
                    (true, digest(&bytes), bytes.len() as u64)
                }
                Err(e) if e.starts_with("Missing") => (false, String::new(), 0),
                Err(e) => return Err(e),
            };
            Ok(DiskVersion { path: relative.into(), exists, version, bytes, interrupted })
        })
    }
    /// Moves an artifact back to the file name. Only when that name is free; never overwrites.
    fn restore_interrupted(&self, id: &str, relative: &str, artifact: &str, expected: &str) -> Result<Preview> {
        let (parent, name, art_name) = artifact_target(relative, artifact)?;
        self.with(id, |root| {
            #[cfg(windows)]
            {
                let (dir, _guards) = guarded_share(root, parent, 3)?;
                if fs::symlink_metadata(dir.join(name)).is_ok() {
                    return Err(coded("EXISTS", "The file exists on disk again. Open the artifact read-only and copy what you need; nothing was renamed."));
                }
                let (file, bytes) = open_artifact(&dir.join(art_name), expected)?;
                let content = String::from_utf8(bytes).map_err(|_| coded("UNSUPPORTED", "The artifact is incomplete or not UTF-8. It was left unchanged."))?;
                win::rename(&file, &dir.join(name)).map_err(|e| save_error(&e, "The artifact was left unchanged."))?;
                drop(file);
                Ok(Preview {
                    path: relative.into(),
                    bytes: content.len(),
                    version: digest(content.as_bytes()),
                    content,
                    interrupted: artifacts(&dir, parent, name),
                    warning: None,
                })
            }
            #[cfg(not(windows))]
            {
                let _ = (root, parent, name, art_name, expected);
                Err("Disk saving requires Windows.".into())
            }
        })
    }
    /// Deletes one artifact the person reviewed (its version must still match).
    fn discard_interrupted(&self, id: &str, relative: &str, artifact: &str, expected: &str) -> Result<Vec<Artifact>> {
        let (parent, name, art_name) = artifact_target(relative, artifact)?;
        self.with(id, |root| {
            #[cfg(windows)]
            {
                let (dir, _guards) = guarded_share(root, parent, 3)?;
                let (file, _) = open_artifact(&dir.join(art_name), expected)?;
                win::delete(&file).map_err(|e| save_error(&e, "The artifact was left unchanged."))?;
                drop(file);
                Ok(artifacts(&dir, parent, name))
            }
            #[cfg(not(windows))]
            {
                let _ = (root, parent, name, art_name, expected);
                Err("Disk saving requires Windows.".into())
            }
        })
    }
}
fn artifact_target<'a>(relative: &'a str, artifact: &'a str) -> Result<(&'a str, &'a str, &'a str)> {
    if parts(relative)?.is_empty() || parts(artifact)?.is_empty() {
        return Err("Select a file.".into());
    }
    let (parent, name) = split_relative(relative);
    let (art_parent, art_name) = split_relative(artifact);
    if art_parent != parent || artifact_kind(name, art_name).is_none() {
        return Err(coded("UNSUPPORTED", "Not a recovery artifact of this file."));
    }
    Ok((parent, name, art_name))
}
#[cfg(windows)]
fn open_artifact(path: &Path, expected: &str) -> Result<(fs::File, Vec<u8>)> {
    use std::os::windows::fs::MetadataExt;
    let mut file = win::open_exclusive(path).map_err(|e| save_error(&e, "Nothing was changed."))?;
    let meta = file.metadata().map_err(io_error)?;
    if !meta.is_file() || meta.file_attributes() & 0x400 != 0 || win::links(&file).map_err(io_error)? != 1 || meta.len() > MAX_BYTES {
        return Err(coded("UNSUPPORTED", "Artifact is not a plain file within the 1 MiB limit."));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file).take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(io_error)?;
    if digest(&bytes) != expected {
        return Err(coded("CONFLICT", "The artifact changed since it was listed. Nothing was changed."));
    }
    Ok((file, bytes))
}

#[cfg(windows)]
fn save_windows(root: &Path, relative: &str, name: &str, content: &str, expected: &str) -> Result<Preview> {
    use std::os::windows::fs::MetadataExt;
    const UNCHANGED: &str = "The original file is unchanged.";
    const TEMP_REMOVED: &str = "The original file is unchanged; the temporary copy was removed.";
    let (parent, _) = split_relative(relative);
    let (dir, _guards) = guarded_share(root, parent, 3)?;
    let target = dir.join(name);
    let fail = |result: std::result::Result<(), Option<std::io::Error>>, outcome: &str| -> Result<()> {
        result.map_err(|e| e.map_or_else(interrupted_error, |e| save_error(&e, outcome)))
    };
    fail(step(Stage::Open), UNCHANGED)?;
    let mut original = win::open_exclusive(&target).map_err(|e| {
        let read_only = fs::symlink_metadata(&target).is_ok_and(|m| m.file_attributes() & 0x1 != 0);
        if read_only && os_code(&e) == "ACCESS_DENIED" {
            coded("READ_ONLY", "The file has the Windows read-only attribute. Nothing was written.")
        } else {
            save_error(&e, "Nothing was written.")
        }
    })?;
    let meta = original.metadata().map_err(io_error)?;
    if !meta.is_file() || meta.file_attributes() & 0x400 != 0 || win::links(&original).map_err(|e| save_error(&e, UNCHANGED))? != 1 {
        return Err(coded("UNSUPPORTED", "Save refuses reparse points, hard links and non-regular files."));
    }
    if meta.len() > MAX_BYTES {
        return Err(coded("UNSUPPORTED", "File exceeds 1 MiB."));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut original).take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| save_error(&e, UNCHANGED))?;
    if bytes.len() as u64 > MAX_BYTES || digest(&bytes) != expected {
        return Err("CONFLICT: File changed on disk. Keep your buffer and reload to compare; save was refused.".into());
    }
    let identity = win::basic(&original).map_err(|e| save_error(&e, UNCHANGED))?;
    let tag: String = uuid::Uuid::new_v4().simple().to_string().chars().take(12).collect();
    let temp_name = format!(".{name}{SAVE_TAG}{tag}.tmp");
    let backup_name = format!(".{name}{BACKUP_TAG}{tag}");

    fail(step(Stage::TempCreate), UNCHANGED)?;
    let mut temp = win::create_temp(&dir.join(&temp_name)).map_err(|e| save_error(&e, UNCHANGED))?;
    let abandon = |temp: &fs::File, e: Option<std::io::Error>| -> String {
        match e {
            Some(e) => {
                let _ = win::delete(temp);
                save_error(&e, TEMP_REMOVED)
            }
            None => interrupted_error(),
        }
    };
    let written = step(Stage::TempWrite).and_then(|_| {
        temp.write_all(content.as_bytes()).and_then(|_| temp.sync_all()).and_then(|_| win::copy_identity(&temp, &identity)).map_err(Some)
    });
    if let Err(e) = written {
        return Err(abandon(&temp, e));
    }
    if let Err(e) = step(Stage::BeforeReplace).and_then(|_| win::rename(&original, &dir.join(&backup_name)).map_err(Some)) {
        return Err(abandon(&temp, e));
    }
    // From here the target name is free; the original bytes live in the pinned backup handle.
    if let Err(e) = step(Stage::Replace).and_then(|_| win::rename(&temp, &target).map_err(Some)) {
        let Some(e) = e else { return Err(interrupted_error()) };
        return Err(match win::rename(&original, &target) {
            Ok(()) => {
                let _ = win::delete(&temp);
                save_error(&e, "The original file was restored unchanged; the temporary copy was removed.")
            }
            Err(back) => coded(
                "ROLLBACK_FAILED",
                &format!(
                    "Save could not finish and the original could not be renamed back. Nothing was deleted: original bytes are in {}, new bytes in {}. Keep the recovery buffer and restore from the Local Folder panel. (OS codes {:?}/{:?})",
                    join_relative(parent, &backup_name),
                    join_relative(parent, &temp_name),
                    e.raw_os_error(),
                    back.raw_os_error()
                ),
            ),
        });
    }
    let _ = temp.sync_all();
    let cleaned = step(Stage::Cleanup).and_then(|_| win::delete(&original).map_err(Some));
    if let Err(None) = cleaned {
        return Err(interrupted_error());
    }
    let warning = cleaned.err().map(|_| {
        format!("Saved. The previous version remains as {}; discard it from the Local Folder panel when you no longer need it.", join_relative(parent, &backup_name))
    });
    drop(original);
    drop(temp);
    Ok(Preview {
        path: relative.into(),
        content: content.into(),
        bytes: content.len(),
        version: digest(content.as_bytes()),
        interrupted: vec![],
        warning,
    })
}
#[tauri::command]
pub async fn folder_save(state: tauri::State<'_, FolderState>, session_id: String, path: String, content: String, expected_version: String) -> Result<Preview> {
    let result = state.save(&session_id, &path, &content, &expected_version);
    crate::diagnostics::note_save(result.as_ref().err());
    result
}
#[tauri::command]
pub async fn folder_version(state: tauri::State<'_, FolderState>, session_id: String, path: String) -> Result<DiskVersion> {
    state.version(&session_id, &path)
}
#[tauri::command]
pub async fn folder_restore_interrupted(state: tauri::State<'_, FolderState>, session_id: String, path: String, artifact: String, expected_version: String) -> Result<Preview> {
    state.restore_interrupted(&session_id, &path, &artifact, &expected_version)
}
#[tauri::command]
pub async fn folder_discard_interrupted(state: tauri::State<'_, FolderState>, session_id: String, path: String, artifact: String, expected_version: String) -> Result<Vec<Artifact>> {
    state.discard_interrupted(&session_id, &path, &artifact, &expected_version)
}

#[cfg(all(test, windows))]
mod editing_tests {
    use super::*;
    const FIXTURE: &str = "\u{feff}// żółć 日本語 🟣\r\nlet x=1;\r\n";
    fn fixture() -> (FolderState, String, PathBuf) {
        let root = std::env::temp_dir().join(format!("melly-m12-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("unicode.ts"), FIXTURE).unwrap();
        let s = FolderState::default();
        let id = s.selected(Some(root.clone())).unwrap().unwrap().session_id;
        (s, id, root)
    }
    fn names(root: &Path) -> Vec<String> {
        let mut v: Vec<_> = fs::read_dir(root).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        v.sort();
        v
    }
    fn with_fault<T>(stage: Stage, kind: Inject, f: impl FnOnce() -> T) -> T {
        FAULT.with(|c| c.set(Some((stage, kind))));
        let out = f();
        FAULT.with(|c| c.set(None));
        out
    }
    fn code(error: &str) -> &str {
        error.split(':').next().unwrap_or("")
    }
    #[test]
    fn explicit_save_roundtrip_conflicts_and_deletion() {
        let (s, id, root) = fixture();
        let f = s.read(&id, "unicode.ts").unwrap();
        let next = f.content.replace("x=1", "x=2");
        let saved = s.save(&id, "unicode.ts", &next, &f.version).unwrap();
        assert_eq!(fs::read(root.join("unicode.ts")).unwrap(), next.as_bytes());
        assert_eq!(names(&root), ["unicode.ts"], "no artifacts after a successful save");
        let cwd = std::env::current_dir().unwrap();
        assert!(fs::read_dir(&cwd).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().contains(".melly-")), "nothing renamed into the working directory");
        fs::write(root.join("unicode.ts"), "external").unwrap();
        assert!(s.save(&id, "unicode.ts", "mine", &saved.version).unwrap_err().contains("CONFLICT"));
        assert_eq!(fs::read_to_string(root.join("unicode.ts")).unwrap(), "external");
        fs::remove_file(root.join("unicode.ts")).unwrap();
        assert_eq!(code(&s.save(&id, "unicode.ts", "mine", &saved.version).unwrap_err()), "MISSING");
        assert!(!root.join("unicode.ts").exists());
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn save_refuses_hardlinks_locks_paths_and_sessions() {
        use std::os::windows::fs::OpenOptionsExt;
        let (s, id, root) = fixture();
        let f = s.read(&id, "unicode.ts").unwrap();
        for p in ["../unicode.ts", "C:/unicode.ts", "unicode.ts:ads", "CON"] {
            assert!(s.save(&id, p, "bad", &f.version).is_err());
        }
        assert!(s.save("wrong", "unicode.ts", "bad", &f.version).is_err());
        let lock = fs::OpenOptions::new().read(true).share_mode(0).open(root.join("unicode.ts")).unwrap();
        assert_eq!(code(&s.save(&id, "unicode.ts", "bad", &f.version).unwrap_err()), "LOCKED");
        drop(lock);
        fs::hard_link(root.join("unicode.ts"), root.join("alias.ts")).unwrap();
        assert!(s.save(&id, "unicode.ts", "bad", &f.version).is_err());
        assert_eq!(s.read(&id, "unicode.ts").unwrap().content, f.content);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn save_refuses_junction_and_keeps_outside_bytes() {
        let (s, id, root) = fixture();
        let outside = std::env::temp_dir().join(format!("melly-m12-out-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("x.ts"), "outside").unwrap();
        let link = root.join("link");
        assert!(std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&link).arg(&outside).output().unwrap().status.success());
        assert!(s.save(&id, "link/x.ts", "bad", &digest(b"outside")).is_err());
        assert_eq!(fs::read_to_string(outside.join("x.ts")).unwrap(), "outside");
        assert_eq!(names(&outside), ["x.ts"], "no artifact created through a junction");
        fs::remove_dir(link).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[test]
    fn unicode_bom_and_line_endings_are_preserved_exactly() {
        let (s, id, root) = fixture();
        for text in [
            "\u{feff}a\r\nb\r\n",
            "no bom\nlf only\n",
            "mixed\r\nlf\ncr\rend",
            "żółć 日本語 🟣 \u{200d}👩‍💻\ttab\u{c}form",
            "",
            "\u{feff}",
        ] {
            let current = s.read(&id, "unicode.ts").unwrap();
            let saved = s.save(&id, "unicode.ts", text, &current.version).unwrap();
            assert_eq!(fs::read(root.join("unicode.ts")).unwrap(), text.as_bytes(), "{text:?}");
            assert_eq!(saved.version, digest(text.as_bytes()));
        }
        assert_eq!(names(&root), ["unicode.ts"]);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn hidden_attribute_and_creation_time_survive_replacement() {
        use std::os::windows::fs::MetadataExt;
        let (s, id, root) = fixture();
        let path = root.join("unicode.ts");
        assert!(std::process::Command::new("attrib").arg("+h").arg(&path).status().unwrap().success());
        let before = fs::metadata(&path).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        let f = s.read(&id, "unicode.ts").unwrap();
        s.save(&id, "unicode.ts", "changed", &f.version).unwrap();
        let after = fs::metadata(&path).unwrap();
        assert_eq!(after.file_attributes() & 0x2, 0x2, "hidden attribute kept");
        assert_eq!(after.creation_time(), before.creation_time(), "creation time kept");
        assert_eq!(after.file_attributes() & 0x400, 0);
        assert!(std::process::Command::new("attrib").arg("-h").arg(&path).status().unwrap().success());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn read_only_and_acl_denied_files_are_reported_and_untouched() {
        let (s, id, root) = fixture();
        let path = root.join("unicode.ts");
        let f = s.read(&id, "unicode.ts").unwrap();
        assert!(std::process::Command::new("attrib").arg("+r").arg(&path).status().unwrap().success());
        assert_eq!(code(&s.save(&id, "unicode.ts", "x", &f.version).unwrap_err()), "READ_ONLY");
        assert!(std::process::Command::new("attrib").arg("-r").arg(&path).status().unwrap().success());
        // Disposable fixture only: deny write for the current user, then remove the deny ACE.
        let user = std::env::var("USERNAME").unwrap();
        let deny = std::process::Command::new("icacls").arg(&path).args(["/deny", &format!("{user}:(W,D)")]).output().unwrap();
        assert!(deny.status.success(), "{}", String::from_utf8_lossy(&deny.stdout));
        let denied = s.save(&id, "unicode.ts", "x", &f.version).unwrap_err();
        let restore = std::process::Command::new("icacls").arg(&path).args(["/remove:d", &user]).output().unwrap();
        assert!(restore.status.success());
        assert_eq!(code(&denied), "ACCESS_DENIED", "{denied}");
        assert_eq!(fs::read_to_string(&path).unwrap(), FIXTURE);
        assert_eq!(names(&root), ["unicode.ts"]);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn injected_failures_preserve_the_original_and_leave_no_artifacts() {
        for stage in [Stage::Open, Stage::TempCreate, Stage::TempWrite, Stage::BeforeReplace, Stage::Replace] {
            let (s, id, root) = fixture();
            let f = s.read(&id, "unicode.ts").unwrap();
            let error = with_fault(stage, Inject::Fail, || s.save(&id, "unicode.ts", "NEW CONTENT", &f.version)).unwrap_err();
            assert_eq!(code(&error), "IO", "{stage:?}: {error}");
            assert!(error.contains("unchanged"), "{stage:?}: {error}");
            assert_eq!(fs::read_to_string(root.join("unicode.ts")).unwrap(), FIXTURE, "{stage:?}");
            assert_eq!(names(&root), ["unicode.ts"], "{stage:?}");
            // The file is still savable afterwards: no handle or lock leaked.
            s.save(&id, "unicode.ts", "after", &f.version).unwrap();
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn failed_cleanup_saves_and_reports_the_kept_backup() {
        let (s, id, root) = fixture();
        let f = s.read(&id, "unicode.ts").unwrap();
        let saved = with_fault(Stage::Cleanup, Inject::Fail, || s.save(&id, "unicode.ts", "NEW", &f.version)).unwrap();
        assert!(saved.warning.as_deref().unwrap().contains(".unicode.ts.melly-backup-"));
        assert_eq!(fs::read_to_string(root.join("unicode.ts")).unwrap(), "NEW");
        let listed = s.read(&id, "unicode.ts").unwrap().interrupted;
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].kind, listed[0].version.as_str()), ("original", f.version.as_str()));
        let left = s.discard_interrupted(&id, "unicode.ts", &listed[0].path, &listed[0].version).unwrap();
        assert!(left.is_empty());
        assert_eq!(names(&root), ["unicode.ts"]);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn restart_after_interrupted_save_is_detected_and_recoverable() {
        for stage in [Stage::TempWrite, Stage::BeforeReplace, Stage::Replace, Stage::Cleanup] {
            let (s, id, root) = fixture();
            let f = s.read(&id, "unicode.ts").unwrap();
            let error = with_fault(stage, Inject::Crash, || s.save(&id, "unicode.ts", "NEW CONTENT", &f.version)).unwrap_err();
            assert_eq!(code(&error), "INTERRUPTED", "{stage:?}");
            // Simulated restart: a fresh native state and a newly selected session.
            drop(s);
            let s = FolderState::default();
            let id = s.selected(Some(root.clone())).unwrap().unwrap().session_id;
            let disk = s.version(&id, "unicode.ts").unwrap();
            let originals: Vec<_> = disk.interrupted.iter().filter(|a| a.kind == "original").collect();
            let temps: Vec<_> = disk.interrupted.iter().filter(|a| a.kind == "new-content").collect();
            match stage {
                Stage::TempWrite | Stage::BeforeReplace => {
                    // Target untouched; only the temporary copy exists.
                    assert!(disk.exists && disk.version == f.version, "{stage:?}");
                    assert_eq!((originals.len(), temps.len()), (0, 1), "{stage:?}");
                    assert_eq!(temps[0].version, if stage == Stage::TempWrite { digest(b"") } else { digest(b"NEW CONTENT") });
                    let refused = s.restore_interrupted(&id, "unicode.ts", &temps[0].path, &temps[0].version).unwrap_err();
                    assert_eq!(code(&refused), "EXISTS", "never overwrites an existing file");
                    assert!(s.save(&id, &temps[0].path, "x", &temps[0].version).is_err(), "artifacts are not saved over");
                    assert!(s.discard_interrupted(&id, "unicode.ts", &temps[0].path, &temps[0].version).unwrap().is_empty());
                    assert_eq!(fs::read_to_string(root.join("unicode.ts")).unwrap(), FIXTURE);
                }
                Stage::Replace => {
                    // Target name free; both copies preserved. Restoring the original is explicit.
                    assert!(!disk.exists);
                    assert_eq!((originals.len(), temps.len()), (1, 1));
                    assert_eq!(originals[0].version, f.version);
                    assert_eq!(temps[0].version, digest(b"NEW CONTENT"));
                    assert!(s.save(&id, "unicode.ts", "x", &f.version).is_err(), "no save over a missing target");
                    assert!(s.restore_interrupted(&id, "unicode.ts", &originals[0].path, "0".repeat(64).as_str()).unwrap_err().starts_with("CONFLICT"));
                    let restored = s.restore_interrupted(&id, "unicode.ts", &originals[0].path, &originals[0].version).unwrap();
                    assert_eq!(restored.content, FIXTURE);
                    assert_eq!(restored.interrupted.len(), 1, "the new-content copy is still listed");
                    assert_eq!(fs::read_to_string(root.join("unicode.ts")).unwrap(), FIXTURE);
                }
                _ => {
                    // New content in place; the previous version kept aside.
                    assert!(disk.exists && disk.version == digest(b"NEW CONTENT"));
                    assert_eq!((originals.len(), temps.len()), (1, 0));
                    assert_eq!(originals[0].version, f.version);
                }
            }
            assert!(s.restore_interrupted(&id, "unicode.ts", "other.txt", &f.version).is_err(), "only artifacts of this file");
            assert!(s.restore_interrupted(&id, "unicode.ts", "x/.unicode.ts.melly-backup-1", &f.version).is_err());
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn external_change_detection_by_version() {
        let (s, id, root) = fixture();
        let f = s.read(&id, "unicode.ts").unwrap();
        assert_eq!(s.version(&id, "unicode.ts").unwrap().version, f.version);
        fs::write(root.join("unicode.ts"), "external").unwrap();
        let changed = s.version(&id, "unicode.ts").unwrap();
        assert!(changed.exists && changed.version == digest(b"external"));
        fs::remove_file(root.join("unicode.ts")).unwrap();
        let gone = s.version(&id, "unicode.ts").unwrap();
        assert!(!gone.exists && gone.version.is_empty());
        assert!(s.version(&id, "../unicode.ts").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
