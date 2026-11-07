// Read-only local Git client. All inspection runs natively without the git executable.
export const GIT_UNAVAILABLE = 'Git inspection requires the Windows desktop app and an open Local Folder.';
const NAMES = {M: 'modified', A: 'added', D: 'deleted', U: 'conflicted'};

export function describeEntry(entry) {
  if (entry.kind === 'nested-repository') return 'Nested repository · not inspected';
  if (entry.x === '?') return 'Untracked';
  if (entry.x === 'U' || entry.y === 'U') return 'Conflicted · resolve outside Melly';
  const parts = [];
  if (entry.x !== ' ') parts.push(`${NAMES[entry.x] || entry.x} · staged`);
  if (entry.y !== ' ') parts.push(`${NAMES[entry.y] || entry.y} · not staged`);
  return parts.join(', ');
}

export function groupEntries(entries) {
  const groups = {staged: [], unstaged: [], untracked: [], conflicted: []};
  for (const entry of entries) {
    if (entry.x === '?') groups.untracked.push(entry);
    else if (entry.x === 'U' || entry.y === 'U') groups.conflicted.push(entry);
    else {
      if (entry.x !== ' ') groups.staged.push(entry);
      if (entry.y !== ' ') groups.unstaged.push(entry);
    }
  }
  return groups;
}

export function unifiedDiff(diff) {
  if (diff.binary) return `Binary files differ: ${diff.path}`;
  if (!diff.hunks.length) return diff.approximate ? 'File is too large for a line diff.' : 'No textual changes.';
  const out = [`--- a/${diff.path} (${diff.oldLabel})`, `+++ b/${diff.path} (${diff.newLabel})`];
  for (const h of diff.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const line of h.lines) out.push((line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ') + line.text.replace(/\r$/, ''));
  }
  if (diff.approximate) out.push('', '(Large change shown as full replacement.)');
  return out.join('\n');
}

export function headLabel(head) {
  if (!head) return 'No HEAD';
  if (head.unborn) return `${head.branch} · no commits yet`;
  if (head.detached) return `Detached HEAD at ${head.short}`;
  return `${head.branch} @ ${head.short}`;
}

export class GitClient {
  constructor(invoke = globalThis.__TAURI__?.core?.invoke) { this.invoke = invoke; }
  get available() { return typeof this.invoke === 'function'; }
  async status(sessionId) { if (!this.available) throw new Error(GIT_UNAVAILABLE); return this.invoke('git_status', {sessionId}); }
  async diff(sessionId, path, staged) { if (!this.available) throw new Error(GIT_UNAVAILABLE); return this.invoke('git_diff', {sessionId, path, staged: !!staged}); }
}
