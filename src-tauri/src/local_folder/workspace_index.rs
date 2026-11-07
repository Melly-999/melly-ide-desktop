//! MEGA-09 bounded workspace index (quick open) and literal text search (find in files).
//! Same boundary as listing and reading: root-relative paths only, every directory and file is
//! opened through `guarded` (no reparse points, ancestors pinned while used), and every walk is
//! bounded in files, directories, depth, bytes and time. Names and lines are untrusted data:
//! Melly never interprets them, and the renderer shows them as text only.
use super::*;

const INDEX_MAX_FILES: usize = 20_000;
const INDEX_MAX_DIRS: usize = 4_000;
const WALK_BUDGET: Duration = Duration::from_millis(2_000);
const SEARCH_MAX_FILES: usize = 5_000;
const SEARCH_MAX_MATCHES: usize = 500;
const SEARCH_PER_FILE: usize = 20;
const SEARCH_FILE_BYTES: u64 = 512 * 1024;
const QUERY_MAX_CHARS: usize = 200;
const PREVIEW_CHARS: usize = 160;
const MAX_SKIPPED_REPORTED: usize = 50;
/// Heavy generated directories are skipped by default and reported, never silently hidden.
pub(crate) const SKIPPED_DIRS: [&str; 7] = [".git", "node_modules", "target", ".venv", "__pycache__", ".next", "desktop-dist"];

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    files: Vec<String>,
    directories: usize,
    skipped: Vec<String>,
    blocked: usize,
    /// Why the index is partial (`files`, `directories` or `time`), absent when complete.
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<&'static str>,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    path: String,
    line: usize,
    column: usize,
    preview: String,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Search {
    matches: Vec<Match>,
    files_scanned: usize,
    files_skipped: usize,
    directories: usize,
    skipped: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<&'static str>,
}

#[derive(Default)]
struct Walk {
    directories: usize,
    skipped: Vec<String>,
    blocked: usize,
    truncated: Option<&'static str>,
}

/// Breadth-first walk (shallow files first). `visit` returns `false` to stop the walk.
fn walk(root: &Path, deadline: Instant, mut visit: impl FnMut(&str) -> bool) -> Walk {
    let mut stats = Walk::default();
    let mut queue = std::collections::VecDeque::from([String::new()]);
    while let Some(dir) = queue.pop_front() {
        if Instant::now() > deadline {
            stats.truncated = Some("time");
            break;
        }
        if stats.directories >= INDEX_MAX_DIRS {
            stats.truncated = Some("directories");
            break;
        }
        stats.directories += 1;
        // Pin the directory chain for the duration of the listing (junction swaps are refused).
        let Ok((path, _guards)) = guarded(root, &dir) else { stats.blocked += 1; continue };
        let Ok(items) = fs::read_dir(&path) else { stats.blocked += 1; continue };
        let mut rows = vec![];
        for item in items.flatten() {
            let Ok(name) = item.file_name().into_string() else { stats.blocked += 1; continue };
            let relative = if dir.is_empty() { name.clone() } else { format!("{dir}/{name}") };
            let Ok(metadata) = fs::symlink_metadata(item.path()) else { stats.blocked += 1; continue };
            #[cfg(windows)]
            let reparse = {
                use std::os::windows::fs::MetadataExt;
                metadata.file_attributes() & 0x400 != 0
            };
            #[cfg(not(windows))]
            let reparse = metadata.file_type().is_symlink();
            if reparse || parts(&relative).is_err() {
                stats.blocked += 1;
            } else if metadata.is_dir() {
                rows.push((true, name, relative));
            } else if metadata.is_file() {
                rows.push((false, name, relative));
            } else {
                stats.blocked += 1;
            }
        }
        rows.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()).then_with(|| a.1.cmp(&b.1)));
        for (is_dir, name, relative) in rows {
            if is_dir {
                if SKIPPED_DIRS.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
                    if stats.skipped.len() < MAX_SKIPPED_REPORTED {
                        stats.skipped.push(relative);
                    }
                } else {
                    queue.push_back(relative);
                }
            } else if !visit(&relative) {
                return stats;
            }
        }
    }
    stats
}

