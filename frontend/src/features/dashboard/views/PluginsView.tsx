import { t } from "../../../i18n";
import { PluginsPage } from "../../../plugins/PluginsPage";
import { useAppFields } from "../../../state";

export function PluginsView() {
  const { state, dispatch } = useAppFields(["sessionId", "resolvedLocale"]);
  return (
    <div className="sb-plugins-host">
      {state.sessionId && (
        <div className="sb-plugins-scope-bar">
          <span className="text-xs text-neutral-400">
            {t("console.plugins.globalScopeHint")}
          </span>
          <button
            type="button"
            className="sb-btn sb-btn-ghost sb-btn-sm"
            data-testid="console-session-plugins"
            onClick={() => void dispatch({ type: "OpenPlugins" })}
          >
            {t("console.plugins.openSession")}
          </button>
        </div>
      )}
      <PluginsPage embedded />
    </div>
  );
}
