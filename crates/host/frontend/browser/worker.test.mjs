import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { BrowserHost } from './supervisor.mjs';

function lifecycleHost(terminateRealm) {
  const entry = { handle: 1, state: 'running', revision: 1, persistence: Promise.resolve(), capture: { finish() {} } };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    processes: new Map([[1, entry]]), waiters: new Map(), options: {}, terminateRealm,
  });
  return { host, entry };
}
test('terminal process waits for realm termination and durable writes before another admission', async () => {
  let acknowledge, persist;
  const { host, entry } = lifecycleHost(() => new Promise(resolve => { acknowledge = resolve; }));
  entry.persistence = new Promise(resolve => { persist = resolve; });
  host.receiveExecution({ type: 'exit', run_id: 1, code: 0 });
  assert.equal(entry.stopping, true);
  assert.equal(entry.state, 'running');
  await assert.rejects(host.execute({ method: 'shell_launch', params: { command: 'echo next', output_bytes: 64 } }), error => error.code === 'conflict');
  acknowledge();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entry.state, 'running');
  persist();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entry.state, 'exited');
  assert.equal(entry.code, 0);
});
test('cleanup failure is retained as failed rather than successful exit', async () => {
  const { host, entry } = lifecycleHost(async () => { throw Error('cleanup unresolved'); });
  host.receiveExecution({ type: 'exit', run_id: 1, code: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(entry.state, 'failed');
});
test('late HTTP receives rejection without gaining broker authority', () => {
  const { host, entry } = lifecycleHost(async () => {});
  const frames = [];
  host.port = { postMessage: frame => frames.push(frame) };
  host.network = { fetch() { assert.fail('late request reached network'); } };
  for (const state of ['running', 'exited']) {
    entry.state = state; entry.stopping = true;
    host.receiveExecution({ type: 'http_request', run_id: 1, id: 'late' });
  }
  host.receiveExecution({ type: 'http_request', run_id: 99, id: 'missing' });
  assert.equal(frames.length, 3);
  assert.ok(frames.every(frame => frame.type === 'http_response' && frame.error));
});
test('a browser missing JSPI fails before fetching assets or admitting execution', async () => {
  const frames = [];
  const self = { postMessage: frame => frames.push(frame), fetch: () => { throw Error('unexpected network access'); } };
  const source = await readFile(new URL('./execution-worker.mjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, { self, TextEncoder, TextDecoder, WebAssembly: {} });
  await self.onmessage({ data: { type: 'boot' } });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'failed');
  assert.match(frames[0].message, /requires WebAssembly JSPI/);
  assert.equal(frames.some(frame => frame.type === 'ready' || frame.type === 'http_request'), false);
});

test('host clock stamp is local wall time in the wasmsh WASMSH_DATE form', async () => {
  const source = await readFile(new URL('./execution-worker.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function hostClockStamp');
  const end = source.indexOf('async function bindHostClock');
  assert.ok(start > 0 && end > start);
  const clock = {};
  vm.runInNewContext(`${source.slice(start, end)}\nthis.stamp = hostClockStamp; this.binding = hostClockBinding;`, clock);
  const at = (offsetMinutes) => ({
    getFullYear: () => 2026, getMonth: () => 10, getDate: () => 10,
    getHours: () => 15, getMinutes: () => 4, getSeconds: () => 5,
    getTimezoneOffset: () => offsetMinutes,
  });
  assert.equal(clock.stamp(at(-480)), '2026-11-10 15:04:05 UTC+0800');
  assert.equal(clock.stamp(at(210)), '2026-11-10 15:04:05 UTC-0330');
  assert.equal(clock.stamp(at(0)), '2026-11-10 15:04:05 UTC+0000');
  assert.equal(clock.binding(at(-480)), "export WASMSH_DATE='2026-11-10 15:04:05 UTC+0800'");
  assert.doesNotMatch(clock.stamp(at(-330)), /'/);
  assert.match(source, /await command\(\{ Init:/);
  assert.match(source, /await bindHostClock\(\);/);
  assert.ok(source.indexOf('await bindHostClock();') > source.indexOf('await command({ Init:'));
  assert.match(source, /\$\{hostClockBinding\(\)\} && cd '\$\{data\.cwd\.replaceAll\("'", "'\\\\''"\)\}' && \$\{data\.command\}/);
});
