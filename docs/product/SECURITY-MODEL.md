# Security model and limits

Melly IDE v0.7.0-alpha.3 is an unsigned experimental public pre-release for Windows 11 x64. This document describes current implementation boundaries. Use the [reporting policy](../../SECURITY.md) for disclosure and [MEGA-08](../MEGA-08.md) and [MEGA-09](../MEGA-09.md) for the current execution contracts.

## Files, save and recovery

Native file access belongs to an explicitly selected folder session. Relative-path checks, pinned directory handles and reparse restrictions constrain the native broker. Save applies to existing supported UTF-8 text up to 1 MiB, compares the current SHA-256 version and refuses conflicting content. The current code attempts rollback on failure; power-loss atomicity and all rollback failure cases are not certified. Some current UI text calls Save "atomic"; this document deliberately states the narrower verified contract.

After restart, a recent-folder entry is a convenience, not authorization. Resume opens the Windows folder dialog again. Browser projects, disk files, disk recovery buffers and backup v3 are separate state owners. Local data is plaintext in the OS/browser profile, can face quota/eviction, and is not a secrets vault. Backup checksums detect damage, not authorship.

## Commands and agent jobs

- Execution starts disabled every session. Enabling execution needs native consent and approves no individual run.
- Each command or job needs a native dialog showing its normalized specification. Approvals are short-lived, single-use and bound to that specification. Changing arguments or other bound inputs invalidates approval.
- The runner accepts an executable plus argument array, not an interactive shell line. It has output polling, cancellation and process-tree confirmation; no ConPTY terminal is provided.
- Approved processes run with the user's Windows rights and can have network effects. Windows Job Objects supervise lifecycle and cleanup, **not OS isolation**.
- Approving an agent job approves its whole session. Melly does not ask again for each subsequent tool action. Exit zero means the process exited successfully, not that every requested action succeeded.
- Claude plan uses an explicit Read/Glob/Grep allowlist. Claude file-read confinement is not verified by Melly. Native disclosures say reads may reach other files accessible to the account.
- Historical Codex read-only probes denied writes but allowed reads outside the workspace and loopback access. Installed user configuration/MCP can affect Codex behavior. Those observations are bounded historical tests, not a promise about future CLI versions.
- Claude `edit` and Codex `workspace-write` remain disabled by `PROFILE_GATED` pending an owner-approved security contract. No setting, environment variable or screenshot harness authorizes bypassing it.

## Git and previews

The Git inspector parses locally without launching Git, hooks, filters or external diff tools. It exposes no stage/commit/reset/push action. Unsupported gitfile worktrees/submodules are refused/reported.

The separate native preview window has no Tauri capability and the dispatcher checks the caller window. Project scripts run in a constrained frame; browser fallback is inert. Project-frame IPC calls have remained unresolved rather than receiving explicit denial in historical tests. Those tests measured no privileged effects; a timeout alone is never proof of denial. WebRTC/DNS egress coverage is incomplete: do not assume complete network isolation.

## Acceptance and media

Real paid Claude/Codex task acceptance, writable-agent policy, broader crash/reparse stress, and assistive technology and high-DPI checks remain separate gates. The public alpha's administrator-context Sandbox smoke test leaves standard-user, Defender, UAC, SmartScreen and Mark-of-the-Web acceptance open.

The current README captures come from the 0.7.0-alpha.3 Windows Sandbox session with a synthetic project. They show the native enable-execution dialog. The session did not run an agent job. The [media provenance](../showcase/MEDIA-SOURCES.md) separates these captures from the superseded browser mock and older native session.
