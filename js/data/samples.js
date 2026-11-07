export const initialFiles = {
  'main.js': `// main.js - Interactive Animation Loop
let angle = 0;
const DEGREES_PER_SECOND = 90;
let lastTime = null;
let frameId = null;

const art = {
  style: {
    transform: 'rotate(0deg)'
  }
};

const step = (time) => {
  if (lastTime !== null) {
    angle = (angle + DEGREES_PER_SECOND * (time - lastTime) / 1000) % 360;
    art.style.transform = \`rotate(\${angle.toFixed(1)}deg)\`;
  }
  lastTime = time;
  frameId = requestAnimationFrame(step);
};

export const start = () => {
  if (frameId !== null) return;
  lastTime = null;
  frameId = requestAnimationFrame(step);
  console.log("Animation started at", new Date().toLocaleTimeString());
};

export const stop = () => {
  if (frameId === null) return;
  cancelAnimationFrame(frameId);
  frameId = null;
  console.log("Animation paused at", new Date().toLocaleTimeString());
};

export const getAngle = () => angle;
`,

  'NetworkService.swift': `import Foundation

// Safe Collection Subscript
extension Collection {
    subscript(safe i: Index) -> Element? {
        return indices.contains(i) ? self[i] : nil
    }
}

// Example usage:
// [1, 2, 3][safe: 10] // -> nil, not a crash

// Robust Retry Logic
func retry<T>(
    _ times: Int, 
    delay: TimeInterval = 0.5,
    _ work: () throws -> T
) rethrows -> T {
    var lastError: Error?
    for attempt in 0..<times {
        do { 
            return try work() 
        } catch {
            lastError = error
            if attempt < times - 1 {
                Thread.sleep(forTimeInterval: delay)
            }
        }
    }
    throw lastError!
}

// Swift's beauty comes from its type safety,
// protocol-oriented design, expressive pattern
// matching, and modern concurrency.
`
};

export const defaultProjects = [
  {
    id: 'proj-1',
    name: 'Mobile AI Companion',
    description: 'Mobile-first editor prototype with simulated chat and voice input; code execution is unavailable.',
    memory: 'Target stack: Modern JS & Swift. Emphasize offline resilience and instant previews.',
    chatsCount: 14,
    updatedAt: 'Just now'
  },
  {
    id: 'proj-2',
    name: 'Melly IDE Workflow Sandbox',
    description: 'Local workspace records, simulated MCP endpoints, and command palette tools.',
    memory: 'Keep commands snappy (<100ms UI response) with keyboard-first shortcuts.',
    chatsCount: 8,
    updatedAt: '2 hours ago'
  }
];

export const defaultSkills = [
  {
    id: 'skill-1',
    name: 'Swift Concurrency & Architecture',
    description: 'Give AI reusable knowledge about Swift 6 sendable rules, Actors, and SwiftUI state.',
    rules: [
      'Prefer async/await over completion closures.',
      'Always enforce safe subscripts for array bounds protection.',
      'Use structured concurrency (TaskGroup) for parallel execution.'
    ],
    updatedAt: 'Yesterday'
  },
  {
    id: 'skill-2',
    name: 'Clean JavaScript / TypeScript',
    description: 'Guidelines for functional composition, clean error handling, and zero memory leaks.',
    rules: [
      'Ensure requestAnimationFrame loops cancel their frameId on stop.',
      'Pure functions for state transformations; isolate side effects.',
      'Provide full JSDoc / TypeScript typing for public exports.'
    ],
    updatedAt: '3 days ago'
  },
  {
    id: 'skill-3',
    name: 'Mobile UX & Touch Target Best Practices',
    description: 'Design rules for thumb-friendly mobile coding bars and quick keys.',
    rules: [
      'Minimum touch target of 44x44px for on-screen code keys.',
      'Quick access to matching braces, tabs, and undo/redo stacks.'
    ],
    updatedAt: 'Oct 14'
  }
];

