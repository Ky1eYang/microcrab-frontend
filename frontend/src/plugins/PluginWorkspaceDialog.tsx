import { useAppFields, useClientPlugins } from "../state";
import { ContentDialog } from "../features/ContentDialog";
import { t } from "../i18n";
import { PluginSurface } from "./PluginSidebar";

/** Individual inspection preserves the mounted page and restores focus on close. */
export function PluginWorkspaceDialog() {
  const { state, dispatch } = useAppFields([
    "pluginWorkspace",
    "sessionId",
    "resolvedLocale",
  ]);
  const plugins = useClientPlugins();
  const workspace = state.pluginWorkspace;
  if (!workspace) return null;
  const plugin = plugins.registry
    ?.getSnapshot()
    .find((entry) => entry.manifest.id === workspace.pluginId);
  return (
    <ContentDialog
      title={plugin?.manifest.name ?? t("plugins.title")}
      layout="workspace"
      maximizable
      onClose={() => void dispatch({ type: "ClosePluginPage" })}
    >
      <div
        className="client-plugin-workspace"
        data-testid="plugin-workspace-dialog"
        data-session-id={state.sessionId ?? ""}
      >
        <div
          className="client-plugin-workspace-body"
          data-testid="expanded-plugin-page"
        >
          <PluginSurface
            key={`${state.sessionId}:${workspace.pluginId}`}
            pluginId={workspace.pluginId}
            target="expanded-page"
          />
        </div>
      </div>
    </ContentDialog>
  );
}
