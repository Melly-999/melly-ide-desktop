# Workspace persistence and recovery

This contract is retained from the inherited README. It applies to IndexedDB workspace projects; native disk files and their local recovery buffers are separate. See [Architecture](ARCHITECTURE.md) and [Security](../SECURITY.md).

## Persistence and recovery contracts

Legacy database `mobileide-editor`, version 1, store `files`, key `filename` remains unchanged. New projects use `melly-ide-workspaces`, version 1, store `state`, key `workspace`. Workspace saves compare generations within a read/write transaction. A conflicting or failed transaction retains the in-memory buffer and never reports it as saved. Legacy corrupt/unsupported records remain intact with autosave paused until explicit replacement.

Workspace limits remain 50 projects, 1000 entries per project, 512 KiB UTF-8 per file content/original and 8 MiB serialized workspace. Storage is local plaintext within the current browser/OS profile. Switching accounts does not create separate local files.

**Export saved projects v3** first flushes pending edits and prepares one complete file. **Recover unsaved edits v3** snapshots in-memory edits without requiring successful IndexedDB persistence. The file distinguishes the last acknowledged snapshot/revisions from recovery buffers. Import confirms new project copies; it never merges or overwrites an existing project. Recovering into a destination with insufficient model capacity or browser quota fails without partial project creation.

V3 uses compact JSON, a 24 MiB file bound, an 8 MiB snapshot budget and an additional 8 MiB serialized recovery budget. The format has exactly one checksummed part in one file; missing/duplicate/foreign/corrupt parts are rejected. SHA-256 detects accidental damage, not hostile forgery, authorship or disclosure. V1/v2 compatibility paths retain their existing 2 MiB limits. Oversized unsaved edits can be preserved in a bounded recovery file but cannot bypass the 512 KiB/file or 8 MiB model limit at import. Nothing is silently truncated.

Unknown fields, unrelated browser data, auth/provider settings and outbox are not exported. Known credential patterns and common sensitive filenames block the entire v3 operation rather than silently dropping files. This is a heuristic; inspect source before sharing. OS download success, available RAM/disk, Safari sharing and permanent browser retention cannot be guaranteed by JavaScript.

## Manual Windows ↔ iPhone handoff

1. Export saved projects, or use Recover unsaved edits if Save fails. Wait for the complete file link and byte count.
2. Download to Files/Downloads, or press Share prepared file if the browser supports file sharing. Keep the page open until the actual file is verified.
3. On the receiving device, use Import backup and select that one JSON file from its file picker. Confirm creation of new local copies, then select a new copy in Local project.
4. Edit and save locally; export and import back. Previous copies remain independent. This is **manual transfer, not cloud/account synchronization**.

The download link remains available for the session. Share uses a separate user gesture and is feature-detected; cancellation/failure preserves the download fallback. A ready file or resolved share dialog does not prove the OS saved/transferred it. If Safari/PWA cannot expose the file, keep the source profile intact and follow the owner checklist; do not clear site data or reinstall to troubleshoot.