export const defaultMcpServers = [
  {
    id: 'mcp-1',
    name: 'GitHub MCP Server',
    url: 'https://mcp.github.com/v1',
    status: 'unverified',
    toolsCount: 18,
    description: 'Read repos, inspect PRs, query commits, and apply code diffs directly.'
  },
  {
    id: 'mcp-2',
    name: 'Filesystem Sandboxed MCP',
    url: 'mcp://localhost/workspace',
    status: 'unverified',
    toolsCount: 6,
    description: 'Safe workspace file read, write, directory listing, and file diffing.'
  },
  {
    id: 'mcp-3',
    name: 'SQLite / DB Schema MCP',
    url: 'mcp://localhost/sqlite',
    status: 'unverified',
    toolsCount: 5,
    description: 'Inspect schemas, run read-only test queries, and validate data types.'
  },
  {
    id: 'mcp-4',
    name: 'Web Documentation Fetcher',
    url: 'https://mcp.docs-search.internal',
    status: 'unverified',
    toolsCount: 4,
    description: 'Fetch official language specs and framework manuals on demand.'
  }
];

export const defaultAgents = [
  {
    id: 'agent-1',
    name: 'Code Reviewer Pro',
    role: 'Senior Staff Engineer',
    systemPrompt: 'Review code for edge cases, performance bottlenecks, concurrency race conditions, and clean patterns.',
    icon: 'user-check',
    runsCount: 42
  },
  {
    id: 'agent-2',
    name: 'Swift & iOS Architect',
    role: 'Apple Ecosystem Specialist',
    systemPrompt: 'Guide SwiftUI, Combine, SwiftData, and async architecture with idiomatic Apple design standards.',
    icon: 'smartphone',
    runsCount: 29
  },
  {
    id: 'agent-3',
    name: 'Refactoring & Bug Hunter',
    role: 'Automated Diagnostic Specialist',
    systemPrompt: 'Detect bugs in JavaScript/Swift/Python, generate safe patches, and verify unit test passes.',
    icon: 'shield-alert',
    runsCount: 37
  }
];

export const defaultAutomations = [
  {
    id: 'auto-1',
    name: 'Morning Workspace Code Audit',
    schedule: 'Every day at 08:30 AM',
    prompt: 'Analyze active files for unhandled exceptions, unused variables, and console leaks.',
    active: true,
    lastRun: 'Never'
  },
  {
    id: 'auto-2',
    name: 'Weekly Dependency & Security Scan',
    schedule: 'Mondays at 00:00 UTC',
    prompt: 'Check imported packages for outdated versions and known security advisories.',
    active: true,
    lastRun: 'Never'
  },
  {
    id: 'auto-3',
    name: 'Automated PR Summary Builder',
    schedule: 'On git commit & push',
    prompt: 'Summarize commit delta and format high-level release notes for team review.',
    active: false,
    lastRun: 'Never'
  }
];

export const defaultCommands = [
  {
    id: 'cmd-1',
    name: 'Explain Code',
    description: 'Deconstruct active file or selection with step-by-step breakdown.',
    icon: 'book-open',
    prompt: 'Explain how this code works in simple, clear terms with practical examples.'
  },
  {
    id: 'cmd-2',
    name: 'Find Bugs & Patch',
    description: 'Spot subtle edge cases, crashes, and propose fixed code.',
    icon: 'bug',
    prompt: 'Audit this code for edge cases, potential crashes, and provide the corrected code.'
  },
  {
    id: 'cmd-3',
    name: 'Generate Unit Tests',
    description: 'Produce high-coverage test cases for edge cases and happy path.',
    icon: 'check-circle-2',
    prompt: 'Write clean unit test suites covering edge cases and assertion boundaries.'
  },
  {
    id: 'cmd-4',
    name: 'Optimize Performance',
    description: 'Reduce algorithmic complexity and prevent memory leaks.',
    icon: 'zap',
    prompt: 'Benchmark complexity and optimize memory allocation and execution speed.'
  }
];

export const defaultExtensions = [
  {
    id: 'ext-1',
    name: 'GitHub Integrations',
    category: 'Developer Tools',
    installed: true,
    description: 'Browse pull requests, issues, and workflow runs without leaving chat.'
  },
  {
    id: 'ext-2',
    name: 'Figma to Code',
    category: 'Design & UI',
    installed: true,
    description: 'Inspect design tokens and transform UI frames into clean CSS and SwiftUI.'
  },
  {
    id: 'ext-3',
    name: 'Terminal & CLI Runner',
    category: 'Execution',
    installed: true,
    description: 'Run shell tasks, build scripts, and view real-time log outputs.'
  }
];
