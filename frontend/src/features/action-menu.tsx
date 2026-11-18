import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./shared";
import { t } from "../i18n";

/** Native application contributions only: plugins never provide executable menu markup. */
type MenuEntry = { id: string; label: string; disabled?: boolean };
export type ActionMenuGroup = MenuEntry & {
  items: readonly ActionMenuItem[];
  onSelect?: never;
  checked?: never;
};
export type ActionMenuItem =
  | ActionMenuGroup
  | (MenuEntry & { items?: never; onSelect: () => void; checked?: boolean });

type Panel = {
  items: readonly ActionMenuItem[];
  anchor: DOMRect;
  parent?: string;
  label?: string;
  last?: boolean;
  focus?: boolean;
};

function MenuPanel({
  panel,
  depth,
  menuId,
  expanded,
  open,
  close,
  back,
}: {
  panel: Panel;
  depth: number;
  menuId: string;
  expanded?: string;
  open: (
    depth: number,
    item: ActionMenuItem,
    anchor: DOMRect,
    intent: "keyboard" | "pointer",
  ) => void;
  close: () => void;
  back: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const element = ref.current!;
    const { width, height } = element.getBoundingClientRect();
    const a = panel.anchor;
    const x = depth
      ? a.right + width + 8 <= innerWidth
        ? a.right + 4
        : a.left - width - 4
      : a.left;
    const y = depth
      ? a.top
      : a.bottom + height + 8 <= innerHeight
        ? a.bottom + 4
        : a.top - height - 4;
    setPosition({
      left: Math.max(8, Math.min(x, innerWidth - width - 8)),
      top: Math.max(8, Math.min(y, innerHeight - height - 8)),
    });
    const rows = element.querySelectorAll<HTMLElement>(
      '[role^="menuitem"]:not(:disabled)',
    );
    if (panel.focus !== false) rows[panel.last ? rows.length - 1 : 0]?.focus();
  }, [panel.anchor, depth]);
  return (
    <div
      ref={ref}
      role="menu"
      id={`${menuId}-${depth}`}
      aria-label={panel.label ?? t("contentViewer.more")}
      className="action-menu-popup"
      style={position}
      data-action-menu={menuId}
      onKeyDown={(event) => {
        const rows = Array.from(
          ref.current!.querySelectorAll<HTMLButtonElement>(
            '[role^="menuitem"]:not(:disabled)',
          ),
        );
        const index = rows.indexOf(document.activeElement as HTMLButtonElement);
        let next: number | undefined;
        if (event.key === "ArrowDown") next = (index + 1) % rows.length;
        if (event.key === "ArrowUp")
          next = (index - 1 + rows.length) % rows.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = rows.length - 1;
        if (next !== undefined) {
          event.preventDefault();
          rows[next]?.focus();
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          const item = panel.items.find(
            (item) =>
              item.id ===
              (document.activeElement as HTMLElement)?.dataset.menuItem,
          );
          if (item?.items && !item.disabled)
            open(
              depth,
              item,
              (document.activeElement as HTMLElement).getBoundingClientRect(),
              "keyboard",
            );
        }
        if (event.key === "ArrowLeft" && depth) {
          event.preventDefault();
          back();
        }
        if (event.key === "Tab") close();
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      {panel.items.map((item) => (
        <button
          key={item.id}
          type="button"
          data-menu-item={item.id}
          role={item.checked === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={item.checked}
          aria-haspopup={item.items ? "menu" : undefined}
          aria-expanded={item.items ? expanded === item.id : undefined}
          disabled={item.disabled}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse" && !item.disabled)
              open(
                depth,
                item,
                event.currentTarget.getBoundingClientRect(),
                "pointer",
              );
          }}
          onClick={(event) => {
            if (item.items)
              open(
                depth,
                item,
                event.currentTarget.getBoundingClientRect(),
                "keyboard",
              );
            else {
              close();
              item.onSelect();
            }
          }}
        >
          <span className="action-menu-check">
            {item.checked && <Icon name="check" size={14} />}
          </span>
          <span>{item.label}</span>
          {item.items && <Icon name="chevron-right" size={14} />}
        </button>
      ))}
    </div>
  );
}

export function ActionMenu({ items }: { items: readonly ActionMenuItem[] }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [panels, setPanels] = useState<Panel[]>([]);
  const close = () => {
    setPanels([]);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!items.length) setPanels([]);
  }, [items.length]);
  useEffect(() => {
    if (!panels.length) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (
        !trigger.current?.contains(target) &&
        !target.closest(`[data-action-menu="${CSS.escape(id)}"]`)
      )
        setPanels([]);
    };
    const dismiss = (event: Event) => {
      if (
        event.type === "scroll" &&
        event.target instanceof Element &&
        event.target.closest(`[data-action-menu="${CSS.escape(id)}"]`)
      )
        return;
      if (event.type === "scroll") {
        const anchor = panels[0].anchor;
        const current = trigger.current?.getBoundingClientRect();
        if (
          current &&
          current.left === anchor.left &&
          current.top === anchor.top
        )
          return;
      }
      setPanels([]);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [panels.length, id]);
  // Resolve open paths against current contributions; removed/disabled entries cannot retain callbacks.
  const resolved: Panel[] = [];
  if (panels.length && items.length) {
    resolved.push({ ...panels[0], items });
    for (let depth = 1; depth < panels.length; depth++) {
      const parent = resolved[depth - 1].items.find(
        (item) => item.id === panels[depth].parent && !item.disabled,
      );
      if (!parent?.items) break;
      resolved.push({ ...panels[depth], items: parent.items });
    }
  }
  if (!items.length) return null;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="action-icon-btn"
        aria-label={t("contentViewer.more")}
        title={t("contentViewer.more")}
        aria-haspopup="menu"
        aria-expanded={!!resolved.length}
        aria-controls={resolved.length ? `${id}-0` : undefined}
        onClick={() =>
          resolved.length
            ? close()
            : setPanels([
                { items, anchor: trigger.current!.getBoundingClientRect() },
              ])
        }
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            setPanels([
              {
                items,
                anchor: trigger.current!.getBoundingClientRect(),
                last: event.key === "ArrowUp",
              },
            ]);
          }
        }}
      >
        <Icon name="ellipsis-vertical" />
      </button>
      {createPortal(
        resolved.map((panel, depth) => (
          <MenuPanel
            key={depth}
            panel={panel}
            depth={depth}
            menuId={id}
            expanded={resolved[depth + 1]?.parent}
            close={close}
            open={(level, item, anchor, intent) => {
              // Portalled panels stay open across the gap. Only entering a different
              // row replaces the deeper path; pointer movement never invokes actions.
              if (
                intent === "pointer" &&
                resolved[level + 1]?.parent === item.id
              )
                return;
              setPanels([
                ...resolved.slice(0, level + 1),
                ...(item.items
                  ? [
                      {
                        items: item.items,
                        anchor,
                        parent: item.id,
                        label: item.label,
                        focus: intent === "keyboard",
                      },
                    ]
                  : []),
              ]);
            }}
            back={() => {
              setPanels(resolved.slice(0, depth));
              document
                .querySelector<HTMLElement>(
                  `[data-action-menu="${CSS.escape(id)}"] [data-menu-item="${CSS.escape(panel.parent!)}"]`,
                )
                ?.focus();
            }}
          />
        )),
        document.body,
      )}
    </>
  );
}
