import { defaultCommands } from '../data/samples.js';

const STORAGE_KEY = 'raycast_commands_v1';

export class CommandsManager {
  constructor() {
    this.commands = this.loadCommands();
  }

  loadCommands() {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) return JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Could not read commands from localStorage', e);
    }
    return [...defaultCommands];
  }

  save() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.commands));
      }
    } catch (e) {
      console.warn('Could not save commands to localStorage', e);
    }
  }

  getAll() {
    return this.commands;
  }

  get(id) {
    return this.commands.find(c => c.id === id);
  }

  add(cmd) {
    const newCmd = {
      id: 'cmd-' + Date.now(),
      name: cmd.name || 'Custom Command',
      description: cmd.description || 'Quick prompt shortcut',
      icon: cmd.icon || 'sparkles',
      prompt: cmd.prompt || 'Process the selected code.'
    };
    this.commands.unshift(newCmd);
    this.save();
    return newCmd;
  }

  delete(id) {
    this.commands = this.commands.filter(c => c.id !== id);
    this.save();
  }
}

export const commandsManager = new CommandsManager();
