//! MEGA-04 isolated Live Preview.
//!
//! Security architecture (see PREVIEW-SECURITY.md):
//! - Project files are served by the `melly-preview` protocol ONLY to the dedicated `preview`
//!   window. The main window never embeds preview content (no iframe, no frame-src).
//! - The `preview` window matches no capability, so Tauri's ACL denies every app and core
//!   command; `main.rs` additionally rejects any invoke whose webview label is not `main`.
//!   (wry injects Tauri's IPC script into every webview/frame on Windows and Tauri treats
//!   app-registered protocols as a local origin, so ACL + label checks are the boundary.)
//! - Responses carry CSP `sandbox allow-scripts` (opaque origin, no storage, no forms/popups/top
//!   navigation) and deny all network; `on_navigation`/`on_new_window` enforce the same natively.
//! - Diagnostics flow one way without IPC: the injected bridge requests
//!   `/<token>/__melly-preview/report?...` images on its own origin; the main window reads them
//!   with `preview_events`.
use crate::{
    local_folder::FolderState,
    scoped_fs::{self, Loaded, Result},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};

pub const SCHEME: &str = "melly-preview";
pub const WINDOW: &str = "preview";
const MAX_FILE: u64 = 8 * 1024 * 1024;
const MAX_FILES: usize = 500;
const MAX_TOTAL: usize = 16 * 1024 * 1024;
const MAX_EVENTS: usize = 100;
const BRIDGE: &str = "__melly-preview/bridge.js";
const REPORT: &str = "__melly-preview/report";
const SHELL: &str = "__melly-preview/shell.html";
const BRIDGE_JS: &str = r#"(()=>{const base=location.pathname.split('/').slice(0,2).join('/')+'/__melly-preview/report';
const post=(kind,text)=>{try{const i=new Image();i.src=base+'?k='+encodeURIComponent(kind)+'&t='+encodeURIComponent(String(text).slice(0,300))}catch{}};
addEventListener('error',e=>{const t=e.target;if(t&&t!==window&&t.tagName){if(String(t.src||'').includes('/__melly-preview/'))return;post('resource','Failed to load '+t.tagName.toLowerCase()+' '+(t.getAttribute('src')||t.getAttribute('href')||''))}else{post('error',(e.message||'Script error')+(e.lineno?' (line '+e.lineno+')':''))}},true);
addEventListener('unhandledrejection',e=>post('error','Unhandled rejection: '+((e.reason&&e.reason.message)||e.reason)));
document.addEventListener('securitypolicyviolation',e=>{if(!String(e.blockedURI).includes('/__melly-preview/'))post('blocked','Blocked by preview policy: '+e.effectiveDirective+' '+(e.blockedURI||''))});
addEventListener('load',()=>post('ready',document.title||''));})();"#;

