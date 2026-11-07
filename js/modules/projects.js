import { defaultProjects } from '../data/samples.js';

const STORAGE_KEY = 'raycast_projects_v1';

export class ProjectsManager {
  constructor() {
    this.projects = this.loadProjects();
  }

  loadProjects() {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) return JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Could not read projects from localStorage', e);
    }
    return [...defaultProjects];
  }

  save() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.projects));
      }
    } catch (e) {
      console.warn('Could not save projects to localStorage', e);
    }
  }

  getAll() {
    return this.projects;
  }

  get(id) {
    return this.projects.find(p => p.id === id);
  }

  add(project) {
    const newProj = {
      id: 'proj-' + Date.now(),
      name: project.name || 'Untitled Project',
      description: project.description || '',
      memory: project.memory || '',
      chatsCount: 0,
      updatedAt: 'Just now'
    };
    this.projects.unshift(newProj);
    this.save();
    return newProj;
  }

  updateMemory(id, memory) {
    const proj = this.get(id);
    if (proj) {
      proj.memory = memory;
      proj.updatedAt = 'Just now';
      this.save();
    }
    return proj;
  }
}

export const projectsManager = new ProjectsManager();
