import type { NativeWireError } from "../client/failure";
import { useEffect, useRef, type SVGProps } from "react";
import type { Block, HistoryPosition, PreviewIdentity } from "../client/types";
import { commonIconShape, IconSvg } from "../ui/icon";

export interface FeatureBlock {
  id: string;
  messageId: string;
  callId?: string;
  partId?: string;
  executionId?: number;
  sessionId?: string;
  role: string;
  kind: string;
  stream: string;
  displayIncomplete?: boolean;
  operationId?: string;
  temporary?: boolean;
  submissionStatus?: Block["submissionStatus"];
  isCompact?: boolean;
  position?: HistoryPosition | null;
  preview?: PreviewIdentity;
  startedMs?: number | null;
  endedMs?: number | null;
  payload: {
    failure?: NativeWireError;
    text: string;
    bytes?: number[] | string;
    formatHint?: string;
    mime?: string;
    providerMetadata?: any;
    outputPaths?: string[];
    [key: string]: any;
  };
  tool?: {
    name: string;
    status: string;
    title?: string | null;
    input: any;
    callId?: string;
    childSessionId?: string | null;
    [key: string]: any;
  } | null;
}
export const lower = (value: unknown) => String(value ?? "").toLowerCase();
export const titleCase = (value: string) =>
  value.length <= 3
    ? value.toUpperCase()
    : value.charAt(0).toUpperCase() + value.slice(1);
export const formatNumber = (n: number) =>
  Math.round(n).toLocaleString("en-US");
export const formatTokens = (n: number) =>
  n >= 1000000
    ? `${+(n / 1000000).toFixed(1)}M`
    : n >= 1000
      ? `${+(n / 1000).toFixed(1)}k`
      : `${Math.round(n)}`;
export const elapsed = (b: FeatureBlock) => {
  const start = b.startedMs ?? b.tool?.startedMs,
    end = b.endedMs ?? b.tool?.endedMs;
  return start != null && end != null ? Math.max(0, end - start) : null;
};
export const isCompactInstruction = (b: FeatureBlock) =>
  b.isCompact && lower(b.role) === "user" && lower(b.kind) === "text";
export const isCompactResult = (b: FeatureBlock) =>
  b.isCompact && lower(b.role) === "assistant" && lower(b.kind) === "text";
export const isSubagent = (b: FeatureBlock) =>
  lower(b.kind) === "child" || !!b.tool?.childSessionId;
export const isBusy = (t: any) =>
  !t.interrupting &&
  (lower(t.sessionStatus?.type ?? t.sessionStatus) === "busy" ||
    (t.blocks ?? []).some(
      (b: FeatureBlock) => lower(b.stream) === "streaming",
    ));
export const isReverted = (t: any, id: string) =>
  (t.revertedForward instanceof Set
    ? t.revertedForward.has(id)
    : (t.revertedForward ?? []).includes(id)) ||
  !!(t.revertBoundaryMessageId && id >= t.revertBoundaryMessageId);
export function latestUser(t: any): FeatureBlock | undefined {
  return [...(t.blocks ?? [])]
    .reverse()
    .find(
      (b) =>
        lower(b.role) === "user" &&
        !b.temporary &&
        b.payload.source !== "framework" &&
        !b.messageId.startsWith("local_") &&
        !isReverted(t, b.messageId),
    );
}
export function childId(b: FeatureBlock) {
  if (b.tool?.childSessionId) return b.tool.childSessionId;
  return "";
}
// The last button or link the user pressed (mouse, touch or keyboard: all
// fire click). A menu opened by that press treats it as its trigger.
let lastPressed: HTMLElement | null = null;
let tracking = false;
function trackPresses() {
  if (tracking) return;
  tracking = true;
  document.addEventListener(
    "click",
    (event) => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("button, [role=button], a[href]")
          : null;
      if (target) lastPressed = target;
    },
    true,
  );
}

/** Esc closes an open menu and returns focus to the control that opened it.
    `open` is any truthy key for the open menu (a new key is a new menu). The
    handler runs in the window capture phase and stops the event, so Esc
    closes only the menu and not a drawer or dialog behind it. */
