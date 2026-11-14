// Focused real-artifact public Python Fetch diagnostic; starts no service.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory = path.resolve(process.argv[2] ?? 'public/browser-host');
const publicInternet = process.argv.includes('--public');
const origin = 'http://127.0.0.1:43777', external = publicInternet ? 'https://httpbin.org' : 'https://allowed.browser-host.test';
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext(); let requests = 0;
  if (!publicInternet) await context.route(external + '/**', route => { requests++; return route.fulfill({ headers: { 'access-control-allow-origin': '*' }, body: 'network-ok' }); });
  await context.route(origin + '/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fetch probe</title>' });
    if (!url.pathname.startsWith('/browser-host/')) return route.fulfill({ status: 404 });
    const relative = url.pathname.slice('/browser-host/'.length);
    if (relative.split('/').includes('..')) return route.fulfill({ status: 403 });
    try { return route.fulfill({ body: await readFile(path.join(directory, relative)), contentType: /\.m?js$/.test(relative) ? 'text/javascript' : relative.endsWith('.json') ? 'application/json' : relative.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); }
    catch { return route.fulfill({ status: 404 }); }
  });
  const page = await context.newPage(); page.on('console', message => console.log('browser:', message.text())); page.on('pageerror', error => console.log('pageerror:', error.message));
  await page.goto(origin);
  const result = await page.evaluate(async ({ origin, external, publicInternet }) => {
    const manifest = await (await fetch('/browser-host/current.json')).json();
    const { BrowserHost } = await import(origin + manifest.base_url + manifest.entry);
    const identity = { backend: origin, owner: 'fetch-probe', browserId: crypto.randomUUID(), conversationId: crypto.randomUUID(), workspaceId: crypto.randomUUID(), allowedOrigins: null };
    let host = await BrowserHost.create(identity);
    const frames = [], receive = host.receiveExecution.bind(host);
    host.receiveExecution = data => { frames.push({ type: data.type, id: data.id, code: data.code, path: data.path }); receive(data); };
    const invocation = crypto.randomUUID(), outcomePath = `/workspace/public-fetch-${invocation}.json`;
    const url = external + (publicInternet ? '/get' : '/public');
    // Preserve transport failure as an outcome; persistence is outside catch so a
    // failed write cannot be confused with a rejected Fetch. Exit zero alone is
    // insufficient: Node asserts HTTP success and this invocation's durable file.
    const source = `async (FS,url,path,invocation) => {
      const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),10000);
      let outcome;
      try {
        const response=await fetch(url,{credentials:'omit',redirect:'error',signal:controller.signal});
        const body=await response.text();
        outcome={invocation,ok:response.ok,status:response.status,url:response.url,type:response.type,contentType:response.headers.get('content-type'),bodyBytes:new TextEncoder().encode(body).length,body};
      } catch(error) { outcome={invocation,ok:false,error:{name:error.name,code:error.code,message:error.message}}; }
      finally { clearTimeout(timer); }
      FS.writeFile(path,JSON.stringify(outcome));
    }`;
    const code = `import js, pyodide_js\njs.eval(${JSON.stringify(source)})(pyodide_js.FS, ${JSON.stringify(url)}, ${JSON.stringify(outcomePath)}, ${JSON.stringify(invocation)})`;
    const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    try {
      let existed = false;
      try { await host.execute({ method: 'stat', params: { path: outcomePath } }); existed = true; }
      catch (error) { if (error.code !== 'not_found') throw error; }
      const launch = await host.execute({ method: 'shell_launch', params: { command: 'python3 -c ' + quote(code), output_bytes: 4096 } });
      const observation = new AbortController(), timer = setTimeout(() => observation.abort(Error('Fetch probe observation deadline')), 15000);
      let waitError;
      try { await host.execute({ method: 'process_wait', params: { handle: launch.handle } }, observation.signal); } catch (error) { waitError = error.message; } finally { clearTimeout(timer); }
      const status = await host.execute({ method: 'process_status', params: { handle: launch.handle } });
      const output = await host.execute({ method: 'shell_read', params: { handle: launch.handle, from: null } });
      let bytes, readError;
      try { bytes = await host.execute({ method: 'read_file', params: { path: outcomePath, max_bytes: 65536 } }); }
      catch (error) { readError = error.message; }
      const pending = host.network.pending.size, requests = host.httpRequests;
      await host.execute({ method: 'process_release', params: { handle: launch.handle } });
      await host.close();
      host = await BrowserHost.create(identity);
      let reopened, reopenError;
      try { reopened = await host.execute({ method: 'read_file', params: { path: outcomePath, max_bytes: 65536 } }); }
      catch (error) { reopenError = error.message; }
      return { artifactHash: manifest.hash, invocation, outcomePath, existed, waitError, status, output, frames, bytes, readError, reopened, reopenError, pending, requests, url };
    } finally { await host.close(); }
  }, { origin, external, publicInternet });
  console.log(JSON.stringify({ ...result, externalRequests: requests }, null, 2));
  assert.equal(result.existed, false, 'Outcome must belong to this invocation');
  assert.equal(result.waitError, undefined, result.waitError);
  assert.equal(result.status.state, 'exited', JSON.stringify(result.status));
  assert.equal(result.status.status?.code, 0, JSON.stringify(result.status));
  assert.equal(result.output.stderr, '', JSON.stringify(result.output));
  assert.equal(result.output.truncated, false);
  assert.equal(result.readError, undefined, result.readError);
  assert.equal(result.reopenError, undefined, result.reopenError);
  assert.deepEqual(result.reopened, result.bytes, 'Outcome must survive Host reopen');
  assert.equal(result.pending, 0); assert.equal(result.requests, 0);
  const outcome = JSON.parse(new TextDecoder().decode(new Uint8Array(result.bytes)));
  assert.equal(outcome.invocation, result.invocation);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.error, undefined, JSON.stringify(outcome));
  assert.equal(outcome.status, 200, JSON.stringify(outcome));
  assert.equal(outcome.url, result.url);
  assert.equal(outcome.type, 'cors');
  assert.ok(outcome.bodyBytes > 0);
  assert.equal(outcome.bodyBytes, new TextEncoder().encode(outcome.body).byteLength);
  if (publicInternet) assert.equal(JSON.parse(outcome.body).url, result.url);
  else { assert.equal(outcome.body, 'network-ok'); assert.equal(requests, 1); }
  console.log(`PASS artifact ${result.artifactHash}: ${publicInternet ? 'public HTTPS' : 'routed HTTPS'} Fetch completed with a durable invocation outcome`);
} finally { await browser.close(); }
