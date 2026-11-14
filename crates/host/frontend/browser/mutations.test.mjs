import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightMutations } from './mutations.mjs';
import { BrowserHost } from './supervisor.mjs';
import { digest } from './workspace.mjs';
const encoder = new TextEncoder();
async function file(path, text) { const data = encoder.encode(text); return { path: '/workspace/' + path, kind: 'file', data, version: await digest(data) }; }
const workspace = rows => ({ serial: Promise.resolve(), async files() { return rows; } });

test('whole-call browser preflight normalizes all paths and rejects stale later sources without effects', async () => {
  const source = await file('source', 'old\r\n');
  const requests = [{ write: { path: './added', content: 'new\n', precondition: 'missing' } }, { move: { path: 'source', destination: '/workspace/target', content: 'changed\r\n', expected_version: source.version } }];
  const normalized = await preflightMutations(workspace([source]), requests);
  assert.equal(normalized[0].write.path, '/workspace/added');
  assert.equal(normalized[1].move.content, 'changed\r\n');
  requests[1].move.expected_version = 'a'.repeat(64);
  await assert.rejects(preflightMutations(workspace([source]), requests), /version changed/);
  assert.equal(source.path, '/workspace/source'); assert.equal(new TextDecoder().decode(source.data), 'old\r\n');
});

test('browser preflight rejects collisions, cycles, protected paths, parent gaps and missing destination conflicts', async () => {
  const source = await file('source', 'old\n'), target = await file('target', 'unrelated');
  for (const requests of [
    [{ write: { path: 'a', content: 'x', precondition: 'missing' } }, { write: { path: './a', content: 'y', precondition: 'missing' } }],
    [{ move: { path: 'source', destination: 'target', content: 'new', expected_version: source.version } }],
    [{ write: { path: '.microcrab/private', content: 'x', precondition: 'missing' } }],
    [{ write: { path: '.micro-crab/private', content: 'x', precondition: 'missing' } }],
    [{ write: { path: '../escape', content: 'x', precondition: 'missing' } }],
    [{ write: { path: 'missing/child', content: 'x', precondition: 'missing' } }],
    [{ write: { path: 'a', content: 'x', precondition: 'missing' } }, { write: { path: 'a/child', content: 'x', precondition: 'missing' } }],
  ]) await assert.rejects(preflightMutations(workspace([source, target]), requests));
});

test('browser preflight rejects binary, line and aggregate byte limits before publication', async () => {
  const binary = await file('binary', 'x'); binary.data = new Uint8Array([255]);
  await assert.rejects(preflightMutations(workspace([binary]), [{ delete: { path: 'binary', expected_version: binary.version } }]), /UTF-8/);
  const lines = await file('lines', 'x\n'.repeat(10001));
  await assert.rejects(preflightMutations(workspace([lines]), [{ delete: { path: 'lines', expected_version: lines.version } }]), /10000 lines/);
  const oversized = Array.from({ length: 5 }, (_, index) => ({ write: { path: 'a' + index, content: 'x'.repeat(1048576), precondition: 'missing' } }));
  await assert.rejects(preflightMutations(workspace([]), oversized), /Aggregate/);
});

test('browser carrier refuses mutation while shell owns workspace and cleanup failure precedes effects', async () => {
  let effects = 0;
  const host = { processes: new Map([[1, { state: 'running' }]]), workspace: { async files() { effects++; return []; } }, async terminateRealm() { throw Error('cleanup failed'); } };
  await assert.rejects(BrowserHost.prototype.execute.call(host, { method: 'preflight_mutations', params: { requests: [{ write: { path: 'a', content: 'x', precondition: 'missing' } }] } }), /running shell/);
  host.processes.clear();
  await assert.rejects(BrowserHost.prototype.execute.call(host, { method: 'mutate', params: { write: { path: 'a', content: 'x', precondition: 'missing' } } }), /cleanup failed/);
  assert.equal(effects, 0);
});
