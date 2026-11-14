import { useEffect, useRef, useState, type ReactNode } from "react";

/** Shared, scope-local overview chrome for main and inspected child sessions. */
export function OverviewPopover({
  id,
  title,
  trigger,
  children,
  titleValue,
  testId,
}: {
  id: string;
  title: string;
  trigger: ReactNode;
  children: ReactNode;
  titleValue?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div ref={root} className="dock-pill-wrapper">
      <button
        ref={button}
        type="button"
        className={`dock-pill-btn${open ? " active" : ""}`}
        data-testid={testId}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${id}-details`}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={`${id}-details`}
          role="dialog"
          aria-label={title}
          className="dock-popover-card composer-stats-popover"
        >
          <div className="dock-popover-header">
            <span>{title}</span>
            {titleValue != null && <span>{titleValue}</span>}
          </div>
          <div className="dock-popover-rows">{children}</div>
        </div>
      )}
    </div>
  );
}
