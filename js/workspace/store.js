import { clone, emptyWorkspace, validateWorkspace } from './model.js';

export const WORKSPACE_DB = 'melly-ide-workspaces';
export class WorkspaceStore {
  constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; this.db = null; }
  async open() {
    if (this.db) return;
    if (!this.indexedDB) throw new Error('Browser storage unavailable.');
    this.db = await new Promise((resolve, reject) => {
      const request = this.indexedDB.open(WORKSPACE_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); this.db = null; }; resolve(request.result); };
      request.onerror = () => reject(new Error('Workspace storage unavailable. Existing data was preserved.'));
      request.onblocked = () => reject(new Error('Close other workspace tabs and retry.'));
    });
  }
  async raw() {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('state', 'readonly'); const request = tx.objectStore('state').get('workspace');
      tx.oncomplete = () => resolve(request.result ?? emptyWorkspace());
      tx.onabort = tx.onerror = () => reject(new Error('Could not read workspace.'));
    });
  }
  async load() { return validateWorkspace(await this.raw()); }
  async save(state, expectedGeneration) {
    validateWorkspace(state); await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('state', 'readwrite'); const store = tx.objectStore('state'); const request = store.get('workspace');
      let failure, next;
      request.onsuccess = () => {
        try {
          const current = request.result ?? emptyWorkspace();
          validateWorkspace(current);
          if (current.generation !== expectedGeneration) throw new Error('Workspace changed in another tab. Export your in-memory copy, then reload to resolve the conflict.');
          next = {...clone(state), generation: expectedGeneration + 1}; validateWorkspace(next); store.put(next, 'workspace');
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(next);
      tx.onabort = tx.onerror = () => reject(failure || new Error('Workspace save failed. Keep this page open and export your copy.'));
    });
  }
}