pub fn origin() -> &'static str {
    if cfg!(windows) {
        "http://melly-preview.localhost"
    } else {
        "melly-preview://localhost"
    }
}
/// Project documents: no network, no nested frames, no forms, no workers; sandboxed to an
/// opaque origin and embeddable only by the preview shell.
pub fn csp() -> String {
    let o = origin();
    format!(
        "default-src 'none'; script-src {o} 'unsafe-inline' 'unsafe-eval'; style-src {o} 'unsafe-inline'; \
         img-src {o} data: blob:; font-src {o} data:; media-src {o} data: blob:; connect-src 'none'; \
         frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; \
         form-action 'none'; base-uri 'none'; frame-ancestors {o}; sandbox allow-scripts"
    )
}
/// The trusted top-level shell runs no script at all. Its `frame-src` stops the project frame
/// from navigating anywhere but the preview origin before any request is sent; the frame's
/// sandbox (no allow-top-navigation/popups/forms) stops it from navigating the window.
pub fn shell_csp() -> String {
    let o = origin();
    format!(
        "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; frame-src {o}; \
         child-src {o}; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"
    )
}
fn shell_html(token: &str, entry: &str) -> Vec<u8> {
    let src = entry.split('/').map(encode).collect::<Vec<_>>().join("/");
    let title: String = entry.chars().map(|c| match c { '&' => "&amp;".into(), '<' => "&lt;".into(), '>' => "&gt;".into(), '"' => "&quot;".into(), c => c.to_string() }).collect();
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Melly Live Preview — {title}</title>\
         <style>html,body,iframe{{margin:0;width:100%;height:100%;border:0;display:block;background:#fff}}</style></head>\
         <body><iframe src=\"/{token}/{src}\" sandbox=\"allow-scripts\" referrerpolicy=\"no-referrer\" allow=\"\" title=\"Live Preview of {title}\"></iframe></body></html>"
    )
    .into_bytes()
}
pub fn is_preview_url(url: &str) -> bool {
    let o = origin();
    url == o || url.starts_with(&format!("{o}/"))
}

#[derive(Default)]
pub struct PreviewState {
    mount: Mutex<Option<Mount>>,
}
struct Mount {
    token: String,
    entry: String,
    source: Source,
    events: VecDeque<PreviewEvent>,
}
enum Source {
    Files(HashMap<String, Vec<u8>>),
    Folder(String),
}
#[derive(Deserialize)]
pub struct PreviewFile {
    path: String,
    content: String,
}
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct PreviewEvent {
    pub kind: &'static str,
    pub text: String,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Mounted {
    token: String,
    url: String,
    origin: &'static str,
    entry: String,
    source: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    available: bool,
    isolation: &'static str,
    origin: &'static str,
    window: &'static str,
    network: &'static str,
    csp: String,
}
pub struct Reply {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    pub shell: bool,
}

fn served_path(relative: &str) -> Result<()> {
    let parts = scoped_fs::rel_parts(relative)?;
    if parts.is_empty() {
        return Err("Empty preview path.".into());
    }
    if parts.iter().any(|p| p.starts_with('.')) {
        return Err("Hidden files and folders (.git, .env, …) are never served by Live Preview.".into());
    }
    Ok(())
}
fn entry_path(entry: &str) -> Result<String> {
    served_path(entry)?;
    let lower = entry.to_ascii_lowercase();
    if !(lower.ends_with(".html") || lower.ends_with(".htm")) {
        return Err("Preview entry must be an .html file.".into());
    }
    Ok(entry.into())
}
fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "wasm" => "application/wasm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}
fn decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}
fn query_value(query: &str, key: &str) -> String {
    query
        .split('&')
        .find_map(|pair| pair.split_once('=').filter(|(k, _)| *k == key).map(|(_, v)| v))
        .and_then(decode)
        .unwrap_or_default()
}
fn inject_bridge(token: &str, html: &[u8]) -> Vec<u8> {
    let tag = format!("<script src=\"/{token}/{BRIDGE}\"></script>");
    let lower: Vec<u8> = html.iter().map(u8::to_ascii_lowercase).collect();
    let find = |needle: &[u8]| lower.windows(needle.len()).position(|w| w == needle);
    let at = [&b"<head"[..], &b"<html"[..]]
        .iter()
        .find_map(|needle| find(needle).and_then(|start| lower[start..].iter().position(|b| *b == b'>').map(|end| start + end + 1)))
        .unwrap_or(0);
    let mut out = html[..at].to_vec();
    out.extend_from_slice(tag.as_bytes());
    out.extend_from_slice(&html[at..]);
    out
}
fn text(status: u16, message: &str) -> Reply {
    Reply { status, content_type: "text/plain; charset=utf-8", body: message.as_bytes().to_vec(), shell: false }
}
fn encode(part: &str) -> String {
    part.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}
fn record(mount: &mut Mount, kind: &'static str, text: impl Into<String>) {
    let text: String = text.into().chars().take(300).collect();
    if mount.events.len() >= MAX_EVENTS {
        mount.events.pop_front();
    }
    mount.events.push_back(PreviewEvent { kind, text });
}

impl PreviewState {
    fn replace(&self, entry: String, source: Source) -> Result<Mounted> {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let kind = match source {
            Source::Files(_) => "workspace-files",
            Source::Folder(_) => "local-folder",
        };
        let url = format!("{}/{token}/{SHELL}", origin());
        *self.mount.lock().map_err(|_| "Preview state unavailable.")? =
            Some(Mount { token: token.clone(), entry: entry.clone(), source, events: VecDeque::new() });
        Ok(Mounted { token, url, origin: origin(), entry, source: kind })
    }
    pub fn mount_files(&self, files: Vec<PreviewFile>, entry: &str) -> Result<Mounted> {
        let entry = entry_path(entry)?;
        if files.len() > MAX_FILES {
            return Err(format!("Preview supports at most {MAX_FILES} files."));
        }
        let mut total = 0;
        let mut map = HashMap::new();
        for file in files {
            if served_path(&file.path).is_err() {
                continue;
            }
            total += file.content.len();
            if total > MAX_TOTAL {
                return Err("Preview files exceed 16 MiB.".into());
            }
            map.insert(file.path, file.content.into_bytes());
        }
        if !map.contains_key(&entry) {
            return Err(format!("Entry file {entry} is not in the project."));
        }
        self.replace(entry, Source::Files(map))
    }
    pub fn mount_folder(&self, session_id: &str, entry: &str, exists: impl Fn(&str) -> Result<bool>) -> Result<Mounted> {
        let entry = entry_path(entry)?;
        if !exists(&entry)? {
            return Err(format!("Entry file {entry} was not found in the Local Folder."));
        }
        self.replace(entry, Source::Folder(session_id.into()))
    }
    pub fn unmount(&self, token: Option<&str>) -> Result<()> {
        let mut mount = self.mount.lock().map_err(|_| "Preview state unavailable.")?;
        if token.is_none() || mount.as_ref().is_some_and(|m| Some(m.token.as_str()) == token) {
            *mount = None;
        }
        Ok(())
    }
    pub fn url_for(&self, token: &str) -> Result<String> {
        let mount = self.mount.lock().map_err(|_| "Preview state unavailable.")?;
        let mount = mount.as_ref().filter(|m| m.token == token).ok_or("This preview was stopped or replaced. Start Live Preview again.")?;
        Ok(format!("{}/{}/{SHELL}", origin(), mount.token))
    }
    pub fn events(&self, token: &str) -> Result<Vec<PreviewEvent>> {
        let mount = self.mount.lock().map_err(|_| "Preview state unavailable.")?;
        Ok(mount.as_ref().filter(|m| m.token == token).map(|m| m.events.iter().cloned().collect()).unwrap_or_default())
    }
    /// Serves `/<token>/<relative>[?query]`. `folder` reads below an open Local Folder session.
    pub fn respond(&self, method: &str, raw_path: &str, query: &str, folder: impl Fn(&str, &str) -> Result<Loaded>) -> Reply {
        if method != "GET" && method != "HEAD" {
            return text(405, "Live Preview is read-only.");
        }
        let Some(path) = decode(raw_path.trim_start_matches('/')) else { return text(400, "Invalid preview URL encoding.") };
        let (token, mut relative) = path.split_once('/').map(|(t, r)| (t.to_string(), r.to_string())).unwrap_or((path.clone(), String::new()));
        let Ok(mut guard) = self.mount.lock() else { return text(500, "Preview state unavailable.") };
        let Some(mount) = guard.as_mut().filter(|m| m.token == token) else {
            return text(404, "This preview was stopped or replaced. Start Live Preview again.");
        };
        if relative == BRIDGE {
            return Reply { status: 200, content_type: "text/javascript; charset=utf-8", body: BRIDGE_JS.as_bytes().to_vec(), shell: false };
        }
        if relative == SHELL {
            return Reply { status: 200, content_type: "text/html; charset=utf-8", body: shell_html(&mount.token, &mount.entry), shell: true };
        }
        if relative == REPORT {
            let kind = match query_value(query, "k").as_str() {
                "ready" => "ready",
                "error" => "error",
                "resource" => "resource",
                "blocked" => "blocked",
                _ => return text(400, "Unknown report kind."),
            };
            record(mount, kind, query_value(query, "t"));
            return Reply { status: 204, content_type: "text/plain; charset=utf-8", body: vec![], shell: false };
        }
        if relative.is_empty() {
            relative = mount.entry.clone();
        } else if relative.ends_with('/') {
            relative.push_str("index.html");
        }
        if let Err(e) = served_path(&relative) {
            record(mount, "refused", format!("{relative}: {e}"));
            return text(403, &e);
        }
        let loaded = match &mount.source {
            Source::Files(files) => Ok(files.get(&relative).cloned().map(Loaded::Bytes).unwrap_or(Loaded::Missing)),
            Source::Folder(session) => folder(session, &relative),
        };
        match loaded {
            Ok(Loaded::Bytes(body)) => {
                let kind = content_type(&relative);
                let body = if kind.starts_with("text/html") { inject_bridge(&mount.token, &body) } else { body };
                Reply { status: 200, content_type: kind, body, shell: false }
            }
            Ok(Loaded::Missing) => {
                record(mount, "missing", relative.clone());
                text(404, &format!("Not found in preview project: {relative}"))
            }
            Err(e) if e.contains("session") => {
                record(mount, "error", "Local Folder session closed or expired.");
                text(410, "Local Folder session closed or expired. Reopen the folder and start Live Preview again.")
            }
            Err(e) => {
                record(mount, "refused", format!("{relative}: {e}"));
                text(403, &e)
            }
        }
    }
}

pub fn protocol<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::Manager;
    // Only the dedicated, capability-free preview window may load project content.
    let reply = if ctx.webview_label() != WINDOW {
        text(403, "Preview content is served only to the isolated preview window.")
    } else {
        let app = ctx.app_handle();
        let folders = app.state::<FolderState>();
        app.state::<PreviewState>().respond(request.method().as_str(), request.uri().path(), request.uri().query().unwrap_or(""), |session, relative| {
            folders.with_root(session, |root| scoped_fs::read_limited(root, relative, MAX_FILE))
        })
    };
    let head = request.method() == tauri::http::Method::HEAD;
    tauri::http::Response::builder()
        .status(reply.status)
        .header("Content-Type", reply.content_type)
        .header("Content-Security-Policy", if reply.shell { shell_csp() } else { csp() })
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        // Sandboxed documents have an opaque origin; module scripts need this CORS grant.
        .header("Access-Control-Allow-Origin", "null")
        .header("Cross-Origin-Opener-Policy", "same-origin")
        .header(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), clipboard-read=(), display-capture=()",
        )
        .body(if head { vec![] } else { reply.body })
        .unwrap_or_else(|_| tauri::http::Response::new(vec![]))
}