/// Single-line, control-free excerpt of at most PREVIEW_CHARS characters around `column`.
fn excerpt(line: &str, column: usize) -> String {
    let chars: Vec<char> = line.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let start = column.saturating_sub(40).min(chars.len());
    let end = (start + PREVIEW_CHARS).min(chars.len());
    let mut text: String = chars[start..end].iter().collect();
    if start == 0 {
        text = text.trim_start().to_string();
    } else {
        text.insert(0, '…');
    }
    if end < chars.len() {
        text.push('…');
    }
    text
}

fn valid_query(query: &str) -> Result<()> {
    let count = query.chars().count();
    if count == 0 || count > QUERY_MAX_CHARS || query.chars().any(|c| c.is_control()) || query.trim().is_empty() {
        return Err(format!("QUERY_REFUSED: Search text must be 1–{QUERY_MAX_CHARS} characters on one line."));
    }
    Ok(())
}

/// Reads one candidate file through its pinned handle. `None` means "skip" (too large, not
/// UTF-8, binary, or unreadable); the file is never modified.
fn searchable(root: &Path, relative: &str) -> Option<String> {
    let (_, guards) = guarded(root, relative).ok()?;
    let file = guards.last()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > SEARCH_FILE_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(SEARCH_FILE_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > SEARCH_FILE_BYTES || bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

impl FolderState {
    pub(crate) fn index(&self, id: &str) -> Result<Index> {
        self.with(id, |root| {
            let mut files = vec![];
            let mut full = false;
            let stats = walk(root, Instant::now() + WALK_BUDGET, |path| {
                if files.len() >= INDEX_MAX_FILES {
                    full = true;
                    return false;
                }
                files.push(path.to_string());
                true
            });
            Ok(Index { files, directories: stats.directories, skipped: stats.skipped, blocked: stats.blocked, truncated: if full { Some("files") } else { stats.truncated } })
        })
    }
    pub(crate) fn search(&self, id: &str, query: &str, case_sensitive: bool) -> Result<Search> {
        valid_query(query)?;
        let needle = if case_sensitive { query.to_string() } else { query.to_lowercase() };
        self.with(id, |root| {
            let deadline = Instant::now() + WALK_BUDGET;
            let (mut matches, mut scanned, mut skipped_files, mut limit) = (vec![], 0usize, 0usize, None);
            let stats = walk(root, deadline, |path| {
                if scanned >= SEARCH_MAX_FILES {
                    limit = Some("files");
                    return false;
                }
                if Instant::now() > deadline {
                    limit = Some("time");
                    return false;
                }
                let Some(text) = searchable(root, path) else { skipped_files += 1; return true };
                scanned += 1;
                let mut in_file = 0;
                for (index, raw) in text.split('\n').enumerate() {
                    let line = raw.strip_suffix('\r').unwrap_or(raw);
                    let hay = if case_sensitive { std::borrow::Cow::Borrowed(line) } else { std::borrow::Cow::Owned(line.to_lowercase()) };
                    let Some(at) = hay.find(&needle) else { continue };
                    let column = hay[..at].chars().count();
                    matches.push(Match { path: path.to_string(), line: index + 1, column: column + 1, preview: excerpt(line, column) });
                    in_file += 1;
                    if matches.len() >= SEARCH_MAX_MATCHES {
                        limit = Some("matches");
                        return false;
                    }
                    if in_file >= SEARCH_PER_FILE {
                        break;
                    }
                }
                true
            });
            Ok(Search { matches, files_scanned: scanned, files_skipped: skipped_files, directories: stats.directories, skipped: stats.skipped, truncated: limit.or(stats.truncated) })
        })
    }
}

#[tauri::command]
pub async fn folder_index(state: tauri::State<'_, FolderState>, session_id: String) -> Result<Index> {
    state.index(&session_id)
}
#[tauri::command]
pub async fn folder_search(state: tauri::State<'_, FolderState>, session_id: String, query: String, case_sensitive: bool) -> Result<Search> {
    state.search(&session_id, &query, case_sensitive)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn query_validation_and_excerpts() {
        for bad in ["", "   ", "a\nb", "a\0", &"x".repeat(QUERY_MAX_CHARS + 1)] {
            assert!(valid_query(bad).unwrap_err().starts_with("QUERY_REFUSED"), "{bad:?}");
        }
        assert!(valid_query("żółć 日本語").is_ok());
        assert_eq!(excerpt("\t  let x = 1;", 4), "let x = 1;");
        let long = format!("{}needle{}", "a".repeat(100), "b".repeat(300));
        let text = excerpt(&long, 100);
        assert!(text.starts_with('…') && text.ends_with('…') && text.contains("needle"));
        assert!(text.chars().count() <= PREVIEW_CHARS + 2);
    }
    #[cfg(windows)]
    #[test]
    fn native_index_and_search_are_bounded_and_confined() {
        let root = std::env::temp_dir().join(format!("melly-m09-{}", uuid::Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("melly-m09-outside-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(root.join("README.md"), "# Title\nneedle at root\n").unwrap();
        fs::write(root.join("src/main.ts"), "const a = 1;\r\nconst NEEDLE = 2; // Needle\r\n").unwrap();
        fs::write(root.join("src/deep/żółć 日本語.ts"), "// needle in unicode file\n").unwrap();
        fs::write(root.join("src/bin.dat"), b"needle\0binary").unwrap();
        fs::write(root.join("src/big.txt"), format!("needle{}", "x".repeat(SEARCH_FILE_BYTES as usize))).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "needle").unwrap();
        fs::write(outside.join("secret.txt"), "needle outside").unwrap();
        let junction = root.join("link");
        assert!(std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&junction).arg(&outside).output().unwrap().status.success());
        let state = FolderState::default();
        let id = state.selected(Some(root.clone())).unwrap().unwrap().session_id;

        let index = state.index(&id).unwrap();
        assert_eq!(index.files.first().map(String::as_str), Some("README.md"), "shallow files first");
        assert!(index.files.contains(&"src/deep/żółć 日本語.ts".to_string()));
        assert!(!index.files.iter().any(|f| f.starts_with("node_modules") || f.starts_with(".git") || f.starts_with("link")));
        assert!(index.skipped.contains(&"node_modules".to_string()) && index.skipped.contains(&".git".to_string()));
        assert!(index.blocked >= 1, "the junction is reported as blocked");
        assert!(index.truncated.is_none());

        let found = state.search(&id, "needle", false).unwrap();
        let paths: Vec<_> = found.matches.iter().map(|m| (m.path.as_str(), m.line)).collect();
        assert!(paths.contains(&("README.md", 2)) && paths.contains(&("src/main.ts", 2)) && paths.contains(&("src/deep/żółć 日本語.ts", 1)));
        assert!(!found.matches.iter().any(|m| m.path.contains("bin.dat") || m.path.contains("big.txt") || m.path.contains("node_modules") || m.path.starts_with("link")));
        assert!(found.files_skipped >= 2);
        assert_eq!(found.matches.iter().find(|m| m.path == "src/main.ts").unwrap().column, 7);
        let exact = state.search(&id, "NEEDLE", true).unwrap();
        assert_eq!(exact.matches.len(), 1);
        assert!(state.search(&id, "needle\nx", false).is_err());
        assert!(state.search("unknown", "needle", false).is_err());
        // Read-only: nothing in the folder changed.
        assert_eq!(fs::read_to_string(root.join("README.md")).unwrap(), "# Title\nneedle at root\n");
        fs::remove_dir(&junction).unwrap();
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
}
