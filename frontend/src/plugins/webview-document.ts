import type { Json } from "./types";

/** Independent presentation quotas: never accept a whole plugin Vars bag here. */
export const WEBVIEW_LIMITS = {
  htmlBytes: 512 * 1024,
  messageBytes: 64 * 1024,
  depth: 24,
  nodes: 4096,
  actionsPerSecond: 30,
  messagesPerSecond: 60,
} as const;

export type JsonRejection =
  "json-shape" | "json-depth" | "json-nodes" | "json-bytes";

export function jsonRejection(value: unknown): JsonRejection | null {
  let nodes = 0;
  let reason: JsonRejection = "json-shape";
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > WEBVIEW_LIMITS.nodes) {
      reason = "json-nodes";
      return false;
    }
    if (depth > WEBVIEW_LIMITS.depth) {
      reason = "json-depth";
      return false;
    }
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    if (Array.isArray(item))
      return item.every((child) => visit(child, depth + 1));
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(item).every((child) => visit(child, depth + 1));
  };
  try {
    if (!visit(value, 0)) return reason;
    return new TextEncoder().encode(JSON.stringify(value)).byteLength >
      WEBVIEW_LIMITS.messageBytes
      ? "json-bytes"
      : null;
  } catch {
    return "json-shape";
  }
}

export function boundedJson(value: unknown): value is Json {
  return jsonRejection(value) === null;
}

export function exactKeys(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

// This function is serialized as source, never interpolated with guest HTML or state.
// The host-only port remains in this closure; plugins receive just action + projection.
function bootstrap(nonce: string) {
  const host = window.parent;
  const listen = window.addEventListener.bind(window);
  const unlisten = window.removeEventListener.bind(window);
  const send = MessagePort.prototype.postMessage;
  const close = MessagePort.prototype.close;
  let port: MessagePort | undefined;
  let current: unknown;
  let hasCurrent = false;
  const subscribers = new Set<(state: unknown) => void>();
  const api = Object.freeze({
    action(action: string, payload: unknown = null) {
      if (port) send.call(port, { type: "action", action, payload });
    },
    onViewState(listener: (state: unknown) => void) {
      if (typeof listener !== "function") return () => {};
      subscribers.add(listener);
      if (hasCurrent) listener(current);
      return () => subscribers.delete(listener);
    },
  });
  Object.defineProperty(window, "microcrab", {
    value: api,
    writable: false,
    configurable: false,
  });
  const connect = (event: MessageEvent) => {
    const data = event.data;
    if (
      event.source !== host ||
      !data ||
      typeof data !== "object" ||
      Object.keys(data).length !== 2 ||
      data.type !== "microcrab-connect" ||
      data.nonce !== nonce ||
      event.ports.length !== 1 ||
      port
    )
      return;
    unlisten("message", connect);
    port = event.ports[0];
    port.onmessage = (message: MessageEvent) => {
      const update = message.data;
      if (
        !update ||
        typeof update !== "object" ||
        Object.keys(update).length !== 2 ||
        update.type !== "view-state"
      )
        return;
      current = update.value;
      hasCurrent = true;
      for (const subscriber of subscribers) {
        try {
          subscriber(current);
        } catch {
          /* A guest listener cannot stop other subscribers. */
        }
      }
    };
    port.start();
    send.call(port, { type: "ack", nonce });
  };
  listen("message", connect);
  listen(
    "pagehide",
    () => {
      unlisten("message", connect);
      if (port) {
        send.call(port, { type: "retire" });
        close.call(port);
      }
      port = undefined;
      subscribers.clear();
    },
    { once: true },
  );
}

/** CSP is parsed before any untrusted bytes. Later guest meta policies only intersect it.
 * Scripted self-navigation remains a browser residual; subsequent loads revoke the broker.
 */
export function webviewDocument(html: string, nonce: string): string {
  if (new TextEncoder().encode(html).byteLength > WEBVIEW_LIMITS.htmlBytes)
    throw new Error("Plugin HTML exceeds the 512 KiB presentation limit");
  const policy =
    "default-src 'none'; script-src 'unsafe-inline'; script-src-attr 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'";
  const argument = JSON.stringify(nonce).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>(${bootstrap.toString()})(${argument});</script></head><body>${html}</body></html>`;
}
