import { t } from "../i18n";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useApp } from "../state";
import { Icon } from "./Icon";
import { useMenuEscape } from "../features/shared";

export function UserCard({ compact = false }: { compact?: boolean }) {
  const { state, dispatch } = useApp();
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>();
  const root = useRef<HTMLDivElement>(null);
  const account = state.authSession;
  const name =
    account?.principal?.display_name?.trim() || t("settingsDlg.signedOut");
  const mark = name.replace(/\s+/g, "").slice(0, 2) || "me";
  const light = state.resolvedTheme === "light";
  useMenuEscape(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const choose = (action: string, keepOpen = false) => {
    if (!keepOpen) setOpen(false);
    if (action === "Help") {
      dispatch({
        type: "ShowToast",
        value: t("user.helpPending"),
        kind: "info",
      });
      return;
    }
    dispatch({ type: action });
  };
  return (
    <div className="user-card-anchor" ref={root} data-compact={compact}>
      <button
        className="user-card-btn"
        type="button"
        aria-expanded={open}
        title={name}
        onClick={() => {
          if (compact && root.current) {
            const rect = root.current.getBoundingClientRect();
            setMenuStyle({
              position: "fixed",
              left: rect.right + 10,
              bottom: Math.max(8, window.innerHeight - rect.bottom),
              width: 220,
            });
          }
          setOpen((value) => !value);
        }}
      >
        <span className="user-card-mark" aria-hidden="true">
          {mark}
        </span>
        {compact ? (
          <span className="sr-only">{name}</span>
        ) : (
          <span className="user-card-name">{name}</span>
        )}
      </button>
      {open && (
        <div
          className="user-card-menu"
          role="menu"
          style={compact ? menuStyle : undefined}
        >
          <div className="user-card-email">{name}</div>
          <button type="button" onClick={() => choose("OpenSettings")}>
            <Icon name="settings" size={15} />
            <span>{t("settingsDlg.title")}</span>
          </button>
          <button type="button" onClick={() => choose("ToggleTheme", true)}>
            <Icon name={light ? "moon" : "sun"} size={15} />
            <span>{light ? t("user.darkMode") : t("user.lightMode")}</span>
          </button>
          <button type="button" onClick={() => choose("Help")}>
            <Icon name="help" size={15} />
            <span>{t("user.help")}</span>
            <Icon name="chevron" size={13} />
          </button>
          {account?.authenticated && (
            <button type="button" onClick={() => choose("Logout")}>
              <Icon name="logout" size={15} />
              <span>{t("settingsDlg.logout")}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
