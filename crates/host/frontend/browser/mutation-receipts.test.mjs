import test from 'node:test';
import assert from 'node:assert/strict';
import { Workspace, MAX_WORKSPACE_BYTES, digest, fault } from './workspace.mjs';
import { BrowserHost } from './supervisor.mjs';
import { Capture } from './capture.mjs';

const encoder = new TextEncoder();
const scope = { scope_version: 3, scope_kind: 'conversation', backend_id: 'backend', binding_id: 'binding', conversation_id: 'conversation' };
const create = path => ({ method: 'mutate', params: { write: { path, content: 'after', precondition: 'missing' } } });
const frame = (method, operation = 'operation') => ({ kind: 'request', request_id: 'request-' + operation, operation_id: operation, lease_generation: 'lease', remaining_budget_ms: 1000, method });

// Substitute only asynchronous IDB requests/atomic commit, not Workspace or
// BrowserHost behavior. Every transaction has isolated snapshots; abort discards
// all file, metadata and receipt writes, including a simulated quota abort after
// every put/delete has already been queued.
function fixture() {
  const namespace = 'fixture';
  let stored = { files: new Map(), receipts: new Map(), meta: new Map([[namespace, { namespace, bytes: 0, count: 0 }]]) };
  const controls = { failFileCommit: false, failSeparateCompletion: false, fileCommits: 0, transactions: [] };
  const result = value => {
    const req = {};
    queueMicrotask(() => { req.result = structuredClone(value); req.onsuccess?.(); });
    return req;
  };
  const db = { transaction(names, mode = 'readonly') {
    names = Array.isArray(names) ? names : [names];
    const snapshot = structuredClone(stored);
    let changedFiles = false, completed = false;
    const tx = {
      abort() {
        if (tx.finished) throw Error('Transaction already finished');
        tx.aborted = true; tx.finished = true; queueMicrotask(() => tx.onabort?.());
      },
      objectStore(name) {
        const rows = snapshot[name];
        return {
          get(key) { return result(rows.get(Array.isArray(key) ? key[1] : key)); },
          getAll(range, max = Infinity) { return result([...rows.values()].filter(row => { const key = name === 'files' ? row.path : name === 'receipts' ? row.operation_id : row.namespace; return !range || row.namespace === range.lower[0] && key >= range.lower[1] && key <= range.upper[1]; }).slice(0, max)); },
          put(value) {
            if (name === 'files') changedFiles = true;
            if (name === 'receipts' && value.state.state === 'completed') {
              completed = true;
              if (controls.failSeparateCompletion && !names.includes('files')) throw fault('io', 'injected separate completion storage failure');
              controls.onCompleted?.(names);
            }
            rows.set(name === 'files' ? value.path : name === 'receipts' ? value.operation_id : value.namespace, structuredClone(value));
          },
          delete(key) { if (name === 'files') changedFiles = true; rows.delete(Array.isArray(key) ? key[1] : key); },
        };
      },
    };
    controls.transactions.push({ names, mode });
    setImmediate(() => {
      if (tx.aborted) return;
      if (controls.failFileCommit && changedFiles && completed) { tx.abort(); return; }
      tx.finished = true;
      if (mode === 'readwrite') {
        for (const name of names) stored[name] = snapshot[name];
        if (changedFiles) { controls.fileCommits++; controls.onFileCommit?.(); }
      }
      tx.oncomplete?.();
    });
    return tx;
  } };
  const workspace = new Workspace(db, namespace);
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    workspace, lease: 'lease', processes: new Map(), activeEffects: new Set(), waiters: new Map(),
    options: {}, async terminateRealm() {},
  });
  return {
    workspace, host, controls,
    files: () => stored.files, receipts: () => stored.receipts,
    meta: () => stored.meta.get(namespace),
    async send(method, operation) {
      const sent = [];
      await host.dispatchFrame(frame(method, operation), scope, async value => sent.push(value));
      return sent;
    },
  };
}
async function withRange(run) {
  const previous = globalThis.IDBKeyRange;
  globalThis.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
  try { await run(); } finally { globalThis.IDBKeyRange = previous; }
}

test('different effect lanes cannot admit the same identity for different payloads', () => withRange(async () => {
  const f = fixture(); let effects = 0;
  f.host.execute = async () => { effects++; return null; };
  const replies = await Promise.all([
    f.send({ method: 'shell_launch', params: { command: 'echo one', output_bytes: 1024 } }, 'shared-operation'),
    f.send({ method: 'process_kill', params: { handle: 1 } }, 'shared-operation'),
  ]);
  const results = replies.map(([response]) => response.result);
  assert.equal(effects, 1);
  assert.equal(results.filter(result => Object.hasOwn(result, 'Ok')).length, 1);
  assert.equal(results.filter(result => result.Err?.code === 'operation_conflict').length, 1);
  assert.equal((await f.workspace.receipt('shared-operation')).state.state, 'completed');
}));

