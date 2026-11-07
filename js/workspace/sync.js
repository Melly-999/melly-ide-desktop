// Metadata only. Each pending operation is bound to the authenticated subject and project.
export class MetadataQueue {
  constructor({load, save, transport}) { this.load = load; this.save = save; this.transport = transport; this.status = 'disconnected'; this.flushing = false; this.pending = Promise.resolve(); }
  serialize(action) { const next = this.pending.catch(() => {}).then(action); this.pending = next; return next; }
  async enqueue({subject, project, localId, name, expectedRevision}) {
    if (this.flushing) throw new Error('Synchronization in progress. Retry enqueue after it completes.');
    if (![subject, project, localId, name].every(s => typeof s === 'string' && s.length > 0 && s.length <= 200) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Invalid metadata operation.');
    return this.serialize(async () => {
      const pending = await this.load(); if (pending.length >= 100) throw new Error('Sync queue is full. Resolve pending operations.');
      const operation = {subject, project, localId, name, expectedRevision, operationId: crypto.randomUUID(), state: 'pending'};
      await this.save([...pending, operation]); return operation;
    });
  }
  async flush({subject, approved}) {
    if (!approved) throw new Error('Explicit cloud mutation approval required.');
    return this.serialize(async () => {
      this.flushing = true;
      try {
      let queue = await this.load();
      for (const operation of [...queue]) {
        if (operation.subject !== subject || operation.state === 'conflict') continue;
        try {
          const {subject: _subject, state: _state, ...args} = operation;
          const result = await this.transport(args);
          if (result.ok === true) queue = queue.filter(o => o.operationId !== operation.operationId);
          else if (result.conflict) queue = queue.map(o => o.operationId === operation.operationId ? {...o, state: 'conflict', actual: result.actual} : o);
          else throw new Error('Unconfirmed metadata mutation.');
          await this.save(queue);
          this.status = queue.some(o => o.state === 'conflict') ? 'conflict' : 'connected';
        } catch (error) { this.status = 'disconnected'; throw error; }
      }
      return queue;
      } finally { this.flushing = false; }
    });
  }
}
