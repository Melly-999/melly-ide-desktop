// Single source of truth for what this prototype does NOT really do.
//
// Rule: a success/verification word (verified, passed, connected, compiled,
// executed) may only be shown when real evidence backs it. Nothing in this
// prototype executes code, talks to an AI provider, connects to MCP servers
// or runs schedules, so every surface that used to imply otherwise goes
// through the helpers below and is labeled SIMULATED or UNAVAILABLE.

export const SIMULATED_LABEL = 'SIMULATED';

export const EXECUTION_UNAVAILABLE_MESSAGE = 'Execution unavailable — sandbox not configured';

// Result of pressing "Run". Code is never executed: there is no isolated
// sandbox in this prototype, and running user code in the page context is unsafe.
export function getRunResult(filename) {
  return {
    status: 'unavailable',
    executed: false,
    filename,
    message: EXECUTION_UNAVAILABLE_MESSAGE,
    output:
      `${EXECUTION_UNAVAILABLE_MESSAGE}\n` +
      `${filename} was not run, compiled or tested. No result is available.`
  };
}

// Result of "Test Connection" on an MCP server entry. No MCP client exists,
// so nothing is ever contacted and no latency or connected state is reported.
export function getMcpTestResult() {
  return {
    status: 'not_tested',
    connected: false,
    label: `Not tested — no MCP client (${SIMULATED_LABEL})`
  };
}

// Result of triggering an automation. There is no scheduler or runner; the
// only thing that really happens is that a "last run" marker is recorded.
export function getAutomationRunResult(name, prompt) {
  return {
    status: 'simulated',
    executed: false,
    output:
      `[${SIMULATED_LABEL}] "${name}" was not executed. ` +
      `No scheduler or agent runtime exists in this prototype. Prompt on record: "${prompt}"`
  };
}

// Result of "Capture & Analyze Screen". The screen is never inspected.
export function getScreenAnalysisResult(prompt) {
  return {
    status: 'not_performed',
    simulated: true,
    prompt,
    findings: [],
    summary: `[${SIMULATED_LABEL}] No screen analysis was performed. No vision provider is configured, so there are no findings.`
  };
}

// Prefix for canned chat replies, so demo output is never mistaken for a model answer.
export function simulatedReplyHeader(agentName) {
  return `**[${SIMULATED_LABEL}] ${agentName}** — canned demo reply. No AI provider is configured; your prompt was only matched against keywords.`;
}
