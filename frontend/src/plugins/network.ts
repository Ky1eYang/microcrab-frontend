import { deliverHttpSse, readHttpResponse } from "./http-response";
import type { PluginResources } from "./resources";
import { LIMITS, type Json, type PluginManifest } from "./types";
interface SocketScope {
  isCurrent: () => boolean;
  event: (
    requestId: number,
    value: Json,
    current?: () => boolean,
  ) => void | Promise<void>;
}

const SSE_INTERVAL_MS = 500;
function waitForSseSlot(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(Error("HTTP response cancelled"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(Error("HTTP response cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class PluginNetwork {
  private sockets = new Map<number, WebSocket>();
  private scopes = new Map<number, SocketScope>();
  private cleanups = new Map<
    number,
    (reason: string, retire?: boolean) => void
  >();
  private next = 0;
  private activeSse?: AbortController;
  private nextSseAt = 0;
  constructor(
    private readonly manifest: PluginManifest,
    private readonly event: (requestId: number, value: Json) => void,
    private readonly resources?: PluginResources,
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
      const resource =
        p.resource !== undefined ? this.resources?.network(p) : undefined;
      if (p.resource !== undefined && !resource)
        throw Error("Resource grants are unavailable");
      const streaming = p.response_mode === "sse";
      if (streaming && (!resource || p.response_id !== undefined))
        throw Error(
          "HTTP SSE mode requires a configured resource without a response identity",
        );
      const url = resource
        ? new URL(resource.url)
        : this.url(p.url, ["http:", "https:"]);
      if (resource) signal = AbortSignal.any([signal, resource.signal]);
      const method =
        resource?.method ?? (typeof p.method === "string" ? p.method : "GET");
      if (
        resource &&
        (method === "GET" || method === "HEAD") &&
        p.body !== undefined
      )
        throw Error("HTTP GET and HEAD cannot carry a body");
      if (p.body !== undefined && typeof p.body !== "string")
        throw new Error("HTTP body must be string");
      if (
        typeof p.body === "string" &&
        new TextEncoder().encode(p.body).length > LIMITS.networkBytes
      )
        throw new Error("HTTP request body exceeds 2 MiB");
      const headers = new Headers();
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
          try {
            headers.append(k, v);
          } catch {
            throw Error("Invalid HTTP header name or value");
          }
        }
      }
      if (resource) {
        for (const key of ["authorization", "cookie", "proxy-authorization"])
          if (headers.has(key))
            throw Error("Resource credentials are host-owned");
        for (const [key, value] of Object.entries(resource.headers))
          headers.set(key, value);
      }
      if (streaming) headers.set("accept", "text/event-stream");
      if (
        p.response_id !== undefined &&
        typeof p.response_id !== "string" &&
        typeof p.response_id !== "number"
      )
        throw Error("Invalid response identity");
      if (streaming && this.activeSse)
        throw Error("Plugin already has an active HTTP SSE request");
      const stream = streaming ? new AbortController() : undefined;
      if (stream) {
        this.activeSse = stream;
        signal = AbortSignal.any([signal, stream.signal]);
      }
      const current = () =>
        !signal.aborted &&
        scope.isCurrent() &&
        (!resource || resource.isCurrent());
      const redact = (text: string) => {
        const authorization = resource?.authorization?.trim();
        if (!authorization) return text;
        const token = /^(?:Bearer|Basic) +(.+)$/i.exec(authorization)?.[1];
        const sanitized = text.replaceAll(authorization, "[redacted]");
        return token ? sanitized.replaceAll(token, "[redacted]") : sanitized;
      };
      try {
        if (!current()) throw Error("HTTP request was cancelled");
        const response = await fetch(url, {
          method,
          headers,
          body: typeof p.body === "string" ? p.body : undefined,
          signal,
          mode: "cors",
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
        });
        let body = "";
        if (streaming) {
          this.nextSseAt = Math.max(this.nextSseAt, performance.now() + SSE_INTERVAL_MS);
          await deliverHttpSse(response, signal, async (event) => {
            const wait = this.nextSseAt - performance.now();
            if (wait > 0) await waitForSseSlot(wait, signal);
            if (!current()) throw Error("HTTP SSE origin is retired");
            await scope.event(
              requestId,
              {
                ...event,
                event: redact(event.event),
                data: redact(event.data),
                ...(event.id !== undefined ? { id: redact(event.id) } : {}),
              },
              current,
            );
            this.nextSseAt = performance.now() + SSE_INTERVAL_MS;
          });
        } else if (p.response_mode === "discard") {
          await response.body?.cancel();
        } else {
          body = await readHttpResponse(
            response,
            p.response_id as string | number | undefined,
            signal,
          );
        }
        if (resource && !resource.isCurrent())
          throw Error("Resource grant was revoked");
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          if (
            !streaming ||
            ![
              "authorization",
              "proxy-authorization",
              "cookie",
              "set-cookie",
            ].includes(k)
          )
            Object.defineProperty(responseHeaders, k, {
              value: streaming ? redact(v) : v,
              enumerable: true,
            });
        });
        return { status: response.status, headers: responseHeaders, body };
      } finally {
        if (stream && this.activeSse === stream) this.activeSse = undefined;
      }
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
    this.activeSse?.abort();
    this.activeSse = undefined;
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
