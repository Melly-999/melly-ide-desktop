import { defaultAgents } from '../data/samples.js';

const STORAGE_KEY = 'raycast_agents_v1';

export class AgentsManager {
  constructor() {
    this.agents = this.loadAgents();
    this.activeAgentId = this.agents[0]?.id || 'agent-1';
  }

  loadAgents() {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) return JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Could not read agents from localStorage', e);
    }
    return [...defaultAgents];
  }

  save() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.agents));
      }
    } catch (e) {
      console.warn('Could not save agents to localStorage', e);
    }
  }

  getAll() {
    return this.agents;
  }

  get(id) {
    return this.agents.find(a => a.id === id);
  }

  getActive() {
    return this.get(this.activeAgentId) || this.agents[0];
  }

  setActive(id) {
    if (this.get(id)) {
      this.activeAgentId = id;
    }
  }

  add(agent) {
    const newAgent = {
      id: 'agent-' + Date.now(),
      name: agent.name || 'New Custom Agent',
      role: agent.role || 'Assistant Specialist',
      systemPrompt: agent.systemPrompt || 'You are a specialized coding agent.',
      icon: agent.icon || 'bot',
      runsCount: 0
    };
    this.agents.unshift(newAgent);
    this.save();
    return newAgent;
  }
}

export const agentsManager = new AgentsManager();
