# MEGA-08 — Approved execution, Claude Code / Codex adapters, agent jobs and Git review

Native QA version **0.6.0-rc.1** (identity unchanged). This document describes behaviour added in MEGA-08; evidence is kept outside the repository.

## Execution broker (`src-tauri/src/exec_broker.rs`)

The only module that creates processes (enforced by a source-scan test). Execution **starts disabled in every app session**; `exec_enable` shows a native Windows dialog and the flag lives in memory only.

A run is one executable plus an argument array — never a shell line. The interactive shell (`terminal_start`) remains not compiled. Flow:

1. `exec_request(request, surface)` — native normalization: live Local Folder session, root-relative working directory pinned without reparse points, program resolved on `PATH` × `.exe .com .cmd .bat` (or a file inside the folder), ≤ 64 arguments, no permission-bypass spellings, env scope `inherit|minimal`, timeout. The exact normalized specification is shown in a native `MessageBoxW` owned by the main window (default **No**). Only *Yes* mints a single-use approval `{approvalId, 256-bit token, specHash}` (commands 60 s, agent jobs 15 min).
2. `exec_start(request, approvalId, token)` — repeats normalization; the approval must be unused, unexpired, token-equal (constant time), same session and same `specHash`. Any changed executable (path, size, modified time), argument, directory, environment scope, timeout, task digest, provider, profile, model, job or attempt is refused (`SPEC_MISMATCH`) and invalidates the approval. Concurrency (1 by default, 2 max), per-folder exclusivity for agent runs and duplicate attempts are checked before the approval is consumed.
3. The process is created suspended, placed in a Windows Job Object (`KILL_ON_JOB_CLOSE`, at most 64 processes), then resumed. Output is read through pipes into a 256 KiB ring per run, line-bounded and redacted (`sk-…`, `ghp_…`, `Bearer …`, `password=…`, private keys, long mixed-case tokens).
4. `exec_poll` returns output after a cursor; `exec_cancel` terminates the whole job. A run is reported `exited`, `cancelled`, `timed-out` or `failed` only after the main process ended and the job reports zero active processes; leftover descendants are terminated and counted. Before/after workspace snapshots give a per-run change summary with attribution `exclusive-melly-window` or `uncertain`.
5. `exec_reconcile` checks recorded `{pid, creation time}` after a restart (`gone`, `alive-unmanaged`, `managed`). Nothing is ever killed or re-run automatically.

Error codes: `DISABLED`, `STALE_WORKSPACE`, `CWD_REFUSED`, `EXECUTABLE_REFUSED`, `ARGS_REFUSED`, `AGENT_VIA_ADAPTER`, `DENIED`, `APPROVAL_INVALID`, `APPROVAL_EXPIRED`, `APPROVAL_REPLAY`, `SPEC_MISMATCH`, `BUSY`, `WORKSPACE_LOCKED`, `DUPLICATE_ATTEMPT`, `IDENTITY_CHANGED`, `PROBE_REQUIRED`, `PROFILE_REFUSED`, `MODEL_REFUSED`, `SPAWN_FAILED`, `TREE_UNCONFIRMED`, `NOT_FOUND`.

The Job Object is cleanup and containment, **not a sandbox**: a run has the owner's Windows permissions and may use the network.

## Claude Code / Codex adapters (`src-tauri/src/agent_cli.rs`)

`agent_detect` only resolves the binaries. `agent_probe` (execution enabled) runs the fixed `--version` and help commands and enables a profile only when the installed help lists every required flag.

| Provider | Profiles | Native arguments (task on stdin) |
|---|---|---|
| Claude Code | `plan`, `edit` | `-p --output-format stream-json --verbose --permission-mode plan\|acceptEdits --tools Read,Glob,Grep[,Edit,Write] --permission-prompts none --restricted --strict-mcp-config --no-session-persistence [--model M]` |
| Codex CLI | `read-only`, `workspace-write` | `exec --json --color never --sandbox read-only\|workspace-write -C <folder> [-m M] -` |

No bypass flag is ever produced. Claude Code's interactive SDK permission protocol is not integrated; anything that would prompt is denied (`--permission-prompts none`). Codex's sandbox is enforced by Codex and not verified by Melly.

**MEGA-08.2 security gate.** An independent review found that `--restricted` alone still exposes Task, WebSearch, EnterWorktree, Cron*, Skill and other tools, so Claude now receives an explicit `--tools` allowlist (verified from the CLI's own session `init` event without inference). Writable profiles (Claude `edit`, Codex `workspace-write`) are refused natively with `PROFILE_GATED` and shown disabled until the owner accepts a writable-agent security contract (`Registry::allow_writable` is set only by tests). A native probe of `codex sandbox` on Windows showed: read-only denies all writes but reads are unconfined; workspace-write also allows writes to %TEMP%; loopback network was reachable in both. Approving a job approves the whole agent session — later tool actions are not individually approved.

## Agent jobs (`js/devcenter/jobs.js`)

States: `pending-approval → queued → starting → running → completed | failed | cancelling → cancelled`, plus `waiting-permission` (reserved), `interrupted`, `orphaned`, `unknown`. Persisted as `melly-agent-jobs-v2` `{version: 2, savedAt, settings: {paused, concurrency}, jobs}`; `melly-agent-jobs-v1` is read once for migration and never written. Approval tokens and raw output are never persisted. FIFO by approval time, pause/resume, concurrency 1–2, one agent job per folder. After a reload or restart, queued approvals are dropped and active jobs are re-attached (broker still holds the run) or marked `interrupted` / `orphaned` / `unknown`. Retry creates a new attempt that needs a new native approval. Exit code 0 is reported as completion of the process, not proof that every tool action succeeded.

## Git review (`git_inspect.rs`, Dev Center → Git)

Still read-only and native (no `git` executable). Adds exact-content rename pairing (`renames`, staged and unstaged), `git_diff_summary` per-file line counts (≤ 200 files), hunk navigation (buttons, `n` / `p`), and a per-job review card listing files changed during the job window with its attribution notes.

## UI

Dev Center keeps the legacy (disabled) interactive terminal card and adds the **Approved command runner**; Agents is now the job manager; a status strip shows execution, CLIs, running work, pending approvals, the workspace lock, Git and the last job. Alt+1…5 switch tools; Ctrl+Enter submits the focused runner or job form. In browsers and the PWA shell everything execution-related is shown as unavailable and nothing is routed to a cloud service.
