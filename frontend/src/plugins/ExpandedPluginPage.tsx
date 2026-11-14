import { useAppFields, useClientPlugins } from "../state";
import { t } from "../i18n";
import { PluginSurface } from "./PluginSidebar";

export function ExpandedPluginPage() {
  const { state, dispatch } = useAppFields(["pluginId", "resolvedLocale"]);
  const plugins = useClientPlugins();
  const plugin = plugins.registry
    ?.getSnapshot()
    .find((entry) => entry.manifest.id === state.pluginId);
  return (
    <section
      className="client-plugins-page client-plugin-expanded-page"
      data-testid="expanded-plugin-page"
    >
      <header className="client-plugin-toolbar">
        <h2>{plugin?.manifest.name ?? t("plugins.title")}</h2>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => void dispatch({ type: "ClosePluginPage" })}
        >
          {t("plugins.back")}
        </button>
      </header>
      {plugin && state.pluginId ? (
        <div className="client-plugin-panel">
          <PluginSurface pluginId={state.pluginId} target="expanded-page" />
        </div>
      ) : (
        <p role={plugins.error ? "alert" : "status"}>
          {plugins.error ||
            t(
              plugins.initializing
                ? "plugins.loading"
                : plugins.registry
                  ? "plugins.notInstalled"
                  : "plugins.unavailable",
            )}
        </p>
      )}
      {!plugin && !plugins.initializing && plugins.registry && (
        <button
          type="button"
          className="ghost-btn"
          onClick={() => void dispatch({ type: "OpenPlugins" })}
        >
          {t("plugins.manage")}
        </button>
      )}
    </section>
  );
}
