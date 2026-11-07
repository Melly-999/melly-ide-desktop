// MEGA-08 tolerant parsers for Claude Code stream-json and Codex `exec --json` output.
// Every line is untrusted data: it is summarized for display (textContent only), never executed,
// never treated as an instruction, and never turned into a progress percentage. Only events that
// actually appear in the output are reported; a process exit code is not proof of tool success.
const MAX_TEXT = 400;
const clip = (value, max = MAX_TEXT) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text; };

// Defense in depth: the native broker already redacts output before the renderer sees it.
const REDACTIONS = [
  /\b(?:sk-ant-|sk-proj-|sk-)[A-Za-z0-9_-]{16,}/g, /\b(?:github_pat_|ghp_|gho_|ghs_|ghu_)[A-Za-z0-9_]{20,}/g, /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, /\bAKIA[A-Z0-9]{12,}/g, /\bAIza[A-Za-z0-9_-]{20,}/g,
];
export function redactText(text) {
  let out = String(text ?? '');
  for (const pattern of REDACTIONS) out = out.replace(pattern, '[REDACTED]');
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED]');
  out = out.replace(/\b(api[_-]?key|apikey|token|secret|password|passwd)(["'\s]*[:=]["'\s]*)([^\s"',;]{8,})/gi, '$1$2[REDACTED]');
  return out;
}

/** One output line → a display event. Unknown JSON shapes become `other`, bad JSON `malformed`. */
export function parseAgentLine(provider, line) {
  const raw = String(line ?? '').trim();
  if (!raw) return null;
  if (raw[0] !== '{') return {kind: 'raw', text: clip(raw)};
  let event;
  try { event = JSON.parse(raw); } catch { return {kind: 'malformed', text: clip(raw, 160)}; }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return {kind: 'malformed', text: clip(raw, 160)};
  return provider === 'codex' ? codexEvent(event) : claudeEvent(event);
}
function claudeEvent(e) {
  switch (e.type) {
    case 'system': return {kind: 'stage', stage: e.subtype === 'init' ? 'Session started' : `System: ${clip(e.subtype, 60)}`, text: e.model ? `Model ${clip(e.model, 80)}` : ''};
    case 'assistant': {
      const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
      const tools = blocks.filter(b => b?.type === 'tool_use').map(b => clip(b.name, 60));
      const text = blocks.filter(b => b?.type === 'text').map(b => b.text).join(' ');
      if (tools.length) return {kind: 'tool', tools, text: clip(text)};
      return text ? {kind: 'message', text: clip(text)} : {kind: 'other', text: 'assistant event'};
    }
    case 'user': {
      const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
      const results = blocks.filter(b => b?.type === 'tool_result');
      return results.length ? {kind: 'tool-result', count: results.length, errors: results.filter(r => r.is_error).length} : {kind: 'other', text: 'user event'};
    }
    case 'result': {
      const denials = Array.isArray(e.permission_denials) ? e.permission_denials.map(d => clip(d?.tool_name ?? d?.toolName ?? 'tool', 60)) : [];
      const ok = e.subtype === 'success' && e.is_error !== true;
      return {kind: 'result', ok, subtype: clip(e.subtype, 60), text: clip(e.result), denials, turns: Number.isInteger(e.num_turns) ? e.num_turns : null};
    }
    default: return {kind: 'other', text: clip(e.type ?? 'event', 60)};
  }
}
function codexEvent(e) {
  const item = e.item && typeof e.item === 'object' ? e.item : null;
  switch (e.type) {
    case 'thread.started': return {kind: 'stage', stage: 'Session started', text: ''};
    case 'turn.started': return {kind: 'stage', stage: 'Turn started', text: ''};
    case 'turn.completed': return {kind: 'result', ok: true, subtype: 'turn.completed', text: '', denials: [], turns: null};
    case 'turn.failed': return {kind: 'result', ok: false, subtype: 'turn.failed', text: clip(e.error?.message), denials: [], turns: null};
    case 'error': return {kind: 'error', text: clip(e.message ?? e.error?.message ?? 'error')};
    case 'item.started': case 'item.updated': case 'item.completed': {
      if (!item) return {kind: 'other', text: e.type};
      const done = e.type === 'item.completed';
      if (item.type === 'agent_message') return {kind: 'message', text: clip(item.text)};
      if (item.type === 'reasoning') return {kind: 'stage', stage: 'Reasoning', text: ''};
      if (item.type === 'command_execution') return {kind: 'tool', tools: ['command'], text: clip(item.command, 200), done, exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null};
      if (item.type === 'file_change') return {kind: 'tool', tools: ['file_change'], text: clip((item.changes || []).map(c => `${c.kind ?? ''} ${c.path ?? ''}`).join(', '), 200), done};
      if (item.type === 'mcp_tool_call') return {kind: 'tool', tools: [clip(`mcp:${item.server ?? ''}/${item.tool ?? ''}`, 80)], text: '', done};
      if (item.type === 'web_search') return {kind: 'tool', tools: ['web_search'], text: clip(item.query, 120), done};
      return {kind: 'other', text: clip(item.type, 60)};
    }
    default: return {kind: 'other', text: clip(e.type ?? 'event', 60)};
  }
}

/** Accumulates chunks from a run into observable progress (stage, last message, tools, result). */
export class AgentStream {
  constructor(provider) {
    this.provider = provider; this.pending = ''; this.events = []; this.stage = 'Waiting for output';
    this.lastMessage = ''; this.toolUses = 0; this.toolNames = []; this.malformed = 0; this.result = null; this.raw = 0;
  }
  push(chunks) {
    const fresh = [];
    for (const chunk of chunks) {
      if (chunk.stream !== 'stdout') continue; // stderr is shown verbatim, never parsed as events
      this.pending += chunk.text;
      let at;
      while ((at = this.pending.indexOf('\n')) >= 0) { const line = this.pending.slice(0, at); this.pending = this.pending.slice(at + 1); const event = this.consume(line); if (event) fresh.push(event); }
      if (this.pending.length > 64 * 1024) { const event = this.consume(this.pending); this.pending = ''; if (event) fresh.push(event); }
    }
    return fresh;
  }
  end() { const event = this.pending ? this.consume(this.pending) : null; this.pending = ''; return event ? [event] : []; }
  consume(line) {
    const event = parseAgentLine(this.provider, line);
    if (!event) return null;
    if (event.text) event.text = redactText(event.text);
    if (event.kind === 'malformed') this.malformed++;
    if (event.kind === 'raw') this.raw++;
    if (event.kind === 'stage') this.stage = event.stage;
    if (event.kind === 'message') { this.lastMessage = event.text; this.stage = 'Responding'; }
    if (event.kind === 'tool') { this.toolUses += event.tools.length; for (const name of event.tools) if (!this.toolNames.includes(name) && this.toolNames.length < 20) this.toolNames.push(name); this.stage = `Tool activity observed: ${event.tools.join(', ')}`; }
    if (event.kind === 'result') { this.result = {ok: event.ok, subtype: event.subtype, text: event.text, denials: event.denials, turns: event.turns}; this.stage = event.ok ? 'Agent reported completion' : 'Agent reported an error'; if (event.text) this.lastMessage = event.text; }
    this.events.push(event); if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    return event;
  }
  summary() {
    return {stage: this.stage, lastMessage: this.lastMessage, toolUses: this.toolUses, toolNames: [...this.toolNames], malformed: this.malformed, rawLines: this.raw,
      result: this.result ? {...this.result, denials: [...(this.result.denials || [])]} : null};
  }
}
