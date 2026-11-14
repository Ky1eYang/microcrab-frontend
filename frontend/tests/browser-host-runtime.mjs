// Standalone real-browser acceptance. Playwright routing provides the HTTP
// fixture; this starts no replacement service. Run with the maintained installed
// browser-host artifact directory, from frontend.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2] ?? 'public/browser-host');
const origin = 'http://127.0.0.1:43777';
const allowed = 'https://allowed.browser-host.test';
const denied = 'https://denied.browser-host.test';
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.addCookies([
    { name: 'application_authority_probe', value: 'not-for-execution', url: origin, httpOnly: true, sameSite: 'Lax' },
    { name: 'ambient_authority_probe', value: 'not-for-execution', url: allowed, httpOnly: true, secure: true, sameSite: 'None' },
  ]);
  const page = await context.newPage();
  let applicationRequests = 0, deniedRequests = 0;
  const externalRequests = [];
  await context.route(denied + '/**', route => { deniedRequests++; return route.fulfill({ body: 'denied-destination' }); });
  await context.route(allowed + '/**', async route => {
    externalRequests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData(), bytes: [...(route.request().postDataBuffer() ?? [])], headers: route.request().headers() });
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, HEAD, POST, PATCH, OPTIONS', 'access-control-allow-headers': 'authorization,content-type,x-guest' } });
    if (route.request().url().endsWith('/no-content')) return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'x-result': 'empty', 'access-control-expose-headers': 'x-result' } });
    if (route.request().url().endsWith('/request')) return route.fulfill({ status: 422, headers: { 'access-control-allow-origin': '*', 'x-result': 'retained', 'access-control-expose-headers': 'x-result' }, body: 'request-received' });
    if (new URL(route.request().url()).pathname === '/fetch-rejected') return route.abort('failed');
    if (route.request().url().endsWith('/oversize')) return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, body: 'x'.repeat(5 * 1024 * 1024) });
    if (route.request().url().endsWith('/slow')) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await route.fulfill({ headers: { 'access-control-allow-origin': '*' }, body: 'slow-ok' }).catch(() => {}); return;
    }
    if (route.request().url().endsWith('/redirect')) return route.fulfill({ status: 302, headers: { location: denied + '/target', 'access-control-allow-origin': '*' } });
    return route.fulfill({ headers: { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' }, body: 'network-ok' });
  });
  await context.route(origin + '/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) { applicationRequests++; return route.fulfill({ status: 403 }); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Browser Host acceptance</title>' });
    if (!url.pathname.startsWith('/browser-host/')) return route.fulfill({ status: 404 });
    const relative = url.pathname.slice('/browser-host/'.length);
    if (relative.split('/').includes('..')) return route.fulfill({ status: 403 });
    try {
      const body = await readFile(path.join(directory, relative));
      const contentType = relative.endsWith('.mjs') || relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.json') ? 'application/json' : relative.endsWith('.html') ? 'text/html' : relative.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
      return route.fulfill({ contentType, body });
    } catch { return route.fulfill({ status: 404 }); }
  });
  await page.goto(origin);
  const result = await page.evaluate(async ({ origin, allowed }) => {
    const manifest = await (await fetch('/browser-host/current.json')).json();
    const { BrowserHost } = await import(origin + manifest.base_url + manifest.entry);
    const { digest } = await import(origin + manifest.base_url + 'workspace.mjs');
    const { Network } = await import(origin + manifest.base_url + 'network.mjs');
    // Real browser Fetch from the same trusted SPA broker used by the worker.
    // These checks complement actual wasmsh/Python below; they are not a mock fetch.
    const broker = new Network(null, origin);
    const requestResponse = await broker.fetch({ url: allowed + '/request', method: 'POST', headers: [['Authorization', 'Bearer guest-fixture'], ['X-Guest', 'sent']], body: new TextEncoder().encode('guest-body') });
    const emptyResponse = await broker.fetch({ url: allowed + '/no-content', method: 'HEAD' });
    const signal = new AbortController();
    const abortRequest = broker.fetch({ url: allowed + '/slow' }, signal.signal).then(() => 'fulfilled', error => error.name);
    setTimeout(() => signal.abort(), 30);
    const requestAbort = await abortRequest;
    const fetchProof = { status: requestResponse.status, body: new TextDecoder().decode(requestResponse.body), headers: requestResponse.headers, url: requestResponse.url, empty: { status: emptyResponse.status, body: emptyResponse.body }, requestAbort, pending: broker.pending.size };
    const identity = { backend: origin, owner: 'acceptance-owner', browserId: crypto.randomUUID(), conversationId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), allowedOrigins: [] };
    let host = await BrowserHost.create(identity);
    const descriptor = await host.descriptor();
    const command = async (target, command, output_bytes = 4096) => {
      const launch = await target.execute({ method: 'shell_launch', params: { command, output_bytes } });
      let waitError = null;
      const observation = new AbortController();
      const deadline = setTimeout(() => observation.abort(Error('Acceptance observation deadline')), 10000);
      try { await target.execute({ method: 'process_wait', params: { handle: launch.handle } }, observation.signal); }
      catch (error) { waitError = error.message; }
      finally { clearTimeout(deadline); }
      const output = await target.execute({ method: 'shell_read', params: { handle: launch.handle, from: null } });
      const status = await target.execute({ method: 'process_status', params: { handle: launch.handle } });
      await target.execute({ method: 'process_release', params: { handle: launch.handle } });
      return { launch, output, status, waitError };
    };
    const initial = await command(host, 'echo shell-ok; python3 -c "print(2 + 2); open(\'/workspace/retained.txt\', \'w\').write(\'persisted\')"');
    const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const asyncFailure = await command(host, 'python3 -c ' + quote("import asyncio, js\nasync def main():\n    response = await js.fetch('https://example.com')\nasyncio.get_event_loop().run_until_complete(main())"));
    const metadataAfterAsync = await command(host, 'python3 -c ' + quote('import pyodide, pyodide.http, pyodide.ffi; print("pyodide",getattr(pyodide,"__version__","?")); print("http",[x for x in dir(pyodide.http) if not x.startswith("_")]); print("ffi",[x for x in dir(pyodide.ffi) if not x.startswith("_")])'));
    const echoAfterAsync = await command(host, 'echo after-async-failure');
    const realmAfterCompletion = { booted: host.booted, pending: host.network.pending.size, requests: host.httpRequests };
    const directories = await command(host, 'mkdir empty; mkdir tree; echo child > tree/file.txt; python3 -c "import os; os.rename(\'/workspace/tree\', \'/workspace/moved\')"');
    if (directories.status.status?.code !== 0) throw Error('Directory shell command failed: ' + JSON.stringify(directories));
    const persistedPaths = (await host.workspace.files()).map(file => ({ path: file.path, kind: file.kind }));
    let duplicateRejected = false, escapeRejected = false;
    try { await BrowserHost.create(identity); } catch (error) { duplicateRejected = error.code === 'conflict'; }
    try { await host.execute({ method: 'read_file', params: { path: '../../private', max_bytes: 64 } }); } catch (error) { escapeRejected = error.code === 'denied'; }
    const scope = { scope_version: 3, scope_kind: 'conversation', binding_id: crypto.randomUUID(), backend_id: crypto.randomUUID(), conversation_id: identity.conversationId };
    const rpc = async (method, params, operation_id = crypto.randomUUID()) => {
      const frames = [];
      await host.handle({ kind: 'request', request_id: crypto.randomUUID(), operation_id, lease_generation: host.lease, remaining_budget_ms: 30000, method: { method, params } }, scope, async frame => { frames.push(frame); });
      return { frames, result: frames.find(frame => frame.kind === 'response')?.result };
    };
    const writeId = crypto.randomUUID(), writeParams = { path: 'receipt.txt', content: 'one-effect', precondition: 'missing' };
    const firstWrite = await rpc('write', writeParams, writeId);
    const duplicateWrite = await rpc('write', writeParams, writeId);
    const changedWrite = await rpc('write', { ...writeParams, content: 'changed' }, writeId);
    const interruptedId = crypto.randomUUID(), interruptedDigest = await digest('interrupted-original');
    await host.workspace.record({ operation_id: interruptedId, payload_digest: interruptedDigest, scope, state: { state: 'intent' } });
    const interrupted = await rpc('settle_unknown', { operation_id: interruptedId, payload_digest: interruptedDigest, scope });
    const missingId = crypto.randomUUID(), missingDigest = await digest('missing-original');
    const missing = await rpc('settle_unknown', { operation_id: missingId, payload_digest: missingDigest, scope });
    const mismatch = await rpc('settle_unknown', { operation_id: missingId, payload_digest: missingDigest, scope: { ...scope, binding_id: crypto.randomUUID() } });
    await host.execute({ method: 'write', params: { path: 'transfer.txt', content: 'x'.repeat(65536), precondition: 'missing' } });
    const transfer = await rpc('read_file', { path: 'transfer.txt', max_bytes: 65536 });
    await host.close();
    host = await BrowserHost.create(identity);
    const retained = await host.execute({ method: 'read', params: { path: 'retained.txt', offset_line: 1, max_lines: 10, max_bytes: 64 } });
    let emptyDirectory, renamedFile, directoryError;
    try {
      emptyDirectory = await host.execute({ method: 'stat', params: { path: 'empty' } });
      renamedFile = await host.execute({ method: 'read', params: { path: 'moved/file.txt', offset_line: 1, max_lines: 10, max_bytes: 64 } });
    } catch (error) { directoryError = error.message + '; persisted paths: ' + JSON.stringify(persistedPaths); }
    const settledAfterReload = await host.workspace.receipt(interruptedId);
    const noReplay = await rpc('write', writeParams, writeId);
    const infinite = await host.execute({ method: 'shell_launch', params: { command: 'python3 -c "while True: pass"', output_bytes: 4096 } });
    const waitRequest = crypto.randomUUID(), waitFrames = [];
    const waiting = host.handle({ kind: 'request', request_id: waitRequest, operation_id: crypto.randomUUID(), lease_generation: host.lease, remaining_budget_ms: 30000, method: { method: 'process_wait', params: { handle: infinite.handle } } }, scope, async frame => { waitFrames.push(frame); });
    await new Promise(resolve => setTimeout(resolve, 0));
    await host.handle({ kind: 'cancel', request_id: waitRequest, lease_generation: host.lease }, scope, async () => {});
    await waiting;
    const afterObservationCancel = await host.execute({ method: 'process_status', params: { handle: infinite.handle } });
    const cancelledWait = waitFrames.find(frame => frame.kind === 'response')?.result;
    await host.execute({ method: 'process_kill', params: { handle: infinite.handle, force: true } });
    const killed = await host.execute({ method: 'process_status', params: { handle: infinite.handle } });
    await host.execute({ method: 'process_release', params: { handle: infinite.handle } });
    const overflow = await command(host, 'echo this-output-exceeds-eight-bytes', 8);
    const beforeUnsupported = host.processes.size;
    const rejectedUnicode = [];
    for (const command of ['echo 你你你', 'echo "你你你"', "echo $'你你你'"]) {
      try { await host.execute({ method: 'shell_launch', params: { command, output_bytes: 4096 } }); rejectedUnicode.push('admitted'); }
      catch (error) { rejectedUnicode.push(error.code); }
    }
    const afterUnsupported = host.processes.size;
    const unicodeShell = await command(host, "echo '你你你'");
    const unicodePython = await command(host, 'python3 -c "print(chr(20320) * 3)"');
    const unicodeOverflow = await command(host, 'python3 -c "print(chr(20320) * 3)"', 8);
    const defaultDenied = await command(host, `curl ${allowed}/default-denied`);
    await host.close();
    const defaultNetwork = await BrowserHost.create({ ...identity, conversationId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), allowedOrigins: null });
    const publicPythonFetch = await command(defaultNetwork, 'python3 -c ' + quote('import js; from pyodide.ffi import run_sync; response = run_sync(js.fetch(' + JSON.stringify(allowed + '/python-public') + ')); print(response.status); print(run_sync(response.text()))'));
    const callbackPythonFetch = await command(defaultNetwork, 'python3 -c ' + quote('import js, pyodide_js; js.eval("(FS, url) => fetch(url).then(r => r.text()).then(text => FS.writeFile(\\\"/workspace/public-fetch.txt\\\", text))")(pyodide_js.FS, ' + JSON.stringify(allowed + '/python-callback') + ')'));
    let publicPythonFile;
    try { publicPythonFile = await defaultNetwork.execute({ method: 'read', params: { path: 'public-fetch.txt', offset_line: 1, max_lines: 10, max_bytes: 4096 } }); }
    catch (error) { publicPythonFile = { error: error.message, callback: callbackPythonFetch }; }
    const defaultFetchCode = `(async (FS) => {
      const proof = {};
      try {
        const abort = new AbortController();
        const tasks = [
          fetch(${JSON.stringify(allowed + '/python-default')}).then(async r => ({status:r.status,url:r.url,statusText:r.statusText,redirected:r.redirected,text:await r.text()})),
          fetch(new Request(${JSON.stringify(allowed + '/request')}, {method:'POST',headers:{Authorization:'Bearer guest-worker','X-Guest':'worker'},body:new Uint8Array([0,128,255]),cache:'no-store'})).then(async r => {
            const copy = r.clone();
            return {status:r.status,url:r.url,statusText:r.statusText,redirected:r.redirected,type:r.type,header:r.headers.get('x-result'),text:await r.text(),clone:await copy.text(),cloneUrl:copy.url,bodyUsed:r.bodyUsed};
          }),
          fetch(${JSON.stringify(allowed + '/no-content')}, {method:'HEAD'}).then(async r => ({status:r.status,body:r.body,url:r.url,text:await r.clone().text()})),
          fetch(${JSON.stringify(allowed + '/slow')}, {signal:abort.signal}).then(() => 'fulfilled', e => e.name),
        ];
        setTimeout(() => abort.abort(), 30);
        [proof.get,proof.post,proof.head,proof.abort] = await Promise.all(tasks);
      } catch (error) { proof.error = String(error?.stack ?? error); }
      FS.writeFile('/workspace/fetch-proof.txt', JSON.stringify(proof));
    })`;
    const defaultPythonFetch = await command(defaultNetwork, 'python3 -c ' + quote('import js, pyodide_js; js.eval(' + JSON.stringify(defaultFetchCode) + ')(pyodide_js.FS)'));
    const defaultPythonProof = await defaultNetwork.execute({ method: 'read_file', params: { path: 'fetch-proof.txt', max_bytes: 4096 } });
    await defaultNetwork.close();
    // Each admitted invocation owns a fresh outcome path and embedded identity.
    // Immediate reads certify process_wait's persistence barrier; reopening checks
    // durable bytes without a second execution that could conceal a late write.
    const outcomeMatrix = [];
    for (const origins of [null, [], [allowed]]) {
      const matrixIdentity = { ...identity, conversationId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), allowedOrigins: origins };
      let matrixHost = await BrowserHost.create(matrixIdentity);
      const state = origins === null ? 'unrestricted' : origins.length ? 'allowed' : 'denied';
      const cells = [];
      const description = (await matrixHost.descriptor()).info.description;
      const example = description.split('Example code: ')[1]?.split('. Read that exact outcome file')[0];
      if (!example) throw Error('Descriptor Fetch example missing');
      for (const [kind, endpoint] of [['callback', '/python-catch'], ['http-error', '/request'], ['rejected', '/fetch-rejected'], ['async-clone', '/slow'], ['unsupported-redirect', '/redirect-follow'], ['descriptor-example', '/descriptor-example']]) {
        const invocation = crypto.randomUUID(), outcomePath = `fetch-${kind}-${invocation}.json`;
        const url = allowed + endpoint;
        const source = kind === 'descriptor-example' ? example : kind === 'async-clone'
          ? `async (FS, url, path, invocation) => {
              let outcome;
              try {
                const response = await fetch(url);
                const copy = response.clone();
                const body = await response.text();
                const clone = await copy.text();
                outcome = {invocation,ok:response.ok,status:response.status,url:response.url,body,clone,bodyUsed:response.bodyUsed,cloneUsed:copy.bodyUsed};
              } catch (error) { outcome = {invocation,ok:false,error:{name:error.name,code:error.code,message:error.message}}; }
              FS.writeFile(path, JSON.stringify(outcome));
            }`
          : `(FS, url, path, invocation) => fetch(url${kind === 'unsupported-redirect' ? ", {redirect:'follow'}" : ''})
              .then(async response => ({invocation,ok:response.ok,status:response.status,url:response.url,body:await response.text()}))
              .catch(error => ({invocation,ok:false,error:{name:error.name,code:error.code,message:error.message}}))
              .then(outcome => FS.writeFile(path, JSON.stringify(outcome)))`;
        const code = 'import js, pyodide_js, os, time; js.eval(' + JSON.stringify(source) + ')(pyodide_js.FS, ' + JSON.stringify(url) + ', ' + JSON.stringify('/workspace/' + outcomePath) + ', ' + JSON.stringify(invocation) + '); time.sleep(0.01); print("before-return-exists", os.path.exists(' + JSON.stringify('/workspace/' + outcomePath) + '))';
        let existed = false;
        try { await matrixHost.execute({ method: 'stat', params: { path: outcomePath } }); existed = true; }
        catch (error) { if (error.code !== 'not_found') throw error; }
        const execution = await command(matrixHost, 'python3 -c ' + quote(code));
        let bytes, readError;
        try { bytes = await matrixHost.execute({ method: 'read_file', params: { path: outcomePath, max_bytes: 4096 } }); }
        catch (error) { readError = error.message; }
        cells.push({ kind, invocation, path: outcomePath, existed, execution, bytes, readError, pending: matrixHost.network.pending.size, requests: matrixHost.httpRequests, booted: matrixHost.booted });
      }
      const fallback = origins === null ? await command(matrixHost, `curl ${allowed}/shell-empty-allowlist || echo curl-fallback-preserved`) : undefined;
      await matrixHost.close();
      matrixHost = await BrowserHost.create(matrixIdentity);
      try {
        for (const cell of cells) {
          try { cell.reopened = await matrixHost.execute({ method: 'read_file', params: { path: cell.path, max_bytes: 4096 } }); }
          catch (error) { cell.reopenError = error.message; }
        }
      } finally { await matrixHost.close(); }
      outcomeMatrix.push({ state, cells, fallback });
    }
    const otherOwner = await BrowserHost.create({ ...identity, owner: 'different-owner' });
    let isolated = false;
    try { await otherOwner.execute({ method: 'read_file', params: { path: 'retained.txt', max_bytes: 64 } }); } catch (error) { isolated = error.code === 'not_found'; }
    await otherOwner.close();
    const network = await BrowserHost.create({ ...identity, conversationId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), allowedOrigins: [allowed] });
    const http = await command(network, `curl ${allowed}/ok`);
    const rejectedShellHttp = await command(network, `curl '${allowed}/fetch-rejected?secret=must-not-leak'`);
    const shellPost = await command(network, `curl -X POST -H 'X-Guest: shell' -d shell-body ${allowed}/request`);
    const shellHead = await command(network, `curl -I ${allowed}/no-content`);
    const oversizedHttp = await command(network, `curl ${allowed}/oversize`);
    const slow = await network.execute({ method: 'shell_launch', params: { command: `curl ${allowed}/slow`, output_bytes: 4096 } });
    for (let attempt = 0; attempt < 100 && network.httpRequests === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const activeHttpBeforeKill = network.httpRequests;
    await new Promise(resolve => setTimeout(resolve, 50));
    await network.execute({ method: 'process_kill', params: { handle: slow.handle, force: true } });
    for (let attempt = 0; attempt < 100 && network.httpRequests !== 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const cancelledHttp = { pending: network.network.pending.size, requests: network.httpRequests, status: await network.execute({ method: 'process_status', params: { handle: slow.handle } }) };
    await network.execute({ method: 'process_release', params: { handle: slow.handle } });
    const redirect = await command(network, `curl ${allowed}/redirect`);
    // Native Python JS fetch/XHR bypasses wrappers. connect-src none must block
    // both even with credentials include; only the trusted broker may connect.
    const externalProbe = `nativeFetch(${JSON.stringify(allowed + '/direct')}, {credentials: 'include'}).catch(() => {})`;
    const backendProbe = `nativeFetch(${JSON.stringify(origin + '/api/authority-probe')}, {credentials: 'include'}).catch(() => {})`;
    const xhrProbe = `try { const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(allowed + '/native-xhr')}, false); x.withCredentials = true; x.send(); } catch {}`;
    const mediatedProbe = `fetch(${JSON.stringify(allowed + '/python')}, {credentials: 'omit', redirect: 'error'}).catch(() => {})`;
    const pythonProbe = `import js; js.eval(${JSON.stringify(externalProbe)}); js.eval(${JSON.stringify(backendProbe)}); js.eval(${JSON.stringify(xhrProbe)}); js.eval(${JSON.stringify(mediatedProbe)})`;
    const direct = await command(network, `python3 -c ${quote(pythonProbe)}`);
    await new Promise(resolve => setTimeout(resolve, 200));
    await network.close();
    return { rejectedShellHttp, outcomeMatrix, publicPythonFile, callbackPythonFetch, publicPythonFetch, fetchProof, defaultPythonFetch, defaultPythonProof, shellPost, shellHead, artifactHash: manifest.hash, descriptor, asyncFailure, metadataAfterAsync, echoAfterAsync, realmAfterCompletion, initial, duplicateRejected, escapeRejected, firstWrite, duplicateWrite, changedWrite, interrupted, missing, mismatch, transfer, retained, emptyDirectory, renamedFile, directoryError, settledAfterReload, noReplay, cancelledWait, afterObservationCancel, killed, overflow, beforeUnsupported, afterUnsupported, rejectedUnicode, unicodeShell, unicodePython, unicodeOverflow, defaultDenied, isolated, http, oversizedHttp, activeHttpBeforeKill, cancelledHttp, redirect, direct };
  }, { origin, allowed });
  console.log('Fetch outcome matrix:', JSON.stringify({ artifactHash: result.artifactHash, rows: result.outcomeMatrix.map(row => ({ state: row.state, cells: row.cells.map(cell => ({ kind: cell.kind, code: cell.execution.status.status?.code, waitError: cell.execution.waitError, early: cell.execution.output.stdout.trim(), readError: cell.readError, reopenError: cell.reopenError })) })) }));
  const outcomePaths = new Set();
  assert.deepEqual(result.outcomeMatrix.map(row => row.state), ['unrestricted', 'denied', 'allowed']);
  for (const row of result.outcomeMatrix) {
    for (const cell of row.cells) {
      const diagnostic = JSON.stringify({ state: row.state, ...cell });
      assert.equal(cell.existed, false, diagnostic);
      assert.equal(outcomePaths.has(cell.path), false, diagnostic); outcomePaths.add(cell.path);
      assert.equal(cell.execution.waitError, null, diagnostic);
      assert.equal(cell.execution.status.state, 'exited', diagnostic);
      assert.equal(cell.execution.status.status?.code, 0, diagnostic);
      assert.equal(cell.execution.output.stderr, '', diagnostic);
      assert.equal(cell.execution.output.truncated, false, diagnostic);
      assert.equal(cell.readError, undefined, diagnostic);
      assert.equal(cell.reopenError, undefined, diagnostic);
      assert.deepEqual(cell.reopened, cell.bytes, diagnostic);
      assert.equal(cell.pending, 0, diagnostic); assert.equal(cell.requests, 0, diagnostic); assert.equal(cell.booted, false, diagnostic);
      const outcome = JSON.parse(new TextDecoder().decode(new Uint8Array(cell.bytes)));
      if (cell.kind === 'async-clone' && row.state !== 'denied') assert.equal(cell.execution.output.stdout, 'before-return-exists False\n', diagnostic);
      if (cell.kind === 'descriptor-example') {
        assert.equal(outcome.ok, row.state !== 'denied', diagnostic);
        if (row.state === 'denied') assert.match(outcome.error, /ceiling/, diagnostic);
        else { assert.equal(outcome.status, 200, diagnostic); assert.equal(outcome.body, 'network-ok', diagnostic); }
        continue;
      }
      assert.equal(outcome.invocation, cell.invocation, diagnostic);
      if (row.state === 'denied' || cell.kind === 'rejected' || cell.kind === 'unsupported-redirect') {
        assert.equal(outcome.ok, false, diagnostic);
        assert.equal(outcome.status, undefined, diagnostic);
        assert.equal(outcome.body, undefined, diagnostic);
        assert.equal(outcome.error.name, 'Error', diagnostic);
        assert.equal(outcome.error.code, cell.kind === 'unsupported-redirect' ? 'unsupported' : row.state === 'denied' ? 'denied' : 'io', diagnostic);
        assert.ok(outcome.error.message.length > 0, diagnostic);
        if (cell.kind === 'unsupported-redirect') assert.match(outcome.error.message, /redirects are unsupported/, diagnostic);
        else if (row.state === 'denied') assert.match(outcome.error.message, /ceiling/, diagnostic);
      } else {
        assert.equal(outcome.error, undefined, diagnostic);
        assert.equal(outcome.status, cell.kind === 'http-error' ? 422 : 200, diagnostic);
        assert.equal(outcome.ok, cell.kind !== 'http-error', diagnostic);
        assert.equal(outcome.body, cell.kind === 'http-error' ? 'request-received' : cell.kind === 'async-clone' ? 'slow-ok' : 'network-ok', diagnostic);
        assert.ok(outcome.url.startsWith(allowed + '/'), diagnostic);
        if (cell.kind === 'async-clone') {
          assert.equal(outcome.clone, outcome.body, diagnostic);
          assert.equal(outcome.bodyUsed, true, diagnostic); assert.equal(outcome.cloneUsed, true, diagnostic);
        }
      }
    }
    if (row.state === 'unrestricted') {
      assert.equal(row.fallback.waitError, null, JSON.stringify(row.fallback));
      assert.equal(row.fallback.status.status?.code, 0, JSON.stringify(row.fallback));
      assert.match(row.fallback.output.stderr, /curl: network access not available/);
      assert.equal(row.fallback.output.stdout, 'curl-fallback-preserved\n');
    }
  }
  assert.equal(outcomePaths.size, 18);
  assert.ok(!externalRequests.some(request => request.url.endsWith('/redirect-follow')));
  assert.ok(!externalRequests.some(request => request.url.endsWith('/shell-empty-allowlist')));
  console.log('Public Python Fetch probes:', JSON.stringify({ runSync: result.publicPythonFetch, callbacks: result.callbackPythonFetch }));
  assert.equal(result.publicPythonFetch.status.status?.code, 1, JSON.stringify(result.publicPythonFetch));
  assert.match(result.publicPythonFetch.output.stderr, /Cannot stack switch/);
  assert.equal(result.callbackPythonFetch.status.status?.code, 0, JSON.stringify(result.callbackPythonFetch));
  assert.equal(result.publicPythonFile.content, 'network-ok');
  assert.equal(result.defaultPythonFetch.status.status?.code, 0, JSON.stringify(result.defaultPythonFetch));
  const pythonFetch = JSON.parse(new TextDecoder().decode(new Uint8Array(result.defaultPythonProof)));
  assert.equal(pythonFetch.error, undefined, pythonFetch.error);
  assert.equal(pythonFetch.get.status, 200); assert.equal(pythonFetch.get.url, allowed + '/python-default'); assert.equal(pythonFetch.get.text, 'network-ok'); assert.equal(pythonFetch.get.redirected, false);
  assert.equal(pythonFetch.post.status, 422); assert.equal(pythonFetch.post.url, allowed + '/request'); assert.equal(typeof pythonFetch.post.statusText, 'string');
  assert.equal(pythonFetch.post.header, 'retained'); assert.equal(pythonFetch.post.text, 'request-received'); assert.equal(pythonFetch.post.clone, 'request-received');
  assert.equal(pythonFetch.post.cloneUrl, allowed + '/request'); assert.equal(pythonFetch.post.type, 'cors'); assert.equal(pythonFetch.post.bodyUsed, true);
  assert.deepEqual(pythonFetch.head, { status: 204, body: null, url: allowed + '/no-content', text: '' });
  assert.equal(pythonFetch.abort, 'AbortError');
  assert.ok(externalRequests.some(request => request.url.endsWith('/request') && request.method === 'POST' && request.headers.authorization === 'Bearer guest-worker' && request.headers['x-guest'] === 'worker' && JSON.stringify(request.bytes) === '[0,128,255]'));
  assert.equal(result.shellHead.status.status?.code, 0, JSON.stringify(result.shellHead));
  assert.match(result.shellPost.output.stdout, /request-received/, JSON.stringify(result.shellPost));
  assert.ok(externalRequests.some(request => request.url.endsWith('/request') && request.method === 'POST' && request.body === 'shell-body' && request.headers['x-guest'] === 'shell'));
  assert.ok(externalRequests.some(request => request.url.endsWith('/no-content') && request.method === 'HEAD'));
  assert.equal(result.fetchProof.status, 422);
  assert.equal(result.fetchProof.body, 'request-received');
  assert.ok(result.fetchProof.headers.some(([name, value]) => name === 'x-result' && value === 'retained'));
  assert.equal(result.fetchProof.url, allowed + '/request');
  assert.deepEqual(result.fetchProof.empty, { status: 204, body: null });
  assert.equal(result.fetchProof.requestAbort, 'AbortError');
  assert.equal(result.fetchProof.pending, 0);
  assert.ok(externalRequests.some(request => request.url.endsWith('/request') && request.method === 'POST' && request.body === 'guest-body' && request.headers.authorization === 'Bearer guest-fixture'));
  assert.equal(result.asyncFailure.status.status?.code, 1, JSON.stringify(result.asyncFailure));
  assert.match(result.asyncFailure.output.stderr, /Cannot stack switch/);
  assert.equal(result.metadataAfterAsync.status.status?.code, 0, JSON.stringify(result.metadataAfterAsync));
  assert.match(result.metadataAfterAsync.output.stdout, /pyodide 0\.29\.3/);
  assert.equal(new TextEncoder().encode(result.metadataAfterAsync.output.stdout).byteLength, 727);
  assert.equal(result.echoAfterAsync.status.status?.code, 0, JSON.stringify(result.echoAfterAsync));
  assert.equal(result.echoAfterAsync.output.stdout, 'after-async-failure\n');
  assert.deepEqual(result.realmAfterCompletion, { booted: false, pending: 0, requests: 0 });
  assert.equal(result.descriptor.info.os_family, 'other');
  assert.equal(result.descriptor.info.shell, 'wasmsh');
  assert.equal(result.descriptor.info.virtual_shell.engine, 'wasmsh');
  assert.equal(result.descriptor.info.virtual_shell.python.implementation, 'cpython');
  assert.match(result.descriptor.info.virtual_shell.python.version, /^\d+\.\d+\.\d+$/);
  assert.equal(result.initial.launch.pid, null);
  assert.match(result.initial.output.stdout, /shell-ok/);
  assert.match(result.initial.output.stdout, /4/);
  assert.equal(result.retained.content, 'persisted');
  assert.equal(result.duplicateRejected, true);
  assert.equal(result.escapeRejected, true);
  assert.equal(result.isolated, true);
  assert.deepEqual(result.firstWrite.result, result.duplicateWrite.result);
  assert.deepEqual(result.firstWrite.result, result.noReplay.result);
  assert.equal(result.changedWrite.result.Err.code, 'operation_conflict');
  assert.equal(result.interrupted.result.Ok.state.state, 'failed_unknown');
  assert.equal(result.missing.result.Ok.state.result.effects_may_have_occurred, true);
  assert.equal(result.mismatch.result.Err.code, 'operation_conflict');
  assert.equal(result.settledAfterReload.state.state, 'failed_unknown');
  assert.equal(result.transfer.result.Ok.kind, 'bytes');
  assert.equal(result.transfer.frames.filter(frame => frame.kind === 'transfer_chunk').length, 4);
  assert.equal(result.transfer.frames.filter(frame => frame.kind === 'transfer_chunk').reduce((sum, frame) => sum + frame.data.length, 0), 65536);
  assert.equal(result.cancelledWait.Err.code, 'cancelled');
  assert.equal(result.afterObservationCancel.state, 'running');
  assert.equal(result.killed.state, 'exited');
  assert.equal(result.killed.status.signal, 'Kill');
  assert.equal(result.overflow.status.state, 'failed');
  assert.equal(result.overflow.output.truncated, true);
  assert.notEqual(result.defaultDenied.status.status?.code, 0);
  assert.equal(result.rejectedShellHttp.waitError, null, JSON.stringify(result.rejectedShellHttp));
  assert.notEqual(result.rejectedShellHttp.status.status?.code, 0, JSON.stringify(result.rejectedShellHttp));
  assert.match(result.rejectedShellHttp.output.stderr, /browser HTTP GET/i);
  assert.ok(result.rejectedShellHttp.output.stderr.includes(allowed));
  assert.match(result.rejectedShellHttp.output.stderr, /path omitted/);
  assert.match(result.rejectedShellHttp.output.stderr, /withheld/i);
  assert.ok(!result.rejectedShellHttp.output.stderr.includes('fetch-rejected'));
  assert.ok(!result.rejectedShellHttp.output.stderr.includes('must-not-leak'));
  assert.equal(result.http.status.status?.code, 0, JSON.stringify({ http: result.http, requests: externalRequests.map(request => request.url) }));
  assert.match(result.http.output.stdout, /network-ok/, JSON.stringify(result.http));
  assert.equal(result.http.status.status.code, 0);
  assert.notEqual(result.oversizedHttp.status.status?.code, 0);
  assert.equal(result.activeHttpBeforeKill, 1);
  assert.equal(result.cancelledHttp.pending, 0);
  assert.equal(result.cancelledHttp.requests, 0);
  assert.equal(result.cancelledHttp.status.status.signal, 'Kill');
  assert.ok(externalRequests.some(request => request.url.endsWith('/slow')));
  assert.notEqual(result.redirect.status.status?.code, 0);
  assert.ok(externalRequests.some(request => request.url.endsWith('/ok')));
  assert.equal(result.direct.status.status?.code, 0, JSON.stringify(result.direct));
  assert.ok(!externalRequests.some(request => request.url.endsWith('/direct')), 'native Python fetch must be blocked by CSP');
  assert.ok(!externalRequests.some(request => request.url.endsWith('/native-xhr')), 'native Python XHR must be blocked by CSP');
  assert.ok(externalRequests.some(request => request.url.endsWith('/python')), 'mediated Python fetch must reach the external fixture');
  assert.ok(!externalRequests.some(request => request.url.endsWith('/default-denied')));
  for (const request of externalRequests) {
    assert.equal(request.headers.cookie, undefined, `ambient cookies must not enter execution requests: ${request.url}`);
    const expectedAuthorization = request.url.endsWith('/request') && request.method === 'POST' ? { sent: 'Bearer guest-fixture', worker: 'Bearer guest-worker' }[request.headers['x-guest']] : undefined;
    assert.equal(request.headers.authorization, expectedAuthorization);
    assert.equal(request.headers.origin, origin);
  }
  assert.equal(applicationRequests, 0);
  assert.equal(deniedRequests, 0);
  assert.deepEqual(result.rejectedUnicode, ['unsupported', 'unsupported', 'unsupported']);
  assert.equal(result.afterUnsupported, result.beforeUnsupported);
  assert.equal(result.unicodePython.output.stdout, '你你你\n', JSON.stringify({ unicodePython: result.unicodePython, unicodeShell: result.unicodeShell }));
  assert.equal(result.unicodeOverflow.output.stdout, '你你', JSON.stringify(result.unicodeOverflow));
  assert.equal(result.unicodeOverflow.output.truncated, true);
  assert.equal(result.unicodeShell.output.stdout, '你你你\n', JSON.stringify(result.unicodeShell));
  assert.equal(result.directoryError, undefined, result.directoryError);
  assert.equal(result.emptyDirectory.kind, 'directory');
  assert.equal(result.renamedFile.content, 'child\n');
  console.log(`PASS artifact ${result.artifactHash}: real shell/Python; persistence; owner/tab/path isolation; durable mutation/recovery receipts; transfer framing; output bounds; cancellation; permitted CORS HTTP; denied backend/default/redirect network; no ambient credentials`);
} finally { await browser.close(); }
