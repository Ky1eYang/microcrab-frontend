import { t } from "../../../i18n";
import { PluginsPage } from "../../../plugins/PluginsPage";
import { useAppFields } from "../../../state";

export function PluginsView() {
  const { state, dispatch } = useAppFields(["sessionId", "resolvedLocale"]);
  return (
    <div className="sb-view-container space-y-4">
      {state.sessionId && (
        <div className="sb-card p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-neutral-400">
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
