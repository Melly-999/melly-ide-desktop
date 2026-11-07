// MEGA-09 accessible picker used by Go to File, the command palette and Find in Files results.
// Items are untrusted data (file names come from the opened folder): everything is rendered with
// textContent, and picking an item only calls the handler the picker was created with.

/** Subsequence fuzzy score of `query` against `text`; null when not every character matches. */
export function fuzzyScore(query, text) {
  const q = String(query || '').toLowerCase().replace(/\s+/g, ''), t = String(text || ''), lower = t.toLowerCase();
  if (!q) return {score: 0, positions: []};
  const base = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\')) + 1;
  const positions = []; let score = 0, from = 0, previous = -2;
  for (const ch of q) {
    const at = lower.indexOf(ch, from);
    if (at < 0) return null;
    const boundary = at === 0 || '/\\_-. '.includes(t[at - 1]) || (t[at] !== lower[at] && t[at - 1] === lower[at - 1]);
    score += 1 + (at === previous + 1 ? 5 : 0) + (boundary ? 4 : 0) + (at >= base ? 2 : 0);
    positions.push(at); previous = at; from = at + 1;
  }
  // Prefer matches inside the file name and shorter paths.
  if (lower.slice(base).includes(q)) score += 12;
  return {score: score - t.length * 0.05, positions};
}
/** Best `limit` items for `query`; an empty query keeps the original order. */
export function rankItems(query, items, key = item => item, limit = 50) {
  if (!String(query || '').trim()) return items.slice(0, limit).map(item => ({item, positions: []}));
  const scored = [];
  for (const item of items) { const m = fuzzyScore(query, key(item)); if (m) scored.push({item, positions: m.positions, score: m.score}); }
  return scored.sort((a, b) => b.score - a.score || key(a.item).localeCompare(key(b.item))).slice(0, limit);
}
/** Text with matched characters wrapped in <mark>, built from DOM nodes only. */
export function highlighted(text, positions = []) {
  const span = document.createElement('span'), marks = new Set(positions);
  let run = '', marked = false;
  const flush = () => { if (!run) return; if (marked) { const m = document.createElement('mark'); m.textContent = run; span.append(m); } else span.append(run); run = ''; };
  [...String(text)].forEach((ch, i) => { const isMark = marks.has(i); if (isMark !== marked) { flush(); marked = isMark; } run += ch; });
  flush(); return span;
}

let pickers = 0;
export class Picker {
  /**
   * @param {{label: string, placeholder: string, empty: string, load: (query: string) => Promise<{rows: Array, note?: string}> | {rows: Array, note?: string}, pick: (row) => void}} options
   * Each row: {key, label, positions?, detail?, keys?, disabled?: string (reason)}.
   */
  constructor({label, placeholder, empty, load, pick}) {
    this.id = `picker${++pickers}`; this.label = label; this.empty = empty; this.load = load; this.pick = pick;
    this.rows = []; this.active = -1; this.request = 0;
    const h = (tag, attrs = {}) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
    this.dialog = h('dialog', {class: 'picker', 'aria-labelledby': `${this.id}-title`});
    const title = h('h2', {id: `${this.id}-title`, class: 'picker-title'}); title.textContent = label;
    this.input = h('input', {type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-autocomplete': 'list', 'aria-controls': `${this.id}-list`, autocomplete: 'off', spellcheck: 'false', placeholder, 'aria-describedby': `${this.id}-status`});
    this.list = h('ul', {id: `${this.id}-list`, role: 'listbox', 'aria-label': label, class: 'picker-list'});
    this.status = h('p', {id: `${this.id}-status`, class: 'picker-status', role: 'status', 'aria-live': 'polite'});
    const hint = h('p', {class: 'picker-hint'}); hint.textContent = '↑ ↓ to move · Enter to choose · Esc to close';
    this.dialog.append(title, this.input, this.list, this.status, hint);
    this.input.addEventListener('input', () => void this.refresh());
    this.input.addEventListener('keydown', event => this.key(event));
    this.list.addEventListener('mousedown', event => event.preventDefault()); // keep focus in the input
    this.list.addEventListener('click', event => { const li = event.target.closest('[role="option"]'); if (li) this.choose(Number(li.dataset.index)); });
    this.dialog.addEventListener('close', () => { const back = this.restore; this.restore = null; if (!this.handedOff) back?.focus?.({preventScroll: true}); this.handedOff = false; });
    this.dialog.addEventListener('click', event => { if (event.target === this.dialog) this.dialog.close(); });
    document.body.append(this.dialog);
  }
  get isOpen() { return this.dialog.open; }
  open(query = '') {
    if (this.dialog.open) { this.input.select(); return Promise.resolve(); }
    this.restore = document.activeElement; this.input.value = query;
    this.dialog.showModal(); this.input.focus(); this.input.select();
    return this.refresh();
  }
  close() { if (this.dialog.open) this.dialog.close(); }
  async refresh() {
    const request = ++this.request;
    let result;
    try { result = await this.load(this.input.value); }
    catch (error) { result = {rows: [], note: String(error?.message || error)}; }
    if (request !== this.request) return;
    // With only disabled rows, the first stays active so Enter explains why it is unavailable.
    this.rows = result.rows || []; this.active = this.rows.findIndex(r => !r.disabled);
    if (this.active < 0 && this.rows.length) this.active = 0;
    this.render(result.note);
  }
  render(note) {
    this.list.replaceChildren(...this.rows.map((row, index) => {
      const li = document.createElement('li');
      li.id = `${this.id}-opt${index}`; li.setAttribute('role', 'option'); li.dataset.index = String(index); li.className = 'picker-option';
      if (row.disabled) li.setAttribute('aria-disabled', 'true');
      const main = highlighted(row.label, row.positions); main.className = 'picker-label';
      li.append(main);
      const detail = row.disabled ? `Unavailable: ${row.disabled}` : row.detail;
      if (detail) { const small = document.createElement('small'); small.textContent = detail; li.append(small); }
      if (row.keys) { const kbd = document.createElement('kbd'); kbd.textContent = row.keys; li.append(kbd); }
      return li;
    }));
    this.sync();
    const count = this.rows.length;
    this.status.textContent = `${count ? `${count} result${count === 1 ? '' : 's'}` : this.empty}${note ? ` · ${note}` : ''}`;
  }
  sync() {
    for (const li of this.list.children) li.setAttribute('aria-selected', String(Number(li.dataset.index) === this.active));
    const current = this.list.children[this.active];
    if (current) { this.input.setAttribute('aria-activedescendant', current.id); current.scrollIntoView?.({block: 'nearest'}); }
    else this.input.removeAttribute('aria-activedescendant');
  }
  move(step) {
    if (!this.rows.length) return;
    this.active = Math.max(0, Math.min(this.rows.length - 1, (this.active < 0 ? -1 : this.active) + step));
    this.sync();
  }
  key(event) {
    const steps = {ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8};
    if (event.key in steps) { event.preventDefault(); this.move(steps[event.key]); }
    else if (event.key === 'Enter') { event.preventDefault(); this.choose(this.active); }
  }
  /** Disabled rows explain themselves and keep the picker open; a chosen row hands focus to its action. */
  choose(index) {
    const row = this.rows[index];
    if (!row) return;
    if (row.disabled) { this.status.textContent = `${row.label} is unavailable: ${row.disabled}`; return; }
    this.handedOff = true; this.close();
    try { this.pick(row); } catch (error) { this.handedOff = false; console.warn('picker action failed', error); }
  }
}
