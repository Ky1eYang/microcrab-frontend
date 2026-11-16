import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import type { Json, PluginView } from "./types";
import {
  exactKeys,
  jsonRejection,
  WEBVIEW_LIMITS,
  webviewDocument,
  type JsonRejection,
} from "./webview-document";
import "./webview.css";
import { readWebviewTheme } from "./webview-theme";

/** All values come from the authenticated mounting surface, never guest messages. */
export interface PluginWebviewScope {
  ownerId: string;
  sessionId: string | null;
  instanceGeneration: number;
  historyGeneration: string | number;
  surfaceId: string;
}
export interface PluginWebviewProps {
  view: PluginView;
  scope: PluginWebviewScope;
  onAction: (action: string, payload?: Json) => void;
  visible?: boolean;
  title?: string;
}
type Failure =
  | JsonRejection
  | "html-bytes"
  | "document-error"
  | "navigation"
  | "channel-error"
  | "message-rate"
  | "handshake"
  | "handshake-timeout"
  | "action-shape"
  | "action-rate";

export function PluginWebview({
  view,
  scope,
  onAction,
  visible = true,
  title,
}: PluginWebviewProps) {
  const fitContent = view.target === "setting-page";
  const [contentHeight, setContentHeight] = useState(144);
  const enabled =
    visible && view.status === "ready" && view.mode === "webview-html";
  const identity = JSON.stringify([
    scope.ownerId,
    scope.sessionId,
    scope.instanceGeneration,
    scope.historyGeneration,
    scope.surfaceId,
    view.pluginId,
    view.target,
    enabled,
    view.content,
  ]);
  const current = useRef(identity);
  current.current = identity;
  const callback = useRef(onAction);
  callback.current = onAction;
  const projection = useRef(view.viewState);
  projection.current = view.viewState;
  const frame = useRef<HTMLIFrameElement>(null);
  const connection = useRef<{ push: () => void } | null>(null);
  const [status, setStatus] = useState("loading");
  const [failure, setFailure] = useState<Failure | null>(null);
  const document = useMemo(() => {
    const nonce = crypto.randomUUID();
    try {
      return {
        nonce,
        html: enabled
          ? webviewDocument(view.content ?? "", nonce, readWebviewTheme(), fitContent)
          : "",
        error: null,
      };
    } catch (error) {
      const reason: Failure =
        error instanceof Error && error.message.includes("512 KiB")
          ? "html-bytes"
          : "document-error";
      return { nonce, html: "", error: reason };
    }
  }, [identity]);

  useLayoutEffect(() => {
    const element = frame.current;
    setFailure(document.error);
    setStatus(document.error ? "rejected" : "loading");
    if (!enabled || document.error || !element) return;
    let retired = false;
    let loaded = false;
    let acknowledged = false;
    let port: MessagePort | undefined;
    let peer: MessagePort | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let windowStart = performance.now();
    let messages = 0;
    let actions = 0;
    const themeObserver = new MutationObserver(() => pushTheme());
    const active = () => !retired && current.current === identity;
    const retire = () => {
      retired = true;
      themeObserver.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      if (port) {
        port.onmessage = null;
        port.onmessageerror = null;
        port.close();
      }
      peer?.close();
      element.removeEventListener("load", load);
    };
    const reject = (reason: Failure) => {
      retire();
      if (current.current === identity) {
        setFailure(reason);
        setStatus("retired");
      }
    };
    const pushTheme = () => {
      if (!active() || !acknowledged || !port) return;
      try {
        port.postMessage({ type: "theme", value: readWebviewTheme() });
      } catch {
        reject("channel-error");
      }
    };
    const push = () => {
      if (!active() || !acknowledged || !port) return;
      const value = projection.current ?? null;
      const reason = jsonRejection(value);
      if (reason) {
        reject(reason);
        return;
      }
      try {
        port.postMessage({ type: "view-state", value });
      } catch {
        reject("channel-error");
      }
    };
    const load = () => {
      // A WindowProxy survives navigation. It must never authorize a replacement document.
      if (loaded) {
        reject("navigation");
        return;
      }
      loaded = true;
      if (!active() || !element.contentWindow) {
        reject("channel-error");
        return;
      }
      const channel = new MessageChannel();
      port = channel.port1;
      peer = channel.port2;
      port.onmessageerror = () => reject("channel-error");
      port.onmessage = (event) => {
        if (!active()) return;
        const now = performance.now();
        if (now - windowStart >= 1000) {
          windowStart = now;
          messages = 0;
          actions = 0;
        }
        if (++messages > WEBVIEW_LIMITS.messagesPerSecond) {
          reject("message-rate");
          return;
        }
        const reason = jsonRejection(event.data);
        if (reason) {
          reject(reason);
          return;
        }
        const data: unknown = event.data;
        if (!acknowledged) {
          if (
            !exactKeys(data, ["type", "nonce"]) ||
            data.type !== "ack" ||
            data.nonce !== document.nonce
          ) {
            reject("handshake");
            return;
          }
          acknowledged = true;
          if (timer !== undefined) clearTimeout(timer);
          setStatus("ready");
          pushTheme();
          push();
          return;
        }
        if (
          fitContent &&
          exactKeys(data, ["type", "height"]) &&
          data.type === "content-height" &&
          typeof data.height === "number" &&
          Number.isSafeInteger(data.height) &&
          data.height > 0 &&
          data.height <= 1000000
        ) {
          setContentHeight(data.height);
          return;
        }
        if (exactKeys(data, ["type"]) && data.type === "retire") {
          reject("navigation");
          return;
        }
        if (
          !exactKeys(data, ["type", "action", "payload"]) ||
          data.type !== "action" ||
          typeof data.action !== "string" ||
          !/^[A-Za-z0-9_.:-]{1,128}$/.test(data.action)
        ) {
          reject("action-shape");
          return;
        }
        if (++actions > WEBVIEW_LIMITS.actionsPerSecond) {
          reject("action-rate");
          return;
        }
        // Only this captured mount can authorize an action; payload identities have no authority.
        callback.current(data.action, data.payload as Json);
      };
      port.start();
      timer = setTimeout(() => reject("handshake-timeout"), 5000);
      try {
        element.contentWindow.postMessage(
          { type: "microcrab-connect", nonce: document.nonce },
          "*",
          [peer],
        );
      } catch {
        reject("channel-error");
      }
    };
    connection.current = { push };
    themeObserver.observe(globalThis.document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    element.addEventListener("load", load);
    return () => {
      retire();
      connection.current = null;
    };
  }, [identity, enabled, document]);

  useLayoutEffect(() => {
    connection.current?.push();
  }, [view.viewState]);
  if (!enabled) return null;
  const reason = document.error ?? failure;
  return (
    <>
      {reason && (
        <p
          className="plugin-webview-error"
          role="alert"
          data-testid="plugin-webview-error"
          data-reason={reason}
        >
          {t(`plugins.webview.error.${reason}`)}
        </p>
      )}
      {!document.error && (
        <iframe
          key={identity}
          ref={frame}
          className="plugin-webview"
          style={fitContent ? { height: contentHeight, flex: "none" } : undefined}
          data-fit-content={fitContent || undefined}
          data-testid="plugin-webview"
          data-status={status}
          data-reason={reason ?? undefined}
          data-surface-id={scope.surfaceId}
          title={title ?? view.pluginId}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
          srcDoc={document.html}
        />
      )}
    </>
  );
}
