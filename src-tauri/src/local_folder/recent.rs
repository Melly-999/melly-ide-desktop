//! MEGA-09 recent Local Folders. Only the native side keeps absolute paths (app-local data,
//! never sent to the WebView); the renderer sees an opaque key, the folder name and a time.
//! A recent entry is not an authorization: resuming always shows the Windows folder dialog at
//! that folder, and only the person's selection there opens a session.
use super::*;

const MAX_RECENT: usize = 8;
const FILE_NAME: &str = "recent-folders-v1.tsv";
const HEADER: &str = "melly-recent-folders\t1";

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Entry {
    key: String,
    path: PathBuf,
    opened: u64,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    key: String,
    name: String,
    last_opened: u64,
    available: bool,
}

pub(crate) fn key_for(root: &Path) -> String {
    digest(root.to_string_lossy().to_lowercase().as_bytes())
}
/// Windows paths cannot contain control characters, so a tab-separated line is unambiguous.
fn parse(text: &str) -> Vec<Entry> {
    let mut lines = text.lines();
    if lines.next() != Some(HEADER) {
        return vec![];
    }
    lines
        .filter_map(|line| {
            let mut cols = line.splitn(3, '\t');
            let (key, opened, path) = (cols.next()?, cols.next()?.parse().ok()?, cols.next()?);
            let path = PathBuf::from(path);
            (key.len() == 64 && key_for(&path) == key).then(|| Entry { key: key.into(), path, opened })
        })
        .take(MAX_RECENT)
        .collect()
}
fn render(entries: &[Entry]) -> String {
    let mut text = format!("{HEADER}\n");
    for e in entries.iter().take(MAX_RECENT) {
        let path = e.path.to_string_lossy();
        if path.chars().any(|c| c.is_control()) {
            continue;
        }
        text.push_str(&format!("{}\t{}\t{}\n", e.key, e.opened, path));
    }
    text
}
fn upsert(mut entries: Vec<Entry>, root: &Path, now: u64) -> Vec<Entry> {
    let key = key_for(root);
    entries.retain(|e| e.key != key);
    entries.insert(0, Entry { key, path: root.to_path_buf(), opened: now });
    entries.truncate(MAX_RECENT);
    entries
}
fn view(entries: &[Entry]) -> Vec<Recent> {
    entries
        .iter()
        .map(|e| Recent {
            key: e.key.clone(),
            name: e.path.file_name().unwrap_or(e.path.as_os_str()).to_string_lossy().into_owned(),
            last_opened: e.opened,
            available: e.path.is_dir(),
        })
        .collect()
}
fn load(file: &Path) -> Vec<Entry> {
    fs::read_to_string(file).map(|t| parse(&t)).unwrap_or_default()
}
/// Replaces the list through a sibling temporary file so a crash never leaves half a list.
fn store(file: &Path, entries: &[Entry]) -> Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(io_error)?;
    }
    let temp = file.with_extension("tsv.tmp");
    fs::write(&temp, render(entries)).map_err(io_error)?;
    fs::rename(&temp, file).map_err(io_error)
}
fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}
fn file_for<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_local_data_dir().ok().map(|dir| dir.join(FILE_NAME))
}
/// Records a folder the person selected in the Windows dialog. Failures never block opening.
pub(crate) fn record<R: tauri::Runtime>(app: &tauri::AppHandle<R>, root: &Path) {
    if let Some(file) = file_for(app) {
        let _ = store(&file, &upsert(load(&file), root, now()));
    }
}
pub(crate) fn lookup<R: tauri::Runtime>(app: &tauri::AppHandle<R>, key: &str) -> Option<PathBuf> {
    file_for(app).map(|f| load(&f)).unwrap_or_default().into_iter().find(|e| e.key == key).map(|e| e.path)
}

#[tauri::command]
pub fn folder_recent(app: tauri::AppHandle) -> Vec<Recent> {
    view(&file_for(&app).map(|f| load(&f)).unwrap_or_default())
}
#[tauri::command]
pub fn folder_forget(app: tauri::AppHandle, key: String) -> Result<Vec<Recent>> {
    let file = file_for(&app).ok_or("Recent folders are unavailable.")?;
    let mut entries = load(&file);
    entries.retain(|e| e.key != key);
    store(&file, &entries)?;
    Ok(view(&entries))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recent_list_round_trip_dedup_and_cap() {
        let dir = std::env::temp_dir().join(format!("melly-recent-{}", uuid::Uuid::new_v4()));
        let file = dir.join(FILE_NAME);
        assert!(load(&file).is_empty(), "missing file is an empty list");
        let mut entries = vec![];
        for n in 0..10 {
            entries = upsert(entries, &PathBuf::from(format!("C:\\work\\p{n}")), n);
        }
        entries = upsert(entries, &PathBuf::from("C:\\WORK\\p5"), 99);
        assert_eq!(entries.len(), MAX_RECENT);
        assert_eq!(entries[0].opened, 99, "re-opening moves to the front");
        assert_eq!(entries.iter().filter(|e| e.key == key_for(Path::new("C:\\work\\p5"))).count(), 1, "keys ignore case");
        store(&file, &entries).unwrap();
        assert_eq!(load(&file), entries);
        let shown = view(&entries);
        assert_eq!(shown[0].name, "p5");
        assert!(shown.iter().all(|r| !r.available), "synthetic paths do not exist");
        // The renderer view carries a key, a name and a time — never a path.
        let flat: Vec<String> = shown.iter().map(|r| format!("{}|{}|{}|{}", r.key, r.name, r.last_opened, r.available)).collect();
        assert!(!flat.join("\n").contains("C:") && !flat.join("\n").contains("work"));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn tampered_or_foreign_lines_are_ignored() {
        let good = PathBuf::from("C:\\work\\ok");
        let text = format!("{HEADER}\n{}\t1\t{}\nbad line\n{}\t2\tC:\\work\\other\n{}\tx\tC:\\work\\ok\n", key_for(&good), good.display(), key_for(&good), key_for(&good));
        assert_eq!(parse(&text).len(), 1, "a key must match its own path");
        assert!(parse("other-format\n").is_empty());
    }
}
