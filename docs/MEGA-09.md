# MEGA-09 — Daily-driver workspace, navigation and review UX

Builds on MEGA-08 / MEGA-08.2 without changing the execution broker, the approval model or the agent permission profiles. Evidence is kept outside the repository.

## Native additions (`src-tauri/src/local_folder/`)

| Command | Purpose | Boundary |
|---|---|---|
| `folder_index(sessionId)` | Bounded file list for Go to File | Same session and path guards as `folder_list`: every directory is opened through `guarded` (ancestors pinned, reparse points refused). Breadth-first, ≤ 20 000 files, ≤ 4 000 directories, 2 s budget. `.git`, `node_modules`, `target`, `.venv`, `__pycache__`, `.next`, `desktop-dist` are skipped **and reported**. Junctions and invalid names are counted as `blocked`, never followed. |
| `folder_search(sessionId, query, caseSensitive)` | Literal text search (Find in Files) | Same walk. Query: 1–200 characters, single line, no control characters (`QUERY_REFUSED`). Files ≤ 512 KiB, valid UTF-8, no NUL; others are skipped and counted. ≤ 5 000 files, ≤ 500 matches (20 per file), 2 s budget; partial results say which limit stopped them. No regular expressions (no ReDoS). Read-only. |
| `folder_recent()` / `folder_forget(key)` | Recent folders | Absolute paths stay in `%LOCALAPPDATA%\<identifier>\recent-folders-v1.tsv` (≤ 8 entries, written via temp file + rename). The WebView receives only `{key, name, lastOpened, available}`; `key` is the SHA-256 of the lower-cased path (same value as the recovery key). |
| `folder_resume(key)` | Resume a recent folder | Opens the **Windows folder dialog** pre-navigated to that folder (`IFileDialog::SetFolder`). Only the person's selection opens a session, exactly like `folder_open`. A recent entry is never an authorization by itself. |

All five are main-window only (`allow-mega09-workspace`, dispatcher `invoke_allowed`); the preview window and project frames have no capability. None writes to the project, starts a process or accepts an absolute path. A search holds the folder session lock for at most its 2 s budget.

## Renderer

- `js/workspace/picker.js` — accessible picker (`dialog` + `combobox` + `listbox`, `aria-activedescendant`, focus restored on Escape). Rows are rendered with `textContent`; fuzzy matching is a subsequence score with boundary and file-name bonuses.
- `js/workspace/commands.js` — command palette (Ctrl+Shift+P / F1), Go to File (Ctrl+P), Find in Files (Ctrl+Shift+F), Go to Line (Ctrl+G), Close Tab (Ctrl+W, desktop), Toggle Files (Ctrl+B); disabled commands stay visible with the reason. Commands only drive existing UI: none starts a process or approves anything, and "Enable execution" still shows the native dialog. Also: keyboard/pointer explorer splitter, getting-started card (non-modal, dismissible) and guide.
- `js/local-folder.js` — recent folders panel, closable tabs (a dirty tab asks: *Save and close*, *Close and keep the buffer in recovery*, *Cancel*; nothing is discarded silently), tab labels with full-path tooltip and path bar, large-file notice, per-project tab memory, `reveal(path, line, column)`.
- `js/editor.js` — the gutter is rebuilt only when the line count changes (large files no longer re-render up to 10 000 spans per keystroke).
- Dev Center (`js/devcenter/ui.js`, `runner.js`):
  - Git: path filter, per-group `+/−` totals, side-by-side view built from native hunks, rendering capped at 5 000 lines with an explicit note, refresh after an explicit save and on window focus (rate-limited), open diff kept across refreshes.
  - Command runner: live preview of the exact program + argument array before the native dialog, harmless example (`node --version`, never run automatically), stdout/stderr/Melly-message filter, last-run evidence (outcome, Job Object tree confirmation, leftovers, duration, folder changes), error categories (`declined`, `policy`, `approval`, `availability`, `start`, `exit`, `timeout`, `cancelled`, `tree`, `monitor`), history "Reuse program" (arguments are never stored).
  - Agents: truthful getting-started checklist, effective-permission text per profile, queue filter, and a read-only limitation notice when an agent reports denied actions (Melly never elevates; writable profiles remain `PROFILE_GATED`).
  - Diagnostics: execution state, CLI states/versions, workspace hash prefix (never the name or path), last failure category, job counts and short ids, recovery state; the export adds the same `session` summary.

## Storage (this device only)

| Key | Content |
|---|---|
| `melly-layout-v1` | `{version: 1, explorerWidth, explorerOpen, devTab, guideSeen}` |
| `melly-folder-tabs-v1` | `{version: 1, projects: {<recoveryKey>: {paths, active, at}}}` — ≤ 16 projects × 16 relative paths, never content |
| `melly-command-history-v1` | unchanged schema plus `category`; arguments and output are still not stored |

Restarting never reopens a folder, re-runs a job or re-enables execution. Resuming a folder restores its remembered tabs after the person confirms the folder in the Windows dialog.

## Not changed

Execution starts disabled; every command and agent job needs its own native approval bound to the exact specification; approvals are single-use; writable agent profiles stay gated; no interactive terminal (ConPTY was not explored in MEGA-09); Git stays read-only and never runs `git`, hooks or diff tools.
