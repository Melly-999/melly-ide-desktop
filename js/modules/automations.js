import { defaultAutomations } from '../data/samples.js';
import { getAutomationRunResult } from './simulation.js';

const STORAGE_KEY = 'raycast_automations_v1';

export class AutomationsManager {
  constructor() {
    this.automations = this.loadAutomations();
    this.runLogs = [];
  }

  loadAutomations() {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(STORAGE_KEY);
        // Earlier versions stored fabricated "last run" labels; keep only
        // markers written by the simulated runner.
        if (saved) {
          return JSON.parse(saved).map(a => ({
            ...a,
            lastRun: typeof a.lastRun === 'string' && a.lastRun.startsWith('Simulated') ? a.lastRun : 'Never'
          }));
        }
      }
    } catch (e) {
      console.warn('Could not read automations from localStorage', e);
    }
    return [...defaultAutomations];
  }

  save() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.automations));
      }
    } catch (e) {
      console.warn('Could not save automations to localStorage', e);
    }
  }

  getAll() {
    return this.automations;
  }

  get(id) {
    return this.automations.find(a => a.id === id);
  }

  toggleActive(id) {
    const item = this.get(id);
    if (item) {
      item.active = !item.active;
      this.save();
    }
    return item;
  }

  add(automation) {
    const newAuto = {
      id: 'auto-' + Date.now(),
      name: automation.name || 'New Automation',
      schedule: automation.schedule || 'Every day at 09:00',
      prompt: automation.prompt || 'Summarize active workspace files.',
      active: true,
      lastRun: 'Never'
    };
    this.automations.unshift(newAuto);
    this.save();
    return newAuto;
  }

  // Nothing is executed here: there is no scheduler or agent runtime. The only
  // real effect is recording a "simulated" last-run marker.
  runNow(id) {
    const item = this.get(id);
    if (!item) return null;
    const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    item.lastRun = `Simulated at ${nowStr}`;
    this.save();
    const result = {
      automationId: id,
      name: item.name,
      timestamp: new Date().toISOString(),
      ...getAutomationRunResult(item.name, item.prompt)
    };
    this.runLogs.unshift(result);
    return result;
  }
}

export const automationsManager = new AutomationsManager();
