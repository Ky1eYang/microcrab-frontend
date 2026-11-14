import { useState } from "react";
import { t } from "../i18n";
import { useApp } from "../state";
import { Executions } from "./Executions";

/** Configuration and credentials live only in this browser instance. */
export function ClientToolsSettings() {
  const { state, dispatch } = useApp();
  const [id, setId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [authorization, setAuthorization] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <section className="settings-card client-tools-settings">
      <h3>{t("clientTools.title")}</h3>
      <p>{t("clientTools.intro")}</p>
      {state.sessionId && (
        <>
          <p role="status">
            {t("clientTools.role", {
              role:
                state.clientTools?.role === "executor"
                  ? t("clientTools.executor")
                  : t("clientTools.observer"),
            })}
          </p>
        </>
      )}
      <h3>MCP · Streamable HTTP</h3>
      <p>{t("clientTools.mcpIntro")}</p>
      <label className="settings-form-group settings-form-label">
        {t("clientTools.connectionId")}{" "}
        <input
          className="settings-input"
          value={id}
          maxLength={64}
          onChange={(e) => setId(e.target.value)}
        />
      </label>
      <label className="settings-form-group settings-form-label">
        {t("clientTools.endpoint")}{" "}
        <input
          className="settings-input"
          type="url"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
        />
      </label>
      <label className="settings-form-group settings-form-label">
        {t("clientTools.authorization")}{" "}
        <input
          className="settings-input"
          type="password"
          autoComplete="off"
          value={authorization}
          onChange={(e) => setAuthorization(e.target.value)}
        />
      </label>
      <button
        className="primary-btn"
        type="button"
        disabled={pending || !id.trim() || !endpoint.trim()}
        onClick={async () => {
          setPending(true);
          try {
            await dispatch({
              type: "ConnectMcp",
              config: {
                id: id.trim(),
                endpoint: endpoint.trim(),
                ...(authorization ? { authorization } : {}),
              },
            });
            setAuthorization("");
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? t("clientTools.initializing") : t("clientTools.connect")}
      </button>
      {(state.mcpServers ?? []).map((server: { id: string; tools: number }) => (
        <div key={server.id} className="settings-row">
          <span>
            {t("clientTools.serverTools", {
              id: server.id,
              count: server.tools,
            })}
          </span>
          <button
            type="button"
            className="ghost-btn"
            onClick={() =>
              dispatch({ type: "DisconnectMcp", value: server.id })
            }
          >
            {t("clientTools.disconnect")}
          </button>
        </div>
      ))}
      <Executions />
      <button
        type="button"
        className="ghost-btn"
        onClick={() => void dispatch({ type: "OpenPlugins" })}
      >
        {t("plugins.title")}
      </button>
    </section>
  );
}
