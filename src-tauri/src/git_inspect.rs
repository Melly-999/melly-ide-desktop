//! MEGA-04 native read-only Git inspection. Parses `.git` directly and never spawns a
//! process, so hooks, fsmonitor, filter drivers, textconv, pagers and external diff
//! tools configured by a repository cannot run. No ref, index or object is written.
use crate::scoped_fs::{self, Loaded, Result};
use flate2::read::ZlibDecoder;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    io::{BufReader, Read, Seek, SeekFrom},
    path::Path,
    time::UNIX_EPOCH,
};

const MAX_OBJECT: usize = 32 * 1024 * 1024;
const MAX_INDEX: u64 = 128 * 1024 * 1024;
const MAX_SMALL: u64 = 1024 * 1024;
const MAX_WORKTREE_ITEMS: usize = 100_000;
const MAX_TREE_ENTRIES: usize = 200_000;
const MAX_REPORTED: usize = 5_000;
const MAX_DIFF_BYTES: usize = 4 * 1024 * 1024;
const MAX_DELTA_DEPTH: usize = 64;
const MAX_EDIT_DISTANCE: usize = 1_500;
const CONTEXT: usize = 3;
type Oid = [u8; 20];

fn hex(oid: &Oid) -> String {
    oid.iter().map(|b| format!("{b:02x}")).collect()
}
fn parse_hex(text: &str) -> Option<Oid> {
    let text = text.trim();
    if text.len() != 40 {
        return None;
    }
    let mut oid = [0u8; 20];
    for (i, byte) in oid.iter_mut().enumerate() {
        *byte = u8::from_str_radix(text.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(oid)
}
fn be32(data: &[u8], at: usize) -> Result<u32> {
    data.get(at..at + 4)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| "Corrupt Git data (truncated).".into())
}
fn blob_oid(content: &[u8]) -> Oid {
    let mut hash = sha1_smol::Sha1::new();
    hash.update(format!("blob {}\0", content.len()).as_bytes());
    hash.update(content);
    hash.digest().bytes()
}
fn crlf_to_lf(content: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len());
    for (i, b) in content.iter().enumerate() {
        if *b == b'\r' && content.get(i + 1) == Some(&b'\n') {
            continue;
        }
        out.push(*b);
    }
    out
}
fn inflate(reader: impl Read, limit: usize) -> Result<Vec<u8>> {
    let mut out = vec![];
    ZlibDecoder::new(reader)
        .take(limit as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|_| "Corrupt Git object (zlib).".to_string())?;
    if out.len() > limit {
        return Err("Git object exceeds the inspection size limit.".into());
    }
    Ok(out)
}

struct Pack {
    idx: Vec<u8>,
    count: usize,
    file: fs::File,
}
impl Pack {
    fn find(&self, oid: &Oid) -> Result<Option<u64>> {
        let fan = |i: usize| be32(&self.idx, 8 + i * 4).map(|v| v as usize);
        let first = oid[0] as usize;
        let (mut lo, mut hi) = (if first == 0 { 0 } else { fan(first - 1)? }, fan(first)?);
        while lo < hi {
            let mid = (lo + hi) / 2;
            let at = 1032 + mid * 20;
            let candidate = self.idx.get(at..at + 20).ok_or("Corrupt pack index.")?;
            match candidate.cmp(&oid[..]) {
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
                std::cmp::Ordering::Equal => {
                    let off = be32(&self.idx, 1032 + self.count * 24 + mid * 4)?;
                    if off & 0x8000_0000 == 0 {
                        return Ok(Some(off as u64));
                    }
                    let at = 1032 + self.count * 28 + (off & 0x7fff_ffff) as usize * 8;
                    let b = self.idx.get(at..at + 8).ok_or("Corrupt pack index.")?;
                    return Ok(Some(u64::from_be_bytes(b.try_into().unwrap())));
                }
            }
        }
        Ok(None)
    }
    fn read_at(&self, repo: &Repo, offset: u64, depth: usize) -> Result<(u8, Vec<u8>)> {
        if depth > MAX_DELTA_DEPTH {
            return Err("Git delta chain is too deep.".into());
        }
        let mut file = &self.file;
        file.seek(SeekFrom::Start(offset)).map_err(scoped_fs::io_error)?;
        let mut head = [0u8; 64];
        let got = file.read(&mut head).map_err(scoped_fs::io_error)?;
        let head = &head[..got];
        let mut pos = 0;
        let byte = |pos: &mut usize| -> Result<u8> {
            let b = *head.get(*pos).ok_or("Corrupt pack entry.")?;
            *pos += 1;
            Ok(b)
        };
        let mut c = byte(&mut pos)?;
        let kind = (c >> 4) & 7;
        let mut size = (c & 15) as usize;
        let mut shift = 4;
        while c & 0x80 != 0 {
            c = byte(&mut pos)?;
            size |= ((c & 0x7f) as usize) << shift;
            shift += 7;
            if shift > 56 {
                return Err("Corrupt pack entry.".into());
            }
        }
        if size > MAX_OBJECT {
            return Err("Git object exceeds the inspection size limit.".into());
        }
        let mut base = None;
        let mut base_oid = None;
        match kind {
            6 => {
                c = byte(&mut pos)?;
                let mut rel = (c & 0x7f) as u64;
                while c & 0x80 != 0 {
                    c = byte(&mut pos)?;
                    rel = ((rel + 1) << 7) | (c & 0x7f) as u64;
                }
                base = Some(offset.checked_sub(rel).ok_or("Corrupt pack delta.")?);
            }
            7 => {
                let b = head.get(pos..pos + 20).ok_or("Corrupt pack delta.")?;
                base_oid = Some(<Oid>::try_from(b).unwrap());
                pos += 20;
            }
            1..=4 => {}
            _ => return Err("Unsupported pack entry type.".into()),
        }
        file.seek(SeekFrom::Start(offset + pos as u64)).map_err(scoped_fs::io_error)?;
        let data = inflate(BufReader::new(file), size)?;
        if let Some(base) = base {
            let (kind, source) = self.read_at(repo, base, depth + 1)?;
            return Ok((kind, apply_delta(&source, &data)?));
        }
        if let Some(oid) = base_oid {
            let (kind, source) = repo.object_at_depth(&oid, depth + 1)?;
            return Ok((kind, apply_delta(&source, &data)?));
        }
        Ok((kind, data))
    }
}
fn apply_delta(base: &[u8], delta: &[u8]) -> Result<Vec<u8>> {
    let mut pos = 0;
    let varint = |pos: &mut usize| -> Result<usize> {
        let (mut value, mut shift) = (0usize, 0);
        loop {
            let b = *delta.get(*pos).ok_or("Corrupt delta.")?;
            *pos += 1;
            value |= ((b & 0x7f) as usize) << shift;
            shift += 7;
            if b & 0x80 == 0 || shift > 56 {
                return Ok(value);
            }
        }
    };
    if varint(&mut pos)? != base.len() {
        return Err("Corrupt delta (base size).".into());
    }
    let target = varint(&mut pos)?;
    if target > MAX_OBJECT {
        return Err("Git object exceeds the inspection size limit.".into());
    }
    let mut out = Vec::with_capacity(target);
    while pos < delta.len() {
        let op = delta[pos];
        pos += 1;
        if op & 0x80 != 0 {
            let (mut off, mut len) = (0usize, 0usize);
            for i in 0..4 {
                if op & (1 << i) != 0 {
                    off |= (*delta.get(pos).ok_or("Corrupt delta.")? as usize) << (i * 8);
                    pos += 1;
                }
            }
            for i in 0..3 {
                if op & (0x10 << i) != 0 {
                    len |= (*delta.get(pos).ok_or("Corrupt delta.")? as usize) << (i * 8);
                    pos += 1;
                }
            }
            if len == 0 {
                len = 0x10000;
            }
            out.extend_from_slice(base.get(off..off + len).ok_or("Corrupt delta (copy).")?);
        } else if op != 0 {
            let n = op as usize;
            out.extend_from_slice(delta.get(pos..pos + n).ok_or("Corrupt delta (insert).")?);
            pos += n;
        } else {
            return Err("Corrupt delta (opcode).".into());
        }
    }
    if out.len() != target {
        return Err("Corrupt delta (target size).".into());
    }
    Ok(out)
}

