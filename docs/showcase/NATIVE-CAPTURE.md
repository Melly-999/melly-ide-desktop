# Native Windows capture

MEGA-SHOWCASE-02 captured every file under `docs/assets/showcase/native/` (withheld from the public source) from the real Melly IDE Windows application on 2026-11-03 (Europe/Warsaw). The window is a Tauri 2 shell rendering through Microsoft Edge WebView2 156 with the genuine Rust IPC boundary. No browser tab, mocked `__TAURI__` bridge or illustrated interface is involved.

## Executable identity

| Item | Value |
|---|---|
| Binary | MEGA-08.2/09 debug build of `src-tauri`, built 2026-10-29 15:53 with `cargo build --offline` |
| SHA-256 | `ae0c7b51958e664015818f6f9cbf4591cbd3cdcec3c6e76affeebbd91dc6abe1` (17,069,056 bytes), identical to the binary used by the historical MEGA-09 native QA |
| Native sources | All 62 files under `src-tauri/` (Rust, Cargo, config, capabilities, permissions, icons) are older than the build |
| Frontend | 70 of 71 allowlisted desktop assets served by the running app are byte-identical to the current working tree; `index.html` differs only by Tauri's HTML re-serialization line breaks |
| Fresh build | **Blocked.** The MSVC linker (`link.exe`) is not installed on the capture machine. No toolchain was installed for this task |

Full hashes: [NATIVE-SOURCE-FINGERPRINT.json](NATIVE-SOURCE-FINGERPRINT.json).

## Isolation

- **App profile.** The capture ran a copy of the binary in which only the 23-byte application identifier was changed (`com.melly.ide.mega05.qa` → `com.melly.ide.shwc02.qa`, 5 differing bytes). The identifier selects the app-local data folder, so the owner's QA profile was not read or written. Nothing else in the executable differs.
- **WebView2 data.** `WEBVIEW2_USER_DATA_FOLDER` redirected the WebView2 profile to an empty folder in the external evidence directory.
- **Workspace.** The opened folder is the disposable synthetic `orbit-dashboard` repository described in [orbit-dashboard-fixture.json](orbit-dashboard-fixture.json). Its single commit uses the synthetic identity `Orbit Showcase <showcase@example.invalid>`.
- **Folder selection.** The folder was chosen in the real Windows folder dialog. A UI Automation helper refuses any path except that exact synthetic folder, verified before the dialog is touched, and reads the edit box back before confirming. No global keystrokes were sent.
- **Execution.** Execution stayed disabled for the whole session. No command, CLI probe, agent job, provider request or file save was performed.

## Capture method

- Input reaches the page through the WebView2 DevTools protocol on a loopback-only port that exists for this QA session. This port is not part of the shipped configuration.
- Frames come from `PrintWindow(PW_RENDERFULLCONTENT)` of the Melly window only, so the desktop, other applications and notifications are never read.
- Screenshots are 1442 × 1053 and include the native title bar. Recordings were sampled at 15 FPS (effective 14.9) and encoded to 1200 × 876 GIFs. Identical consecutive frames are merged with their real durations, which keeps the original timing; no frame was added, painted or reordered.
- The pointer is not drawn, because the OS cursor never moves. Hover highlights come from the page itself.
- A viewport privacy guard refuses to capture when any painted text looks like a local path or personal identifier. It refused one Agent Control Center composition, because detected CLI paths include the Windows account name. The published scene starts below those lines.

## What the media does not show

- The title bar reads "MEGA-07 QA" because that is the window title configured in `tauri.conf.json`. The binary is the later MEGA-08.2/09 build.
- The editor has no syntax highlighting; the captures show it as it is.
- The breadcrumb label "Legacy samples" is the default browser-local project. It is unrelated to the opened disk folder.
- Agent CLI detection reflects the capture machine. No CLI was probed or run, writable profiles remain gated, and paid provider execution is not shown.

[Media sources](MEDIA-SOURCES.md) lists every asset.