test('settled receipt state is immutable even after later storage repair attempts', () => withRange(async () => {
  const f = fixture();
  const receipt = { operation_id: 'operation', payload_digest: 'a'.repeat(64), scope, state: { state: 'intent' } };
  await f.workspace.record(receipt, 32768);
  const completed = { ...receipt, state: { state: 'completed', result: { Ok: null } } };
  await f.workspace.record(completed);
  await assert.rejects(f.workspace.record({ ...receipt, state: { state: 'failed_unknown', result: { effects_may_have_occurred: true } } }), error => error.code === 'operation_conflict');
  await assert.rejects(f.workspace.record({ ...completed, payload_digest: 'b'.repeat(64) }), error => error.code === 'operation_conflict');
  assert.deepEqual(await f.workspace.receipt('operation'), completed);
}));

test('completion envelope quota is rejected before controlled file publication', () => withRange(async () => {
  const f = fixture(); f.meta().receiptBytes = MAX_WORKSPACE_BYTES - 1000;
  const [response] = await f.send(create('destination'));
  assert.equal(response.result.Err.code, 'limit');
  assert.equal(f.files().size, 0); assert.equal(f.receipts().size, 0);
  assert.equal(f.controls.fileCommits, 0);
}));

test('whole preflight checks receipt slots for every operation without creating intents', () => withRange(async () => {
  const f = fixture(); f.meta().receiptCount = 4095;
  const [response] = await f.send({ method: 'preflight_mutations', params: { requests: [create('a').params, create('b').params] } });
  assert.equal(response.result.Err.code, 'limit');
  assert.match(response.result.Err.message, /Whole patch/);
  assert.equal(f.files().size, 0); assert.equal(f.receipts().size, 0);
  assert.equal(f.meta().receiptCount, 4095);
}));

for (const method of ['write', 'mutate']) {
  test(`${method} commits file and exact durable outcome together without a later receipt write`, () => withRange(async () => {
    const f = fixture(); f.controls.failSeparateCompletion = true;
    const request = method === 'write' ? { method, params: { path: 'destination', content: 'after', precondition: 'missing' } } : create('destination');
    const [response] = await f.send(request);
    assert.ok(response.result.Ok);
    const durable = await f.workspace.receipt('operation');
    assert.deepEqual(durable.state, { state: 'completed', result: response.result });
    assert.equal(new TextDecoder().decode(f.files().get('/workspace/destination').data), 'after');
    assert.equal(f.controls.fileCommits, 1);
    assert.ok(f.controls.transactions.some(tx => ['files', 'meta', 'receipts'].every(name => tx.names.includes(name))));
    assert.equal('_completion_padding' in durable, false);
    assert.equal('_completion_padding' in (await f.workspace.receipts())[0], false);
    const [again] = await f.send(request);
    assert.deepEqual(again.result, response.result);
    assert.equal(f.controls.fileCommits, 1);
  }));
}

for (const method of ['write', 'mutate']) {
  for (const afterCommit of [false, true]) {
    test(`${method} ${afterCommit ? 'preserves a known committed receipt' : 'aborts before publication'} on cancellation`, () => withRange(async () => {
      const f = fixture(), controller = new AbortController();
      const abort = () => controller.abort(fault('cancelled', 'injected cancellation'));
      if (afterCommit) f.controls.onFileCommit = abort;
      else f.controls.onCompleted = names => { if (names.includes('files')) abort(); };
      const request = method === 'write' ? { method, params: { path: 'destination', content: 'after', precondition: 'missing' } } : create('destination');
      const sent = [];
      await f.host.dispatchFrame(frame(request), scope, async value => sent.push(value), controller.signal);
      const result = sent[0].result;
      if (afterCommit) { assert.ok(result.Ok); assert.equal(f.files().size, 1); }
      else { assert.equal(result.Err.code, 'cancelled'); assert.equal(f.files().size, 0); }
      assert.deepEqual((await f.workspace.receipt('operation')).state.result, result);
    }));
  }
}

