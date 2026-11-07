import { assertPath } from './model.js';

export class PublicGitHub {
  constructor(fetcher = globalThis.fetch.bind(globalThis)) { this.fetcher = fetcher; }
  repository(value) {
    const name = value.trim().replace(/^https:\/\/github.com\//, '').replace(/\/$/, '');
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(name) || name.split('/').some(s => ['.', '..'].includes(s))) throw new Error('Enter a public repository as owner/name.');
    return name;
  }
  async get(path) {
    const response = await this.fetcher('https://api.github.com' + path, {method: 'GET', credentials: 'omit', redirect: 'error', headers: {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}, signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub rate limit or access denied. Retry later; saved copies remain available.' : `GitHub request failed (${response.status}). Private repositories require a secure backend integration.`);
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024) throw new Error('GitHub response exceeds the safe limit.');
    return JSON.parse(text);
  }
  async browse(value) {
    const repository = this.repository(value);
    const [metadata, branches] = await Promise.all([this.get(`/repos/${repository}`), this.get(`/repos/${repository}/branches?per_page=100`)]);
    if (metadata.private !== false) throw new Error('Only public repositories are supported.');
    return {repository, metadata, branches};
  }
  async commits(repository, branch) { return this.get(`/repos/${this.repository(repository)}/commits?sha=${encodeURIComponent(branch)}&per_page=30`); }
  async tree(repository, sha) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Select an exact commit SHA.');
    const commit = await this.get(`/repos/${this.repository(repository)}/git/commits/${sha}`);
    if (commit.sha !== sha) throw new Error('GitHub commit identity mismatch.');
    const tree = await this.get(`/repos/${repository}/git/trees/${commit.tree.sha}?recursive=1`);
    if (tree.truncated) throw new Error('Repository tree is too large. Incomplete trees are not imported.');
    return tree.tree.filter(e => e.type === 'blob' && e.mode !== '120000' && e.mode !== '160000').filter(e => { try { assertPath(e.path); return true; } catch { return false; } });
  }
  async file(repository, commit, entry) {
    assertPath(entry.path);
    if (!/^[a-f0-9]{40}$/.test(entry.sha) || entry.size > 512 * 1024) throw new Error('Binary or oversized file is unavailable.');
    const blob = await this.get(`/repos/${this.repository(repository)}/git/blobs/${entry.sha}`);
    if (blob.sha !== entry.sha || blob.encoding !== 'base64' || blob.size > 512 * 1024) throw new Error('Unsupported GitHub blob.');
    const raw = Uint8Array.from(atob(blob.content.replace(/\s/g, '')), c => c.charCodeAt(0));
    if (raw.includes(0)) throw new Error('Binary files cannot be edited as text.');
    const header = new TextEncoder().encode(`blob ${raw.length}\0`); const gitObject = new Uint8Array(header.length + raw.length); gitObject.set(header); gitObject.set(raw, header.length);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-1', gitObject))].map(b => b.toString(16).padStart(2, '0')).join('');
    if (digest !== entry.sha) throw new Error('Blob integrity verification failed.');
    return {content: new TextDecoder('utf-8', {fatal: true}).decode(raw), source: {repository, commit, blob: entry.sha}};
  }
}
