import { getScreenAnalysisResult } from './simulation.js';

export class ScreenAwarenessManager {
  constructor() {
    this.history = [];
  }

  // The image is never inspected (no vision provider exists), so this returns
  // an explicit "not performed" result with no findings instead of canned ones.
  analyzeScreen(imageDataUrl, prompt) {
    const result = getScreenAnalysisResult(
      prompt || 'Analyze this UI screen for layout issues, accessible contrast, and code structure.'
    );
    const analysis = {
      id: 'screen-' + Date.now(),
      timestamp: new Date().toISOString(),
      ...result,
      detectedComponents: result.findings,
      aiFeedback: result.summary,
      suggestedFix: null
    };
    this.history.unshift(analysis);
    return analysis;
  }
}

export const screenAwarenessManager = new ScreenAwarenessManager();
