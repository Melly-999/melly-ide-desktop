# Feature inventory

Scope: the local integrated working tree inspected for MEGA-SHOWCASE-01 on 2026-11-02 and rechecked natively for MEGA-SHOWCASE-02 on 2026-11-03. The branch HEAD alone does not identify this dirty source tree. "Tested" identifies the stated evidence; it does not mean owner-accepted or released.

| Feature | Classification | Implementation / evidence | Limit |
|---|---|---|---|
| Windows Tauri 2 / WebView2 shell | IMPLEMENTED + TESTED | [Tauri config](../../src-tauri/tauri.conf.json), historical native MEGA-09 QA, SHOWCASE-02 native session | SHOWCASE-02 launched the MEGA-08.2/09 build for media only; no approved beta release |
| Folder Explorer, explicit Save, recovery | IMPLEMENTED + TESTED | [Folder UI](../../js/local-folder.js), [native folder broker](../../src-tauri/src/local_folder.rs), Node tests and historical native save/conflict QA | Selected session; existing UTF-8 text up to 1 MiB; conflicts refused; rollback/power-loss limits |
| Workspace resume and tab memory | IMPLEMENTED + TESTED | [MEGA-09](../MEGA-09.md), [navigation](../../js/workspace/commands.js) | Restart never authorizes a folder; Windows dialog required again |
| Palette / quick-open / literal search | IMPLEMENTED + TESTED | [Navigation implementation](../../js/workspace/commands.js), `tests/mega09.test.js`; native SHOWCASE-02 recordings (13-file synthetic index, 23 ms literal search) | Bounds and refusal paths are covered by tests, not by the media |
| Read-only Git, hunks, split view | IMPLEMENTED + TESTED | [Git UI](../../js/devcenter/ui.js), [native inspector](../../src-tauri/src/git_inspect.rs), Node and historical native QA | No mutating Git operations; linked-worktree/submodule gitfiles unsupported |
| Approved one-shot Command Runner | IMPLEMENTED + TESTED | [Broker](../../src-tauri/src/exec_broker.rs), [runner UI logic](../../js/devcenter/runner.js), [MEGA-08](../MEGA-08.md) | Disabled per session until native consent; never an interactive terminal |
| Claude/Codex detection, probes, read-only job orchestration | IMPLEMENTED BUT NOT OWNER-ACCEPTED | [CLI adapters](../../src-tauri/src/agent_cli.rs), [jobs](../../js/devcenter/jobs.js), mock tests and historical native synthetic CLI jobs | No real paid task acceptance; local installed CLI versions are not promised compatible forever |
| Writable Claude/Codex profiles | PARTIALLY IMPLEMENTED | Adapter definitions exist; native `PROFILE_GATED` and renderer gating are tested | Owner security contract pending; unavailable in production configuration |
| Native security approvals | IMPLEMENTED + TESTED | [Broker](../../src-tauri/src/exec_broker.rs), [execution contract](../MEGA-08.md) | Native consent was historical synthetic QA; this run requests none |
| Separate native preview | IMPLEMENTED + TESTED | [Preview implementation](../../src-tauri/src/preview.rs), historical native QA | Project-frame unresolved IPC timeouts; incomplete network-isolation evidence |
| Offline shell / browser-local projects / backup v3 | IMPLEMENTED + TESTED | [Offline shell](../../js/offline.js), [workspace recovery](../WORKSPACE-RECOVERY.md), current Node tests | Complete first cache installation, same profile/origin; eviction possible; no native broker in browser |
| Interactive terminal / ConPTY | NOT AVAILABLE | [MEGA-08](../MEGA-08.md) | Runner is one-shot |
| Account-private source sync, generally available paid AI integration | PLANNED | Existing backend foundations do not establish live acceptance | Separate activation, owner approval and testing |
| Supported macOS/Linux/native iOS release | NOT AVAILABLE | No cross-platform acceptance established by this run | Windows is the verified engineering target |

Current showcase verification: `npm test`, `npm run typecheck`, separate Convex typecheck and a native Windows session on a synthetic repository (folder dialog, Explorer, tabs, palette, Go to File, Find in Files, read-only Git) with execution disabled. Historical MEGA-09 native report records 26 scenarios; that suite was not rerun and the media must not be represented as new native QA of saves, execution or agents.

For exact media provenance see [Media sources](../showcase/MEDIA-SOURCES.md). For execution limits read [Security model](SECURITY-MODEL.md). Older overview documents remain historical where their availability wording predates MEGA-08/09.
