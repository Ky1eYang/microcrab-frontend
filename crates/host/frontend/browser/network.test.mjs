import test from 'node:test';
import assert from 'node:assert/strict';
import { Network } from './network.mjs';
const backend = 'https://app.test', external = 'https://external.test';
test('missing policy allows external HTTPS while explicit empty policy and authority remain denied', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return new Response(null, { status: 204, statusText: 'No Content' }); });
  const result = await new Network(null, backend).fetch({ url: external + '/ok', headers: [['Authorization', 'Bearer guest-value']] });
  assert.equal(result.status, 204); assert.equal(result.body, null); assert.equal(result.statusText, 'No Content');
  assert.equal(calls[0].options.credentials, 'omit'); assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.get('authorization'), 'Bearer guest-value');
  for (const url of [backend + '/api/private', 'http://external.test/']) await assert.rejects(new Network(null, backend).fetch({ url }), e => e.code === 'denied');
  await assert.rejects(new Network([], backend).fetch({ url: external }), e => e.code === 'denied');
  await assert.rejects(new Network(null, backend).fetch({ url: external, headers: [['Cookie', 'private=value']] }), e => e.code === 'denied');
  assert.equal(calls.length, 1);
});
test('binary request, response error status and per-request abort reach SPA fetch', async t => {
  let observed;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    observed = options;
    if (url.pathname === '/slow') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    return new Response(new Uint8Array([0, 255]), { status: 422, headers: { 'x-result': 'retained' } });
  });
  const network = new Network([external], backend);
  const result = await network.fetch({ url: external + '/body', method: 'PATCH', body: new Uint8Array([0, 128, 255]), cache: 'reload' });
  assert.deepEqual(observed.body, new Uint8Array([0, 128, 255])); assert.equal(observed.method, 'PATCH'); assert.equal(observed.cache, 'reload');
  assert.equal(result.status, 422); assert.deepEqual(result.body, new Uint8Array([0, 255])); assert.ok(result.headers.some(([name, value]) => name === 'x-result' && value === 'retained'));
  const controller = new AbortController();
  const pending = network.fetch({ url: external + '/slow' }, controller.signal);
  controller.abort(); await assert.rejects(pending, e => e.name === 'AbortError' && e.code === 'cancelled'); assert.equal(network.pending.size, 0);
});
test('pre-abort and owner cancellation retain their known cause', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  });
  const network = new Network(null, backend);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(network.fetch({ url: external }, controller.signal), e => e.code === 'cancelled' && e.name === 'AbortError');
  const pending = network.fetch({ url: external });
  network.cancel();
  await assert.rejects(pending, e => e.code === 'cancelled' && e.name === 'AbortError');
  assert.equal(network.pending.size, 0);
});
