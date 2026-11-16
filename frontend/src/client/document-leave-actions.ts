import type { AppAction, AppState } from "./types";

/** Only deliberate UI intents consult draft guards. Incoming scope/permission
 * revocation remains authoritative and must not wait on user confirmation. */
export function documentLeaveSelector(
  action: AppAction,
  state: AppState,
): string | null | undefined {
  switch (action.type) {
    case "ToggleRightRail":
      return state.rightRailCollapsed ? undefined : ".right-sidebar-shell";
    case "SetRightOverlay":
      return action.value || !state.rightOverlayOpen
        ? undefined
        : ".right-sidebar-shell";
    case "SelectViewTab":
      return state.sessionPluginTab
        ? "[data-testid='session-plugin-panel']"
        : undefined;
    case "SelectPluginTab":
      return state.sessionPluginTab &&
        state.sessionPluginTab.pluginId !== action.value
        ? "[data-testid='session-plugin-panel']"
        : undefined;
    case "ClosePluginPage":
      return state.pluginWorkspace
        ? ".client-plugin-workspace"
        : state.page === "plugin"
          ? ".client-plugin-expanded-page"
          : state.page === "plugins"
            ? ".client-plugins-page"
            : undefined;
    case "OpenPlugins":
    case "OpenPluginsPage":
      return state.page === "plugins" && !state.pluginWorkspace
        ? undefined
        : null;
    case "OpenPlugin":
      return state.page === "plugins"
        ? ".client-plugins-page"
        : state.pluginWorkspace?.type === "view" &&
            state.pluginWorkspace.pluginId !== action.id
          ? ".client-plugin-workspace"
          : undefined;
    case "Navigate":
      return action.value === state.page ? undefined : null;
    case "OpenDashboard":
      return state.page === "dashboard" ? undefined : null;
    case "Attach":
      return action.value === state.sessionId && state.page === "conversation"
        ? undefined
        : null;
    case "Logout":
    case "NewChat":
    case "SelectKnownProject":
    case "SelectDraftWorkspace":
    case "SelectSearchSession":
    case "OpenSubAgentDetail":
      return null;
    default:
      return undefined;
  }
}
