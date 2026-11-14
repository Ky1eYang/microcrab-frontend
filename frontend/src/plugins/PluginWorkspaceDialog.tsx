import { useAppFields, useClientPlugins } from "../state";
import { ContentDialog } from "../features/ContentDialog";
import { t } from "../i18n";
import { PluginsPage } from "./PluginsPage";
import { PluginSurface } from "./PluginSidebar";

/** Temporary inspection keeps the conversation mounted, its route and draft intact. */
export function PluginWorkspaceDialog() {
  const { state, dispatch } = useAppFields([
    "pluginWorkspace",
    "sessionId",
    "resolvedLocale",
  ]);
  const plugins = useClientPlugins();
  const workspace = state.pluginWorkspace;
  const sessionId = state.sessionId;
  if (!workspace) return null;
  const plugin =
    workspace.type === "view"
      ? plugins.registry
          ?.getSnapshot()
          .find((entry) => entry.manifest.id === workspace.pluginId)
      : undefined;
  return (
    <ContentDialog
      title={
        workspace.type === "manager"
          ? t("plugins.title")
          : (plugin?.manifest.name ?? t("plugins.title"))
      }
      layout={workspace.type === "manager" ? "content" : "workspace"}
      maximizable={workspace.type === "view"}
      onClose={() => void dispatch({ type: "ClosePluginPage" })}
    >
      <div
        className="client-plugin-workspace"
        data-testid="plugin-workspace-dialog"
        data-session-id={sessionId ?? ""}
      >
        {workspace.type === "manager" ? (
          <PluginsPage embedded />
        ) : (
          <div
            className="client-plugin-workspace-body"
            data-testid="expanded-plugin-page"
          >
            <PluginSurface
              key={`${sessionId}:${workspace.pluginId}`}
              pluginId={workspace.pluginId}
              target="expanded-page"
            />
          </div>
        )}
      </div>
    </ContentDialog>
  );
}
