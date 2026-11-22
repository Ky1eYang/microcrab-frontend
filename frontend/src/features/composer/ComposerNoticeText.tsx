import { useId, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { Icon } from "../shared";

/** A visual ellipsis keeps the full message in the reading order. The separate
 * disclosure keeps actions and the independently scrolling dock in place. */
export function ComposerNoticeText({ text }: { text: string }) {
  const id = useId();
  const textBox = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLSpanElement>(null);
  const dismissTimer = useRef<number | undefined>(undefined);
  const [truncated, setTruncated] = useState(false);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const nativePopover = typeof HTMLElement.prototype.showPopover === "function";
  const expanded = truncated && open;

  useLayoutEffect(() => {
    const label = textBox.current;
    const column = label?.parentElement;
    const textRun = label?.firstElementChild;
    if (!column || !textRun) return;
    const measure = () => {
      // Measure against the entire column, without the disclosure button, so
      // adding or removing the button can't change the overflow decision.
      setTruncated(textRun.getBoundingClientRect().width > column.clientWidth);
    };
    measure();
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
    if (nativePopover) popover.current?.hidePopover();
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
    if (nativePopover) popup.showPopover();
    setOpen(true);
  }

  function dismissSoon() {
    window.clearTimeout(dismissTimer.current);
    if (!pinned) dismissTimer.current = window.setTimeout(dismiss, 140);
  }

  return (
    <span
      className="composer-notice-message"
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
          accessible copy into the expanded area after the button. */}
      <span
        ref={textBox}
        className="composer-notice-text"
        aria-hidden={pinned || undefined}
      >
        <span>{text}</span>
      </span>
      {truncated && (
        <button
          ref={trigger}
          type="button"
          className="composer-notice-reveal"
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
        className="composer-notice-popover"
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