struct Repo<'a> {
    root: &'a Path,
    packs: Vec<Pack>,
    config: BTreeMap<String, String>,
    autocrlf: bool,
}
enum Opened<'a> {
    Repo(Repo<'a>),
    NotRepo(String),
}
impl<'a> Repo<'a> {
    fn read(&self, relative: &str, max: u64) -> Result<Option<Vec<u8>>> {
        match scoped_fs::read_limited(self.root, relative, max)? {
            Loaded::Bytes(b) => Ok(Some(b)),
            Loaded::Missing => Ok(None),
        }
    }
    fn open(root: &'a Path) -> Result<Opened<'a>> {
        let git = match fs::symlink_metadata(root.join(".git")) {
            Ok(m) => m,
            Err(_) => {
                return Ok(Opened::NotRepo(
                    "No .git directory at the selected folder root. Melly inspects only the selected folder and never reads parent directories.".into(),
                ))
            }
        };
        if scoped_fs::is_link(&git) {
            return Ok(Opened::NotRepo(".git is a link or reparse point and is not inspected.".into()));
        }
        if git.is_file() {
            return Ok(Opened::NotRepo(
                ".git is a gitfile (linked worktree or submodule) pointing elsewhere. Select the main repository folder.".into(),
            ));
        }
        let mut repo = Repo { root, packs: vec![], config: BTreeMap::new(), autocrlf: false };
        if repo.read(".git/HEAD", 4096)?.is_none() {
            return Ok(Opened::NotRepo(".git has no HEAD file; not a usable repository.".into()));
        }
        if let Some(text) = repo.read(".git/config", MAX_SMALL)? {
            repo.config = parse_config(&String::from_utf8_lossy(&text));
        }
        repo.autocrlf = matches!(
            repo.config.get("core.autocrlf").map(|v| v.to_ascii_lowercase()).as_deref(),
            Some("true" | "input")
        );
        if let Ok(entries) = fs::read_dir(root.join(".git/objects/pack")) {
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter(|n| n.starts_with("pack-") && n.ends_with(".idx"))
                .collect();
            names.sort();
            for name in names {
                let idx = repo
                    .read(&format!(".git/objects/pack/{name}"), 512 * 1024 * 1024)?
                    .ok_or("Pack index disappeared during inspection.")?;
                if idx.get(..8) != Some(&[0xff, b't', b'O', b'c', 0, 0, 0, 2][..]) {
                    return Err("Unsupported pack index version (only v2 is supported).".into());
                }
                let count = be32(&idx, 8 + 255 * 4)? as usize;
                let pack = name.trim_end_matches(".idx").to_string() + ".pack";
                let (_, mut guards) = scoped_fs::open_pinned(root, &format!(".git/objects/pack/{pack}"))?;
                let file = guards.pop().ok_or("Pack file unavailable.")?;
                repo.packs.push(Pack { idx, count, file });
            }
        }
        Ok(Opened::Repo(repo))
    }
    fn object(&self, oid: &Oid) -> Result<(u8, Vec<u8>)> {
        self.object_at_depth(oid, 0)
    }
    fn object_at_depth(&self, oid: &Oid, depth: usize) -> Result<(u8, Vec<u8>)> {
        let h = hex(oid);
        if let Some(raw) = self.read(&format!(".git/objects/{}/{}", &h[..2], &h[2..]), MAX_OBJECT as u64)? {
            let data = inflate(&raw[..], MAX_OBJECT + 64)?;
            let nul = data.iter().position(|b| *b == 0).ok_or("Corrupt loose object.")?;
            let header = std::str::from_utf8(&data[..nul]).map_err(|_| "Corrupt loose object.")?;
            let kind = match header.split(' ').next() {
                Some("commit") => 1,
                Some("tree") => 2,
                Some("blob") => 3,
                Some("tag") => 4,
                _ => return Err("Unknown loose object type.".into()),
            };
            return Ok((kind, data[nul + 1..].to_vec()));
        }
        for pack in &self.packs {
            if let Some(offset) = pack.find(oid)? {
                return pack.read_at(self, offset, depth);
            }
        }
        Err(format!(
            "Git object {} not found (alternates and promisor remotes are not read).",
            &h[..12]
        ))
    }
    fn blob(&self, oid: &Oid) -> Result<Vec<u8>> {
        match self.object(oid)? {
            (3, data) => Ok(data),
            _ => Err("Expected a Git blob.".into()),
        }
    }
    fn resolve_ref(&self, name: &str, depth: usize) -> Result<Option<Oid>> {
        if depth > 5 || scoped_fs::rel_parts(name).is_err() {
            return Ok(None);
        }
        if let Some(text) = self.read(&format!(".git/{name}"), 4096)? {
            let text = String::from_utf8_lossy(&text);
            if let Some(target) = text.trim().strip_prefix("ref: ") {
                return self.resolve_ref(target.trim(), depth + 1);
            }
            return Ok(parse_hex(&text));
        }
        if let Some(packed) = self.read(".git/packed-refs", 64 * 1024 * 1024)? {
            for line in String::from_utf8_lossy(&packed).lines() {
                if line.starts_with('#') || line.starts_with('^') {
                    continue;
                }
                if let Some((oid, refname)) = line.split_once(' ') {
                    if refname.trim() == name {
                        return Ok(parse_hex(oid));
                    }
                }
            }
        }
        Ok(None)
    }
    fn head(&self) -> Result<Head> {
        let text = String::from_utf8_lossy(&self.read(".git/HEAD", 4096)?.unwrap_or_default()).trim().to_string();
        let mut head = Head::default();
        let oid = if let Some(target) = text.strip_prefix("ref: ") {
            head.branch = Some(target.trim_start_matches("refs/heads/").to_string());
            let oid = self.resolve_ref(target, 0)?;
            head.unborn = oid.is_none();
            oid
        } else {
            head.detached = true;
            Some(parse_hex(&text).ok_or("HEAD is neither a ref nor an object id.")?)
        };
        if let Some(oid) = oid {
            head.oid = Some(hex(&oid));
            head.short = Some(hex(&oid)[..7].to_string());
            if let Ok((1, data)) = self.object(&oid) {
                let text = String::from_utf8_lossy(&data);
                let (headers, message) = text.split_once("\n\n").unwrap_or((&text, ""));
                head.summary = message.lines().next().map(|l| l.chars().take(200).collect());
                for line in headers.lines() {
                    if let Some(rest) = line.strip_prefix("author ") {
                        if let Some(end) = rest.rfind('>') {
                            head.author = rest[..end].split(" <").next().map(str::to_string);
                            head.time = rest[end + 1..].split_whitespace().next().and_then(|t| t.parse().ok());
                        }
                    }
                }
            }
        }
        Ok(head)
    }
    fn head_tree(&self, head: &Head) -> Result<BTreeMap<String, (u32, Oid)>> {
        let mut out = BTreeMap::new();
        let Some(oid) = head.oid.as_deref().and_then(parse_hex) else { return Ok(out) };
        let (kind, data) = self.object(&oid)?;
        if kind != 1 {
            return Err("HEAD does not point to a commit.".into());
        }
        let tree = String::from_utf8_lossy(&data)
            .lines()
            .next()
            .and_then(|l| l.strip_prefix("tree "))
            .and_then(parse_hex)
            .ok_or("Commit has no tree.")?;
        self.flatten(&tree, "", &mut out, 0)?;
        Ok(out)
    }
    fn flatten(&self, tree: &Oid, prefix: &str, out: &mut BTreeMap<String, (u32, Oid)>, depth: usize) -> Result<()> {
        if depth > 64 {
            return Err("Git tree is too deep.".into());
        }
        let (kind, data) = self.object(tree)?;
        if kind != 2 {
            return Err("Expected a Git tree.".into());
        }
        let mut pos = 0;
        while pos < data.len() {
            let space = data[pos..].iter().position(|b| *b == b' ').ok_or("Corrupt tree.")? + pos;
            let nul = data[space..].iter().position(|b| *b == 0).ok_or("Corrupt tree.")? + space;
            let mode = u32::from_str_radix(std::str::from_utf8(&data[pos..space]).map_err(|_| "Corrupt tree.")?, 8)
                .map_err(|_| "Corrupt tree.")?;
            let name = String::from_utf8_lossy(&data[space + 1..nul]);
            let oid: Oid = data.get(nul + 1..nul + 21).ok_or("Corrupt tree.")?.try_into().unwrap();
            pos = nul + 21;
            let path = if prefix.is_empty() { name.to_string() } else { format!("{prefix}/{name}") };
            if mode == 0o40000 {
                self.flatten(&oid, &path, out, depth + 1)?;
            } else {
                out.insert(path, (mode, oid));
                if out.len() > MAX_TREE_ENTRIES {
                    return Err("HEAD tree exceeds 200000 entries.".into());
                }
            }
        }
        Ok(())
    }
}

fn parse_config(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut section = String::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(inner) = line.strip_prefix('[').and_then(|l| l.split(']').next()) {
            section = match inner.split_once(' ') {
                Some((name, sub)) => format!("{}.{}", name.to_ascii_lowercase(), sub.trim().trim_matches('"')),
                None => inner.to_ascii_lowercase(),
            };
            continue;
        }
        let (key, value) = line.split_once('=').unwrap_or((line, "true"));
        out.insert(format!("{section}.{}", key.trim().to_ascii_lowercase()), value.trim().trim_matches('"').to_string());
    }
    out
}

