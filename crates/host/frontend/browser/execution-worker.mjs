// Trusted execution supervisor creates this source inside an opaque,
// credentialless sandbox. The worker receives bytes, never application URLs or
// cookies. CSP remains the authority for Python's direct JavaScript interop.
let moduleRef, runtime, pyodide, runId, limit = 65536, outputBytes = 0;
let manifestFiles = new Map(), assetRoot, wasmExports, invokeCommand;
const httpPending = new Map(), httpActive = new Set();
let nextHttp = 0, executing = false;
function trackHttp(promise) {
  httpActive.add(promise);
  const settled = () => httpActive.delete(promise);
  void promise.then(settled, settled);
  return promise;
}
function brokerFetch(request, signal) {
  // Python may schedule a coroutine after its synchronous shell entrypoint has
  // already exited. Such work has no admitted process and must not leave a
  // broker promise for the next command to drain.
  if (!executing) return Promise.reject(new Error('Browser HTTP requires an active execution'));
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
  if (httpPending.size >= 8) return Promise.reject(new Error('Browser HTTP request capacity reached'));
  const id = String(++nextHttp), owner = runId;
  let abort;
  const promise = new Promise((resolve, reject) => {
    abort = () => {
      if (!httpPending.delete(id)) return;
      send({ type: 'http_cancel', run_id: owner, id });
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    httpPending.set(id, { resolve, reject });
    signal?.addEventListener('abort', abort, { once: true });
    send({ type: 'http_request', run_id: owner, id, request });
  });
  httpActive.add(promise);
  const settled = () => { httpActive.delete(promise); signal?.removeEventListener('abort', abort); };
  void promise.then(settled, settled);
  return promise;
}
const decoder = new TextDecoder(), encoder = new TextEncoder();
const send = value => self.postMessage(value);
function confined(path) { return typeof path === 'string' && (path === '/workspace' || path.startsWith('/workspace/')) && !path.split('/').includes('..'); }
function boundedOutput(channel, input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : new Uint8Array(input);
  const remaining = Math.max(0, limit - outputBytes); outputBytes += bytes.byteLength;
  let end = Math.min(remaining, bytes.byteLength);
  while (end > 0 && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end--;
  if (end) send({ type: 'output', run_id: runId, channel, data: bytes.slice(0, end) });
  if (bytes.byteLength > remaining) send({ type: 'output_limit', run_id: runId });
}
async function asset(url) {
  const key = new URL(String(url), assetRoot).href;
  const entry = manifestFiles.get(key);
  if (!entry) throw new Error('Runtime asset is not in the installed manifest');
  return entry;
}
const nativeFetch = self.fetch.bind(self);
async function boot(params) {
  if (typeof WebAssembly.Suspending !== 'function' || typeof WebAssembly.promising !== 'function')
    throw new Error('Browser Host requires WebAssembly JSPI (Suspending and promising) for credential-isolated HTTP');
  runId = params.run_id; assetRoot = params.assetRoot;
  for (const file of params.assets) manifestFiles.set(new URL(file.path, assetRoot).href, file);
  // Dynamic imports in the pinned Pyodide loader are redirected to verified
  // local bytes. Unknown modules fail rather than gain application-origin access.
  const modules = new Map(), scripts = new Map();
  const nativeImportScripts = self.importScripts.bind(self);
  for (const [url, file] of manifestFiles) if (/\.m?js$/.test(file.path))
    scripts.set(url, URL.createObjectURL(new Blob([file.data], { type: 'text/javascript' })));
  self.importScripts = (...urls) => nativeImportScripts(...urls.map(value => {
    const blob = scripts.get(new URL(String(value), assetRoot).href);
    if (!blob) throw new Error('Runtime script is not in the installed manifest');
    return blob;
  }));
  self.__microcrabImport = async url => {
    const entry = await asset(url); const key = new URL(String(url), assetRoot).href;
    if (!modules.has(key)) {
      let source = decoder.decode(entry.data);
      if (/\bimport\s+(?!\()[^;]*?\bfrom\s*['"]|\bimport\s*['"]|\bexport\s+[^;]*?\bfrom\s*['"]/.test(source))
        throw new Error('Static runtime imports need an explicit installed module adapter');
      source = source.replace(/\bimport\s*\(/g, 'globalThis.__microcrabImport(');
      const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      modules.set(key, import(blob).finally(() => URL.revokeObjectURL(blob)));
    }
    return modules.get(key);
  };
  self.fetch = (input, options = {}) => trackHttp((async () => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, assetRoot);
    if (manifestFiles.has(url.href)) return new Response((await asset(url)).data, { headers: { 'Content-Type': url.pathname.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } });
    if (options.credentials === 'include') throw Object.assign(new Error('Browser HTTP does not expose ambient credentials; supply explicit API headers'), { code: 'denied' });
    if (options.redirect != null && options.redirect !== 'error') throw Object.assign(new Error('Browser HTTP redirects are unsupported; use redirect error'), { code: 'unsupported' });
    const request = new Request(input, { ...options, credentials: 'omit', redirect: 'error' });
    if (request.mode !== 'cors') throw Object.assign(new Error('Browser Host HTTP requires CORS-readable responses'), { code: 'unsupported' });
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const response = await brokerFetch({ url: request.url, method: request.method, headers: [...request.headers], body, mode: request.mode, cache: request.cache, integrity: request.integrity, keepalive: request.keepalive }, request.signal);
    const nullBody = request.method === 'HEAD' || [204, 205, 304].includes(response.status);
    const result = new Response(nullBody ? null : response.body, { status: response.status, statusText: response.statusText, headers: response.headers });
    // Response constructors cannot set these browser-produced metadata fields.
    // Keep native body readers/clone behavior, with the broker's final metadata.
    const decorate = target => {
      Object.defineProperties(target, Object.fromEntries(['url', 'redirected', 'type'].map(key => [key, { value: response[key], configurable: true }])));
      const clone = target.clone.bind(target);
      Object.defineProperty(target, 'clone', { value: () => decorate(clone()) });
      for (const name of ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']) {
        if (typeof target[name] !== 'function') continue;
        const consume = target[name].bind(target);
        Object.defineProperty(target, name, { value: (...args) => trackHttp(consume(...args)) });
      }
      return target;
    };
    return decorate(result);
  })());
  const instantiate = WebAssembly.instantiate, instantiateStreaming = WebAssembly.instantiateStreaming;
  WebAssembly.instantiateStreaming = async (response, imports) => WebAssembly.instantiate(await (await response).arrayBuffer(), imports);
  const sentinel = {};
  WebAssembly.instantiate = async (binary, imports) => {
    if (imports) {
      imports.sentinel ??= { create_sentinel: () => sentinel, is_sentinel: value => value === sentinel ? 1 : 0 };
      imports.env ??= {};
      imports.env.wasmsh_js_http_fetch = new WebAssembly.Suspending(async (urlPtr, methodPtr, headersPtr, bodyPtr, bodyLen, follow) => {
        const m = moduleRef;
        if (!m) return 0;
        let result;
        try {
          if (bodyLen > 1048576) throw Object.assign(new Error('Network request exceeds byte limit'), { code: 'limit' });
          const response = await brokerFetch({ url: m.UTF8ToString(urlPtr), method: m.UTF8ToString(methodPtr), headers: JSON.parse(m.UTF8ToString(headersPtr) || '[]'), body: bodyPtr && bodyLen ? m.HEAPU8.slice(bodyPtr, bodyPtr + bodyLen) : undefined });
          let raw = ''; for (const byte of response.body ?? []) raw += String.fromCharCode(byte);
          result = { status: response.status, headers: response.headers, body_base64: btoa(raw) };
        } catch (error) { result = { status: 0, headers: [], body_base64: '', error: error?.code ? error.message : 'Browser HTTP bridge failed before receiving a response' }; }
        return m.stringToNewUTF8(JSON.stringify(result));
      });
    }
    const instance = await instantiate.call(WebAssembly, binary, imports);
    const exports = instance.instance?.exports ?? instance.exports;
    if (typeof exports?.wasmsh_runtime_handle_json === 'function') wasmExports = exports;
    return instance;
  };
  try {
    const { loadPyodide } = await self.__microcrabImport(new URL('pyodide.mjs', assetRoot));
    pyodide = await loadPyodide({ indexURL: assetRoot, args: [], env: { HOME: '/workspace', PYTHONHOME: '/' }, stdout: text => boundedOutput('stdout', text + '\n'), stderr: text => boundedOutput('stderr', text + '\n') });
  } finally { WebAssembly.instantiate = instantiate; WebAssembly.instantiateStreaming = instantiateStreaming; }
  const m = moduleRef = pyodide._module;
  if (!m?.ccall || typeof m._wasmsh_runtime_new !== 'function' || typeof m._wasmsh_runtime_handle_json !== 'function')
    throw new Error('Installed Pyodide module does not contain wasmsh');
  if (!wasmExports?.wasmsh_runtime_handle_json) throw new Error('Installed runtime lacks the JSPI invocation export');
  invokeCommand = WebAssembly.promising(wasmExports.wasmsh_runtime_handle_json);
  m.FS.mkdirTree('/workspace');
  runtime = m.ccall('wasmsh_runtime_new', 'number', [], []);
  if (!runtime) throw new Error('wasmsh runtime initialization failed');
  await command({ Init: { step_budget: 100000, allowed_hosts: (params.allowedOrigins ?? []).map(value => new URL(value).host) } });
  // wasmsh date stays at 2026-01-01 unless WASMSH_DATE names a clock. Bind the
  // browser's local time once the runtime can accept a command.
  await bindHostClock();
  for (const file of params.files) {
    if (!confined(file.path) || file.data.byteLength > 4194304) throw new Error('Invalid persisted workspace file');
    m.FS.mkdirTree(file.path.slice(0, file.path.lastIndexOf('/')));
    if (file.kind === 'directory') m.FS.mkdirTree(file.path);
    else m.FS.writeFile(file.path, file.data);
  }
  // Observe selected changed paths, never scan the entire workspace at a round
  // boundary. Persist file content after close; interrupted open writes remain
  // explicitly indeterminate rather than being described as rolled back.
  const resolved = input => {
    if (typeof input !== 'string') return input;
    const absolute = input.startsWith('/') ? input : m.FS.cwd() + '/' + input;
    const parts = [];
    for (const part of absolute.split('/')) { if (!part || part === '.') continue; if (part === '..') parts.pop(); else parts.push(part); }
    return '/' + parts.join('/');
  };
  const close = m.FS.close.bind(m.FS), unlink = m.FS.unlink.bind(m.FS), rename = m.FS.rename.bind(m.FS), mkdir = m.FS.mkdir.bind(m.FS), rmdir = m.FS.rmdir.bind(m.FS);
  let observing = false;
  const publishPath = path => {
    path = resolved(path);
    if (observing || !confined(path)) return;
    observing = true;
    try {
      const stat = m.FS.stat(path);
      if (m.FS.isFile(stat.mode)) {
        if (stat.size > 4194304) throw new Error('Workspace file exceeds quota');
        send({ type: 'fs_write', run_id: runId, path, data: m.FS.readFile(path) });
      }
    } finally { observing = false; }
  };
  m.FS.close = stream => { const path = stream.path, writable = (stream.flags & 3) !== 0; const result = close(stream); if (writable) publishPath(path); return result; };
  m.FS.unlink = path => { const absolute = resolved(path), result = unlink(path); if (confined(absolute)) send({ type: 'fs_remove', run_id: runId, path: absolute }); return result; };
  m.FS.mkdir = (...args) => { const path = resolved(args[0]), result = mkdir(...args); if (confined(path) && path !== '/workspace') send({ type: 'fs_mkdir', run_id: runId, path }); return result; };
  m.FS.rmdir = path => { const absolute = resolved(path), result = rmdir(path); if (confined(absolute)) send({ type: 'fs_remove', run_id: runId, path: absolute }); return result; };
  m.FS.rename = (from, to) => { const source = resolved(from), destination = resolved(to), result = rename(from, to); if (confined(source) && confined(destination)) send({ type: 'fs_rename', run_id: runId, from: source, to: destination }); else { if (confined(source)) send({ type: 'fs_remove', run_id: runId, path: source }); publishPath(destination); } return result; };
  const pythonVersion = pyodide.runPython("import sys; '.'.join(str(value) for value in sys.version_info[:3])");
  const implementation = pyodide.runPython('sys.implementation.name');
  send({ type: 'ready', python: { implementation, version: pythonVersion } });
}
function hostClockStamp(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} UTC${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`;
}
function hostClockBinding(now) {
  return `export WASMSH_DATE='${hostClockStamp(now)}'`;
}
async function bindHostClock() {
  const events = await command({ Run: { input: hostClockBinding() } });
  let code = null;
  for (const event of events) {
    if (Object.hasOwn(event, 'Exit')) code = event.Exit;
    if (event.Diagnostic?.[0] === 'Error') throw new Error('wasmsh host clock binding failed');
  }
  if (code !== 0) throw new Error('wasmsh host clock binding failed');
}
async function command(value) {
  const input = moduleRef.stringToNewUTF8(JSON.stringify(value));
  let ptr;
  try {
    ptr = await invokeCommand(runtime, input);
    if (!ptr) throw new Error('wasmsh command returned no result');
    return JSON.parse(moduleRef.UTF8ToString(ptr));
  } finally {
    if (ptr) moduleRef.ccall('wasmsh_runtime_free_string', null, ['number'], [ptr]);
    moduleRef._free(input);
  }
}
self.onmessage = async ({ data }) => {
  if (data.type === 'http_response') {
    const pending = httpPending.get(data.id); if (!pending) return;
    httpPending.delete(data.id);
    if (data.error) pending.reject(Object.assign(new Error(data.error), { code: data.code, name: data.code === 'cancelled' ? 'AbortError' : 'Error' })); else pending.resolve(data.response);
    return;
  }
  try {
    if (data.type === 'boot') { await boot(data); return; }
    if (data.type !== 'run' || !runtime) throw new Error('Unsupported execution request');
    runId = data.run_id; limit = data.output_bytes; outputBytes = 0; executing = true;
    if (!confined(data.cwd)) throw new Error('Working directory leaves workspace');
    // Refresh the bound clock at the external command boundary. A long-lived
    // runtime would otherwise keep the timestamp from startup.
    const events = await command({ Run: { input: `${hostClockBinding()} && cd '${data.cwd.replaceAll("'", "'\\''")}' && ${data.command}` } });
    let code = null;
    for (const event of events) {
      if (event.Stdout) boundedOutput('stdout', event.Stdout);
      if (event.Stderr) boundedOutput('stderr', event.Stderr);
      if (Object.hasOwn(event, 'Exit')) code = event.Exit;
      if (event.Diagnostic?.[0] === 'Error') throw new Error('wasmsh execution diagnostic');
    }
    if (!Number.isInteger(code)) throw new Error('wasmsh Run returned without an Exit event');
    // Always take an idle checkpoint: Fetch may reject before broker admission
    // (for example redirect:follow), then leave httpActive before Run returns.
    // Its catch/write continuation still belongs to this invocation. Checking
    // only a nonempty set could retire the realm before that outcome is saved.
    do {
      await Promise.allSettled([...httpActive]);
      await new Promise(resolve => setTimeout(resolve, 0));
    } while (httpActive.size);
    executing = false;
    send({ type: 'exit', run_id: runId, code });
  } catch (error) { executing = false; send({ type: 'failed', run_id: runId, code: 'execution_failed', message: data.type === 'boot' ? String(error?.message ?? 'Browser runtime bootstrap failed').slice(0, 512) : 'Browser runtime failed; inspect the retained execution receipt' }); }
};
