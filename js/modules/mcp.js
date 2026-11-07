import { defaultMcpServers } from '../data/samples.js';

const STORAGE_KEY = 'raycast_mcp_v1';

// This module is only a local registry: there is no MCP client, so no server
// is ever actually connected. 'unverified' means "registered, never contacted".
// Entries persisted by earlier versions may still say 'connected'; normalize
// them so a status that never had evidence cannot survive a reload.
function normalizeStatus(status) {
  return status === 'disabled' ? 'disabled' : 'unverified';
}

export class McpManager {
  constructor() {
    this.servers = this.loadServers();
  }

  loadServers() {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) return JSON.parse(saved).map(s => ({ ...s, status: normalizeStatus(s.status) }));
      }
    } catch (e) {
      console.warn('Could not read MCP from localStorage', e);
    }
    return defaultMcpServers.map(s => ({ ...s, status: normalizeStatus(s.status) }));
  }

  save() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.servers));
      }
    } catch (e) {
      console.warn('Could not save MCP to localStorage', e);
    }
  }

  getAll() {
    return this.servers;
  }

  get(id) {
    return this.servers.find(s => s.id === id);
  }

  add(server) {
    const newServer = {
      id: 'mcp-' + Date.now(),
      name: server.name || 'Custom MCP Server',
      url: server.url || 'http://localhost:8080/sse',
      status: 'unverified',
      toolsCount: server.toolsCount || 3,
      description: server.description || 'Custom Model Context Protocol endpoint'
    };
    this.servers.unshift(newServer);
    this.save();
    return newServer;
  }

  toggleStatus(id) {
    const s = this.get(id);
    if (s) {
      s.status = s.status === 'disabled' ? 'unverified' : 'disabled';
      this.save();
    }
    return s;
  }

  delete(id) {
    this.servers = this.servers.filter(s => s.id !== id);
    this.save();
  }
}

export const mcpManager = new McpManager();
