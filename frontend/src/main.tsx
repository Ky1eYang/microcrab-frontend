import { useClientPlugins } from "./state";
import {
  hasActiveSessionSidebarPlugin,
  sessionTabPlugins,
  selectedSessionPlugin,
} from "./plugins/session-tabs";
import { PluginWorkspaceDialog } from "./plugins/PluginWorkspaceDialog";
import { PluginSubmitNotice } from "./plugins/PluginSidebar";
import { PluginsPage } from "./plugins/PluginsPage";
import { ExpandedPluginPage } from "./plugins/ExpandedPluginPage";
import "./features/action-menu.css";
import "./features/plugin-block-variants.css";
import "./styles/client-plugins.css";
import "./styles/plugins.css";
import { PermissionProposalDialog } from "./features/PermissionProposalDialog";
import { reportDiagnostic } from "./client/diagnostics";
import { preference } from "./client/storage";
import { syncLocaleFromPreference } from "./i18n";
import { RecoveredDrafts } from "./features/RecoveredDrafts";
import { LoginPage } from "./login";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AppProvider, useAppFields } from "./state";
import { Icon, useMenuEscape } from "./features/shared";
import { SessionRail } from "./shell/SessionRail";
import { Header } from "./shell/Header";
import { HomePage } from "./shell/HomePage";
import { ConversationPage } from "./features/conversation";
import { RightRail } from "./features/rightRail";
import { DashboardPage } from "./features/management";
import { PopupView } from "./features/popups";
import "./styles/tokens.css";
import "./styles/chrome.css";
import "./styles/components.css";
import "./features/citations/citations.css";
import "./features/visualizers/visualizers.css";
import "./features/questions/question-images.css";
import "./styles/interaction-polish.css";
import "./styles/dashboard.css";

// The app menus, their triggers and the click-outside backdrop.
const MENU_PARTS = [
  ".menu-click-outside-backdrop",
  ".session-menu",
  ".session-action-more",
  ".rail-project-more-btn",
  ".workspace-dropdown-menu",
  ".home-workspace-badge-btn",
  ".header-popover-menu",
  ".header-subagents-btn",
  ".header-running-tools-btn",
].join(", ");

function Layout() {
  const plugins = useClientPlugins();
  const { state, dispatch } = useAppFields([
    "menuSession",
    "menuProject",
    "showWorkspaceDropdown",
    "showRunningToolsMenu",
    "showSubagentsMenu",
    "page",
    "sessionId",
    "resolvedLocale",
    "connection",
    "railCollapsed",
    "rightRailCollapsed",
    "viewMode",
    "sessionPluginTab",
    "toast",
  ]);
  const installedSnapshot = plugins.registry?.getSnapshot() ?? [];
  const isPluginEnabled = (id: string) =>
    plugins.registry?.isEnabled(id, state.sessionId) ?? false;
  const selectedPlugin = selectedSessionPlugin(
    state.sessionPluginTab,
    state.sessionId,
    sessionTabPlugins(installedSnapshot, isPluginEnabled),
  );
  const canShowRightRail = hasActiveSessionSidebarPlugin(
    installedSnapshot,
    isPluginEnabled,
    state.page,
    state.sessionId,
  );
  const menu =
    state.menuSession ||
    state.menuProject ||
    state.showWorkspaceDropdown ||
    state.showRunningToolsMenu ||
    state.showSubagentsMenu;
  const closeMenus = () => {
    dispatch({ type: "CloseMenu" });
    dispatch({ type: "CloseProjectMenu" });
    dispatch({ type: "CloseDropdowns" });
  };
  // Esc closes whichever app menu is open and refocuses its trigger. The key
  // names the menu, so moving between menus refreshes the trigger.
  useMenuEscape(
    menu &&
      [
        state.menuSession,
        state.menuProject,
        state.showWorkspaceDropdown,
        state.showRunningToolsMenu,
        state.showSubagentsMenu,
      ].join("|"),
    closeMenus,
  );
  // Any page or session change also closes them, so no stale backdrop stays.
  const closeRef = useRef(closeMenus);
  closeRef.current = closeMenus;
  const openRef = useRef(menu);
  openRef.current = menu;
  useEffect(() => {
    if (openRef.current) closeRef.current();
  }, [state.page, state.sessionId]);
  // Some layers sit above the click-outside backdrop (the header, the narrow
  // drawer), so a press there never reaches it. While a menu is open, a press
  // anywhere outside the open menu and its trigger closes it; the press still
  // goes on to its target. Presses on the backdrop itself are left to it, so it
  // still swallows the closing click over the page.
  useEffect(() => {
    if (!menu) return;
    const onPress = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(MENU_PARTS))
        return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", onPress, true);
    return () => document.removeEventListener("pointerdown", onPress, true);
  }, [menu]);
  useEffect(() => {
    document.title = "microcrab";
  }, []);
  return (
    <>
      {menu && (
        <div
          className="menu-click-outside-backdrop"
          onClick={(e) => {
            e.stopPropagation();
            closeMenus();
          }}
        />
      )}
      {state.page === "dashboard" ? (
        <DashboardPage />
      ) : (
        <div
          className="shell"
          data-rail-collapsed={state.railCollapsed}
          data-left-collapsed={state.railCollapsed}
          data-right-collapsed={!canShowRightRail || state.rightRailCollapsed}
        >
          <SessionRail />
          <div className="main-container">
            <Header />
            <PluginSubmitNotice />
            <main
              className="page"
              id="main-view-panel"
              {...(state.page === "conversation" && state.sessionId
                ? {
                    role: "tabpanel",
                    "aria-labelledby": selectedPlugin
                      ? `view-tab-plugin-${selectedPlugin}`
                      : `view-tab-${state.viewMode}`,
                  }
                : {})}
            >
              {(state.page === "conversation" ||
                state.page === "plugins" ||
                state.page === "plugin") && (
                <div
                  className="retained-conversation-page"
                  data-inactive={state.page !== "conversation"}
                  inert={state.page !== "conversation"}
                  aria-hidden={state.page !== "conversation"}
                >
                  <ConversationPage active={state.page === "conversation"} />
                </div>
              )}
              {state.page === "plugins" ? (
                <PluginsPage />
              ) : state.page === "plugin" ? (
                <ExpandedPluginPage />
              ) : state.page !== "conversation" ? (
                <HomePage />
              ) : null}
            </main>
          </div>
          <RightRail />
        </div>
      )}
      <PluginWorkspaceDialog />
      <PopupView />
      <PermissionProposalDialog />
      {state.toast && (
        <ToastBanner
          toast={state.toast}
          onDismiss={() => dispatch({ type: "DismissToast" })}
        />
      )}
    </>
  );
}