struct IndexEntry {
    path: String,
    mtime_s: u32,
    mtime_ns: u32,
    size: u32,
    mode: u32,
    oid: Oid,
    stage: u8,
    skip_worktree: bool,
    intent_to_add: bool,
}
fn parse_index(data: &[u8]) -> Result<Vec<IndexEntry>> {
    if data.len() < 32 || &data[..4] != b"DIRC" {
        return Err("Corrupt Git index (signature).".into());
    }
    let body = data.len() - 20;
    if sha1_smol::Sha1::from(&data[..body]).digest().bytes()[..] != data[body..] {
        return Err("Git index checksum mismatch. The index may be in use; refresh and retry.".into());
    }
    let version = be32(data, 4)?;
    if !(2..=4).contains(&version) {
        return Err("Unsupported Git index version.".into());
    }
    let count = be32(data, 8)? as usize;
    let mut out = Vec::with_capacity(count.min(1 << 20));
    let mut pos = 12;
    let mut previous: Vec<u8> = vec![];
    for _ in 0..count {
        let start = pos;
        if pos + 62 > body {
            return Err("Corrupt Git index (entry).".into());
        }
        let flags = u16::from_be_bytes([data[pos + 60], data[pos + 61]]);
        let mut extended = 0u16;
        pos += 62;
        if version >= 3 && flags & 0x4000 != 0 {
            extended = u16::from_be_bytes([*data.get(pos).ok_or("Corrupt Git index.")?, *data.get(pos + 1).ok_or("Corrupt Git index.")?]);
            pos += 2;
        }
        let name: Vec<u8> = if version == 4 {
            let mut c = *data.get(pos).ok_or("Corrupt Git index.")?;
            pos += 1;
            let mut strip = (c & 0x7f) as usize;
            while c & 0x80 != 0 {
                c = *data.get(pos).ok_or("Corrupt Git index.")?;
                pos += 1;
                strip = ((strip + 1) << 7) | (c & 0x7f) as usize;
            }
            let nul = data[pos..body].iter().position(|b| *b == 0).ok_or("Corrupt Git index.")? + pos;
            let keep = previous.len().checked_sub(strip).ok_or("Corrupt Git index (prefix).")?;
            let mut name = previous[..keep].to_vec();
            name.extend_from_slice(&data[pos..nul]);
            pos = nul + 1;
            name
        } else {
            let nul = data[pos..body].iter().position(|b| *b == 0).ok_or("Corrupt Git index.")? + pos;
            let name = data[pos..nul].to_vec();
            pos = start + ((pos - start + name.len() + 8) & !7);
            name
        };
        previous = name.clone();
        out.push(IndexEntry {
            path: String::from_utf8_lossy(&name).into_owned(),
            mtime_s: be32(data, start + 8)?,
            mtime_ns: be32(data, start + 12)?,
            mode: be32(data, start + 24)?,
            size: be32(data, start + 36)?,
            oid: data[start + 40..start + 60].try_into().unwrap(),
            stage: ((flags >> 12) & 3) as u8,
            skip_worktree: extended & 0x4000 != 0,
            intent_to_add: extended & 0x2000 != 0,
        });
    }
    while pos + 8 <= body {
        let signature = &data[pos..pos + 4];
        if signature == b"link" {
            return Err("Split Git index is not supported yet.".into());
        }
        if signature == b"sdir" {
            return Err("Sparse Git index is not supported yet.".into());
        }
        pos += 8 + be32(data, pos + 4)? as usize;
    }
    Ok(out)
}

