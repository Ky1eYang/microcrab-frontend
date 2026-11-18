import type { Json } from "./types";
import type { WebviewTheme } from "./webview-theme";

/** Independent presentation quotas: never accept a whole plugin Vars bag here. */
export const WEBVIEW_LIMITS = {
  htmlBytes: 512 * 1024,
  messageBytes: 64 * 1024,
  depth: 24,
  nodes: 4096,
  actionsPerSecond: 30,
  messagesPerSecond: 60,
  clipboardPerSecond: 1,
  clipboardTextBytes: 48 * 1024,
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
function bootstrap(
  nonce: string,
  initialTheme?: WebviewTheme,
  fitContent = false,
) {
  // These constants also bound the parent-side broker. The enclosing JSON envelope
  // has its independent 64 KiB limit (including escaping and request metadata).
  const clipboardTextBytes = 48 * 1024;
  let nextCopyId = 0;
  let pendingCopy:
    | {
        id: number;
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const rejectCopy = (reason: string) => {
    const pending = pendingCopy;
    pendingCopy = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  };
  const themeKeys = Object.keys(initialTheme?.tokens ?? {});
  let theme = initialTheme?.scheme;
  const themeSubscribers = new Set<(scheme: string) => void>();
  const applyTheme = (value: WebviewTheme) => {
    if (
      !value ||
      (value.scheme !== "light" && value.scheme !== "dark") ||
      !value.tokens ||
      typeof value.tokens !== "object"
    )
      return;
    const root = document.documentElement;
    root.dataset.theme = value.scheme;
    root.style.colorScheme = value.scheme;
    for (const key of themeKeys) {
      if (typeof value.tokens[key] === "string")
        root.style.setProperty(key, value.tokens[key]);
    }
    // Informational HTML without authored styles also inherits host colors.
    root.style.backgroundColor = "var(--microcrab-bg)";
    root.style.color = "var(--microcrab-text)";
    root.style.fontFamily = "var(--microcrab-font-sans)";
    theme = value.scheme;
    for (const subscriber of themeSubscribers) {
      try {
        subscriber(theme);
      } catch {
        /* Isolate guest listeners. */
      }
    }
  };
  if (initialTheme) applyTheme(initialTheme);
  const host = window.parent;
  const listen = window.addEventListener.bind(window);
  const unlisten = window.removeEventListener.bind(window);
  const send = MessagePort.prototype.postMessage;
  const close = MessagePort.prototype.close;
  let port: MessagePort | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let contentObserver: MutationObserver | undefined;
  let resizeFrame: number | undefined;
  let lastHeight = 0;
  const measure = () => {
    if (!fitContent || !port || resizeFrame !== undefined) return;
    resizeFrame = window.setTimeout(() => {
      resizeFrame = undefined;
      if (!port || !document.body) return;
      const height = Math.max(
        1,
        Math.ceil(document.body.getBoundingClientRect().height),
      );
      if (height !== lastHeight) {
        lastHeight = height;
        send.call(port, { type: "content-height", height });
      }
    });
  };
  let current: unknown;
  let hasCurrent = false;
  const subscribers = new Set<(state: unknown) => void>();
  const api = Object.freeze({
    copyText(text: string): Promise<void> {
      if (
        typeof text !== "string" ||
        new TextEncoder().encode(text).byteLength > clipboardTextBytes
      )
        return Promise.reject(
          new Error(
            "Clipboard text exceeds the 48 KiB limit or is not a string",
          ),
        );
      if (!port)
        return Promise.reject(
          new Error("Clipboard Host channel is unavailable"),
        );
      if (!navigator.userActivation?.isActive)
        return Promise.reject(
          new Error("Clipboard copy requires a current user activation"),
        );
      if (pendingCopy)
        return Promise.reject(
          new Error("Clipboard request is already pending"),
        );
      if (!Number.isSafeInteger(nextCopyId + 1))
        return Promise.reject(
          new Error("Clipboard request identity exhausted"),
        );
      const id = ++nextCopyId;
      const request = { type: "clipboard-write", id, text };
      if (
        new TextEncoder().encode(JSON.stringify(request)).byteLength >
        64 * 1024
      )
        return Promise.reject(
          new Error("Clipboard request exceeds the 64 KiB envelope limit"),
        );
      return new Promise<void>((resolve, reject) => {
        // A lost channel never claims success and never retries a clipboard mutation.
        const timer = setTimeout(
          () =>
            rejectCopy("Clipboard result is unavailable; copy was not retried"),
          5000,
        );
        pendingCopy = { id, resolve, reject, timer };
        try {
          send.call(port!, request);
        } catch {
          rejectCopy("Clipboard Host channel failed");
        }
      });
    },
    action(action: string, payload: unknown = null) {
      if (port) send.call(port, { type: "action", action, payload });
    },
    onThemeChange(listener: (scheme: string) => void) {
      if (typeof listener !== "function") return () => {};
      themeSubscribers.add(listener);
      if (theme) listener(theme);
      return () => themeSubscribers.delete(listener);
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
        update &&
        typeof update === "object" &&
        update.type === "host-retired"
      ) {
        rejectCopy("Clipboard mount retired");
        close.call(port!);
        port = undefined;
        return;
      }
      if (
        update &&
        typeof update === "object" &&
        update.type === "clipboard-result"
      ) {
        if (
          Object.keys(update).length !== 4 ||
          !pendingCopy ||
          update.id !== pendingCopy.id ||
          typeof update.ok !== "boolean" ||
          typeof update.error !== "string"
        )
          return;
        const pending = pendingCopy;
        pendingCopy = undefined;
        clearTimeout(pending.timer);
        if (update.ok) pending.resolve();
        else
          pending.reject(new Error(update.error || "Clipboard write failed"));
        return;
      }
      if (
        update &&
        typeof update === "object" &&
        Object.keys(update).length === 2 &&
        update.type === "theme"
      ) {
        applyTheme(update.value);
        measure();
        return;
      }
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
    if (fitContent) {
      const style = document.createElement("style");
      style.textContent =
        "html,body{height:auto!important;min-height:0!important;overflow-y:hidden!important}body{display:flow-root!important;margin:0!important}";
      document.head.append(style);
      resizeObserver = new ResizeObserver(measure);
      resizeObserver.observe(document.body);
      contentObserver = new MutationObserver(measure);
      contentObserver.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      listen("resize", measure);
      measure();
    }
  };
  listen("message", connect);
  listen(
    "pagehide",
    () => {
      unlisten("message", connect);
      rejectCopy("Clipboard document retired");
      if (port) {
        send.call(port, { type: "retire" });
        close.call(port);
      }
      resizeObserver?.disconnect();
      contentObserver?.disconnect();
      unlisten("resize", measure);
      if (resizeFrame !== undefined) clearTimeout(resizeFrame);
      port = undefined;
      subscribers.clear();
      themeSubscribers.clear();
    },
    { once: true },
  );
}

/** CSP is parsed before any untrusted bytes. Later guest meta policies only intersect it.
 * Scripted self-navigation remains a browser residual; subsequent loads revoke the broker.
 */
export function webviewDocument(
  html: string,
  nonce: string,
  theme?: WebviewTheme,
  fitContent = false,
): string {
  if (new TextEncoder().encode(html).byteLength > WEBVIEW_LIMITS.htmlBytes)
    throw new Error("Plugin HTML exceeds the 512 KiB presentation limit");
  const policy =
    "default-src 'none'; script-src 'unsafe-inline'; script-src-attr 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'";
  const argument = JSON.stringify(nonce).replace(/</g, "\\u003c");
  const themeArgument = JSON.stringify(theme ?? null).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>(${bootstrap.toString()})(${argument},${themeArgument},${fitContent});</script></head><body>${html}</body></html>`;
}