test('actual storage abort rolls back both move paths and the completed receipt', () => withRange(async () => {
  const f = fixture();
  const data = encoder.encode('before'), version = await digest(data);
  f.files().set('/workspace/source', { namespace: 'fixture', path: '/workspace/source', data, version, kind: 'file' });
  f.meta().bytes = data.byteLength; f.meta().count = 1;
  f.controls.failFileCommit = true;
  const [response] = await f.send({ method: 'mutate', params: { move: { path: 'source', destination: 'destination', content: 'after', expected_version: version } } });
  assert.equal(response.result.Err.code, 'io');
  assert.equal(new TextDecoder().decode(f.files().get('/workspace/source').data), 'before');
  assert.equal(f.files().has('/workspace/destination'), false);
  assert.equal(f.controls.fileCommits, 0);
  const durable = await f.workspace.receipt('operation');
  assert.equal(durable.state.state, 'completed');
  assert.equal(durable.state.result.Err.code, 'io');
  assert.equal(f.meta().bytes, data.byteLength); assert.equal(f.meta().count, 1);
}));

test('drain reserves its maximum escaped completion before consuming any output', () => withRange(async () => {
  const f = fixture(), capture = new Capture(1048576);
  capture.append('stdout', encoder.encode('retained'));
  f.host.processes.set(1, { handle: 1, capture });
  f.meta().receiptBytes = MAX_WORKSPACE_BYTES - 1000;
  const [response] = await f.send({ method: 'shell_drain', params: { handle: 1, max_bytes: 1048576 } });
  assert.equal(response.result.Err.code, 'limit');
  assert.equal(capture.read().stdout, 'retained');
  assert.equal(f.receipts().size, 0);
}));

test('a known drain with failed completion storage is fenced and repaired without consuming again', () => withRange(async () => {
  const f = fixture(), capture = new Capture(1048576);
  capture.append('stdout', encoder.encode('retained'));
  f.host.processes.set(1, { handle: 1, capture });
  f.controls.failSeparateCompletion = true;
  const request = { method: 'shell_drain', params: { handle: 1, max_bytes: 1048576 } };
  const [response] = await f.send(request);
  assert.equal(response.result.Err.code, 'outcome_unknown');
  assert.match(response.result.Err.message, /known outcome/);
  assert.equal(capture.read().stdout, '');
  assert.equal((await f.workspace.receipt('operation')).state.state, 'intent');
  assert.equal(f.host.pendingCompletions.get('operation').state.result.Ok.stdout, 'retained');
  assert.equal(f.host.activeEffects.has('operation'), true);
  const [blocked] = await f.send(request, 'different-operation');
  assert.equal(blocked.result.Err.code, 'outcome_unknown');
  const [independent] = await f.send(create('destination'), 'independent-write');
  assert.ok(independent.result.Ok);
  assert.equal(f.files().size, 1);
  f.controls.failSeparateCompletion = false;
  const replies = [];
  await f.host.dispatchFrame({ kind: 'status', operation_id: 'operation', request_id: 'status', lease_generation: 'lease' }, scope, async value => replies.push(value));
  assert.equal(replies[0].receipt.state.state, 'completed');
  assert.equal(replies[0].receipt.state.result.Ok.stdout, 'retained');
  assert.equal(f.host.pendingCompletions.size, 0);
  const [again] = await f.send(request);
  assert.equal(again.result.Ok.stdout, 'retained');
  assert.equal(capture.read().stdout, '');
}));

test('ambiguous process errors remain indeterminate instead of completed failures', () => withRange(async () => {
  const f = fixture(); let calls = 0;
  f.host.execute = async () => { calls++; throw fault('io', 'cleanup acknowledgment was lost'); };
  const request = { method: 'process_kill', params: { handle: 1 } };
  const [response] = await f.send(request);
  assert.equal(response.result.Err.code, 'outcome_unknown');
  assert.match(response.result.Err.message, /cleanup acknowledgment was lost/);
  assert.equal((await f.workspace.receipt('operation')).state.state, 'indeterminate');
  const [again] = await f.send(request);
  assert.equal(again.result.Err.code, 'outcome_unknown');
  assert.equal(calls, 1);
}));

test('bounded Unicode error receipts fit the persisted completion reservation', () => withRange(async () => {
  const f = fixture();
  f.host.execute = async () => { throw fault('conflict', '\u0001拒'.repeat(10000)); };
  const [response] = await f.send({ method: 'process_kill', params: { handle: 1 } });
  assert.equal(response.result.Err.code, 'conflict');
  assert.ok(encoder.encode(response.result.Err.message).byteLength <= 4096);
  assert.deepEqual((await f.workspace.receipt('operation')).state.result, response.result);
  const actual = [...f.receipts().values()].reduce((sum, row) => sum + encoder.encode(JSON.stringify(row)).byteLength, 0);
  assert.equal(f.meta().receiptBytes, actual);
}));
