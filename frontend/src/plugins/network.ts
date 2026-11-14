import { LIMITS, type Json, type PluginManifest } from "./types";
interface SocketScope {
  isCurrent: () => boolean;
  event: (requestId: number, value: Json) => void;
}
export class PluginNetwork {
  private sockets = new Map<number, WebSocket>();
  private scopes = new Map<number, SocketScope>();
  private cleanups = new Map<
    number,
    (reason: string, retire?: boolean) => void
  >();
  private next = 0;
  constructor(
    private readonly manifest: PluginManifest,
    private readonly event: (requestId: number, value: Json) => void,
  ) {}
  private url(value: Json | undefined, protocols: string[]): URL {
    if (typeof value !== "string")
      throw new Error("network URL must be string");
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || url.username || url.password)
      throw new Error("unsupported network protocol or URL credentials");
    if (!this.manifest.network_origins?.includes(url.origin))
      throw new Error(
        `network origin was not declared by manifest: ${url.origin}`,
      );
    return url;
  }
  async execute(
    kind: string,
    payload: Json,
    signal: AbortSignal,
    requestId: number,
    scope: SocketScope = { isCurrent: () => true, event: this.event },
  ): Promise<Json> {
    this.retireStale();
    if (!scope.isCurrent()) throw new Error("network origin is retired");
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("network payload must be object");
    const p = payload;
    if (kind === "http") {
      const url = this.url(p.url, ["http:", "https:"]);
      if (p.body !== undefined && typeof p.body !== "string")
        throw new Error("HTTP body must be string");
      if (
        typeof p.body === "string" &&
        new TextEncoder().encode(p.body).length > LIMITS.networkBytes
      )
        throw new Error("HTTP request body exceeds 2 MiB");
      const headers: Record<string, string> = {};
      if (p.headers !== undefined) {
        if (
          !p.headers ||
          typeof p.headers !== "object" ||
          Array.isArray(p.headers)
        )
          throw new Error("HTTP headers must be object");
        for (const [k, v] of Object.entries(p.headers)) {
          if (typeof v !== "string")
            throw new Error("HTTP header value must be string");
          headers[k] = v;
        }
      }
      const response = await fetch(url, {
        method: typeof p.method === "string" ? p.method : "GET",
        headers,
        body: typeof p.body === "string" ? p.body : undefined,
        signal,
        redirect: "error",
        credentials: "omit",
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > LIMITS.networkBytes) {
              await reader.cancel();
              throw new Error("HTTP response exceeds 2 MiB");
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });
      return {
        status: response.status,
        headers: responseHeaders,
        body: new TextDecoder().decode(bytes),
      };
    }
    if (kind === "ws-open") {
      if (this.sockets.size >= LIMITS.sockets)
        throw new Error("plugin exceeds four WebSocket handles");
      const url = this.url(p.url, ["ws:", "wss:"]);
      const id = ++this.next;
      const protocols = p.protocols;
      if (
        protocols !== undefined &&
        (!Array.isArray(protocols) ||
          protocols.length > 16 ||
          protocols.some((x) => typeof x !== "string"))
      )
        throw new Error("invalid WebSocket protocols");
      const socket = new WebSocket(url, protocols as string[] | undefined);
      this.sockets.set(id, socket);
      this.scopes.set(id, scope);
      const current = () => {
        if (this.sockets.get(id) === socket && scope.isCurrent()) return true;
        this.retireStale();
        return false;
      };
      return await new Promise<Json>((resolve, reject) => {
        // The owner can retire a CONNECTING socket before any browser event.
        // Settle its open request and release the listener synchronously.
        const cleanup = (reason: string) => {
          signal.removeEventListener("abort", abort);
          this.sockets.delete(id);
          this.scopes.delete(id);
          this.cleanups.delete(id);
          reject(new Error(reason));
        };
        const abort = () => {
          cleanup("WebSocket open cancelled");
          socket.close(1000, "request cancelled");
        };
        let retired = false;
        this.cleanups.set(id, (reason, retire = true) => {
          retired = retire;
          cleanup(reason);
        });
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        socket.onopen = () => {
          signal.removeEventListener("abort", abort);
          if (!current()) {
            reject(new Error("WebSocket origin is retired"));
            return;
          }
          resolve({ handle: id });
        };
        socket.onerror = () => {
          cleanup("WebSocket connection failed");
          socket.close(1000, "connection failed");
        };
        socket.onmessage = (event) => {
          if (!current()) return;
          if (typeof event.data !== "string") {
            socket.close(4003, "text only");
            return;
          }
          if (
            new TextEncoder().encode(event.data).length > LIMITS.networkBytes
          ) {
            socket.close(4009, "message quota");
            return;
          }
          scope.event(requestId, {
            type: "ws-message",
            handle: id,
            data: event.data,
          });
        };
        socket.onclose = (event) => {
          const deliver = !retired && scope.isCurrent();
          cleanup(`WebSocket closed before open: ${event.code}`);
          if (!deliver) return;
          scope.event(requestId, {
            type: "ws-close",
            handle: id,
            code: event.code,
            reason: event.reason,
          });
        };
      });
    }
    if (typeof p.handle !== "number")
      throw new Error("WebSocket handle must be number");
    const socket = this.sockets.get(p.handle);
    if (!socket) throw new Error("unknown or closed WebSocket handle");
    if (kind === "ws-close") {
      this.cleanups.get(p.handle)?.("WebSocket explicitly closed", false);
      socket.close(1000);
      return { closed: true };
    }
    if (kind === "ws-send") {
      if (typeof p.data !== "string")
        throw new Error("WebSocket data must be string");
      if (
        new TextEncoder().encode(p.data).length > LIMITS.networkBytes ||
        socket.bufferedAmount > LIMITS.networkBytes
      )
        throw new Error("WebSocket send quota exceeded");
      if (socket.readyState !== WebSocket.OPEN)
        throw new Error("WebSocket is not open");
      socket.send(p.data);
      return { sent: true };
    }
    throw new Error(`unsupported network operation: ${kind}`);
  }
  retireStale(): void {
    for (const [id, socket] of this.sockets)
      if (!this.scopes.get(id)?.isCurrent()) {
        this.cleanups.get(id)?.("WebSocket origin is retired");
        socket.onopen = null;
        socket.onerror = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.close(1000, "plugin origin retired");
      }
  }
  close(): void {
    for (const [id, socket] of this.sockets) {
      this.cleanups.get(id)?.("WebSocket plugin instance ended");
      socket.onopen = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.close(1000, "plugin instance ended");
    }
    this.sockets.clear();
    this.scopes.clear();
    this.cleanups.clear();
  }
}
