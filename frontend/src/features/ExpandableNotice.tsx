import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { t } from "../i18n";
import { Icon } from "../shell/Icon";

/** Split display text after its first sentence. The i18n source stays intact;
 * only presentation is layered (lead line + expandable remainder). */
export function splitFirstSentence(text: string): [string, string] {
  const source = text.trim();
  const newline = source.indexOf("\n");
  const match = /[。！？；]|[.!?;](?=\s|$)/.exec(source);
  let end = -1;
  if (match) end = match.index + match[0].length;
  if (newline >= 0 && (end < 0 || newline < end)) end = newline;
  if (end <= 0 || end >= source.length) return [source, ""];
  const rest = source.slice(end).trim();
  return rest ? [source.slice(0, end).trim(), rest] : [source, ""];
}

export type NoticeTone = "warn" | "danger" | "neutral" | "info" | "success";

/**
 * One-line status notice: tone marker + first sentence + optional "Details"
 * disclosure + primary action. Narrow viewports ellipsize the lead line;
 * clicking the row (or Details) reveals the full original text. A single
 * sentence that does not fit on one narrow line is expandable too.
 *
 * `marker`: "dot" (default) draws the 8px tone dot; "none" leaves the tone to
 * the host class (e.g. `.inline-notice` border); a node replaces the dot
 * (e.g. a spinner). `trailing` renders after the text (e.g. a countdown).
 */
export function ExpandableNotice({
  text,
  tone = "warn",
  action,
  trailing,
  marker = "dot",
  className,
  role = "status",
  ...rest
}: {
  text: string;
  tone?: NoticeTone;
  action?: ReactNode;
  trailing?: ReactNode;
  marker?: "dot" | "none" | ReactNode;
  className?: string;
  role?: "status" | "alert" | null;
} & Record<`data-${string}`, string | undefined>) {
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);
  const id = useId();
  const [lead, more] = splitFirstSentence(text);
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || open) return;
    const measure = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, text]);
  const expandable = more.length > 0 || overflow || open;
  const toggle = () => expandable && setOpen((value) => !value);
  return (
    <div
      className={`expandable-notice${className ? ` ${className}` : ""}`}
      role={role ?? undefined}
      data-tone={tone}
      data-expanded={String(open)}
      data-expandable={expandable ? "true" : undefined}
      {...rest}
    >
      <div
        className="expandable-notice-lead"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button,a")) return;
          toggle();
        }}
      >
        {marker === "dot" ? (
          <span className="expandable-notice-dot" aria-hidden="true" />
        ) : marker === "none" ? null : (
          <span className="expandable-notice-marker" aria-hidden="true">
            {marker}
          </span>
        )}
        <span
          ref={textRef}
          className="offline-text"
          title={open ? undefined : text}
        >
          <span className="expandable-notice-first">{lead}</span>
          {more && (
            <span className="expandable-notice-more" id={id} hidden={!open}>
              {more}
            </span>
          )}
          {trailing}
        </span>
      </div>
      {(expandable || action) && (
        <div className="expandable-notice-actions">
          {expandable && (
            <button
              type="button"
              className="expandable-notice-toggle"
              aria-expanded={open}
              aria-controls={more ? id : undefined}
              onClick={toggle}
            >
              {open ? t("common.collapse") : t("notice.details")}
              <Icon name="chevron" size={12} aria-hidden="true" />
            </button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
