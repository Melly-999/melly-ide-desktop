export const FILE_STORE_DB_NAME = 'mobileide-editor';
export const FILE_STORE_DB_VERSION = 1;
export const FILE_STORE_RECORD_VERSION = 1;
export const FILE_STORE_NAME = 'files';

function outcomeError(error, fallbackCode = 'storage_error') {
  const name = error?.name || '';
  const code = name === 'QuotaExceededError'
    ? 'quota_exceeded'
    : name === 'AbortError'
      ? 'transaction_aborted'
      : name === 'VersionError'
        ? 'unsupported_database_version'
        : name === 'SecurityError' || name === 'InvalidStateError'
          ? 'storage_unavailable'
          : fallbackCode;

  const messages = {
    quota_exceeded: 'Browser storage quota was exceeded. Free local storage space and retry Save.',
    transaction_aborted: 'The browser aborted the local save transaction. Your in-memory edit is still available; retry Save.',
    unsupported_database_version: 'This browser contains a newer, incompatible Melly IDE storage database. Existing data was not changed.',
    storage_unavailable: 'Browser-local storage is unavailable or access was denied. Keep this page open to preserve in-memory edits.',
    storage_error: 'Browser-local storage failed. Your in-memory edit is still available; retry Save.'
  };

  return {
    ok: false,
    code,
    message: messages[code] || messages.storage_error,
    error
  };
}

export function createFileRecord(filename, content, revision, updatedAt = new Date().toISOString()) {
  return {
    schemaVersion: FILE_STORE_RECORD_VERSION,
    filename,
    content,
    revision,
    updatedAt
  };
}

export function validateFileRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, code: 'corrupt_record', message: 'Stored file record is not an object.' };
  }
  if (record.schemaVersion !== FILE_STORE_RECORD_VERSION) {
    return {
      ok: false,
      code: 'unsupported_schema_version',
      message: `Stored schema version ${String(record.schemaVersion)} is not supported.`,
      filename: typeof record.filename === 'string' ? record.filename : null
    };
  }
  if (typeof record.filename !== 'string' || record.filename.length === 0
    || typeof record.content !== 'string'
    || !Number.isInteger(record.revision) || record.revision < 0
    || typeof record.updatedAt !== 'string' || record.updatedAt.length === 0) {
    return {
      ok: false,
      code: 'corrupt_record',
      message: 'Stored file record has invalid fields.',
      filename: typeof record.filename === 'string' ? record.filename : null
    };
  }

  return { ok: true, record: { ...record } };
}

export class IndexedDbFileStore {
  constructor(options = {}) {
    this.indexedDB = options.indexedDB ?? globalThis.indexedDB;
    this.dbName = options.dbName || FILE_STORE_DB_NAME;
    this.now = options.now || (() => new Date().toISOString());
    this.db = null;
  }

