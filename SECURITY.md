# Security policy and boundaries

Melly IDE is an early alpha. Version 0.7.0-alpha.3 is an unsigned, experimental pre-release build. No production security certification, code signature or supported public release is claimed. Current work targets Windows 11, Tauri 2 and WebView2.

## Report a suspected vulnerability

Use the repository's private vulnerability reporting feature if the owner has enabled it. Otherwise arrange a private reporting channel with the maintainer before sharing sensitive details. No security email or response SLA has been declared. Do not include real credentials, private repositories or exploitable secrets in public issues. Use sanitized synthetic reproductions.

## Native filesystem boundary

`src-tauri/src/local_folder.rs` owns selected-folder sessions, relative-path validation and explicit Save. Sessions expire after inactivity. Windows drive/device/ADS paths, traversal and unsupported reparse paths are refused. Directory handles pin ancestors; saving opens the existing target exclusively, rejects reparse and multiple-hardlink targets, compares SHA-256 of current bytes and writes through the same handle. Only existing supported UTF-8 files up to 1 MiB are saved. Session authority is not restored automatically after restart.

Ordinary selected-folder editing is access to that folder, not a secrets vault. Choose disposable copies for untrusted projects and never grant an unnecessarily broad root. Save failure attempts rollback; neither rollback success under every failure nor power-loss atomicity is guaranteed.

## Preview isolation

The trusted `main` window owns the capability. The separate `preview` window matches no capability, and every Melly command also checks the invoking window label. The custom preview protocol serves only its window. Project content runs in a sandboxed opaque-origin frame with a restrictive CSP; popups, navigation, workers, connections and hidden project paths are constrained. Main never embeds a scripted project frame or exposes a project postMessage command bridge.

Browser fallback removes scripts and renders a fully inert snapshot. Automated tests cover explicit IPC denials and selected egress paths. These checks do not certify complete WebRTC/DNS-prefetch prevention. Do not open actively hostile content assuming a complete network sandbox.

## Git, terminal and agents

`git_inspect.rs` reads Git structures without launching Git, hooks, filters, textconv, fsmonitor or external diff. Linked-worktree/submodule gitfiles and unsupported structures are reported rather than followed. Terminal capability reports execution disabled; explicit start is refused. Shipped agent executors are unavailable, and persisted job states do not represent completed AI work. Test-only fake executors are labeled simulated.

## Storage, cloud and packaging

IndexedDB workspace, local recovery buffers and job metadata are plaintext within the current browser/OS profile, subject to quota and eviction. Backup v3 applies to workspace projects, excluding disk buffers, credentials and provider settings. Its checksum detects accidental damage and does not authenticate origin. Secret-pattern filtering is heuristic; inspect exports before sharing.

Public source defaults do not activate Clerk, Convex or paid AI. Live providers, account-private synchronization and privileged executors require separate gates. Static desktop preparation copies an allowlist of frontend/auth runtime assets; environment files, backend code, Git metadata and user databases are excluded. Keep these exclusions and review dependency notices before distribution.

## Remaining security acceptance

Power-loss consistency, failed-rollback fault injection, dedicated Windows ACL denial and hostile concurrent reparse stress require additional tests. WebRTC/DNS egress coverage remains incomplete. Unsigned QA installation and second-machine launch are separate acceptance gates. Report reproduced issues distinctly from these untested areas.
