// MEGA-07 deterministic classification of IPC negative-test outcomes.
// An attempt is only an explicit denial when the runtime answered with a denial. A timeout
// is never a denial: it is "unresolved" and is acceptable only together with clean side-effect
// evidence (no state change, no privileged effect, no network request, no dispatcher entry).
'use strict';
const CLASSES = Object.freeze(['EXPLICIT_ACL_DENIAL', 'EXPLICIT_LABEL_DENIAL', 'NO_BRIDGE', 'TRANSPORT_BLOCKED', 'UNRESOLVED_TIMEOUT', 'OTHER_REJECTION', 'RESOLVED']);
const ACL = /not allowed on window|not allowed\. Permissions associated with this command|not allowed by ACL|Command .* not allowed/i;
const LABEL = /available only to the main window/i;
const TRANSPORT = /Failed to fetch|NetworkError|Content Security Policy|violates the following|Load failed|webview is undefined|postMessage/i;

function classify(outcome) {
  const status = outcome && outcome.status, text = String((outcome && outcome.error) || '');
  if (status === 'no-bridge') return 'NO_BRIDGE';
  if (status === 'resolved') return 'RESOLVED';
  if (status === 'timeout') return 'UNRESOLVED_TIMEOUT';
  if (status === 'rejected' || status === 'threw') {
    if (ACL.test(text)) return 'EXPLICIT_ACL_DENIAL';
    if (LABEL.test(text)) return 'EXPLICIT_LABEL_DENIAL';
    if (TRANSPORT.test(text)) return 'TRANSPORT_BLOCKED';
    return 'OTHER_REJECTION';
  }
  throw new TypeError(`Unknown IPC outcome status: ${status}`);
}

// sideEffects: {stateUnchanged, privilegedEffects, trapHits, dispatcherDelta, secretsServed}
function summarize(attempts, sideEffects = {}) {
  const counts = Object.fromEntries(CLASSES.map(c => [c, 0]));
  const rows = attempts.map(a => { const cls = classify(a); counts[cls]++; return {command: a.command, context: a.context, class: cls, ms: a.ms ?? null, transport: a.transport || null, detail: String(a.error || a.value || '').slice(0, 200)}; });
  const clean = sideEffects.stateUnchanged === true && (sideEffects.privilegedEffects || 0) === 0 && (sideEffects.trapHits || 0) === 0
    && (sideEffects.dispatcherDelta || 0) === 0 && (sideEffects.secretsServed || 0) === 0;
  const explicit = counts.EXPLICIT_ACL_DENIAL + counts.EXPLICIT_LABEL_DENIAL;
  let verdict;
  if (counts.RESOLVED > 0 || counts.OTHER_REJECTION > 0) verdict = 'FAIL';
  else if (!clean) verdict = sideEffects.stateUnchanged === undefined ? 'INCONCLUSIVE' : 'FAIL';
  else if (counts.UNRESOLVED_TIMEOUT > 0) verdict = 'NO_EFFECT_UNRESOLVED';
  else verdict = 'PASS';
  return {verdict, counts, explicitDenials: explicit, unresolved: counts.UNRESOLVED_TIMEOUT, transportBlocked: counts.TRANSPORT_BLOCKED, noBridge: counts.NO_BRIDGE, sideEffectsClean: clean, rows};
}

// Browser-side helper source: runs each invoke with a deadline and reports raw facts only.
// Injected verbatim into the preview window and the sandboxed project frame by the harness.
// Single object argument so harnesses can pass it straight to Playwright's evaluate (no eval).
const PROBE_SOURCE = `async ({commands, timeoutMs}) => {
  const internals = window.__TAURI_INTERNALS__;
  const transport = {fetch: [], cspViolations: 0};
  const origFetch = window.fetch;
  try { window.fetch = function (url, init) { transport.fetch.push(String(url).replace(/[0-9a-f]{32}/g, '<token>').slice(0, 80)); return origFetch.apply(this, arguments); }; } catch (e) { transport.fetchWrap = 'blocked:' + e.name; }
  document.addEventListener('securitypolicyviolation', () => { transport.cspViolations++; });
  const results = [];
  for (const [command, args] of commands) {
    const started = performance.now();
    if (!internals || typeof internals.invoke !== 'function') { results.push({command, status: 'no-bridge', ms: 0}); continue; }
    const before = {fetch: transport.fetch.length, csp: transport.cspViolations};
    let outcome;
    try {
      outcome = await Promise.race([
        internals.invoke(command, args).then(value => ({status: 'resolved', value: JSON.stringify(value).slice(0, 120)}), error => ({status: 'rejected', error: String(error && error.message || error).slice(0, 240)})),
        new Promise(resolve => setTimeout(() => resolve({status: 'timeout'}), timeoutMs))
      ]);
    } catch (error) { outcome = {status: 'threw', error: String(error && error.message || error).slice(0, 240)}; }
    outcome.ms = Math.round(performance.now() - started);
    await new Promise(resolve => setTimeout(resolve, 50));
    outcome.transport = {customProtocolFetches: transport.fetch.length - before.fetch, cspViolations: transport.cspViolations - before.csp};
    results.push({command, ...outcome});
  }
  try { window.fetch = origFetch; } catch {}
  return {bridge: [typeof window.__TAURI__, typeof internals, typeof window.ipc, typeof (window.chrome && window.chrome.webview)].join('/'), origin: String(self.origin), results};
}`;

module.exports = {CLASSES, classify, summarize, PROBE_SOURCE};
