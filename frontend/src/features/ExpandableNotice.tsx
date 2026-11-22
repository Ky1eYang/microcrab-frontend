import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { t } from "../i18n";
import { Icon } from "../shell/Icon";
import "../styles/notice.css";

export type NoticeTone = "warn" | "danger" | "neutral" | "info" | "success";

/**
 * The one status-notice pattern for the whole app (composer dock, composer
 * banners, cards, settings, plugins, transcript status lines).
 *
 * Layout: tone marker + one line of text + optional trailing node + actions.
 * Text that does not fit is ellipsized; a "…" disclosure (and mouse hover)
 * shows the full original text in a positioned popover, so actions, the
 * independently scrolling composer dock and the transcript never move.
 * `data-expanded` mirrors the pinned disclosure for tests and styling.
 *
 * `marker`: "dot" (default) draws the 8px tone dot; "none" leaves the tone to
 * the host class (e.g. `.inline-notice` border); a node replaces the dot
 * (e.g. a spinner).
 */
export function ExpandableNotice({
  text,
  tone = "warn",
  action,
  trailing,
  marker = "dot",
  className,
  role = "status",
  as: Tag = "div",
  ...rest
}: {
  text: string;
  tone?: NoticeTone;
  action?: ReactNode;
  trailing?: ReactNode;
  marker?: "dot" | "none" | ReactNode;
  className?: string;
  role?: "status" | "alert" | null;
  as?: "div" | "article";
} & Omit<HTMLAttributes<HTMLElement>, "role" | "className"> &
  Record<`data-${string}`, string | undefined>) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Tag
      className={`expandable-notice${className ? ` ${className}` : ""}`}
      role={role ?? undefined}
      data-tone={tone}
      data-expanded={String(expanded)}
      {...rest}
    >
      {marker === "dot" ? (
        <span className="expandable-notice-dot" aria-hidden="true" />
      ) : marker === "none" ? null : (
        <span className="expandable-notice-marker" aria-hidden="true">
          {marker}
        </span>
      )}
      <NoticeText text={text} trailing={trailing} onExpanded={setExpanded} />
      {action && <div className="expandable-notice-actions">{action}</div>}
    </Tag>
  );
}

/** A visual ellipsis keeps the full message in the reading order. The separate
 * disclosure keeps actions and any scrolling container in place. */
function NoticeText({
  text,
  trailing,
  onExpanded,
}: {
  text: string;
  trailing?: ReactNode;
  onExpanded: (expanded: boolean) => void;
}) {
  const id = useId();
  const textBox = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLSpanElement>(null);
  const dismissTimer = useRef<number | undefined>(undefined);
  const [truncated, setTruncated] = useState(false);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const nativePopover =
    typeof HTMLElement !== "undefined" &&
    typeof HTMLElement.prototype.showPopover === "function";
  const expanded = truncated && open;

  useLayoutEffect(() => {
    onExpanded(pinned && expanded);
  }, [onExpanded, pinned, expanded]);

  useLayoutEffect(() => {
    const label = textBox.current;
    const column = label?.parentElement;
    const textRun = label?.firstElementChild;
    if (!label || !column || !textRun) return;
    const measure = () => {
      // Compare the unclipped text run with the space the label may use, so
      // adding or removing the disclosure button cannot flip the decision.
      const reserved = trigger.current?.offsetWidth ?? 0;
      setTruncated(
        textRun.getBoundingClientRect().width >
          label.clientWidth + reserved + 1,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    observer.observe(textRun);
    return () => {
      observer.disconnect();
      window.clearTimeout(dismissTimer.current);
    };
  }, [text]);

  useLayoutEffect(() => {
    const popup = popover.current;
    if (!popup || !nativePopover) return;
    const sync = () => {
      const shown = popup.matches(":popover-open");
      setOpen(shown);
      if (!shown) setPinned(false);
    };
    popup.addEventListener("toggle", sync);
    return () => popup.removeEventListener("toggle", sync);
  }, [nativePopover]);

  function dismiss() {
    window.clearTimeout(dismissTimer.current);
    if (nativePopover && popover.current?.matches(":popover-open"))
      popover.current.hidePopover();
    setOpen(false);
    setPinned(false);
  }

  // A positioned, light-dismissible fallback keeps the same tap/keyboard path
  // on browsers without native Popover, without putting the full text in flow.
  useLayoutEffect(() => {
    if (!expanded || nativePopover) return;
    const outside = (event: PointerEvent) => {
      if (!textBox.current?.parentElement?.contains(event.target as Node))
        dismiss();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (document.activeElement === popover.current) trigger.current?.focus();
      dismiss();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [expanded, nativePopover]);

  useLayoutEffect(() => {
    if (!truncated && open) dismiss();
  }, [truncated, open]);

  function reveal(anchor: HTMLElement) {
    window.clearTimeout(dismissTimer.current);
    const popup = popover.current;
    if (!truncated || !popup) return;
    const row = anchor.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const width = Math.min(480, viewportWidth - 24);
    const left = Math.max(12, Math.min(row.left, viewportWidth - width - 12));
    const above = row.top >= window.innerHeight / 2;
    const space = above ? row.top : window.innerHeight - row.bottom;
    popup.style.setProperty("--notice-popover-left", `${left}px`);
    popup.style.setProperty("--notice-popover-width", `${width}px`);
    popup.style.setProperty(
      "--notice-popover-edge",
      `${window.innerHeight - space}px`,
    );
    popup.style.setProperty("--notice-popover-space", `${space - 12}px`);
    popup.dataset.placement = above ? "above" : "below";
    if (nativePopover && !popup.matches(":popover-open")) popup.showPopover();
    setOpen(true);
  }

  function dismissSoon() {
    window.clearTimeout(dismissTimer.current);
    if (!pinned) dismissTimer.current = window.setTimeout(dismiss, 140);
  }

  return (
    <span
      className="notice-message"
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") reveal(event.currentTarget);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") dismissSoon();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) dismiss();
      }}
    >
      {/* The hover hint is visual-only; an explicit disclosure moves the one
          accessible copy into the popover after the button. */}
      <span
        ref={textBox}
        className="notice-text offline-text"
        aria-hidden={pinned || undefined}
      >
        <span>{text}</span>
      </span>
      {trailing && <span className="notice-trailing">{trailing}</span>}
      {truncated && (
        <button
          ref={trigger}
          type="button"
          className="notice-reveal"
          aria-label={t("composer.showFullNotice")}
          aria-controls={id}
          aria-expanded={pinned && expanded}
          onClick={(event) => {
            if (pinned) dismiss();
            else {
              setPinned(true);
              reveal(event.currentTarget.parentElement!);
            }
          }}
        >
          <Icon name="ellipsis" size={16} aria-hidden="true" />
        </button>
      )}
      <span
        ref={popover}
        id={id}
        popover={nativePopover ? "auto" : undefined}
        hidden={!nativePopover && !expanded}
        className="notice-popover"
        aria-hidden={!pinned || undefined}
        tabIndex={pinned && expanded ? 0 : undefined}
        onPointerEnter={() => window.clearTimeout(dismissTimer.current)}
        onPointerLeave={dismissSoon}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !pinned) return;
          event.preventDefault();
          trigger.current?.focus();
          dismiss();
        }}
      >
        {text}
      </span>
    </span>
  );
}
