//! MEGA-04 read-only helpers shared by Git inspection and Live Preview.
//! Every path is root-relative; symlinks and Windows reparse points are never followed.
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};
pub type Result<T> = std::result::Result<T, String>;
pub const MAX_DEPTH: usize = 32;

pub fn io_error(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "Missing file or directory.".into(),
        std::io::ErrorKind::PermissionDenied => {
            "Access denied. The item may be locked or unavailable to this Windows account.".into()
        }
        _ => format!("Local filesystem request failed (OS code {:?}).", e.raw_os_error()),
    }
}

/// Same rules as the M1.1 Local Folder boundary: no traversal, drive, device or ADS syntax.
pub fn rel_parts(relative: &str) -> Result<Vec<&str>> {
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
            || part.chars().any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
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

pub fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 || metadata.file_type().is_symlink()
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

/// Opens one item without following a final reparse point and denies delete/write sharing,
/// so a pinned directory cannot be swapped for a junction while it is held.
pub fn open_item(path: &Path) -> Result<fs::File> {
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .custom_flags(0x00200000 | 0x02000000)
            .open(path)
            .map_err(io_error)?
    };
    #[cfg(not(windows))]
    let file = {
        if is_link(&fs::symlink_metadata(path).map_err(io_error)?) {
            return Err("Symlinks and Windows reparse points are not supported.".into());
        }
        fs::File::open(path).map_err(io_error)?
    };
    let metadata = file.metadata().map_err(io_error)?;
    if is_link(&metadata) {
        return Err("Symlinks and Windows reparse points are not supported.".into());
    }
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("Unsupported filesystem item.".into());
    }
    Ok(file)
}

/// Pins the root and every relative ancestor, returning the final handle last.
pub fn open_pinned(root: &Path, relative: &str) -> Result<(PathBuf, Vec<fs::File>)> {
    let mut path = root.to_path_buf();
    let mut guards = vec![open_item(&path)?];
    for part in rel_parts(relative)? {
        path.push(part);
        guards.push(open_item(&path)?);
    }
    Ok((path, guards))
}

pub enum Loaded {
    Bytes(Vec<u8>),
    Missing,
}

/// Reads a regular file below root, bounded by `max` bytes.
pub fn read_limited(root: &Path, relative: &str, max: u64) -> Result<Loaded> {
    if rel_parts(relative)?.is_empty() {
        return Err("Select a file.".into());
    }
    let (_, guards) = match open_pinned(root, relative) {
        Ok(found) => found,
        Err(e) if e.starts_with("Missing") => return Ok(Loaded::Missing),
        Err(e) => return Err(e),
    };
    let file = guards.last().ok_or("Select a file.")?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() {
        return Err("Select a regular file.".into());
    }
    if metadata.len() > max {
        return Err(format!("File exceeds the {max} byte limit."));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(max + 1).read_to_end(&mut bytes).map_err(io_error)?;
    if bytes.len() as u64 > max {
        return Err(format!("File exceeds the {max} byte limit."));
    }
    Ok(Loaded::Bytes(bytes))
}

pub struct WalkItem<'a> {
    pub relative: &'a str,
    pub metadata: &'a fs::Metadata,
    pub blocked: bool,
}

/// Depth-first walk that holds a handle on every directory currently being listed.
/// `visit` returns false for a directory that must not be entered. Returns false when
/// the item limit stopped the walk early.
pub fn walk(root: &Path, limit: usize, visit: &mut dyn FnMut(WalkItem) -> bool) -> Result<bool> {
    fn inner(
        dir: &Path,
        prefix: &str,
        depth: usize,
        seen: &mut usize,
        limit: usize,
        visit: &mut dyn FnMut(WalkItem) -> bool,
    ) -> Result<bool> {
        let _pin = open_item(dir)?;
        let mut items = vec![];
        for item in fs::read_dir(dir).map_err(io_error)? {
            let item = item.map_err(io_error)?;
            let Ok(name) = item.file_name().into_string() else { continue };
            items.push((name, item.path()));
        }
        items.sort_by(|a, b| a.0.cmp(&b.0));
        for (name, path) in items {
            *seen += 1;
            if *seen > limit {
                return Ok(false);
            }
            let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
            let blocked = is_link(&metadata) || rel_parts(&relative).is_err();
            let enter = visit(WalkItem { relative: &relative, metadata: &metadata, blocked });
            if enter
                && !blocked
                && metadata.is_dir()
                && depth + 1 < MAX_DEPTH
                && !inner(&path, &relative, depth + 1, seen, limit, visit)?
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
    let mut seen = 0usize;
    inner(root, "", 0, &mut seen, limit, visit)
}