/// Gitignore matching: last match wins, directories excluded by a parent stay excluded.
struct Rule {
    base: String,
    pattern: String,
    negate: bool,
    dir_only: bool,
    anchored: bool,
}
#[derive(Default)]
struct Ignore {
    rules: Vec<Rule>,
}
impl Ignore {
    fn add(&mut self, base: &str, text: &str) {
        for raw in text.lines() {
            let mut line = raw.trim_end_matches('\r');
            if !line.ends_with("\\ ") {
                line = line.trim_end();
            }
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let negate = line.starts_with('!');
            let mut pattern = line.strip_prefix('!').unwrap_or(line);
            if pattern.starts_with("\\#") || pattern.starts_with("\\!") {
                pattern = &pattern[1..];
            }
            let dir_only = pattern.ends_with('/');
            let pattern = pattern.trim_end_matches('/');
            let anchored = pattern.contains('/');
            let pattern = pattern.trim_start_matches('/');
            if pattern.is_empty() {
                continue;
            }
            self.rules.push(Rule { base: base.into(), pattern: pattern.into(), negate, dir_only, anchored });
        }
    }
    fn ignored(&self, relative: &str, is_dir: bool) -> bool {
        let mut result = false;
        for rule in &self.rules {
            let sub = if rule.base.is_empty() {
                relative
            } else if let Some(sub) = relative.strip_prefix(rule.base.as_str()).and_then(|s| s.strip_prefix('/')) {
                sub
            } else {
                continue;
            };
            if rule.dir_only && !is_dir {
                continue;
            }
            let target = if rule.anchored { sub } else { sub.rsplit('/').next().unwrap_or(sub) };
            if wildmatch(rule.pattern.as_bytes(), target.as_bytes()) {
                result = !rule.negate;
            }
        }
        result
    }
}
fn wildmatch(p: &[u8], t: &[u8]) -> bool {
    if p.is_empty() {
        return t.is_empty();
    }
    if p.starts_with(b"**") {
        let rest = &p[2..];
        let rest = rest.strip_prefix(b"/").unwrap_or(rest);
        if rest.is_empty() {
            return true;
        }
        if wildmatch(rest, t) {
            return true;
        }
        return t.iter().enumerate().any(|(i, c)| *c == b'/' && wildmatch(rest, &t[i + 1..]));
    }
    match p[0] {
        b'*' => (0..=t.len()).take_while(|&i| i == 0 || t[i - 1] != b'/').any(|i| wildmatch(&p[1..], &t[i..])),
        b'?' => !t.is_empty() && t[0] != b'/' && wildmatch(&p[1..], &t[1..]),
        b'[' => {
            let Some(close) = p.iter().skip(2).position(|c| *c == b']').map(|i| i + 2) else {
                return !t.is_empty() && t[0] == b'[' && wildmatch(&p[1..], &t[1..]);
            };
            if t.is_empty() || t[0] == b'/' {
                return false;
            }
            let set = &p[1..close];
            let (negated, set) = match set.first() {
                Some(b'!' | b'^') => (true, &set[1..]),
                _ => (false, set),
            };
            let mut hit = false;
            let mut i = 0;
            while i < set.len() {
                if i + 2 < set.len() && set[i + 1] == b'-' {
                    hit |= set[i] <= t[0] && t[0] <= set[i + 2];
                    i += 3;
                } else {
                    hit |= set[i] == t[0];
                    i += 1;
                }
            }
            hit != negated && wildmatch(&p[close + 1..], &t[1..])
        }
        b'\\' if p.len() > 1 => !t.is_empty() && t[0] == p[1] && wildmatch(&p[2..], &t[1..]),
        c => !t.is_empty() && t[0] == c && wildmatch(&p[1..], &t[1..]),
    }
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    pub branch: Option<String>,
    pub detached: bool,
    pub unborn: bool,
    pub oid: Option<String>,
    pub short: Option<String>,
    pub summary: Option<String>,
    pub author: Option<String>,
    pub time: Option<i64>,
}
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub x: String,
    pub y: String,
    pub kind: &'static str,
}
#[derive(Serialize, Default, Debug)]
pub struct Counts {
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub conflicted: usize,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repository: bool,
    pub reason: Option<String>,
    pub root_name: String,
    pub head: Option<Head>,
    pub entries: Vec<StatusEntry>,
    pub counts: Counts,
    pub notices: Vec<String>,
    pub truncated: bool,
    pub renames: Vec<Rename>,
    pub engine: &'static str,
}

fn security_notices(repo: &Repo) -> Vec<String> {
    let mut notices = vec![];
    let risky: Vec<&String> = repo
        .config
        .keys()
        .filter(|k| {
            ["core.fsmonitor", "core.hookspath", "core.pager", "core.editor", "core.sshcommand", "diff.external"].contains(&k.as_str())
                || (k.starts_with("filter.") && [".clean", ".smudge", ".process"].iter().any(|s| k.ends_with(s)))
                || (k.starts_with("diff.") && (k.ends_with(".textconv") || k.ends_with(".command")))
        })
        .collect();
    if !risky.is_empty() {
        notices.push(format!(
            "Repository config defines executable settings ({}). Melly never runs them; inspection is native and read-only.",
            risky.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(", ")
        ));
    }
    if let Ok(hooks) = fs::read_dir(repo.root.join(".git/hooks")) {
        let mut names: Vec<String> = hooks
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| !n.ends_with(".sample"))
            .collect();
        names.sort();
        if !names.is_empty() {
            notices.push(format!("{} Git hook(s) present ({}). Hooks are never executed by Melly.", names.len(), names.join(", ")));
        }
    }
    if repo.root.join(".git/objects/info/alternates").exists() {
        notices.push("Object alternates outside the selected folder are configured and are not read.".into());
    }
    notices
}

fn stat_matches(entry: &IndexEntry, metadata: &fs::Metadata, index_mtime: u64) -> bool {
    let Ok(modified) = metadata.modified() else { return false };
    let Ok(since) = modified.duration_since(UNIX_EPOCH) else { return false };
    metadata.len() as u32 == entry.size
        && since.as_secs() as u32 == entry.mtime_s
        && since.subsec_nanos() == entry.mtime_ns
        && (entry.mtime_s as u64) < index_mtime
}