function ToastBanner({
  toast,
  onDismiss,
}: {
  toast: { text: string; kind?: string; sticky?: boolean; generation: number };
  onDismiss: () => void;
}) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(4000);
  const startTimeRef = useRef(Date.now());
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    remainingRef.current = 4000;
    startTimeRef.current = Date.now();
    setPaused(false);

    if (toast.sticky) return;

    timerRef.current = window.setTimeout(() => {
      dismissRef.current();
    }, 4000);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [toast.generation, toast.sticky]);

  const handleMouseEnter = () => {
    if (toast.sticky) return;
    setPaused(true);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const elapsed = Date.now() - startTimeRef.current;
    remainingRef.current = Math.max(0, remainingRef.current - elapsed);
  };

  const handleMouseLeave = () => {
    if (toast.sticky || remainingRef.current <= 0) return;
    setPaused(false);
    startTimeRef.current = Date.now();
    timerRef.current = window.setTimeout(() => {
      dismissRef.current();
    }, remainingRef.current);
  };

  return (
    <div
      className="toast toast-container"
      role="status"
      data-kind={toast.kind}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {!toast.sticky && (
        <div
          key={toast.generation}
          className="toast-progress-bar"
          style={{
            animationPlayState: paused ? "paused" : "running",
            animationDuration: "4s",
          }}
        />
      )}
      <div className="toast-body">{toast.text}</div>
      <button
        type="button"
        className="toast-close"
        aria-label="关闭提示"
        onClick={(e) => {
          e.stopPropagation();
          dismissRef.current();
        }}
      >
        <Icon name="close" size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    reportDiagnostic("ui", "render", error);
  }
  render() {
    if (this.state.error)
      return (
        <div
          role="alert"
          style={{
            position: "fixed",
            inset: "0 0 auto",
            zIndex: "var(--z-fatal)",
            background: "var(--danger)",
            color: "var(--on-danger)",
            padding: "var(--sp-5)",
          }}
        >
          <strong>前端发生错误</strong>
          <pre style={{ whiteSpace: "pre-wrap" }}>
            {this.state.error.message}
          </pre>
          <button onClick={() => location.reload()}>刷新页面</button>
        </div>
      );
    return this.props.children;
  }
}
const root = document.getElementById("main");
if (!root) throw new Error("Missing #main application root");
// /login has no AppProvider. Resolve its existing persisted locale before
// rendering, just as the store does for the app; no render-time side effects.
if (location.pathname === "/login")
  syncLocaleFromPreference(preference("locale", "zh-CN"));
createRoot(root).render(
  <ErrorBoundary>
    {location.pathname === "/login" ? (
      <LoginPage />
    ) : (
      <AppProvider>
        <Layout />
      </AppProvider>
    )}
    <RecoveredDrafts />
  </ErrorBoundary>,
);
