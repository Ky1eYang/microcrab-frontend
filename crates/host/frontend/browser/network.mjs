// External HTTP is subordinate to an admitted shell invocation. Execution-realm
// CSP denies native connections; only this trusted credential-omitting broker
// reaches external origins, with bounded request and streamed response bytes.
import { fault } from './workspace.mjs';
export class Network {
  constructor(origins = null, backendOrigin = location.origin) {
    this.backendOrigin = backendOrigin;
    this.origins = origins === null ? null : new Set(origins.map(value => {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password)
        throw fault('invalid_request', 'Network destinations must be exact HTTPS origins');
      if (url.origin === backendOrigin) throw fault('denied', 'Application origin cannot be a shell network destination');
      return value;
    }));
    this.pending = new Set();
  }
  async fetch(value, signal) {
    if (!value || typeof value.url !== 'string' || value.url.length > 8192 || !Array.isArray(value.headers ?? []) || (value.headers?.length ?? 0) > 128)
      throw fault('invalid_request', 'Invalid browser HTTP envelope');
    if (value.body != null && (!(value.body instanceof Uint8Array) || value.body.byteLength > 1048576))
      throw fault('limit', 'HTTP request exceeds the Host byte limit');
    const url = new URL(value.url);
    if ((this.origins !== null && !this.origins.has(url.origin)) || url.origin === this.backendOrigin || url.username || url.password || url.protocol !== 'https:')
      throw fault('denied', 'Network destination is outside the Host ceiling');
    const method = String(value.method ?? 'GET');
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method) || ['CONNECT', 'TRACE', 'TRACK'].includes(method.toUpperCase()))
      throw fault('unsupported', 'Unsupported browser HTTP method');
    const headers = new Headers();
    let headerBytes = 0;
    for (const pair of value.headers ?? []) {
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(item => typeof item !== 'string')) throw fault('invalid_request', 'Invalid HTTP header');
      const [name, text] = pair;
      headerBytes += new TextEncoder().encode(name + text).byteLength;
      if (headerBytes > 16384) throw fault('limit', 'HTTP headers exceed the Host byte limit');
      if (/^(cookie2?$|proxy-|sec-|origin$|host$|referer$)/i.test(name))
        throw fault('denied', 'Ambient credentials and browser identity headers are not exposed');
      headers.append(name, text);
    }
    const body = value.body ? new Uint8Array(value.body) : undefined;
    if (body && body.byteLength > 1024 * 1024) throw fault('limit', 'HTTP request exceeds the Host byte limit');
    if (value.mode != null && value.mode !== 'cors') throw fault('unsupported', 'Browser Host HTTP requires CORS-readable responses');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    this.pending.add(controller);
    try {
      const response = await fetch(url, { method, headers, body, signal: controller.signal, credentials: 'omit', redirect: 'error', mode: 'cors', referrerPolicy: 'no-referrer', cache: value.cache ?? 'no-store', integrity: value.integrity ?? '', keepalive: value.keepalive ?? false });
      const reader = response.body?.getReader(); let length = 0; const chunks = [];
      if (reader) try {
        for (;;) {
          const { value: chunk, done } = await reader.read(); if (done) break;
          length += chunk.byteLength;
          if (length > 4 * 1024 * 1024) { await reader.cancel(); throw fault('limit', 'HTTP response exceeds the Host byte limit'); }
          chunks.push(chunk);
        }
      } finally { reader.releaseLock(); }
      const data = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      const nullBody = method.toUpperCase() === 'HEAD' || [204, 205, 304].includes(response.status) || response.body === null;
      return { status: response.status, statusText: response.statusText, url: response.url, redirected: response.redirected, type: response.type, headers: [...response.headers], body: nullBody ? null : data };
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(fault('cancelled', 'Browser HTTP cancelled by the request owner'), { name: 'AbortError' });
      throw error;
    } finally { signal?.removeEventListener('abort', abort); this.pending.delete(controller); }
  }
  cancel() { for (const controller of this.pending) controller.abort(); this.pending.clear(); }
}
