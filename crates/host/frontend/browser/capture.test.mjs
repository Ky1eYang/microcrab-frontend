import test from 'node:test';
import assert from 'node:assert/strict';
import { Capture } from './capture.mjs';
import { pathOf } from './workspace.mjs';
const bytes = value => new TextEncoder().encode(value);
test('capture preserves interleaved channels and byte-addressed continuation', () => {
  const capture = new Capture(64);
  capture.append('stdout', bytes('你'));
  const first = capture.read();
  assert.deepEqual(first.next, { line: 1, column: 3 });
  capture.append('stderr', bytes('error\n'));
  capture.append('stdout', bytes('done'));
  const continuation = capture.read(first.next);
  assert.equal(continuation.stdout, 'done');
  assert.equal(continuation.stderr, 'error\n');
  assert.throws(() => capture.read({ line: 1, column: 1 }), /UTF-8/);
});
test('failed drain leaves capture unchanged and a successful drain advances once', () => {
  const capture = new Capture(64);
  capture.append('stdout', bytes('hello'));
  assert.throws(() => capture.drain(4), /byte limit/);
  assert.equal(capture.read().stdout, 'hello');
  assert.equal(capture.drain(5).stdout, 'hello');
  assert.equal(capture.read().stdout, '');
  capture.append('stderr', bytes('next'));
  assert.equal(capture.read().stderr, 'next');
});
test('workspace path admission cannot traverse outside its root', () => {
  assert.equal(pathOf('a/../b'), '/workspace/b');
  assert.throws(() => pathOf('../../private'), /workspace/);
  assert.throws(() => pathOf('/workspace/../other'), /workspace/);
  assert.throws(() => pathOf('/workspace\0secret'), /Invalid/);
});