  async init() {
    if (this.db) return { ok: true };
    if (!this.indexedDB || typeof this.indexedDB.open !== 'function') {
      return outcomeError(null, 'storage_unavailable');
    }

    return new Promise(resolve => {
      let request;
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      try {
        request = this.indexedDB.open(this.dbName, FILE_STORE_DB_VERSION);
      } catch (error) {
        finish(outcomeError(error, 'storage_unavailable'));
        return;
      }

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(FILE_STORE_NAME)) {
          database.createObjectStore(FILE_STORE_NAME, { keyPath: 'filename' });
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        this.db.onversionchange = () => {
          this.db?.close();
          this.db = null;
        };
        finish({ ok: true });
      };
      request.onerror = () => finish(outcomeError(request.error, 'storage_unavailable'));
      request.onblocked = () => finish({
        ok: false,
        code: 'storage_blocked',
        message: 'Browser-local storage upgrade is blocked by another open Melly IDE tab. Close the other tab and retry.'
      });
    });
  }

  async loadFiles(allowedFilenames = []) {
    const ready = await this.init();
    if (!ready.ok) return ready;

    return new Promise(resolve => {
      let transaction;
      let request;
      let records = [];
      const allowed = new Set(allowedFilenames);
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      try {
        transaction = this.db.transaction(FILE_STORE_NAME, 'readonly');
        request = transaction.objectStore(FILE_STORE_NAME).getAll();
      } catch (error) {
        finish(outcomeError(error));
        return;
      }

      request.onsuccess = () => { records = request.result || []; };
      request.onerror = () => finish(outcomeError(request.error));
      transaction.onabort = () => finish(outcomeError(transaction.error || request.error));
      transaction.onerror = () => finish(outcomeError(transaction.error || request.error));
      transaction.oncomplete = () => {
        const files = {};
        const issues = [];

        for (const candidate of records) {
          const validated = validateFileRecord(candidate);
          if (!validated.ok) {
            issues.push(validated);
            continue;
          }
          const record = validated.record;
          if (allowed.size > 0 && !allowed.has(record.filename)) {
            issues.push({
              ok: false,
              code: 'unknown_file',
              filename: record.filename,
              message: `Stored file ${record.filename} is not part of this editor and was left unchanged.`
            });
            continue;
          }
          files[record.filename] = record;
        }

        finish({ ok: true, files, issues });
      };
    });
  }

  async saveFile({ filename, content, revision }) {
    if (typeof filename !== 'string' || filename.length === 0
      || typeof content !== 'string'
      || !Number.isInteger(revision) || revision < 0) {
      return {
        ok: false,
        code: 'invalid_save_request',
        message: 'The local save request was invalid. The in-memory edit was not changed.'
      };
    }

    const ready = await this.init();
    if (!ready.ok) return ready;
    const record = createFileRecord(filename, content, revision, this.now());

    return new Promise(resolve => {
      let transaction;
      let request;
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      try {
        transaction = this.db.transaction(FILE_STORE_NAME, 'readwrite');
        request = transaction.objectStore(FILE_STORE_NAME).put(record);
      } catch (error) {
        finish(outcomeError(error));
        return;
      }

      request.onerror = () => finish(outcomeError(request.error));
      transaction.onabort = () => finish(outcomeError(transaction.error || request.error));
      transaction.onerror = () => finish(outcomeError(transaction.error || request.error));
      transaction.oncomplete = () => finish({ ok: true, record });
    });
  }

  async readBackupRecords() {
    const ready = await this.init(); if (!ready.ok) return ready;
    return new Promise(resolve => {
      const tx = this.db.transaction(FILE_STORE_NAME, 'readonly');
      const request = tx.objectStore(FILE_STORE_NAME).getAll();
      tx.oncomplete = () => resolve({ok:true,records:request.result});
      tx.onabort = tx.onerror = () => resolve(outcomeError(tx.error));
    });
  }

  async restoreBackup(records, baseline, guard) {
    const ready = await this.init(); if (!ready.ok) return ready;
    return new Promise(resolve => {
      let tx; let reason='Storage write failed; no import was committed.';
      try {
        tx=this.db.transaction(FILE_STORE_NAME,'readwrite');
        const store=tx.objectStore(FILE_STORE_NAME); const request=store.getAll(); const written=[];
        request.onsuccess=()=>{
          try {
            if (!guard()) {reason='Preview is stale. Cancel and select the backup again.';tx.abort();return;}
            for(const incoming of records) {
              const current=request.result.find(r=>r.filename===incoming.filename);
              const expected=baseline.find(r=>r.filename===incoming.filename);
              if(JSON.stringify(current)!==JSON.stringify(expected)) {reason='Stored file changed after preview. Cancel and preview again.';tx.abort();return;}
            }
            for(const incoming of records) {
              const current=request.result.find(r=>r.filename===incoming.filename);
              const revision=Math.max(Number.isSafeInteger(current?.revision)?current.revision:0,incoming.revision)+1;
              if(!Number.isSafeInteger(revision))throw new Error('Revision limit reached.');
              const record=createFileRecord(incoming.filename,incoming.content,revision,this.now());
              written.push(record);store.put(record);
            }
          } catch(error) {reason=error.message;tx.abort();}
        };
        tx.oncomplete=()=>resolve({ok:true,records:written});
        tx.onabort=tx.onerror=()=>resolve({ok:false,code:'import_failed',message:reason});
      } catch(error) {try{tx?.abort();}catch{}resolve(outcomeError(error));}
    });
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}
