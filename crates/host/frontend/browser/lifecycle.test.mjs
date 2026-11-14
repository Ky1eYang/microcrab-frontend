import test from 'node:test';
import assert from 'node:assert/strict';
import { Workspace, MAX_FILE_BYTES, MAX_WORKSPACE_BYTES } from './workspace.mjs';
import { BrowserHost } from './supervisor.mjs';

// Only the asynchronous IDB port is substituted. Tests call the actual durable
// Workspace operations and inspect both retained bytes and quota admission.
function database(entries) {
  const namespace = 'fixture';
  const files = new Map(entries.map(([path, bytes, kind = 'file']) => [path,
    { namespace, path, data: new Uint8Array(bytes), kind, version: 'initial' }]));
  let meta = { namespace, bytes: entries.reduce((sum, [, bytes]) => sum + bytes, 0), count: entries.length };
  const result = value => {
    const request = {};
    queueMicrotask(() => { request.result = structuredClone(value); request.onsuccess?.(); });
    return request;
  };
  const db = { transaction() {
    const tx = { abort() { tx.aborted = true; queueMicrotask(() => tx.onabort?.()); }, objectStore(name) {
      return name === 'meta' ? {
        get: () => result(meta), put: value => { meta = structuredClone(value); },
      } : {
        get: ([, path]) => result(files.get(path)),
        getAll: range => result([...files.values()].filter(file => file.path >= range.lower[1] && file.path <= range.upper[1])),
        put: value => files.set(value.path, structuredClone(value)),
        delete: ([, path]) => files.delete(path),
      };
    } };
    setImmediate(() => { if (!tx.aborted) tx.oncomplete?.(); });
    return tx;
  } };
  return { workspace: new Workspace(db, namespace), files, meta: () => meta };
}

test('same-path file and directory renames preserve durable quotas and normal overwrites', async () => {
  const previous = globalThis.IDBKeyRange;
  globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
  try {
    const fixture = database([
      ['/workspace/a', 3], ['/workspace/dir', 0, 'directory'],
      ['/workspace/dir/b', 5], ['/workspace/overwrite', 2],
    ]);
    for (let index = 0; index < 8; index++) {
      await fixture.workspace.rename('/workspace/a', './a');
      await fixture.workspace.rename('/workspace/dir', '/workspace/./dir');
    }
    assert.equal(fixture.meta().bytes, 10);
    assert.equal(fixture.meta().count, 4);
    assert.equal(fixture.files.get('/workspace/dir/b').data.byteLength, 5);
    await fixture.workspace.rename('a', 'overwrite');
    assert.equal(fixture.meta().bytes, 8);
    assert.equal(fixture.meta().count, 3);
    assert.equal(fixture.files.has('/workspace/a'), false);
    assert.equal(fixture.files.get('/workspace/overwrite').data.byteLength, 3);
  } finally { globalThis.IDBKeyRange = previous; }
});

test('same-path rename cannot create headroom past byte or entry quotas', async () => {
  const fullBytes = database(Array.from({ length: 4 }, (_, index) => [`/workspace/file-${index}`, MAX_FILE_BYTES]));
  await fullBytes.workspace.rename('file-0', 'file-0');
  assert.equal(fullBytes.meta().bytes, MAX_WORKSPACE_BYTES);
  await assert.rejects(fullBytes.workspace.write('extra', new Uint8Array([1])), /quota exceeded/);
  const fullEntries = database(Array.from({ length: 4096 }, (_, index) => [`/workspace/dir-${index}`, 0, 'directory']));
  await fullEntries.workspace.rename('dir-0', 'dir-0');
  assert.equal(fullEntries.meta().count, 4096);
  await assert.rejects(fullEntries.workspace.write('extra', new Uint8Array()), /quota exceeded/);
});

test('close releases durable workspace after an actual realm acknowledgment timeout and retains its cause', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    closed: false, processes: new Map(), effectLanes: new Map(),
    network: { cancel() { events.push('network-cancel'); } },
    port: { postMessage(frame) { events.push(frame.type); }, close() { events.push('port-close'); } },
    frame: { remove() { events.push('frame-remove'); } },
    workspace: { async close() { events.push('workspace-close'); throw Error('secondary storage close failure'); } },
  });
  const closing = host.close();
  const rejected = assert.rejects(closing, error => error.code === 'outcome_unknown' && /cleanup is unresolved/.test(error.message));
  // Pass effect-lane admission, then expire the production termination timer.
  await Promise.resolve();
  t.mock.timers.tick(5000);
  await rejected;
  assert.deepEqual(events, ['network-cancel', 'terminate', 'frame-remove', 'port-close', 'workspace-close']);
  assert.equal(host.port, null);
  assert.equal(host.closed, true);
});

