import { useId, useState, type ReactNode } from "react";
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

/**
 * One-line status notice: tone dot + first sentence + optional "Details"
 * disclosure + primary action. Narrow viewports ellipsize the lead line;
 * clicking the row (or Details) reveals the full original text.
 */
export function ExpandableNotice({
  text,
  tone = "warn",
  action,
  className,
  role = "status",
  ...rest
}: {
  text: string;
  tone?: "warn" | "danger" | "neutral";
  action?: ReactNode;
  className?: string;
  role?: "status" | "alert";
} & Record<`data-${string}`, string | undefined>) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const [lead, more] = splitFirstSentence(text);
  const expandable = more.length > 0;
  const toggle = () => expandable && setOpen((value) => !value);
  return (
    <div
      className={`expandable-notice${className ? ` ${className}` : ""}`}
      role={role}
      data-tone={tone}
      data-expanded={expandable ? String(open) : undefined}
      {...rest}
    >
      <div
        className="expandable-notice-lead"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button,a")) return;
          toggle();
        }}
      >
        <span className="expandable-notice-dot" aria-hidden="true" />
        <span className="offline-text" title={open ? undefined : text}>
          <span className="expandable-notice-first">{lead}</span>
          {expandable && (
            <span className="expandable-notice-more" id={id} hidden={!open}>
              {more}
            </span>
          )}
        </span>
      </div>
      {(expandable || action) && (
        <div className="expandable-notice-actions">
          {expandable && (
            <button
              type="button"
              className="expandable-notice-toggle"
              aria-expanded={open}
              aria-controls={id}
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
