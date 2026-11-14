import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserHost } from './supervisor.mjs';
import { digest } from './workspace.mjs';

const fixture = python => ({
  options: { browserId: 'browser-fixture', workspaceId: 'workspace-fixture' },
  instance: 'instance-fixture', python,
});

test('browser Host owns implementation descriptions and fingerprints exact metadata', async () => {
  const descriptor = await BrowserHost.prototype.descriptor.call(fixture({ implementation: 'pyodide', version: 'fixture-version' }));
  assert.equal(descriptor.info.shell, 'wasmsh');
  assert.equal(descriptor.info.os_family, 'other');
  assert.match(descriptor.info.description, /wasmsh 0\.5\.1/);
  assert.match(descriptor.info.description, /pyodide \(fixture-version\)/);
  assert.match(descriptor.info.description, /compatible Pyodide wheels/);
  assert.match(descriptor.info.description, /CORS/);
  assert.match(descriptor.info.description, /plain single quotes/);
  assert.match(descriptor.info.description, /ANSI-C-quoted Unicode are unsupported/);
  assert.match(descriptor.info.description, /OS PIDs/);
  assert.match(descriptor.info.description, /WASMSH_DATE is bound when the runtime starts/);
  assert.deepEqual(descriptor.info.capabilities, descriptor.tool_capabilities);
  assert.ok(descriptor.tool_capabilities.includes('file_mutation'));
  assert.ok(descriptor.supported_primitives.includes('file_mutation'));
  const fingerprintInput = { ...descriptor, bridge_instance_id: '', descriptor_digest: '' };
  assert.equal(descriptor.descriptor_digest, await digest(JSON.stringify(fingerprintInput)));
  fingerprintInput.info = { ...descriptor.info, description: 'Different implementation facts' };
  assert.notEqual(descriptor.descriptor_digest, await digest(JSON.stringify(fingerprintInput)));
});

test('browser Host never invents interpreter availability', async () => {
  const descriptor = await BrowserHost.prototype.descriptor.call(fixture(undefined));
  assert.equal(descriptor.info.virtual_shell.python, null);
  assert.match(descriptor.info.description, /No Python interpreter is advertised/);
  assert.doesNotMatch(descriptor.info.description, /Python implementation:/);
});

for (const [origins, expected] of [
  [undefined, /empty destination allowlist/],
  [[], /explicitly configured destination list is empty/],
  [['https://b.test', 'https://a.test'], /https:\/\/a\.test, https:\/\/b\.test/],
]) {
  test(`browser Host describes network policy ${JSON.stringify(origins)} and completion evidence`, async () => {
    const host = fixture({ implementation: 'cpython', version: '3.13.0' });
    host.options.allowedOrigins = origins;
    const { info } = await BrowserHost.prototype.descriptor.call(host);
    assert.match(info.description, expected);
    assert.match(info.description, /XMLHttpRequest.*not brokered/);
    assert.match(info.description, /A JavaScript async function is supported/);
    assert.match(info.description, /HTTP 4xx\/5xx resolve normally/);
    assert.match(info.description, /uuid\.uuid4\(\)/);
    assert.match(info.description, /missing outcome file is inconclusive/);
  });
}
