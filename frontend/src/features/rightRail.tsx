import { PluginSidebar } from "../plugins/PluginSidebar";
import { t } from "../i18n";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useAppFields } from "../state";
import { focusFirst, usePluginDrawerViewport } from "../client/viewport";
import { Icon } from "./shared";

export function RightRail() {
  const { state, dispatch } = useAppFields([
    "rightRailWidth",
    "railCollapsed",
    "rightOverlayOpen",
    "rightRailCollapsed",
    "conversationWidth",
    "resolvedLocale",
  ]);
  const [dragging, setDragging] = useState(false);
  const shell = useRef<HTMLElement>(null);
  const start = useRef({ x: 0, width: state.rightRailWidth });
  const clamp = (requested: number) => {
    const cap = Math.max(
      0,
      window.innerWidth - (state.railCollapsed ? 60 : 260) - 640,
    );
    return Math.round(Math.max(280, Math.min(requested, cap)));
  };
  const paint = (width: number) => {
    if (shell.current) {
      shell.current.style.width = `${width}px`;
      shell.current.style.minWidth = `${width}px`;
      shell.current.style.maxWidth = `${width}px`;
    }
  };
  const clear = (width: number) => {
    if (shell.current) {
      shell.current.style.setProperty("--right-rail-width", `${width}px`);
      shell.current.style.removeProperty("width");
      shell.current.style.removeProperty("min-width");
      shell.current.style.removeProperty("max-width");
    }
  };
  const narrow = usePluginDrawerViewport();
  useEffect(() => {
    const fit = () => void dispatch({ type: "FitPluginRail" });
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [dispatch, state.railCollapsed, state.rightRailCollapsed, narrow]);
  // Below 1000px the plugin rail opens explicitly as an overlay. The left
  // navigation and trajectory inspector retain their independent 768px rule.
  const overlay = narrow && state.rightOverlayOpen;
  const closeOverlay = () => {
    dispatch({ type: "SetRightOverlay", value: false });
    document.querySelector<HTMLElement>(".header-right-toggle-btn")?.focus();
  };
  useEffect(() => {
    if (!overlay) return;
    focusFirst(shell.current);
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === "Tab" &&
        shell.current?.contains(document.activeElement)
      ) {
        const controls = Array.from(
          shell.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!shell.current?.contains(document.activeElement)) return;
      event.preventDefault();
      closeOverlay();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay]);
  if (narrow ? !overlay : state.rightRailCollapsed) return null;
  return (
    <>
      {overlay && (
        <div
          className="rail-drawer-backdrop"
          data-testid="right-rail-backdrop"
          aria-hidden="true"
          onClick={closeOverlay}
        />
      )}
      <aside
        tabIndex={overlay ? -1 : undefined}
        ref={shell}
        className="right-sidebar-shell"
        data-overlay={overlay}
        aria-label="Plugins"
        style={
          { "--right-rail-width": `${state.rightRailWidth}px` } as CSSProperties
        }
        data-resizing={dragging}
      >
        <div
          id="right-sidebar-resize"
          className="right-sidebar-resize"
          title={t("rail.resizePlugins")}
          role="separator"
          aria-label={t("rail.resizePlugins")}
          aria-orientation="vertical"
          aria-valuemin={280}
          aria-valuenow={state.rightRailWidth}
          tabIndex={narrow ? -1 : 0}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const current =
              shell.current?.getBoundingClientRect().width ??
              state.rightRailWidth;
            void dispatch({
              type: "SetRightRailWidth",
              value: clamp(current + (event.key === "ArrowLeft" ? 16 : -16)),
            });
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            start.current = {
              x: e.clientX,
              width:
                shell.current?.getBoundingClientRect().width ??
                state.rightRailWidth,
            };
            setDragging(true);
          }}
          onPointerMove={(e) => {
            if (dragging)
              paint(clamp(start.current.width - e.clientX + start.current.x));
          }}
          onPointerUp={(e) => {
            if (!dragging) return;
            e.stopPropagation();
            e.currentTarget.releasePointerCapture(e.pointerId);
            setDragging(false);
            const width = clamp(
              start.current.width - e.clientX + start.current.x,
            );
            clear(width);
            dispatch({ type: "SetRightRailWidth", value: width });
          }}
          onPointerCancel={(e) => {
            if (!dragging) return;
            e.currentTarget.releasePointerCapture(e.pointerId);
            clear(start.current.width);
            setDragging(false);
          }}
        />
        <div className="right-sidebar-content-slot client-plugin-rail-slot">
          <PluginSidebar>
            {
              <button
                type="button"
                className="right-sidebar-close-btn"
                data-testid="right-rail-close"
                aria-label={t("rail.closePlugins")}
                title={t("rail.closePlugins")}
                onClick={() => {
                  if (overlay) closeOverlay();
                  else {
                    void dispatch({ type: "ToggleRightRail" });
                    document
                      .querySelector<HTMLElement>(".header-right-toggle-btn")
                      ?.focus();
                  }
                }}
              >
                <Icon name="close" size={15} />
              </button>
            }
          </PluginSidebar>
        </div>
      </aside>
    </>
  );
}
export function WidthHandle({ side }: { side: "left" | "right" }) {
  const { state, dispatch } = useAppFields([
    "rightRailWidth",
    "railCollapsed",
    "rightOverlayOpen",
    "rightRailCollapsed",
    "conversationWidth",
    "resolvedLocale",
  ]);
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: 820 });
  const width = (x: number) =>
    Math.round(
      Math.max(
        640,
        Math.min(
          Math.max(640, Math.min(1400, window.innerWidth - 120)),
          start.current.width +
            (x - start.current.x) * (side === "right" ? 2 : -2),
        ),
      ),
    );
  const paint = (element: HTMLElement, w: number) => {
    element.parentElement?.style.setProperty("--chat-content-width", `${w}px`);
    document
      .querySelector<HTMLElement>(".conversation-viewport")
      ?.style.setProperty("--chat-content-width", `${w}px`);
  };
  return (
    <div
      id={`width-handle-${side}`}
      className="width-handle"
      data-side={side}
      data-dragging={dragging}
      title={t("rail.resizeChat")}
      onDoubleClick={(e) => {
        e.stopPropagation();
        paint(e.currentTarget, 820);
        dispatch({ type: "SetConversationWidth", value: 820 });
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width: state.conversationWidth };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty(
          "--pointer-y",
          `${Math.max(0, Math.min(rect.height, e.clientY - rect.top))}px`,
        );
        if (dragging) paint(e.currentTarget, width(e.clientX));
      }}
      onPointerUp={(e) => {
        if (!dragging) return;
        e.stopPropagation();
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragging(false);
        dispatch({ type: "SetConversationWidth", value: width(e.clientX) });
      }}
      onPointerCancel={(e) => {
        if (!dragging) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        paint(e.currentTarget, start.current.width);
        setDragging(false);
      }}
    />
  );
}