/// Read-only status of the repository whose `.git` directory sits at `root`.
pub fn inspect(root: &Path) -> Result<GitStatus> {
    let root_name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let repo = match Repo::open(root)? {
        Opened::Repo(repo) => repo,
        Opened::NotRepo(reason) => {
            return Ok(GitStatus {
                repository: false,
                reason: Some(reason),
                root_name,
                head: None,
                entries: vec![],
                counts: Counts::default(),
                notices: vec![],
                truncated: false,
                renames: vec![],
                engine: "native-readonly",
            })
        }
    };
    let mut notices = security_notices(&repo);
    let head = repo.head()?;
    let tree = repo.head_tree(&head)?;
    let index_mtime = fs::metadata(root.join(".git/index"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let entries = match repo.read(".git/index", MAX_INDEX)? {
        Some(data) => parse_index(&data)?,
        None => vec![],
    };
    let mut status: BTreeMap<String, (char, char, &'static str)> = BTreeMap::new();
    let mut stage0: HashMap<&str, &IndexEntry> = HashMap::new();
    let mut conflicted: BTreeSet<&str> = BTreeSet::new();
    for entry in &entries {
        if entry.stage == 0 {
            stage0.insert(&entry.path, entry);
        } else {
            conflicted.insert(&entry.path);
        }
    }
    for path in &conflicted {
        status.insert(path.to_string(), ('U', 'U', "conflicted"));
    }
    for (path, entry) in &stage0 {
        if entry.intent_to_add {
            status.insert(path.to_string(), (' ', 'A', "added"));
            continue;
        }
        match tree.get(*path) {
            None => {
                status.insert(path.to_string(), ('A', ' ', "added"));
            }
            Some((mode, oid)) if *oid != entry.oid || *mode != entry.mode => {
                status.insert(path.to_string(), ('M', ' ', "modified"));
            }
            _ => {}
        }
    }
    for path in tree.keys() {
        if !stage0.contains_key(path.as_str()) && !conflicted.contains(path.as_str()) {
            status.insert(path.clone(), ('D', ' ', "deleted"));
        }
    }
    let mut tracked_dirs: HashSet<String> = HashSet::new();
    for path in stage0.keys().chain(conflicted.iter()) {
        let mut dir = *path;
        while let Some((parent, _)) = dir.rsplit_once('/') {
            if !tracked_dirs.insert(parent.to_string()) {
                break;
            }
            dir = parent;
        }
    }
    let mut ignore = Ignore::default();
    if let Some(text) = repo.read(".git/info/exclude", MAX_SMALL)? {
        ignore.add("", &String::from_utf8_lossy(&text));
    }
    if let Some(text) = repo.read(".gitignore", MAX_SMALL)? {
        ignore.add("", &String::from_utf8_lossy(&text));
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut ignored_dirs: HashSet<String> = HashSet::new();
    let mut untracked: Vec<(String, &'static str)> = vec![];
    let mut blocked = 0usize;
    let mut submodules = 0usize;
    let mut failure: Option<String> = None;
    let complete = scoped_fs::walk(root, MAX_WORKTREE_ITEMS, &mut |item| {
        if failure.is_some() {
            return false;
        }
        let relative = item.relative;
        if relative == ".git" {
            return false;
        }
        let parent = relative.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        let inside_ignored = ignored_dirs.contains(parent);
        if item.blocked {
            blocked += 1;
            return false;
        }
        if item.metadata.is_dir() {
            if stage0.get(relative).is_some_and(|e| e.mode == 0o160000) {
                submodules += 1;
                seen.insert(relative.to_string());
                return false;
            }
            if fs::symlink_metadata(root.join(relative).join(".git")).is_ok() {
                if !tracked_dirs.contains(relative) && !inside_ignored && !ignore.ignored(relative, true) {
                    untracked.push((format!("{relative}/"), "nested-repository"));
                }
                return false;
            }
            let ignored = inside_ignored || ignore.ignored(relative, true);
            if ignored && !tracked_dirs.contains(relative) {
                return false;
            }
            if ignored {
                ignored_dirs.insert(relative.to_string());
            }
            match repo.read(&format!("{relative}/.gitignore"), MAX_SMALL) {
                Ok(Some(text)) => ignore.add(relative, &String::from_utf8_lossy(&text)),
                Ok(None) => {}
                Err(e) => failure = Some(e),
            }
            return true;
        }
        match stage0.get(relative) {
            Some(entry) => {
                seen.insert(relative.to_string());
                if entry.intent_to_add || entry.mode == 0o160000 {
                    return false;
                }
                if stat_matches(entry, item.metadata, index_mtime) {
                    return false;
                }
                let changed = match repo.read(relative, MAX_OBJECT as u64) {
                    Ok(Some(content)) => {
                        blob_oid(&content) != entry.oid
                            && !(repo.autocrlf && blob_oid(&crlf_to_lf(&content)) == entry.oid)
                    }
                    Ok(None) => true,
                    Err(_) => true,
                };
                if changed {
                    let current = status.get(relative).copied().unwrap_or((' ', ' ', "modified"));
                    status.insert(relative.to_string(), (current.0, 'M', "modified"));
                }
            }
            None if conflicted.contains(relative) => {
                seen.insert(relative.to_string());
            }
            None => {
                if !inside_ignored && !ignore.ignored(relative, false) {
                    untracked.push((relative.to_string(), "untracked"));
                }
            }
        }
        false
    })?;
    if let Some(e) = failure {
        return Err(e);
    }
    for (path, entry) in &stage0 {
        if !seen.contains(*path) && !entry.skip_worktree && !entry.intent_to_add && complete {
            let current = status.get(*path).copied().unwrap_or((' ', ' ', "deleted"));
            status.insert(path.to_string(), (current.0, 'D', if current.0 == ' ' { "deleted" } else { current.2 }));
        }
    }
    for (path, kind) in untracked {
        status.insert(path, ('?', '?', kind));
    }
    let renames = exact_renames(&repo, &status, &tree, &stage0);
    if !complete {
        notices.push(format!("Working tree exceeds {MAX_WORKTREE_ITEMS} items; unstaged and untracked results are partial."));
    }
    if blocked > 0 {
        notices.push(format!("{blocked} link, reparse point or unsupported name(s) were not inspected."));
    }
    if submodules > 0 {
        notices.push(format!("{submodules} submodule(s) are listed but their contents are not inspected."));
    }
    let mut counts = Counts::default();
    let mut list = vec![];
    for (path, (x, y, kind)) in &status {
        match (x, y) {
            ('?', '?') => counts.untracked += 1,
            ('U', _) => counts.conflicted += 1,
            _ => {
                if *x != ' ' {
                    counts.staged += 1;
                }
                if *y != ' ' {
                    counts.unstaged += 1;
                }
            }
        }
        if list.len() < MAX_REPORTED {
            list.push(StatusEntry { path: path.clone(), x: x.to_string(), y: y.to_string(), kind });
        }
    }
    Ok(GitStatus {
        repository: true,
        reason: None,
        root_name,
        head: Some(head),
        truncated: status.len() > MAX_REPORTED || !complete,
        entries: list,
        counts,
        notices,
        renames,
        engine: "native-readonly",
    })
}

/// MEGA-08: pairs deletions with additions whose content is byte-identical (Git's 100% rename
/// case). Staged: HEAD blob = index blob. Unstaged: index blob = untracked file content. Entries
/// keep their D / A / ? status (porcelain `status.renames=false` parity); this is extra context.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rename {
    pub from: String,
    pub to: String,
    pub staged: bool,
    pub similarity: &'static str,
}
const MAX_RENAME_CANDIDATES: usize = 200;
fn exact_renames(
    repo: &Repo,
    status: &BTreeMap<String, (char, char, &'static str)>,
    tree: &BTreeMap<String, (u32, Oid)>,
    stage0: &HashMap<&str, &IndexEntry>,
) -> Vec<Rename> {
    let mut renames = vec![];
    let deleted: Vec<(&String, Oid)> = status.iter().filter(|(_, s)| s.0 == 'D').filter_map(|(p, _)| tree.get(p).map(|(_, oid)| (p, *oid))).collect();
    let mut used: HashSet<&String> = HashSet::new();
    for (path, _) in status.iter().filter(|(_, s)| s.0 == 'A') {
        let Some(entry) = stage0.get(path.as_str()) else { continue };
        if let Some((from, _)) = deleted.iter().find(|(from, oid)| *oid == entry.oid && !used.contains(from)) {
            used.insert(from);
            renames.push(Rename { from: (*from).clone(), to: path.clone(), staged: true, similarity: "exact" });
        }
    }
    let missing: Vec<(&String, Oid)> = status.iter().filter(|(_, s)| s.1 == 'D').filter_map(|(p, _)| stage0.get(p.as_str()).map(|e| (p, e.oid))).collect();
    if missing.is_empty() {
        return renames;
    }
    for (path, _) in status.iter().filter(|(_, s)| s.0 == '?' && s.2 == "untracked").take(MAX_RENAME_CANDIDATES) {
        let Ok(Some(content)) = repo.read(path, MAX_SMALL) else { continue };
        let oids = [blob_oid(&content), if repo.autocrlf { blob_oid(&crlf_to_lf(&content)) } else { blob_oid(&content) }];
        if let Some((from, _)) = missing.iter().find(|(from, oid)| oids.contains(oid) && !used.contains(from)) {
            used.insert(from);
            renames.push(Rename { from: (*from).clone(), to: path.clone(), staged: false, similarity: "exact" });
        }
    }
    renames
}

/// MEGA-08 per-file line counts for the review list (bounded; each item is a real diff).
#[derive(serde::Deserialize, Debug)]
pub struct SummaryItem {
    pub path: String,
    pub staged: bool,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRow {
    pub path: String,
    pub staged: bool,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
    pub approximate: bool,
    pub error: Option<String>,
}
pub const MAX_SUMMARY: usize = 200;
pub fn diff_summary(root: &Path, items: &[SummaryItem]) -> Result<Vec<SummaryRow>> {
    if items.len() > MAX_SUMMARY {
        return Err(format!("At most {MAX_SUMMARY} files per summary."));
    }
    Ok(items
        .iter()
        .map(|item| match diff(root, &item.path, item.staged) {
            Ok(d) => SummaryRow { path: item.path.clone(), staged: item.staged, additions: d.additions, deletions: d.deletions, binary: d.binary, approximate: d.approximate, error: None },
            Err(e) => SummaryRow { path: item.path.clone(), staged: item.staged, additions: 0, deletions: 0, binary: false, approximate: false, error: Some(e) },
        })
        .collect())
}

#[derive(Serialize, Debug)]
pub struct Line {
    pub kind: &'static str,
    pub text: String,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub lines: Vec<Line>,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    pub path: String,
    pub staged: bool,
    pub old_label: String,
    pub new_label: String,
    pub binary: bool,
    pub approximate: bool,
    pub lossy: bool,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Vec<Hunk>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Op {
    Equal(usize, usize),
    Delete(usize),
    Insert(usize),
}
fn myers(a: &[&str], b: &[&str]) -> Option<Vec<Op>> {
    let (n, m) = (a.len() as isize, b.len() as isize);
    let cap = ((n + m) as usize).min(MAX_EDIT_DISTANCE) as isize;
    let off = cap + 1;
    let mut v = vec![0isize; (2 * off + 1) as usize];
    let mut trace: Vec<Vec<isize>> = vec![];
    for d in 0..=cap {
        trace.push(v[(off - d - 1).max(0) as usize..=(off + d + 1) as usize].to_vec());
        let mut k = -d;
        while k <= d {
            let at = |k: isize| (off + k) as usize;
            let mut x = if k == -d || (k != d && v[at(k - 1)] < v[at(k + 1)]) { v[at(k + 1)] } else { v[at(k - 1)] + 1 };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[at(k)] = x;
            if x >= n && y >= m {
                let mut ops = vec![];
                let (mut x, mut y) = (n, m);
                for d in (1..=d).rev() {
                    let snap = &trace[d as usize];
                    let base = off - d - 1;
                    let get = |k: isize| snap[(off + k - base.max(0)) as usize];
                    let k = x - y;
                    let prev_k = if k == -d || (k != d && get(k - 1) < get(k + 1)) { k + 1 } else { k - 1 };
                    let prev_x = get(prev_k);
                    let prev_y = prev_x - prev_k;
                    while x > prev_x && y > prev_y {
                        ops.push(Op::Equal((x - 1) as usize, (y - 1) as usize));
                        x -= 1;
                        y -= 1;
                    }
                    if x == prev_x {
                        ops.push(Op::Insert((y - 1) as usize));
                    } else {
                        ops.push(Op::Delete((x - 1) as usize));
                    }
                    x = prev_x;
                    y = prev_y;
                }
                while x > 0 && y > 0 {
                    ops.push(Op::Equal((x - 1) as usize, (y - 1) as usize));
                    x -= 1;
                    y -= 1;
                }
                ops.reverse();
                return Some(ops);
            }
            k += 2;
        }
    }
    None
}
fn edit_script(a: &[&str], b: &[&str]) -> (Vec<Op>, bool) {
    let prefix = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let suffix = a[prefix..].iter().rev().zip(b[prefix..].iter().rev()).take_while(|(x, y)| x == y).count();
    let (am, bm) = (&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    let mut ops: Vec<Op> = (0..prefix).map(|i| Op::Equal(i, i)).collect();
    let (middle, approximate) = match myers(am, bm) {
        Some(ops) => (ops, false),
        None => ((0..am.len()).map(Op::Delete).chain((0..bm.len()).map(Op::Insert)).collect(), true),
    };
    for op in middle {
        ops.push(match op {
            Op::Equal(x, y) => Op::Equal(x + prefix, y + prefix),
            Op::Delete(x) => Op::Delete(x + prefix),
            Op::Insert(y) => Op::Insert(y + prefix),
        });
    }
    for i in 0..suffix {
        ops.push(Op::Equal(a.len() - suffix + i, b.len() - suffix + i));
    }
    (ops, approximate)
}
fn hunks(a: &[&str], b: &[&str], ops: &[Op]) -> Vec<Hunk> {
    let changes: Vec<usize> = ops.iter().enumerate().filter(|(_, op)| !matches!(op, Op::Equal(..))).map(|(i, _)| i).collect();
    let mut ranges: Vec<(usize, usize)> = vec![];
    for i in changes {
        let (start, end) = (i.saturating_sub(CONTEXT), (i + CONTEXT + 1).min(ops.len()));
        match ranges.last_mut() {
            Some(last) if start <= last.1 => last.1 = end,
            _ => ranges.push((start, end)),
        }
    }
    let mut old_at = vec![0usize; ops.len() + 1];
    let mut new_at = vec![0usize; ops.len() + 1];
    for (i, op) in ops.iter().enumerate() {
        old_at[i + 1] = old_at[i] + usize::from(!matches!(op, Op::Insert(_)));
        new_at[i + 1] = new_at[i] + usize::from(!matches!(op, Op::Delete(_)));
    }
    ranges
        .into_iter()
        .map(|(start, end)| {
            let lines = ops[start..end]
                .iter()
                .map(|op| match *op {
                    Op::Equal(x, _) => Line { kind: "context", text: a[x].to_string() },
                    Op::Delete(x) => Line { kind: "del", text: a[x].to_string() },
                    Op::Insert(y) => Line { kind: "add", text: b[y].to_string() },
                })
                .collect();
            let (old_lines, new_lines) = (old_at[end] - old_at[start], new_at[end] - new_at[start]);
            Hunk {
                old_start: if old_lines == 0 { old_at[start] } else { old_at[start] + 1 },
                old_lines,
                new_start: if new_lines == 0 { new_at[start] } else { new_at[start] + 1 },
                new_lines,
                lines,
            }
        })
        .collect()
}
fn split_lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').map(|l| l.strip_suffix('\n').unwrap_or(l)).collect()
}
pub fn diff_text(path: &str, staged: bool, old: Option<&[u8]>, new: Option<&[u8]>, old_label: String, new_label: String) -> Diff {
    let (old, new) = (old.unwrap_or_default(), new.unwrap_or_default());
    let binary = [old, new].iter().any(|bytes| bytes[..bytes.len().min(8000)].contains(&0));
    let mut diff = Diff { path: path.into(), staged, old_label, new_label, binary, approximate: false, lossy: false, additions: 0, deletions: 0, hunks: vec![] };
    if binary || old == new {
        return diff;
    }
    if old.len() > MAX_DIFF_BYTES || new.len() > MAX_DIFF_BYTES {
        diff.approximate = true;
        return diff;
    }
    diff.lossy = std::str::from_utf8(old).is_err() || std::str::from_utf8(new).is_err();
    let (old, new) = (String::from_utf8_lossy(old), String::from_utf8_lossy(new));
    let (a, b) = (split_lines(&old), split_lines(&new));
    let (ops, approximate) = edit_script(&a, &b);
    diff.approximate = approximate;
    diff.deletions = ops.iter().filter(|op| matches!(op, Op::Delete(_))).count();
    diff.additions = ops.iter().filter(|op| matches!(op, Op::Insert(_))).count();
    diff.hunks = hunks(&a, &b, &ops);
    diff
}

/// Real diff for one path: staged = HEAD → index, unstaged = index → working tree.
pub fn diff(root: &Path, path: &str, staged: bool) -> Result<Diff> {
    let parts = scoped_fs::rel_parts(path)?;
    if parts.is_empty() || parts[0] == ".git" {
        return Err("Select a working-tree file. .git internals are not diffed.".into());
    }
    let repo = match Repo::open(root)? {
        Opened::Repo(repo) => repo,
        Opened::NotRepo(reason) => return Err(reason),
    };
    let head = repo.head()?;
    let tree = repo.head_tree(&head)?;
    let index = match repo.read(".git/index", MAX_INDEX)? {
        Some(data) => parse_index(&data)?,
        None => vec![],
    };
    let indexed = index.iter().find(|e| e.path == path && e.stage == 0);
    if index.iter().any(|e| e.path == path && e.stage > 0) {
        return Err("Path has unresolved merge conflicts; conflict diffs are not supported yet.".into());
    }
    let index_blob = match indexed {
        Some(entry) if entry.mode == 0o160000 => return Err("Submodule contents are not inspected.".into()),
        Some(entry) if !entry.intent_to_add => Some(repo.blob(&entry.oid)?),
        _ => None,
    };
    let (old, new, old_label, new_label) = if staged {
        let old = match tree.get(path) {
            Some((mode, _)) if *mode == 0o160000 => return Err("Submodule contents are not inspected.".into()),
            Some((_, oid)) => Some(repo.blob(oid)?),
            None => None,
        };
        (old, index_blob, "HEAD".to_string(), "index".to_string())
    } else {
        let worktree = match repo.read(path, MAX_OBJECT as u64)? {
            Some(bytes) if repo.autocrlf => Some(crlf_to_lf(&bytes)),
            other => other,
        };
        (index_blob, worktree, "index".to_string(), "working tree".to_string())
    };
    if old.is_none() && new.is_none() {
        return Err("Path is not present in HEAD, the index or the working tree.".into());
    }
    Ok(diff_text(path, staged, old.as_deref(), new.as_deref(), old_label, new_label))
}

fn session_root(state: &crate::local_folder::FolderState, session_id: &str) -> Result<std::path::PathBuf> {
    state.with_root(session_id, |root| Ok(root.to_path_buf()))
}
#[tauri::command]
pub async fn git_status(state: tauri::State<'_, crate::local_folder::FolderState>, session_id: String) -> Result<GitStatus> {
    let root = session_root(&state, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || inspect(&root))
        .await
        .map_err(|_| "Git inspection stopped unexpectedly.".to_string())?
}
#[tauri::command]
pub async fn git_diff(
    state: tauri::State<'_, crate::local_folder::FolderState>,
    session_id: String,
    path: String,
    staged: bool,
) -> Result<Diff> {
    let root = session_root(&state, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || diff(&root, &path, staged))
        .await
        .map_err(|_| "Git diff stopped unexpectedly.".to_string())?
}
#[tauri::command]
pub async fn git_diff_summary(
    state: tauri::State<'_, crate::local_folder::FolderState>,
    session_id: String,
    items: Vec<SummaryItem>,
) -> Result<Vec<SummaryRow>> {
    let root = session_root(&state, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || diff_summary(&root, &items))
        .await
        .map_err(|_| "Git diff summary stopped unexpectedly.".to_string())?
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{path::PathBuf, process::Command};
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("melly-mega04-git-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Fixture(root)
    }
    /// Test-only fixture builder. Isolated from user/system Git config and hook templates.
    fn git(dir: &Path, args: &[&str]) -> String {
        let empty = std::env::temp_dir().join("melly-mega04-empty-gitconfig");
        fs::write(&empty, "").unwrap();
        let out = Command::new("git")
            .args(["-c", "core.hooksPath=NUL", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", &empty)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Melly QA")
            .env("GIT_AUTHOR_EMAIL", "qa@localhost")
            .env("GIT_COMMITTER_NAME", "Melly QA")
            .env("GIT_COMMITTER_EMAIL", "qa@localhost")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }
    fn porcelain(dir: &Path) -> BTreeSet<String> {
        git(dir, &["-c", "status.renames=false", "status", "--porcelain=v1", "-uall"]).lines().map(|l| l.trim_end().to_string()).collect()
    }
    fn ours(dir: &Path) -> BTreeSet<String> {
        inspect(dir).unwrap().entries.iter().map(|e| format!("{}{} {}", e.x, e.y, e.path)).collect()
    }
    fn write(root: &Path, path: &str, text: &str) {
        let file = root.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }
    fn scenario(root: &Path) {
        git(root, &["init", "-q", "--template=", "-b", "main"]);
        write(root, "a.txt", "one\ntwo\nthree\n");
        write(root, "b.txt", "bee\n");
        write(root, "dir/c.txt", "c1\nc2\n");
        write(root, "keep/tracked.log", "tracked but ignored by pattern\n");
        write(root, ".gitignore", "*.log\nbuild/\n!important.log\n");
        git(root, &["add", "-A", "-f"]);
        git(root, &["commit", "-q", "-m", "initial"]);
        write(root, "a.txt", "one\nTWO\nthree\nfour\n");
        fs::remove_file(root.join("b.txt")).unwrap();
        write(root, "dir/c.txt", "c1\nc2 staged\n");
        git(root, &["add", "dir/c.txt"]);
        write(root, "dir/c.txt", "c1\nc2 staged and edited\n");
        write(root, "d.txt", "new staged\n");
        git(root, &["add", "d.txt"]);
        write(root, "untracked.txt", "u\n");
        write(root, "newdir/deep/file.md", "deep\n");
        write(root, "debug.log", "ignored\n");
        write(root, "important.log", "re-included\n");
        write(root, "build/out.js", "ignored dir\n");
        write(root, "keep/tracked.log", "tracked file changed\n");
        write(root, "keep/new.log", "ignored untracked\n");
        fs::create_dir(root.join("nested")).unwrap();
        git(&root.join("nested"), &["init", "-q", "--template="]);
        write(root, "nested/inner.txt", "nested content\n");
    }
    #[test]
    fn status_matches_git_porcelain_loose_and_packed() {
        let f = fixture();
        scenario(&f.0);
        assert_eq!(ours(&f.0), porcelain(&f.0));
        git(&f.0, &["gc", "-q", "--aggressive"]);
        assert!(f.0.join(".git/packed-refs").exists());
        assert_eq!(ours(&f.0), porcelain(&f.0));
        let status = inspect(&f.0).unwrap();
        let head = status.head.unwrap();
        assert_eq!(head.branch.as_deref(), Some("main"));
        assert_eq!(head.oid.unwrap(), git(&f.0, &["rev-parse", "HEAD"]).trim());
        assert_eq!(head.summary.as_deref(), Some("initial"));
        assert!(status.entries.iter().any(|e| e.path == "nested/" && e.kind == "nested-repository"));
    }
    #[test]
    fn diffs_match_git_changed_lines() {
        let f = fixture();
        scenario(&f.0);
        for (path, staged) in [("a.txt", false), ("dir/c.txt", true), ("dir/c.txt", false), ("d.txt", true), ("b.txt", false)] {
            let ours = diff(&f.0, path, staged).unwrap();
            let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3"];
            if staged {
                args.push("--cached");
            }
            args.extend(["--", path]);
            let theirs: Vec<String> = git(&f.0, &args)
                .lines()
                .filter(|l| (l.starts_with('+') && !l.starts_with("+++")) || (l.starts_with('-') && !l.starts_with("---")))
                .map(str::to_string)
                .collect();
            let mine: Vec<String> = ours
                .hunks
                .iter()
                .flat_map(|h| &h.lines)
                .filter(|l| l.kind != "context")
                .map(|l| format!("{}{}", if l.kind == "add" { '+' } else { '-' }, l.text))
                .collect();
            assert_eq!(mine, theirs, "{path} staged={staged}");
        }
        let untracked = diff(&f.0, "untracked.txt", false).unwrap();
        assert_eq!((untracked.additions, untracked.deletions), (1, 0));
        let a = diff(&f.0, "a.txt", false).unwrap();
        assert_eq!((a.hunks[0].old_start, a.hunks[0].old_lines, a.hunks[0].new_start, a.hunks[0].new_lines), (1, 3, 1, 4));
    }
    #[test]
    fn detached_unborn_and_not_repository() {
        let f = fixture();
        assert!(!inspect(&f.0).unwrap().repository);
        git(&f.0, &["init", "-q", "--template=", "-b", "trunk"]);
        write(&f.0, "first.txt", "1\n");
        git(&f.0, &["add", "first.txt"]);
        let unborn = inspect(&f.0).unwrap();
        let head = unborn.head.as_ref().unwrap();
        assert!(head.unborn && head.oid.is_none() && head.branch.as_deref() == Some("trunk"));
        assert_eq!(ours(&f.0), porcelain(&f.0));
        git(&f.0, &["commit", "-q", "-m", "one"]);
        git(&f.0, &["checkout", "-q", "--detach"]);
        let detached = inspect(&f.0).unwrap().head.unwrap();
        assert!(detached.detached && detached.branch.is_none());
        assert_eq!(detached.oid.unwrap(), git(&f.0, &["rev-parse", "HEAD"]).trim());
        let other = fixture();
        fs::write(other.0.join(".git"), "gitdir: C:/elsewhere/.git\n").unwrap();
        let gitfile = inspect(&other.0).unwrap();
        assert!(!gitfile.repository && gitfile.reason.unwrap().contains("gitfile"));
    }
    #[test]
    fn untrusted_hooks_config_and_filters_never_execute() {
        let f = fixture();
        git(&f.0, &["init", "-q", "--template=", "-b", "main"]);
        write(&f.0, "x.txt", "x\n");
        git(&f.0, &["add", "x.txt"]);
        git(&f.0, &["commit", "-q", "-m", "x"]);
        let marker = f.0.join("..").join(format!("melly-pwned-{}", uuid::Uuid::new_v4()));
        let cmd = format!("cmd /c echo pwned> \"{}\"", marker.display());
        let config = fs::read_to_string(f.0.join(".git/config")).unwrap()
            + &format!("[core]\n\tfsmonitor = {cmd}\n\thooksPath = .git/hooks\n\tpager = {cmd}\n[diff]\n\texternal = {cmd}\n[diff \"evil\"]\n\ttextconv = {cmd}\n[filter \"evil\"]\n\tclean = {cmd}\n\tsmudge = {cmd}\n\tprocess = {cmd}\n");
        fs::write(f.0.join(".git/config"), config).unwrap();
        fs::create_dir_all(f.0.join(".git/hooks")).unwrap();
        for hook in ["pre-commit", "post-checkout", "post-index-change", "fsmonitor-watchman", "reference-transaction"] {
            fs::write(f.0.join(".git/hooks").join(hook), format!("#!/bin/sh\n{cmd}\n")).unwrap();
            fs::write(f.0.join(".git/hooks").join(format!("{hook}.cmd")), format!("{cmd}\r\n")).unwrap();
        }
        write(&f.0, ".gitattributes", "* filter=evil diff=evil\n");
        write(&f.0, "x.txt", "x changed\n");
        let status = inspect(&f.0).unwrap();
        let d = diff(&f.0, "x.txt", false).unwrap();
        assert_eq!(d.additions, 1);
        assert!(status.notices.iter().any(|n| n.contains("core.fsmonitor") && n.contains("filter.evil.clean")));
        assert!(status.notices.iter().any(|n| n.contains("hook")));
        assert!(!marker.exists(), "repository-provided command executed");
    }
    #[test]
    fn path_validation_and_crlf_normalisation() {
        let f = fixture();
        git(&f.0, &["init", "-q", "--template=", "-b", "main"]);
        git(&f.0, &["config", "core.autocrlf", "true"]);
        write(&f.0, "win.txt", "a\r\nb\r\n");
        git(&f.0, &["add", "win.txt"]);
        git(&f.0, &["commit", "-q", "-m", "crlf"]);
        let file = fs::OpenOptions::new().write(true).open(f.0.join("win.txt")).unwrap();
        file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
        drop(file);
        assert_eq!(ours(&f.0), porcelain(&f.0));
        assert!(inspect(&f.0).unwrap().entries.is_empty());
        for bad in ["../x", ".git/config", ".git", "C:/Windows/win.ini", "a\\b", "NUL", ""] {
            assert!(diff(&f.0, bad, false).is_err(), "{bad}");
        }
    }
    fn dot_git_state(dir: &Path) -> BTreeMap<String, (u64, std::time::SystemTime)> {
        let mut out = BTreeMap::new();
        let mut stack = vec![dir.join(".git")];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap() {
                let e = e.unwrap();
                let m = e.metadata().unwrap();
                if m.is_dir() {
                    stack.push(e.path());
                } else {
                    out.insert(e.path().display().to_string(), (m.len(), m.modified().unwrap()));
                }
            }
        }
        out
    }
    #[test]
    fn mega08_exact_renames_numstat_unicode_binary_and_no_git_writes() {
        let f = fixture();
        git(&f.0, &["init", "-q", "--template=", "-b", "main"]);
        write(&f.0, "old name.txt", "same content\nline2\n");
        write(&f.0, "zażółć/plik.txt", "ą\n");
        write(&f.0, "unstaged-src.txt", "moved without git\n");
        write(&f.0, "edited.txt", "one\n");
        fs::write(f.0.join("img.bin"), b"\0\x01\x02").unwrap();
        git(&f.0, &["add", "-A"]);
        git(&f.0, &["commit", "-q", "-m", "base"]);
        git(&f.0, &["mv", "old name.txt", "new name.txt"]);
        fs::rename(f.0.join("unstaged-src.txt"), f.0.join("unstaged-dst.txt")).unwrap();
        write(&f.0, "edited.txt", "one\ntwo\n");
        write(&f.0, "zażółć/plik.txt", "ą\nę\n");
        fs::write(f.0.join("img.bin"), b"\0\x01\x03").unwrap();
        // The git CLI used as the oracle refreshes .git/index itself, so it runs first.
        let unquoted: BTreeSet<String> = git(&f.0, &["-c", "status.renames=false", "status", "--porcelain=v1", "-uall", "-z"]).split('\0').filter(|l| !l.is_empty()).map(str::to_string).collect();
        let before = dot_git_state(&f.0);
        let status = inspect(&f.0).unwrap();
        assert_eq!(ours(&f.0), unquoted, "entries keep D / A / ? status, Unicode paths exact");
        assert!(status.renames.contains(&Rename { from: "old name.txt".into(), to: "new name.txt".into(), staged: true, similarity: "exact" }));
        assert!(status.renames.contains(&Rename { from: "unstaged-src.txt".into(), to: "unstaged-dst.txt".into(), staged: false, similarity: "exact" }));
        assert!(!status.renames.iter().any(|r| r.from == "edited.txt" || r.to == "edited.txt"));
        let items = [("zażółć/plik.txt", false), ("img.bin", false), ("edited.txt", false), ("missing.txt", false), ("new name.txt", true)]
            .map(|(path, staged)| SummaryItem { path: path.into(), staged });
        let rows = diff_summary(&f.0, &items).unwrap();
        assert_eq!((rows[0].additions, rows[0].deletions, rows[0].binary), (1, 0, false));
        assert!(rows[1].binary && rows[1].additions == 0);
        assert_eq!((rows[2].additions, rows[2].deletions), (1, 0));
        assert!(rows[3].error.is_some());
        assert_eq!((rows[4].additions, rows[4].error.is_none()), (2, true));
        let too_many: Vec<SummaryItem> = (0..=MAX_SUMMARY).map(|i| SummaryItem { path: format!("f{i}"), staged: false }).collect();
        assert!(diff_summary(&f.0, &too_many).is_err());
        assert_eq!(dot_git_state(&f.0), before, "inspection must never write .git (index, refs, objects, hooks)");
    }
    #[test]
    fn diff_algorithm_edges() {
        let d = diff_text("x", false, Some(b"a\nb\nc\n"), Some(b"a\nc\nd\n"), "o".into(), "n".into());
        assert_eq!((d.additions, d.deletions, d.hunks.len()), (1, 1, 1));
        let d = diff_text("x", false, Some(b"bin\0ary"), Some(b"other"), "o".into(), "n".into());
        assert!(d.binary && d.hunks.is_empty());
        let big_a: String = (0..4000).map(|i| format!("a{i}\n")).collect();
        let big_b: String = (0..4000).map(|i| format!("b{i}\n")).collect();
        let d = diff_text("x", false, Some(big_a.as_bytes()), Some(big_b.as_bytes()), "o".into(), "n".into());
        assert!(d.approximate && d.additions == 4000 && d.deletions == 4000);
        let mut ignore = Ignore::default();
        ignore.add("", "*.log\n/root-only\nsrc/**/gen/\n!keep.log\n");
        assert!(ignore.ignored("x/y.log", false) && !ignore.ignored("keep.log", false));
        assert!(ignore.ignored("root-only", false) && !ignore.ignored("a/root-only", false));
        assert!(ignore.ignored("src/a/b/gen", true) && !ignore.ignored("src/a/b/gen", false));
    }
}
