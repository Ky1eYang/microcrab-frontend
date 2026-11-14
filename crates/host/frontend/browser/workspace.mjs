// Durable per-owner, per-Conversation browser storage. No credentials enter the
// execution realm. A write is acknowledged only after its IDB transaction commits.
import { sameScope } from './receipts.mjs';
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_WORKSPACE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 4096;
const encoder = new TextEncoder();
export function fault(code, message) { return Object.assign(new Error(message), { code }); }
export function pathOf(input) {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.length > 4096)
    throw fault('invalid_request', 'Invalid workspace path');
  const path = input.startsWith('/') ? input : `/workspace/${input}`;
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw fault('denied', 'Path leaves workspace'); parts.pop(); }
    else parts.push(part);
  }
  if (parts[0] !== 'workspace') throw fault('denied', 'Path leaves workspace');
  return '/' + parts.join('/');
}
export async function digest(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result); req.onerror = () => reject(fault(req.error?.name === 'QuotaExceededError' ? 'limit' : 'io', `Browser storage request failed: ${req.error?.name ?? 'UnknownError'}`));
});
const complete = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onabort = () => reject(fault(tx.error?.name === 'QuotaExceededError' ? 'limit' : 'io', `Browser storage transaction aborted before commit: ${tx.error?.name ?? 'AbortError'}`));
});
export class Workspace {
  constructor(db, namespace) { this.db = db; this.namespace = namespace; }
  static async open(identity) {
    if (!globalThis.indexedDB || !globalThis.navigator?.locks)
      throw fault('unsupported', 'Persistent browser storage and Web Locks are required');
    const namespace = await digest(JSON.stringify(identity));
    const opening = indexedDB.open('microcrab.browser-host.v1', 1);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      db.createObjectStore('files', { keyPath: ['namespace', 'path'] });
      db.createObjectStore('receipts', { keyPath: ['namespace', 'operation_id'] });
      db.createObjectStore('meta', { keyPath: 'namespace' });
    };
    return new Workspace(await request(opening), namespace);
  }
  async lease() {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let acquired;
    const ready = new Promise((resolve, reject) => { acquired = { resolve, reject }; });
    this.lock = navigator.locks.request(`microcrab.browser-host:${this.namespace}`, { ifAvailable: true }, async lock => {
      if (!lock) { acquired.reject(fault('conflict', 'This Conversation is active in another tab')); return; }
      acquired.resolve(); await held;
    });
    this.release = release;
    await ready;
  }
  range() { return IDBKeyRange.bound([this.namespace, ''], [this.namespace, '\uffff']); }
  async files() {
    const tx = this.db.transaction('files', 'readonly');
    const result = await request(tx.objectStore('files').getAll(this.range(), MAX_FILES + 1));
    if (result.length > MAX_FILES) throw fault('limit', 'Browser workspace file count exceeds its quota');
    return result;
  }
  async file(input) {
    const path = pathOf(input);
    return request(this.db.transaction('files', 'readonly').objectStore('files').get([this.namespace, path]));
  }
  async write(input, bytes, precondition, kind = 'file', receipt = null, signal) {
    const path = pathOf(input);
    if (path === '/workspace') throw fault('invalid_request', 'Cannot replace workspace root');
    const data = new Uint8Array(bytes);
    if (data.byteLength > MAX_FILE_BYTES) throw fault('limit', 'Browser file exceeds its quota');
    const version = await digest(data);
    // The workspace lease serializes this owner against other tabs. Serialize
    // local publication too, including execution-realm filesystem notifications.
    const output = { version, bytes: data.byteLength };
    const publish = async () => {
      if (signal?.aborted) throw signal.reason ?? fault('cancelled', 'Write cancelled before commit');
      const tx = this.db.transaction(receipt ? ['files', 'meta', 'receipts'] : ['files', 'meta'], 'readwrite');
      const done = complete(tx), files = tx.objectStore('files'), meta = tx.objectStore('meta');
      try {
        const old = await request(files.get([this.namespace, path]));
        const state = await request(meta.get(this.namespace)) ?? { namespace: this.namespace, bytes: 0, count: 0 };
        if (precondition && ((precondition === 'missing' && old) || (typeof precondition === 'object' && precondition.version !== old?.version))) throw fault('conflict', 'File version changed');
        state.bytes += data.byteLength - (old?.data.byteLength ?? 0); state.count += old ? 0 : 1;
        if (state.bytes > MAX_WORKSPACE_BYTES || state.count > MAX_FILES) throw fault('limit', 'Browser workspace quota exceeded');
        if (receipt) await this.stageReceipt(tx, state, { ...receipt, state: { state: 'completed', result: { Ok: output } } });
        if (signal?.aborted) throw signal.reason ?? fault('cancelled', 'Write cancelled before commit');
        files.put({ namespace: this.namespace, path, data, version, kind }); meta.put(state);
        await done;
        return output;
      } catch (error) {
        try { tx.abort(); } catch {}
        await done.catch(() => {}); throw error;
      }
    };
    const pending = (this.serial ?? Promise.resolve()).then(publish);
    this.serial = pending.catch(() => {}); return pending;
  }
  async remove(input) {
    const path = pathOf(input);
    const publish = async () => {
      const tx = this.db.transaction(['files', 'meta'], 'readwrite'); const done = complete(tx);
      const files = tx.objectStore('files'), meta = tx.objectStore('meta');
      const old = await request(files.get([this.namespace, path]));
      if (old) {
        const state = await request(meta.get(this.namespace));
        state.bytes -= old.data.byteLength; state.count--; meta.put(state); files.delete([this.namespace, path]);
      }
      await done;
    };
    const pending = (this.serial ?? Promise.resolve()).then(publish);
    this.serial = pending.catch(() => {}); return pending;
  }
  async rename(fromInput, toInput) {
    const from = pathOf(fromInput), to = pathOf(toInput);
    // A successful same-path MEMFS rename still reaches this observer. It must
    // not count the retained entries as overwritten destination files.
    if (from === to) return;
    if (from === '/workspace' || to === '/workspace' || to.startsWith(from + '/')) throw fault('denied', 'Invalid workspace rename');
    const publish = async () => {
      const tx = this.db.transaction(['files', 'meta'], 'readwrite'), done = complete(tx);
      const files = tx.objectStore('files'), meta = tx.objectStore('meta');
      const root = await request(files.get([this.namespace, from]));
      const children = await request(files.getAll(IDBKeyRange.bound([this.namespace, from + '/'], [this.namespace, from + '/\uffff']), MAX_FILES + 1));
      const entries = root ? [root, ...children] : children;
      const state = await request(meta.get(this.namespace));
      for (const entry of entries) {
        const path = to + entry.path.slice(from.length);
        const previous = await request(files.get([this.namespace, path]));
        if (previous) { state.bytes -= previous.data.byteLength; state.count--; }
        files.delete([this.namespace, entry.path]); files.put({ ...entry, path });
      }
      if (state) meta.put(state); await done;
    };
    const pending = (this.serial ?? Promise.resolve()).then(publish); this.serial = pending.catch(() => {}); return pending;
  }
  async receipt(id) {
    const value = await request(this.db.transaction('receipts', 'readonly').objectStore('receipts').get([this.namespace, id]));
    if (!value) return undefined;
    const { namespace, _completion_padding, ...receipt } = value; return receipt;
  }
  async checkReceiptCapacity(count, bytes) {
    await this.serial;
    const state = await request(this.db.transaction('meta', 'readonly').objectStore('meta').get(this.namespace));
    if ((state?.receiptCount ?? 0) + count > 4096 || (state?.receiptBytes ?? 0) + bytes > MAX_WORKSPACE_BYTES)
      throw fault('limit', 'Whole patch exceeds browser receipt retention quota before publication');
  }
  // The caller owns this transaction and its meta snapshot. File operations use
  // this port so publication, quota accounting and completion are one commit.
  async stageReceipt(tx, state, value, reserveBytes = 0) {
    const receipts = tx.objectStore('receipts');
    const previous = await request(receipts.get([this.namespace, value.operation_id]));
    if (previous) {
      if (previous.payload_digest !== value.payload_digest || !sameScope(previous.scope, value.scope)) throw fault('operation_conflict', 'Original browser receipt payload or scope changed');
      if (!['intent', 'indeterminate'].includes(previous.state.state) && JSON.stringify(previous.state) !== JSON.stringify(value.state)) throw fault('operation_conflict', 'Settled browser receipt cannot be replaced');
      if (value.state.state === 'intent') throw fault('operation_conflict', 'Original browser effect was already admitted');
    }
    const stored = { ...value, namespace: this.namespace };
    // Actual persisted padding reserves physical storage as well as logical quota
    // for non-IDB effects. It never leaves the private storage owner.
    if (reserveBytes) stored._completion_padding = ' '.repeat(reserveBytes);
    state.receiptCount = (state.receiptCount ?? 0) + (previous ? 0 : 1);
    state.receiptBytes = (state.receiptBytes ?? 0) + encoder.encode(JSON.stringify(stored)).byteLength - (previous ? encoder.encode(JSON.stringify(previous)).byteLength : 0);
    if (state.receiptCount > 4096 || state.receiptBytes > MAX_WORKSPACE_BYTES) throw fault('limit', 'Browser receipt retention quota exceeded');
    receipts.put(stored);
  }
  async record(value, reserveBytes = 0) {
    const publish = async () => {
      const tx = this.db.transaction(['receipts', 'meta'], 'readwrite'), done = complete(tx);
      try {
        const meta = tx.objectStore('meta');
        const state = await request(meta.get(this.namespace)) ?? { namespace: this.namespace, bytes: 0, count: 0 };
        await this.stageReceipt(tx, state, value, reserveBytes);
        meta.put(state); await done;
      } catch (error) {
        try { tx.abort(); } catch {}
        await done.catch(() => {}); throw error;
      }
    };
    const pending = (this.serial ?? Promise.resolve()).then(publish); this.serial = pending.catch(() => {}); return pending;
  }
  async receipts() {
    const values = await request(this.db.transaction('receipts', 'readonly').objectStore('receipts').getAll(this.range(), 4097));
    if (values.length > 4096) throw fault('limit', 'Browser receipt retention requires explicit cleanup');
    return values.map(({ namespace, _completion_padding, ...value }) => value);
  }
  async close() { await this.serial; this.release?.(); await this.lock; this.db.close(); }
}
