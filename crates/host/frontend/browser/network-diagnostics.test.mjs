import test from 'node:test';
import assert from 'node:assert/strict';
import { browserHttpFailure } from './network-diagnostics.mjs';
import { BrowserHost } from './supervisor.mjs';

const request = { method: 'POST', url: 'https://user:password@api.test/secret-token?key=secret#fragment' };
test('opaque failures expose bounded method/origin without path credentials or native exception', () => {
  const result = browserHttpFailure(Error('secret native details'), request);
  assert.equal(result.code, 'io');
  assert.match(result.message, /POST https:\/\/api\.test \[path omitted\]/);
  assert.match(result.message, /browser withheld the cause/);
  assert.doesNotMatch(result.message, /password|user|secret|key=|fragment/);
  assert.ok(new TextEncoder().encode(result.message).byteLength <= 512);
  for (const value of [
    { method: 'X'.repeat(9000), url: 'https://api.test/' },
    { method: 'GET\nsecret', url: 'not a URL?secret' },
    { method: 'GET', url: 'data:secret' },
    { method: 'GET', url: 'https://api.test/' + '你'.repeat(9000) },
    undefined,
  ]) {
    const failure = browserHttpFailure(Error('secret'), value);
    assert.ok(new TextEncoder().encode(failure.message).byteLength <= 512);
    assert.doesNotMatch(failure.message, /secret|你|\n/);
  }
});
test('known faults retain their concrete causes and witnessed cancellation is distinct', () => {
  for (const code of ['denied', 'unsupported', 'invalid_request', 'limit', 'cancelled']) {
    assert.deepEqual(browserHttpFailure({ code, message: 'Specific bounded cause' }, request), { code, message: 'Specific bounded cause' });
  }
  const controller = new AbortController(); controller.abort();
  const result = browserHttpFailure(Error('opaque'), request, controller.signal);
  assert.equal(result.code, 'cancelled');
  assert.match(result.message, /cancelled by the request owner/);
  assert.doesNotMatch(result.message, /withheld|CORS/);
});
test('broker forwards one diagnostic and known cancellation without rewriting it', async () => {
  const frames = [];
  const entry = { state: 'running' };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    processes: new Map([[1, entry]]), httpRequests: 0,
    port: { postMessage: value => frames.push(value) },
    network: { async fetch(_request, signal) {
      if (_request.url.endsWith('/cancel')) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('native abort')), { once: true }));
      else throw Error('secret native details');
    } },
  });
  host.receiveExecution({ type: 'http_request', run_id: 1, id: '1', request });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames[0].error, browserHttpFailure(Error('opaque'), request).message);
  host.receiveExecution({ type: 'http_request', run_id: 1, id: '2', request: { url: 'https://api.test/cancel' } });
  host.receiveExecution({ type: 'http_cancel', run_id: 1, id: '2' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames[1].code, 'cancelled');
  assert.equal(host.httpRequests, 0);
  assert.equal(entry.httpControllers.size, 0);
});
