import { useEffect, useRef } from "react";
import { useAppFields } from "../state";
import { Composer } from "../features/composer";
import { RecentSessions } from "../features/home/RecentSessions";
import { WorkspacePicker } from "../features/home/WorkspacePicker";
import { t } from "../i18n";
import "../styles/home-page.css";

export function HomePage() {
  const { state, dispatch } = useAppFields([
    "showWorkspaceDropdown",
    "connection",
    "apiBase",
    "resolvedLocale",
  ]);
  const emit = (type: string, value?: unknown) => dispatch({ type, value });
  // Leaving home (any route) must not leave the workspace menu or its
  // backdrop open over the next page.
  const close = useRef(dispatch);
  close.current = dispatch;
  useEffect(
    () => () => {
      void close.current({ type: "CloseDropdowns" });
    },
    [],
  );
  return (
    <div
      className="home-page-container"
      onClick={() => state.showWorkspaceDropdown && emit("CloseDropdowns")}
    >
      <div className="home-center-stage">
        <WorkspacePicker />
        <Composer />
        {state.connection === "disconnected" && (
          <p className="home-disconnected-hint">
            {t("home.backendOffline", { api: state.apiBase })}
          </p>
        )}
        <RecentSessions />
      </div>
    </div>
  );
}
