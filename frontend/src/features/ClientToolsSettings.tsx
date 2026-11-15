import { t } from "../i18n";
import { useApp } from "../state";
import { Executions } from "./Executions";

/** Configuration and credentials live only in this browser instance. */
export function ClientToolsSettings() {
  const { state, dispatch } = useApp();
  return (
    <section className="settings-card client-tools-settings">
      <div className="settings-section-head">
        <div className="settings-card-title">{t("clientTools.title")}</div>
        {state.sessionId && (
          <span className="limit-source-pill" role="status">
            {t("clientTools.role", {
              role:
                state.clientTools?.role === "executor"
                  ? t("clientTools.executor")
                  : t("clientTools.observer"),
            })}
          </span>
        )}
      </div>
      <p className="settings-description">{t("clientTools.intro")}</p>
      <Executions />
      <div className="settings-actions-row">
        <button
          type="button"
          className="ghost-btn"
          onClick={() => void dispatch({ type: "OpenPlugins" })}
        >
          {t("plugins.title")}
        </button>
      </div>
    </section>
  );
}