#[tauri::command]
pub fn preview_capability() -> Capability {
    Capability {
        available: true,
        isolation: "separate-capability-free-window+opaque-sandbox",
        origin: origin(),
        window: WINDOW,
        network: "denied-by-csp-and-navigation-handler",
        csp: csp(),
    }
}
#[tauri::command]
pub fn preview_mount_files(state: tauri::State<'_, PreviewState>, files: Vec<PreviewFile>, entry: String) -> Result<Mounted> {
    state.mount_files(files, &entry)
}
#[tauri::command]
pub fn preview_mount_folder(
    state: tauri::State<'_, PreviewState>,
    folders: tauri::State<'_, FolderState>,
    session_id: String,
    entry: String,
) -> Result<Mounted> {
    state.mount_folder(&session_id, &entry, |entry| {
        folders.with_root(&session_id, |root| Ok(matches!(scoped_fs::read_limited(root, entry, MAX_FILE)?, Loaded::Bytes(_))))
    })
}
/// Opens (or navigates) the isolated preview window. Async: Windows requires window
/// creation off the IPC thread.
#[tauri::command]
pub async fn preview_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, PreviewState>,
    token: String,
    width: Option<f64>,
) -> Result<()> {
    use tauri::Manager;
    let url: tauri::Url = state.url_for(&token)?.parse().map_err(|_| "Invalid preview URL.")?;
    let width = width.filter(|w| (240.0..=3840.0).contains(w)).unwrap_or(1024.0);
    if let Some(window) = app.get_webview_window(WINDOW) {
        window.navigate(url).map_err(|e| format!("Preview window navigation failed: {e}"))?;
        let _ = window.set_size(tauri::LogicalSize::new(width, 800.0));
        let _ = window.set_focus();
        return Ok(());
    }
    let window = tauri::WebviewWindowBuilder::new(&app, WINDOW, tauri::WebviewUrl::CustomProtocol(url))
        .title("Melly Live Preview — isolated (no app, file, Git or network access)")
        .inner_size(width, 800.0)
        .min_inner_size(240.0, 320.0)
        .on_navigation(|url| is_preview_url(url.as_str()))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| format!("Preview window could not open: {e}"))?;
    let app_handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = app_handle.state::<PreviewState>().unmount(None);
        }
    });
    Ok(())
}
#[tauri::command]
pub fn preview_resize<R: tauri::Runtime>(app: tauri::AppHandle<R>, width: f64) -> Result<()> {
    use tauri::Manager;
    if !(240.0..=3840.0).contains(&width) {
        return Err("Preview width must be between 240 and 3840 pixels.".into());
    }
    let window = app.get_webview_window(WINDOW).ok_or("Preview window is not open.")?;
    window.set_size(tauri::LogicalSize::new(width, 800.0)).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn preview_close<R: tauri::Runtime>(app: tauri::AppHandle<R>, state: tauri::State<'_, PreviewState>) -> Result<()> {
    use tauri::Manager;
    state.unmount(None)?;
    if let Some(window) = app.get_webview_window(WINDOW) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn preview_events(state: tauri::State<'_, PreviewState>, token: String) -> Result<Vec<PreviewEvent>> {
    state.events(&token)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn files(list: &[(&str, &str)]) -> Vec<PreviewFile> {
        list.iter().map(|(p, c)| PreviewFile { path: p.to_string(), content: c.to_string() }).collect()
    }
    fn no_folder(_: &str, _: &str) -> Result<Loaded> {
        Err("no folder".into())
    }
    #[test]
    fn serves_mounted_files_with_bridge_and_policy() {
        let s = PreviewState::default();
        let m = s.mount_files(files(&[("index.html", "<!doctype html><HTML><Head><title>x</title></head></html>"), ("css/app.css", "body{}"), ("ü ber.js", "1")]), "index.html").unwrap();
        assert!(m.url.starts_with(origin()) && m.url.ends_with(SHELL));
        assert_eq!(s.url_for(&m.token).unwrap(), m.url);
        let shell = s.respond("GET", &format!("/{}/{SHELL}", m.token), "", no_folder);
        let shell_text = String::from_utf8(shell.body).unwrap();
        assert!(shell.shell && shell.status == 200);
        assert!(shell_text.contains(&format!("<iframe src=\"/{}/index.html\" sandbox=\"allow-scripts\"", m.token)));
        assert!(!shell_text.contains("<script"), "shell runs no script");
        for directive in ["script-src 'none'", &format!("frame-src {}", origin()), "connect-src 'none'", "frame-ancestors 'none'"] {
            assert!(shell_csp().contains(directive), "{directive}");
        }
        assert!(s.mount_files(files(&[("a\"<b>.html", "x")]), "a\"<b>.html").is_err(), "markup characters are not valid entry names");
        let tricky = s.mount_files(files(&[("a&b'c d.html", "x")]), "a&b'c d.html").unwrap();
        let tricky_shell = String::from_utf8(s.respond("GET", &format!("/{}/{SHELL}", tricky.token), "", no_folder).body).unwrap();
        assert!(tricky_shell.contains("a%26b%27c%20d.html") && tricky_shell.contains("Melly Live Preview — a&amp;b'c d.html"));
        let m = s.mount_files(files(&[("index.html", "<!doctype html><HTML><Head><title>x</title></head></html>"), ("css/app.css", "body{}"), ("ü ber.js", "1")]), "index.html").unwrap();
        let page = s.respond("GET", &format!("/{}/index.html", m.token), "", no_folder);
        assert_eq!(page.status, 200);
        let html = String::from_utf8(page.body).unwrap();
        assert!(html.starts_with(&format!("<!doctype html><HTML><Head><script src=\"/{}/{BRIDGE}\"></script>", m.token)));
        assert_eq!(s.respond("GET", &format!("/{}/css/app.css", m.token), "", no_folder).content_type, "text/css; charset=utf-8");
        assert_eq!(s.respond("GET", &format!("/{}/%C3%BC%20ber.js", m.token), "", no_folder).status, 200);
        assert_eq!(s.respond("GET", &format!("/{}/", m.token), "", no_folder).status, 200);
        assert_eq!(s.respond("GET", &format!("/{}/{BRIDGE}", m.token), "", no_folder).status, 200);
        assert!(!BRIDGE_JS.contains("postMessage") && !BRIDGE_JS.contains("__TAURI"), "bridge never talks to the app");
        for directive in ["connect-src 'none'", "frame-src 'none'", "form-action 'none'", "worker-src 'none'", "default-src 'none'", &format!("frame-ancestors {}", origin()), "sandbox allow-scripts"] {
            assert!(csp().contains(directive), "{directive}");
        }
        assert!(!csp().contains("allow-same-origin") && !csp().contains("allow-popups") && !csp().contains("allow-top-navigation"));
    }
    #[test]
    fn report_channel_is_bounded_text_only() {
        let s = PreviewState::default();
        let m = s.mount_files(files(&[("index.html", "x")]), "index.html").unwrap();
        let report = |q: &str| s.respond("GET", &format!("/{}/{REPORT}", m.token), q, no_folder).status;
        assert_eq!(report("k=error&t=Boom%20%3Cscript%3E"), 204);
        assert_eq!(report("k=invoke&t=folder_list"), 400);
        for i in 0..150 {
            report(&format!("k=blocked&t={i}{}", "x".repeat(400)));
        }
        let events = s.events(&m.token).unwrap();
        assert_eq!(events.len(), MAX_EVENTS);
        assert!(events.iter().all(|e| e.text.chars().count() <= 300));
        assert!(s.events("other-token").unwrap().is_empty());
        s.respond("GET", &format!("/{}/missing.css", m.token), "", no_folder);
        assert_eq!(s.events(&m.token).unwrap().last().unwrap(), &PreviewEvent { kind: "missing", text: "missing.css".into() });
    }
    #[test]
    fn refuses_hidden_traversal_methods_and_stale_tokens() {
        let s = PreviewState::default();
        let m = s.mount_files(files(&[("index.html", "<p>x</p>"), (".env", "SECRET=1"), (".git/config", "x")]), "index.html").unwrap();
        for path in [".env", ".git/config", "../index.html", "a/../index.html", "%2e%2e/index.html", "C:/Windows/win.ini", "a%5Cb", "NUL", "missing.js"] {
            let r = s.respond("GET", &format!("/{}/{path}", m.token), "", no_folder);
            assert!(r.status == 403 || r.status == 404 || r.status == 400, "{path} -> {}", r.status);
            assert!(!String::from_utf8_lossy(&r.body).contains("SECRET"));
        }
        assert_eq!(s.respond("POST", &format!("/{}/index.html", m.token), "", no_folder).status, 405);
        assert_eq!(s.respond("GET", "/not-the-token/index.html", "", no_folder).status, 404);
        let old = m.token.clone();
        let next = s.mount_files(files(&[("index.html", "y")]), "index.html").unwrap();
        assert_eq!(s.respond("GET", &format!("/{old}/index.html"), "", no_folder).status, 404);
        assert!(s.url_for(&old).is_err());
        s.unmount(Some(&next.token)).unwrap();
        assert_eq!(s.respond("GET", &format!("/{}/index.html", next.token), "", no_folder).status, 404);
    }
    #[test]
    fn entry_limits_navigation_and_folder_session_errors() {
        let s = PreviewState::default();
        assert!(s.mount_files(files(&[("a.js", "1")]), "a.js").is_err());
        assert!(s.mount_files(files(&[("a.html", "1")]), "missing.html").is_err());
        assert!(s.mount_files(files(&[("a.html", "1")]), "../a.html").is_err());
        let many: Vec<PreviewFile> = (0..=MAX_FILES).map(|i| PreviewFile { path: format!("{i}.html"), content: String::new() }).collect();
        assert!(s.mount_files(many, "0.html").is_err());
        let m = s.mount_folder("sid", "index.html", |_| Ok(true)).unwrap();
        let closed = s.respond("GET", &format!("/{}/index.html", m.token), "", |_, _| Err("Folder session expired or closed. Select the folder again.".into()));
        assert_eq!(closed.status, 410);
        let served = s.respond("GET", &format!("/{}/img/logo.png", m.token), "", |sid, rel| {
            assert_eq!((sid, rel), ("sid", "img/logo.png"));
            Ok(Loaded::Bytes(vec![0x89, b'P', b'N', b'G']))
        });
        assert_eq!((served.status, served.content_type), (200, "image/png"));
        assert!(s.mount_folder("sid", "index.html", |_| Ok(false)).is_err());
        assert!(is_preview_url(&format!("{}/abc/index.html", origin())));
        for bad in ["https://example.com/", "http://melly-preview.localhost.evil.com/", "http://tauri.localhost/", "http://ipc.localhost/folder_list"] {
            assert!(!is_preview_url(bad), "{bad}");
        }
    }
}