test('failed realm cleanup stays latched after its port is removed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let writes = 0, reads = 0;
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    processes: new Map(), network: { cancel() {} },
    port: { postMessage() {}, close() {} }, frame: { remove() {} },
    workspace: { async write() { writes++; }, async files() { reads++; return []; } },
  });
  const terminated = assert.rejects(host.terminateRealm(), error => error.code === 'outcome_unknown');
  t.mock.timers.tick(5000);
  await terminated;
  const cause = host.cleanupFailure;
  assert.equal(host.port, null);
  await assert.rejects(host.terminateRealm(), error => error === cause);
  await assert.rejects(host.boot(), error => error === cause);
  await assert.rejects(host.execute({ method: 'write', params: { path: 'a', content: 'x', precondition: 'missing' } }), error => error === cause);
  await assert.rejects(host.execute({ method: 'preflight_mutations', params: { requests: [{ write: { path: 'a', content: 'x', precondition: 'missing' } }] } }), error => error === cause);
  assert.equal(writes, 0); assert.equal(reads, 0);
});

test('close surfaces storage failure when realm cleanup succeeded', async () => {
  const cause = Error('durable workspace close failed');
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    closed: false, processes: new Map(), effectLanes: new Map(),
    async terminateRealm() {}, workspace: { async close() { throw cause; } },
  });
  await assert.rejects(host.close(), error => error === cause);
});

test('kill includes a closed write received while realm shutdown is pending', async () => {
  let terminate, persist;
  const cleanup = new Promise(resolve => { terminate = resolve; });
  const write = new Promise(resolve => { persist = resolve; });
  const states = [];
  const entry = { handle: 1, state: 'running', revision: 1, started: performance.now(),
    persistence: Promise.resolve(), capture: { finish() {} } };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    processes: new Map([[1, entry]]), waiters: new Map(),
    options: { onFrame() { states.push(entry.state); } },
    workspace: { async write() { await write; } },
    async terminateRealm() { await cleanup; },
  });
  const killed = host.execute({ method: 'process_kill', params: { handle: 1 } });
  host.receiveExecution({ type: 'fs_write', run_id: 1, path: '/workspace/closed', data: new Uint8Array([1]) });
  terminate();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(entry.state, 'running');
  assert.deepEqual(states, []);
  persist();
  await killed;
  assert.deepEqual(states, ['exited']);
});

for (const method of ['process_kill', 'process_release']) {
  for (const rejectWrite of [false, true]) {
    test(`${method} waits for durable writes and ${rejectWrite ? 'retains their concrete failure' : 'publishes only acknowledged termination'}`, async () => {
      let acceptWrite, failWrite;
      const persistence = new Promise((resolve, reject) => { acceptWrite = resolve; failWrite = reject; });
      const publications = [];
      const entry = { handle: 1, state: 'running', revision: 1, started: performance.now(), persistence,
        capture: { finish() { publications.push('capture-finished'); } } };
      const host = Object.assign(Object.create(BrowserHost.prototype), {
        processes: new Map([[1, entry]]), waiters: new Map(),
        options: { onFrame() { publications.push(entry.state); } },
        async terminateRealm() {},
      });
      let settled = false, waited = false;
      const kill = host.execute({ method, params: { handle: 1 } });
      const outcome = kill.then(() => { settled = true; return null; }, error => { settled = true; return error; });
      const wait = host.execute({ method: 'process_wait', params: { handle: 1 } }).then(
        value => { waited = true; return value; }, error => { waited = true; return error; },
      );
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(settled, false);
      assert.equal(waited, false);
      assert.deepEqual(publications, []);
      assert.equal((await host.execute({ method: 'process_status', params: { handle: 1 } })).state, 'running');
      if (rejectWrite) failWrite(Error('closed file write exceeded durable storage quota'));
      else acceptWrite();
      const error = await outcome;
      await wait;
      if (rejectWrite) {
        assert.equal(error.code, 'io');
        assert.match(error.message, /closed file write exceeded durable storage quota/);
        const status = await host.execute({ method: 'process_status', params: { handle: 1 } });
        assert.equal(status.state, 'failed');
        assert.equal(status.reason, error.message);
        assert.equal(host.processes.has(1), true);
        assert.deepEqual(publications, ['failed', 'capture-finished']);
      } else {
        assert.equal(error, null);
        assert.deepEqual(publications, ['exited', 'capture-finished']);
        assert.equal(host.processes.has(1), method !== 'process_release');
      }
    });
  }
}
