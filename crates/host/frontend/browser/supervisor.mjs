// Browser Host owns effects, durable workspace and virtual process handles.
// Session remains the invocation/job/permission authority. No LocalHost fallback.
import { Network } from './network.mjs';
import { browserHttpFailure } from './network-diagnostics.mjs';
import { settleUnknown, sameScope } from './receipts.mjs';
import { Capture } from './capture.mjs';
import { preflightMutations, mutate as mutateFile } from './mutations.mjs';
import { Workspace, pathOf, digest, fault, MAX_FILE_BYTES } from './workspace.mjs';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
export const FRAME_BYTES = 131072, CHUNK_BYTES = 16384;
const primitiveNames = ['file_mutation', 'filesystem.stat', 'process.status', 'process.wait', 'process.watch', 'process.kill-tree', 'process.release', 'shell.launch', 'shell.capture-status', 'shell.read', 'shell.drain'];
const toolNames = ['read', 'write', 'file_mutation', 'read_file', 'cache_point', 'shell', 'process'];
export function validateShellInput(input) {
  // wasmsh 0.5.1 parses unquoted/double-quoted literals byte-by-byte as chars.
  // SingleQuoted preserves the original UTF-8 slice. Reject instead of guessing
  // an output recoding or changing the user's command semantics.
  let quote = null, escaped = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (character.charCodeAt(0) > 127 && quote !== 'single')
      throw fault('unsupported', 'wasmsh 0.5.1 requires non-ASCII shell text inside plain single quotes; use Python ASCII escapes for generated Unicode');
    if (escaped) { escaped = false; continue; }
    if (quote === 'single' || quote === 'ansi') { if (character === "'") quote = null; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (quote === 'double') { if (character === '"') quote = null; continue; }
    if (character === '"') quote = 'double';
    else if (character === "'") quote = input[index - 1] === '$' ? 'ansi' : 'single';
  }
}
function size(value) { return encoder.encode(JSON.stringify(value)).byteLength; }
function boundedMessage(message) {
  const bytes = encoder.encode(String(message ?? 'Browser Host operation failed'));
  let end = Math.min(bytes.byteLength, 4096);
  while (end < bytes.byteLength && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}
function wireError(error) { return { code: ['unsupported', 'denied', 'timeout', 'cancelled', 'conflict', 'operation_conflict', 'invalid_request', 'limit', 'io', 'not_found', 'outcome_unknown'].includes(error?.code) ? error.code : 'io', message: boundedMessage(error?.message) }; }
// At most 4096 UTF-8 error bytes, including sixfold JSON escaping. Normal
// control/file outcomes fit this envelope; a drain additionally reserves every
// byte the process can retain, even if output arrives during admission.
const COMPLETION_PADDING = 32768;
function completionPadding(request, processes) {
  return COMPLETION_PADDING + (request.method === 'shell_drain' ? 6 * (processes.get(request.params?.handle)?.capture.limit ?? 0) : 0);
}
function reservedReceiptBytes(receipt, namespace, padding) {
  return size({ ...receipt, namespace, _completion_padding: ' '.repeat(padding) });
}
function mutation(method) { return ['write', 'mutate', 'shell_launch', 'process_kill', 'process_release', 'shell_drain'].includes(method); }
export async function loadInstallation(manifestUrl = '/browser-host/current.json') {
  const url = new URL(manifestUrl, location.href);
  if (url.origin !== location.origin) throw fault('denied', 'Browser Host assets must be same-origin');
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw fault('unsupported', 'Browser Host artifacts are not installed');
  const manifest = await response.json();
  if (manifest.schema !== 1 || manifest.kind !== 'browser-host' || manifest.wasmsh_version !== '0.5.1' || !Array.isArray(manifest.files) || manifest.files.length > 2048 || !/^[a-f0-9]{64}$/.test(manifest.hash))
    throw fault('unsupported', 'Browser Host artifact manifest is incompatible');
  const base = new URL(manifest.base_url, url);
  if (base.origin !== location.origin || !base.pathname.startsWith('/browser-host/')) throw fault('denied', 'Invalid browser artifact origin');
  const files = [];
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || entry.path.startsWith('/') || entry.path.split('/').includes('..') || entry.size > 128 * 1024 * 1024)
      throw fault('invalid_request', 'Invalid browser artifact path or size');
    const result = await fetch(new URL(entry.path, base), { credentials: 'same-origin', redirect: 'error' });
    if (!result.ok) throw fault('unsupported', 'Browser Host artifact is missing');
    const data = new Uint8Array(await result.arrayBuffer());
    if (data.byteLength !== entry.size || await digest(data) !== entry.sha256) throw fault('conflict', 'Browser Host artifact integrity check failed');
    files.push({ path: entry.path, data });
  }
  for (const required of ['execution-worker.mjs', 'pyodide/pyodide.mjs', 'pyodide/pyodide.asm.wasm', 'pyodide/python_stdlib.zip'])
    if (!files.some(file => file.path === required)) throw fault('unsupported', 'Browser Host runtime artifact is incomplete');
  return { manifest, base, files };
}
export class BrowserHost {
  constructor(workspace, installation, options) {
    this.workspace = workspace; this.installation = installation; this.options = options;
    this.network = new Network(options.allowedOrigins ?? null, new URL(options.backend).origin); this.httpRequests = 0;
    this.processes = new Map(); this.nextHandle = 0; this.sequence = Promise.resolve(); this.closed = false;
    this.lease = crypto.randomUUID(); this.instance = crypto.randomUUID(); this.waiters = new Map(); this.activeEffects = new Set();
  }
  static async create(options) {
    const installation = await loadInstallation(options.manifestUrl);
    const workspace = await Workspace.open([options.backend, options.owner, options.browserId, options.conversationId, options.workspaceId]);
    try {
      await workspace.lease();
      const host = new BrowserHost(workspace, installation, options);
      await host.boot(); return host;
    } catch (error) { await workspace.close(); throw error; }
  }
  async descriptor() {
    const capabilities = [...toolNames].sort();
    const descriptor = {
      protocol_version: 2, host_id: this.options.browserId, workspace_id: this.options.workspaceId,
      bridge_instance_id: '', workspace_root: '/workspace', platform: 'browser',
      info: { os_family: 'other', os: 'browser', arch: 'wasm32', shell: 'wasmsh', path_separator: '/', newline: '\n', capabilities, virtual_shell: { engine: 'wasmsh', python: this.python ?? null }, description: [
        'This Host runs wasmsh 0.5.1 in a browser virtual workspace. Native Bash, OS PIDs, PTYs, OS process-tree control and native package installation are unavailable.',
        this.python ? `Python implementation: ${this.python.implementation}${this.python.version ? ` (${this.python.version})` : ''}. Only pure Python packages and compatible Pyodide wheels are supported; unsupported native extensions fail. Interpreter memory is volatile; durable package artifacts do not resume a running interpreter.` : 'No Python interpreter is advertised. Do not assume Python or pip is available.',
        `HTTP network ceiling: ${this.options.allowedOrigins == null ? 'brokered Fetch admits external HTTPS subject to the limits below; pinned wasmsh curl/wget have an empty destination allowlist, so every network destination is denied with "curl: network access not available". This is a guest policy state, not evidence of a network outage. Use brokered Fetch, or configure explicit destination origins for curl/wget' : this.options.allowedOrigins.length ? 'brokered Fetch is limited to these exact HTTPS origins: ' + [...this.options.allowedOrigins].sort().join(', ') + '; pinned wasmsh curl/wget additionally check their exact destination host allowlist before reaching that broker' : 'the explicitly configured destination list is empty: brokered Fetch and wasmsh curl/wget network requests are denied. Reset the origin preference for default brokered Fetch access, or configure explicit destination origins'}. Fetch is credential-omitting, CORS-readable, redirect-rejecting and bounded; request cancellation is supported. Explicit API authorization headers are allowed; application cookies and browser identity headers are unavailable.`,
        'For Python networking, use import js, pyodide_js, uuid; choose path = "/workspace/fetch-" + uuid.uuid4().hex + ".json" and print(path), then launch js.eval(code)(pyodide_js.FS, url, path). Example code: async (FS, url, path) => { let outcome; try { const r = await fetch(url); outcome = {ok:r.ok,status:r.status,body:await r.text()}; } catch (error) { outcome = {ok:false,error:String(error)}; } FS.writeFile(path, JSON.stringify(outcome)); }. Read that exact outcome file after the process finishes; HTTP 4xx/5xx resolve normally and require inspecting ok/status. A fresh path prevents a prior result from being mistaken for this request. A JavaScript async function is supported, but the synchronous Python entrypoint cannot await it with run_sync/asyncio; Python Promise callbacks and asynchronous print are unsupported. Completion drains owned Fetch/body/clone consumers through an idle checkpoint and waits for acknowledged workspace writes; arbitrary detached timers are not owned work. Attach a rejection handler or try/catch and persist its outcome. A missing outcome file is inconclusive: inspect the exact process and persistence receipt rather than treating absence or shell exit zero as HTTP success, failure or a network outage.',
        'XMLHttpRequest and direct native connections are not brokered and are blocked by the execution realm CSP. Their NetworkError is not evidence that external HTTPS is unavailable; use brokered Fetch. Unknown browser Fetch failures do not by themselves distinguish CORS, TLS, DNS or redirect rejection.',
        'Browser HTTP requests are subject to CORS, mixed-content restrictions and Host network policy. Raw TCP, listening sockets and UDP are unavailable.',
        'wasmsh 0.5.1: put non-ASCII shell text in plain single quotes; unquoted, double-quoted and ANSI-C-quoted Unicode are unsupported. Python ASCII escapes or chr() can generate Unicode.',
        'Shell date follows the browser host local time. WASMSH_DATE is bound when the runtime starts and refreshed before each external command; the built-in 2026-01-01 clock is not used.',
      ].join(' ') },
      tool_capabilities: capabilities, supported_primitives: [...primitiveNames].sort(), descriptor_digest: '',
    };
    descriptor.descriptor_digest = await digest(JSON.stringify(descriptor));
    descriptor.bridge_instance_id = this.instance; return descriptor;
  }
  async boot() {
    if (this.cleanupFailure) throw this.cleanupFailure;
    const origins = this.options.allowedOrigins ?? null;
    for (const value of origins ?? []) {
      const url = new URL(value);
      if (url.origin !== value || url.protocol !== 'https:' || url.origin === new URL(this.options.backend).origin)
        throw fault('denied', 'Browser network ceiling requires exact external HTTPS origins');
    }
    const frame = document.createElement('iframe');
    if (!('credentialless' in frame)) throw fault('unsupported', 'This browser cannot isolate execution credentials');
    frame.credentialless = true; frame.sandbox.add('allow-scripts'); frame.hidden = true;
    frame.referrerPolicy = 'no-referrer'; frame.setAttribute('aria-hidden', 'true');
    const realm = new URL(this.installation.manifest.realm, this.installation.base);
    realm.hash = encodeURIComponent(JSON.stringify({ origins, backend: new URL(this.options.backend).origin }));
    frame.src = realm.href;
    this.frame = frame;
    const channel = new MessageChannel(); this.port = channel.port1;
    let resolveBoot, rejectBoot;
    const ready = new Promise((resolve, reject) => { resolveBoot = resolve; rejectBoot = reject; });
    // Bounded boot is setup admission, not an elapsed execution ceiling.
    const timer = setTimeout(() => rejectBoot(fault('unsupported', 'Browser Host runtime initialization timed out')), 30000);
    this.port.onmessage = ({ data }) => {
      if (data.type === 'terminated' && data.nonce === this.terminationNonce) { this.terminationResolve?.(); return; }
      if (data.type === 'realm_ready') {
        const source = this.installation.files.find(file => file.path === 'execution-worker.mjs');
        this.port.postMessage({ type: 'start', source: decoder.decode(source.data), boot: {
          type: 'boot', run_id: null, assetRoot: 'https://microcrab-runtime.invalid/pyodide/',
          assets: this.installation.files.filter(file => file.path.startsWith('pyodide/')).map(file => ({ ...file, path: file.path.slice(8) })),
          files: this.bootFiles, allowedOrigins: origins,
        } });
      } else if (data.type === 'ready' && !this.booted) {
        if (data.python?.implementation !== 'cpython' || !/^\d+\.\d+\.\d+$/.test(data.python?.version)) return rejectBoot(fault('unsupported', 'Browser Python metadata is unavailable'));
        this.python = { implementation: data.python.implementation, version: data.python.version }; resolveBoot();
      }
      else if (data.type === 'failed' && !this.booted) rejectBoot(fault('unsupported', data.message ?? 'Browser runtime unavailable'));
      else this.receiveExecution(data);
    };
    this.port.start(); this.bootFiles = await this.workspace.files();
    frame.onload = () => frame.contentWindow.postMessage({ type: 'connect' }, '*', [channel.port2]);
    document.body.append(frame);
    try { await ready; this.booted = true; } catch (error) { await this.terminateRealm(); throw error; }
    finally { clearTimeout(timer); this.bootFiles = null; }
  }
  async terminateRealm() {
    if (this.cleanupFailure) throw this.cleanupFailure;
    this.network.cancel();
    if (!this.port) { this.booted = false; return; }
    if (this.terminating) return this.terminating;
    const port = this.port, frame = this.frame;
    this.terminating = (async () => {
      const nonce = this.terminationNonce = crypto.randomUUID();
      let timer;
      try {
        const acknowledged = new Promise((resolve, reject) => {
          this.terminationResolve = resolve;
          timer = setTimeout(() => reject(fault('outcome_unknown', 'Browser worker cleanup is unresolved')), 5000);
        });
        port.postMessage({ type: 'terminate', nonce }); await acknowledged;
      } finally {
        clearTimeout(timer); frame?.remove(); port.close(); this.booted = false;
        if (this.port === port) this.port = null;
        this.terminationResolve = null;
      }
    })();
    try { await this.terminating; }
    catch (error) { this.cleanupFailure = error; throw error; }
    finally { this.terminating = null; }
  }
  receiveExecution(data) {
    const entry = this.processes.get(data.run_id);
    if (data.type === 'http_request' && (!entry || entry.state !== 'running' || entry.stopping)) {
      this.port?.postMessage({ type: 'http_response', id: data.id, error: 'Browser HTTP execution has ended' }); return;
    }
    if (!entry || entry.state !== 'running' || entry.stopping) return;
    if (data.type === 'http_cancel') { entry.httpControllers?.get(data.id)?.abort(); return; }
    if (data.type === 'http_request') {
      const port = this.port;
      if (this.httpRequests >= 8 || typeof data.id !== 'string' || data.id.length > 128) {
        port.postMessage({ type: 'http_response', id: data.id, error: 'Browser HTTP request capacity exceeded' }); return;
      }
      const controller = new AbortController();
      entry.httpControllers ??= new Map();
      if (entry.httpControllers.has(data.id)) { port.postMessage({ type: 'http_response', id: data.id, error: 'Duplicate browser HTTP request' }); return; }
      entry.httpControllers.set(data.id, controller);
      this.httpRequests++;
      void this.network.fetch(data.request, controller.signal).then(response => {
        if (this.port === port) port.postMessage({ type: 'http_response', id: data.id, response });
      }).catch(error => {
        const failure = browserHttpFailure(error, data.request, controller.signal);
        if (this.port === port) port.postMessage({ type: 'http_response', id: data.id, error: failure.message, code: failure.code });
      }).finally(() => { entry.httpControllers.delete(data.id); this.httpRequests--; });
      return;
    }
    if (data.type === 'output') {
      if (!['stdout', 'stderr'].includes(data.channel) || !(data.data instanceof Uint8Array)) return this.failProcess(entry, 'Invalid execution output');
      try { entry.capture.append(data.channel, data.data); }
      catch { return this.failProcess(entry, 'Browser output quota exceeded or invalid UTF-8 output'); }
      this.changed(entry); return;
    }
    if (data.type === 'output_limit') { entry.truncated = true; return this.failProcess(entry, 'Browser output quota exceeded'); }
    if (['fs_write', 'fs_remove', 'fs_mkdir', 'fs_rename'].includes(data.type)) {
      entry.persistence = entry.persistence.then(() => {
        if (data.type === 'fs_write') return this.workspace.write(data.path, data.data);
        if (data.type === 'fs_mkdir') return this.workspace.write(data.path, new Uint8Array(), undefined, 'directory');
        if (data.type === 'fs_rename') return this.workspace.rename(data.from, data.to);
        return this.workspace.remove(data.path);
      });
      entry.persistence.catch(() => this.failProcess(entry, 'Browser workspace persistence failed')); return;
    }
    if (data.type === 'exit') {
      // A Python coroutine can outlive wasmsh's synchronous entrypoint. End the
      // process realm before another launch, so delayed callbacks cannot inherit
      // the next process's HTTP authority or contribute to its completion drain.
      entry.stopping = true;
      void Promise.allSettled([entry.persistence, this.terminateRealm()]).then(results => {
        if (entry.state !== 'running') return;
        if (results.every(result => result.status === 'fulfilled') && Number.isInteger(data.code)) {
          entry.state = 'exited'; entry.code = data.code;
        } else {
          entry.state = 'failed'; entry.reason = 'Browser execution completion or cleanup failed';
        }
        this.changed(entry);
      }); return;
    }
    if (data.type === 'failed') this.failProcess(entry, data.message ?? 'Browser execution failed');
  }
  failProcess(entry, reason) {
    if (entry.stopping) return; entry.stopping = true;
    void this.terminateRealm().then(() => {
      entry.state = 'failed'; entry.reason = reason; this.changed(entry);
    }).catch(() => {
      entry.state = 'failed'; entry.reason = 'Browser worker cleanup outcome is unknown'; this.changed(entry);
    });
  }
  changed(entry) {
    entry.revision++;
    this.options.onFrame?.({ kind: 'process_changed', lease_generation: this.lease, handle: entry.handle, revision: entry.revision });
    if (entry.state !== 'running') { entry.capture.finish(); for (const resolve of [...(this.waiters.get(entry.handle) ?? [])]) resolve(); this.waiters.delete(entry.handle); }
  }
  async execute(request, signal, receipt = null, scope = null) {
    if (signal?.aborted) throw signal.reason;
    const method = request.method, p = request.params ?? {};
    if (method === 'normalize') return pathOf(p.path).replace(/^\/workspace\/?/, '') || '.';
    if (method === 'cache_point') {
      if (!Number.isSafeInteger(p.max_bytes) || p.max_bytes < 1 || p.max_bytes > 8388608) throw fault('invalid_request', 'Invalid cache point byte limit');
      const path = pathOf(p.path).replace(/^\/workspace\/?/, '');
      if (!path) throw fault('unsupported', 'Workspace root is not a file cache point');
      const file = await this.workspace.file(p.path);
      if (file?.kind === 'directory') throw fault('unsupported', 'Directory cache points are unavailable');
      if (file && file.data.byteLength > p.max_bytes) throw fault('limit', 'Cache point exceeds its byte limit');
      return { path, data: file ? [...file.data] : null, version: file?.version ?? null };
    }
    if (method === 'read_file') {
      const file = await this.workspace.file(p.path); if (!file) throw fault('not_found', 'File not found');
      if (file.data.byteLength > p.max_bytes) throw fault('limit', 'File exceeds byte limit'); return [...file.data];
    }
    if (method === 'read') {
      const file = await this.workspace.file(p.path); if (!file) throw fault('not_found', 'File not found');
      const text = decoder.decode(file.data), lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      if (!Number.isSafeInteger(p.offset_line) || p.offset_line < 1 || p.max_lines < 1 || p.max_bytes < 1) throw fault('invalid_request', 'Invalid text bounds');
      let content = '', at = p.offset_line - 1, count = 0;
      for (; at < lines.length && count < p.max_lines; at++, count++) {
        if (encoder.encode(content + lines[at]).byteLength > p.max_bytes) break; content += lines[at];
      }
      if (!count && at < lines.length) throw fault('limit', 'A file line exceeds the requested byte limit');
      return { content, start_line: p.offset_line, next_line: at < lines.length ? at + 1 : null, truncated: at < lines.length, version: file.version };
    }
    if (method === 'preflight_mutations' || method === 'mutate') {
      if (this.cleanupFailure) throw this.cleanupFailure;
      if ([...this.processes.values()].some(entry => entry.state === 'running')) throw fault('conflict', 'Workspace is owned by a running shell');
      if (method === 'preflight_mutations') {
        const normalized = await preflightMutations(this.workspace, p.requests);
        const sample = { operation_id: '\0'.repeat(256), payload_digest: '0'.repeat(64), scope, state: { state: 'intent' } };
        await this.workspace.checkReceiptCapacity(normalized.length, normalized.length * reservedReceiptBytes(sample, this.workspace.namespace, COMPLETION_PADDING));
        return normalized;
      }
      // Retire the execution realm before publication. A cleanup failure therefore
      // cannot turn an already committed mutation into an apparent generic error.
      await this.terminateRealm();
      return mutateFile(this.workspace, p, signal, receipt);
    }
    if (method === 'write') {
      if ([...this.processes.values()].some(entry => entry.state === 'running')) throw fault('conflict', 'Workspace is owned by a running shell');
      // Cleanup precedes the atomic file/receipt transaction for ordinary writes
      // as well as multi-file mutations. It cannot mask committed file bytes.
      await this.terminateRealm();
      if (signal?.aborted) throw signal.reason;
      return this.workspace.write(p.path, encoder.encode(p.content), p.precondition, 'file', receipt, signal);
    }
    if (method === 'stat') {
      const path = pathOf(p.path), file = await this.workspace.file(path);
      if (path === '/workspace') return { kind: 'directory', size: '0', modified_ms: null };
      if (!file) throw fault('not_found', 'File not found'); return { kind: file.kind ?? 'file', size: String(file.data.byteLength), modified_ms: null };
    }
    if (method === 'process_inventory') return [...this.processes.values()].map(entry => ({ handle: entry.handle, pid: null, state: this.state(entry), revision: entry.revision }));
    if (method === 'shell_launch') {
      if (typeof p.command !== 'string' || !p.command || encoder.encode(p.command).byteLength > 65536 || !Number.isInteger(p.output_bytes) || p.output_bytes < 1 || p.output_bytes > 1048576) throw fault('invalid_request', 'Invalid virtual shell bounds');
      validateShellInput(p.command);
      if ([...this.processes.values()].some(entry => entry.state === 'running')) throw fault('conflict', 'Virtual shell is busy with an existing process');
      if (this.processes.size >= 32) throw fault('limit', 'Virtual process capacity is exhausted');
      if (!this.booted) await this.boot();
      if (signal?.aborted) throw signal.reason;
      const handle = ++this.nextHandle;
      const entry = { handle, state: 'running', capture: new Capture(p.output_bytes), revision: 1, started: performance.now(), persistence: Promise.resolve(), truncated: false };
      this.processes.set(handle, entry);
      this.port.postMessage({ type: 'run', run_id: handle, command: p.command, cwd: pathOf(p.cwd ?? '/workspace'), output_bytes: p.output_bytes });
      return { handle, pid: null, revision: 1 };
    }
    const entry = this.processes.get(p.handle);
    if (!entry) throw fault('not_found', 'Virtual process handle not found');
    if (method === 'process_status') return { pid: null, ...this.state(entry), elapsed_s: Math.floor((performance.now() - entry.started) / 1000) };
    if (method === 'process_wait') {
      if (entry.state === 'running') await new Promise((resolve, reject) => {
        const waits = this.waiters.get(entry.handle) ?? [];
        const finished = () => { cleanup(); resolve(); };
        const aborted = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => { signal?.removeEventListener('abort', aborted); const index = waits.indexOf(finished); if (index >= 0) waits.splice(index, 1); };
        waits.push(finished); this.waiters.set(entry.handle, waits);
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
      });
      if (entry.state === 'failed') throw fault('io', entry.reason); return { code: entry.code, signal: entry.signal ?? null };
    }
    if (method === 'process_kill' || method === 'process_release') {
      if (entry.state === 'running') {
        // A kill acknowledgment cannot certify success before admitted closed
        // writes settle. Keep status/wait observers active through both owners.
        const results = await Promise.allSettled([this.terminateRealm()]);
        // Cleanup retires the message port; capture the final received write
        // chain after that barrier, including writes received during shutdown.
        results.push(...await Promise.allSettled([entry.persistence]));
        const failure = results.find(result => result.status === 'rejected');
        if (failure) {
          entry.state = 'failed'; entry.reason = failure.reason?.message ?? 'Browser process cleanup or persistence failed';
          this.changed(entry); throw fault('io', entry.reason);
        }
        entry.state = 'exited'; entry.code = null; entry.signal = 'Kill'; this.changed(entry);
      }
      await entry.persistence;
      if (method === 'process_release') this.processes.delete(entry.handle); return null;
    }
    if (method === 'shell_capture_status') {
      const counts = entry.capture.counts();
      return { closed: entry.state !== 'running', cursor: entry.capture.cursor, stdout_bytes: counts.stdout, stderr_bytes: counts.stderr, truncated: entry.capture.truncated || entry.truncated };
    }
    if (method === 'shell_read' || method === 'shell_drain') {
      const output = method === 'shell_read' ? entry.capture.read(p.from ?? entry.capture.cursor) : entry.capture.drain(p.max_bytes);
      output.truncated ||= entry.truncated; return output;
    }
    throw fault('unsupported', 'Host operation is unavailable in a browser');
  }
  state(entry) { return entry.state === 'running' ? { state: 'running' } : entry.state === 'failed' ? { state: 'failed', reason: entry.reason } : { state: 'exited', status: { code: entry.code, signal: entry.signal ?? null } }; }
  async effectOwned(effect, key = 'workspace') {
    this.effectLanes ??= new Map();
    const previous = this.effectLanes.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.effectLanes.set(key, current);
    await previous;
    try { return await effect(); } finally {
      release(); if (this.effectLanes.get(key) === current) this.effectLanes.delete(key);
    }
  }
  async flushCompletion(operation, scope) {
    const receipt = this.pendingCompletions?.get(operation);
    if (!receipt) return;
    if (scope && !sameScope(receipt.scope, scope)) throw fault('operation_conflict', 'Original completion scope changed');
    // This retries storage of an already known result, never its original effect.
    await this.workspace.record(receipt);
    this.pendingCompletions.delete(operation);
    this.activeEffects.delete(operation);
  }
  async transferOwned(transfer) {
    const previous = this.transferAdmission ?? Promise.resolve();
    let release;
    this.transferAdmission = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await transfer(); } finally { release(); }
  }
  async handle(frame, scope, send) {
    if (this.closed) throw fault('denied', 'Browser Host is closed');
    if (frame.kind === 'cancel') {
      if (frame.lease_generation !== this.lease) throw fault('denied', 'Browser Host lease changed');
      this.requestCancels?.get(frame.request_id)?.abort(fault('cancelled', 'Browser Host observation cancelled')); return;
    }
    const counter = frame.kind === 'request' ? 'pendingRequests' : 'pendingControl';
    const limit = frame.kind === 'request' ? 32 : 8;
    if ((this[counter] ?? 0) >= limit) {
      if (frame.kind === 'request') await send({ kind: 'response', request_id: frame.request_id, operation_id: frame.operation_id, result: { Err: { code: 'limit', message: 'Browser Host request capacity reached' } } });
      else throw fault('limit', 'Browser Host control capacity reached');
      return;
    }
    this[counter] = (this[counter] ?? 0) + 1;
    const cancel = new AbortController(); let timer;
    if (frame.kind === 'request') {
      this.requestCancels ??= new Map(); this.requestCancels.set(frame.request_id, cancel);
      if (Number.isInteger(frame.remaining_budget_ms) && frame.remaining_budget_ms > 0)
        timer = setTimeout(() => cancel.abort(fault('timeout', 'Browser Host RPC observation budget expired')), Math.min(frame.remaining_budget_ms, 2147483647));
    }
    try { return await this.dispatchFrame(frame, scope, send, cancel.signal); }
    finally { clearTimeout(timer); this.requestCancels?.delete(frame.request_id); this[counter]--; }
  }
  async dispatchFrame(frame, scope, send, signal) {
    if (size(frame) > FRAME_BYTES) throw fault('limit', 'Browser Host frame exceeds byte limit');
    if (frame.lease_generation !== this.lease) throw fault('denied', 'Browser Host lease changed');
    if (frame.kind === 'ping') return send({ kind: 'pong', lease_generation: this.lease });
    if (frame.kind === 'cancel') return; // Admission cancellation never kills an admitted process; job.kill owns that operation.
    if (frame.kind === 'status') {
      try { await this.flushCompletion(frame.operation_id, scope); } catch { /* The durable intent stays unresolved; status never invents a completed receipt. */ }
      const receipt = await this.workspace.receipt(frame.operation_id);
      return send({ kind: 'receipt', request_id: frame.request_id, receipt: receipt && sameScope(receipt.scope, scope) ? receipt : null });
    }
    if (frame.kind !== 'request') throw fault('unsupported', 'Unsupported browser Host frame');
    const request = frame.method, operation = frame.operation_id, hash = await digest(JSON.stringify(request));
    const consumption = request.method === 'shell_drain' ? `shell:${request.params?.handle}` : null;
    const lane = consumption ?? (['process_kill', 'process_release'].includes(request.method) ? `process:${request.params?.handle}` : 'workspace');
    let result;
    try {
      if (request.method === 'recovery') {
        for (const [operation, receipt] of this.pendingCompletions ?? []) {
          if (sameScope(receipt.scope, scope)) {
            try { await this.flushCompletion(operation, scope); } catch { /* Persisted intent still certifies unresolved ownership. */ }
          }
        }
        result = { Ok: (await this.workspace.receipts()).filter(receipt => sameScope(receipt.scope, scope)) };
      }
      else if (request.method === 'settle_unknown') result = { Ok: await this.effectOwned(() => settleUnknown(this.workspace, request.params, scope, this.activeEffects)) };
      else if (mutation(request.method)) result = await this.effectOwned(async () => {
        if (signal?.aborted) throw signal.reason;
        if (typeof operation !== 'string' || !operation || operation.length > 256) throw fault('invalid_request', 'Mutation requires a bounded operation identity');
        let old = await this.workspace.receipt(operation);
        if (old) {
          if (old.payload_digest !== hash || !sameScope(old.scope, scope)) throw fault('operation_conflict', 'Operation identity changed');
          try { await this.flushCompletion(operation); }
          catch (error) { throw fault('outcome_unknown', `Original browser effect is known but its completion receipt is not durable: ${boundedMessage(error.message)}; do not replay`); }
          old = await this.workspace.receipt(operation);
          if (old.state.state !== 'completed') throw fault('outcome_unknown', 'Original browser effect requires reconciliation');
          return old.state.result;
        }
        if ((await this.workspace.receipts()).some(receipt => sameScope(receipt.scope, scope) && ['intent', 'indeterminate'].includes(receipt.state.state) && (!receipt.consumption_key || receipt.consumption_key === consumption)))
          throw fault('outcome_unknown', 'Unresolved browser effect fences new mutations');
        const receipt = { operation_id: operation, payload_digest: hash, scope, state: { state: 'intent' }, ...(consumption ? { consumption_key: consumption } : {}) };
        const atomicFile = ['write', 'mutate'].includes(request.method);
        this.activeEffects.add(operation);
        try {
          // Materialize enough durable padding for the worst bounded completion,
          // before process admission, drain consumption or file publication.
          await this.workspace.record(receipt, completionPadding(request, this.processes));
          let outcome;
          try { outcome = { Ok: await this.execute(request, signal, atomicFile ? receipt : null, scope) }; }
          catch (error) { outcome = { Err: wireError(error) }; }
          if (atomicFile && Object.hasOwn(outcome, 'Ok')) return outcome;
          if (outcome.Err && (['outcome_unknown'].includes(outcome.Err.code) || (!atomicFile && ['io', 'timeout', 'cancelled'].includes(outcome.Err.code)))) {
            // A generic execution/cleanup failure does not prove no effect. Keep
            // the original intent as a durable fence if even this update fails.
            let storageFailure = '';
            try { await this.workspace.record({ ...receipt, state: { state: 'indeterminate' } }); }
            catch (error) { storageFailure = `; receipt storage also failed: ${boundedMessage(error.message)}`; }
            throw fault('outcome_unknown', `Browser effect may have occurred: ${outcome.Err.message}${storageFailure}; reconcile the original operation; do not replay`);
          }
          const completed = { ...receipt, state: { state: 'completed', result: outcome } };
          this.pendingCompletions ??= new Map();
          this.pendingCompletions.set(operation, completed);
          try { await this.flushCompletion(operation); }
          catch (error) {
            // Preserve the known result in this owner and the durable original
            // intent across reload. Status/duplicate observation may retry only
            // completion storage; no request path re-executes the effect.
            throw fault('outcome_unknown', `Browser effect returned a known outcome but completion storage failed: ${boundedMessage(error.message)}; reconcile the original operation; do not replay`);
          }
          return outcome;
        } finally { if (!this.pendingCompletions?.has(operation)) this.activeEffects.delete(operation); }
      }, lane);
      else result = { Ok: await this.execute(request, signal, null, scope) };
    } catch (error) { result = { Err: wireError(error) }; }
    const raw = request.method === 'read_file' && result.Ok ? new Uint8Array(result.Ok) : null;
    const bytes = raw ?? encoder.encode(JSON.stringify(result.Ok));
    if (result.Ok !== undefined && (raw || bytes.byteLength > FRAME_BYTES / 2)) {
      // Serialize declarations with their bounded chunks through EOF. Control
      // replies still bypass this lane and never wait for a bulk transfer.
      await this.transferOwned(async () => {
      const transfer_id = crypto.randomUUID();
      await send({ kind: 'response', request_id: frame.request_id, operation_id: operation, result: { Ok: { transfer_id, byte_length: bytes.byteLength, sha256: await digest(bytes), kind: raw ? 'bytes' : 'json' } } });
      for (let offset = 0, sequence = 0; offset < bytes.byteLength || sequence === 0; offset += CHUNK_BYTES, sequence++)
        await send({ kind: 'transfer_chunk', transfer_id, sequence, data: [...bytes.slice(offset, offset + CHUNK_BYTES)], eof: offset + CHUNK_BYTES >= bytes.byteLength });
      });
      return;
    }
    await send({ kind: 'response', request_id: frame.request_id, operation_id: operation, result });
  }
  async close() {
    if (this.closed) return; this.closed = true;
    for (const cancel of this.requestCancels?.values() ?? []) cancel.abort(fault('cancelled', 'Browser Host closed'));
    let cleanupFailed = false;
    try {
      await Promise.all(this.effectLanes?.values() ?? []);
      await this.terminateRealm();
      for (const entry of this.processes.values()) if (entry.state === 'running') { entry.state = 'failed'; entry.reason = 'Browser Host detached; effects may have occurred'; this.changed(entry); }
    } catch (error) { cleanupFailed = true; throw error; }
    finally {
      // Realm termination removes its iframe/port even when acknowledgment times
      // out. Retire the durable owner too, preserving the original cleanup cause.
      try { await this.workspace.close(); } catch (error) { if (!cleanupFailed) throw error; }
    }
  }
}
