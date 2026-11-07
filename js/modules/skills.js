import { defaultSkills } from '../data/samples.js';

const STORAGE_KEY = 'raycast_skills_v1';

export class SkillsManager {
  constructor() {
    this.skills = this.loadSkills();
    this.activeSkillIds = new Set(this.skills.map(s => s.id));
  }

  loadSkills() {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) return JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Could not read skills from localStorage', e);
    }
    return [...defaultSkills];
  }

  save() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.skills));
      }
    } catch (e) {
      console.warn('Could not save skills to localStorage', e);
    }
  }

  getAll() {
    return this.skills;
  }

  get(id) {
    return this.skills.find(s => s.id === id);
  }

  toggleActive(id) {
    if (this.activeSkillIds.has(id)) {
      this.activeSkillIds.delete(id);
    } else {
      this.activeSkillIds.add(id);
    }
    return this.activeSkillIds.has(id);
  }

  isActive(id) {
    return this.activeSkillIds.has(id);
  }

  add(skill) {
    const newSkill = {
      id: 'skill-' + Date.now(),
      name: skill.name || 'New Custom Skill',
      description: skill.description || 'Custom reusable agent instructions',
      rules: Array.isArray(skill.rules) ? skill.rules : (skill.rules ? skill.rules.split('\n').filter(r => r.trim()) : []),
      updatedAt: 'Just now'
    };
    this.skills.unshift(newSkill);
    this.activeSkillIds.add(newSkill.id);
    this.save();
    return newSkill;
  }

  delete(id) {
    this.skills = this.skills.filter(s => s.id !== id);
    this.activeSkillIds.delete(id);
    this.save();
  }

  getActiveInstructions() {
    const active = this.skills.filter(s => this.activeSkillIds.has(s.id));
    if (!active.length) return '';
    return active.map(s => `[Skill: ${s.name}]\n${s.rules.map(r => `- ${r}`).join('\n')}`).join('\n\n');
  }
}

export const skillsManager = new SkillsManager();