export function useMenuEscape(open: unknown, close: () => void) {
  const callback = useRef(close);
  callback.current = close;
  useEffect(trackPresses, []);
  useEffect(() => {
    if (!open) return;
    const trigger =
      lastPressed ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      callback.current();
      if (trigger?.isConnected) trigger.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
}

export function useOutside(selector: string, close: () => void) {
  const callback = useRef(close);
  callback.current = close;
  useEffect(() => {
    const handler = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(selector))
        callback.current();
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [selector]);
}

/** A decorative icon that replaces a text glyph (⌵ ⌃ ⌄ ↗ ✓): hidden from
    assistive tech, so the control's accessible name is its text alone. The
    chevron points right; `dir` turns it down or up. */
export function GlyphIcon({
  name,
  dir,
  size = 12,
  className,
}: {
  name: "chevron" | "check" | "external";
  dir?: "down" | "up";
  size?: number;
  className?: string;
}) {
  return (
    <Icon
      name={name}
      size={size}
      aria-hidden="true"
      focusable="false"
      className={className ? `glyph-icon ${className}` : "glyph-icon"}
      data-dir={dir}
    />
  );
}

export function Icon({
  name,
  size = 14,
  ...props
}: SVGProps<SVGSVGElement> & { name: string; size?: number }) {
  const sharedShape = commonIconShape(name);
  return (
    <IconSvg size={size} {...props}>
      {sharedShape ? (
        sharedShape
      ) : name === "check" ? (
        <polyline points="20 6 9 17 4 12" />
      ) : name === "down" ? (
        <polyline points="6 9 12 15 18 9" />
      ) : name === "dot" ? (
        <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />
      ) : name === "info" ? (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </>
      ) : name === "up" ? (
        <polyline points="18 15 12 9 6 15" />
      ) : name === "bot" ? (
        <>
          <rect x="4" y="8" width="16" height="12" rx="2" />
          <path d="M12 8V4" />
          <circle cx="12" cy="3" r="1" />
          <line x1="9" y1="13" x2="9" y2="15" />
          <line x1="15" y1="13" x2="15" y2="15" />
        </>
      ) : name === "external" ? (
        <>
          <line x1="7" y1="17" x2="17" y2="7" />
          <polyline points="7 7 17 7 17 17" />
        </>
      ) : name === "close" ? (
        <>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </>
      ) : name === "plus" ? (
        <>
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </>
      ) : name === "send" ? (
        <>
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </>
      ) : name === "stop" ? (
        <rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" />
      ) : name === "clock" ? (
        <>
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 14 14" />
        </>
      ) : name === "database" ? (
        <>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
        </>
      ) : name === "activity" || ["signal", "kill", "term"].includes(name) ? (
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      ) : name === "refresh" ? (
        <>
          <path d="M20 7v5h-5" />
          <path d="M4 17v-5h5" />
          <path d="M6 7a7 7 0 0 1 11-1l3 6M4 12l3 6a7 7 0 0 0 11-1" />
        </>
      ) : name === "undo" ? (
        <>
          <path d="M3 7v6h6" />
          <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
        </>
      ) : name === "compact" ? (
        <>
          <path d="M4 14h6v6" />
          <path d="M20 10h-6V4" />
          <path d="m14 10 7-7" />
          <path d="m3 21 7-7" />
        </>
      ) : name === "attach" ? (
        <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
      ) : name === "todo" ? (
        <>
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </>
      ) : name === "model" ? (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          {[9, 15].map((x) => (
            <g key={x}>
              <line x1={x} y1="1" x2={x} y2="4" />
              <line x1={x} y1="20" x2={x} y2="23" />
            </g>
          ))}
          {[9, 14].map((y) => (
            <g key={y}>
              <line x1="20" y1={y} x2="23" y2={y} />
              <line x1="1" y1={y} x2="4" y2={y} />
            </g>
          ))}
        </>
      ) : ["shell", "pty", "terminal", "exec"].includes(name) ? (
        <>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </>
      ) : ["read", "write", "file"].includes(name) ? (
        <>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </>
      ) : ["edit", "patch"].includes(name) ? (
        <>
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </>
      ) : ["search", "glob", "grep", "find"].includes(name) ? (
        <>
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </>
      ) : ["question", "ask"].includes(name) ? (
        <>
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </>
      ) : name === "status-failed" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m15 9-6 6M9 9l6 6" />
        </>
      ) : name === "status-cancelled" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="m5.7 5.7 12.6 12.6" />
        </>
      ) : name === "status-stopped" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <rect x="9" y="9" width="6" height="6" rx="1" />
        </>
      ) : name === "status-pending" ? (
        <circle cx="12" cy="12" r="8" />
      ) : name === "status-unknown" ? (
        <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
      ) : (
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      )}
    </IconSvg>
  );
}
