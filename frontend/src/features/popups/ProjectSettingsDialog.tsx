import { OwnerSettings } from "./OwnerSettings";
import { ReferencesSettings } from "./ReferencesSettings";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useApp } from "../../state";
import { Icon } from "../shared";
import { trapFocus } from "../../client/viewport";
import { hostLocator, hostPreferenceScope } from "../../client/host-locators";
import { hostReason, hostStatus } from "./RemoteConnectDialog";
import { t } from "../../i18n";
import type { AgentInfo, NativeProject } from "../../client/types";

type ProjectTab = "host" | "references" | "permissions" | "agents";

const TABS: { id: ProjectTab; labelKey: string }[] = [
  { id: "host", labelKey: "project.settings.tab.host" },
  { id: "references", labelKey: "project.settings.tab.references" },
  { id: "permissions", labelKey: "project.settings.tab.permissions" },
  { id: "agents", labelKey: "project.settings.tab.agents" },
];

function Row({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">{label}</div>
        <div className={`settings-row-sub${mono ? " monospace-text" : ""}`}>
          {children}
        </div>
      </div>
    </div>
  );
}

function tip(kind: "info" | "warn" | "danger", children: ReactNode) {
  return (
    <div
      className={`project-settings-tip project-settings-tip-${kind}`}
      role="status"
    >
      {children}
    </div>
  );
}

function HostPane({
  project,
  projectId,
}: {
  project: NativeProject | undefined;
  projectId: string;
}) {
  const { state, dispatch } = useApp();
  const connection = state.hostConnection;
  const matched =
    connection?.projectId === projectId && connection.state !== "detached";
  const statusKey = matched ? (connection?.state ?? "detached") : "detached";
  const statusLabel =
    t(`host.status.${statusKey}`) !== `host.status.${statusKey}`
      ? t(`host.status.${statusKey}`)
      : (hostStatus[statusKey] ?? statusKey);
  const reason =
    matched && connection?.reason
      ? (hostReason[connection.reason] ?? connection.reason)
      : null;
  const scope = hostPreferenceScope(state.apiBase, state.authSession);
  const endpoint =
    (matched && connection?.endpoint) || hostLocator(scope, project) || "";
  const catalogReady = matched && connection?.catalogReady === true;
  const catalogError = matched ? connection?.catalogError : undefined;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      dispatch({
        type: "ShowToast",
        kind: "info",
        text: t("project.settings.host.copied"),
      });
    } catch {
      dispatch({
        type: "ShowToast",
        kind: "warn",
        text: t("project.settings.host.copyFailed"),
      });
    }
  };
  return (
    <div data-testid="project-host-summary">
      <h4 className="project-settings-pane-title">
        {t("project.settings.host.heading")}
      </h4>
      {!matched &&
        tip(
          "warn",
          <>
            <Icon name="warning" size={14} aria-hidden="true" />
            <span>{t("project.settings.host.offlineTip")}</span>
            <button
              type="button"
              className="ghost-btn"
              data-testid="project-host-reconnect"
              onClick={() => {
                dispatch({ type: "DismissPopup" });
                dispatch({ type: "OpenRemoteConnectDialog", projectId });
              }}
            >
              {t("project.settings.host.connect")}
            </button>
          </>,
        )}
      {catalogError &&
        tip(
          "danger",
          <span style={{ color: "var(--danger)" }}>{catalogError}</span>,
        )}
      <Row label={t("project.settings.host.name")}>{project?.name ?? "—"}</Row>
      <Row label={t("project.settings.host.id")} mono>
        <span className="project-settings-inline">
          <span>{projectId}</span>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void copy(projectId)}
          >
            {t("project.settings.host.copy")}
          </button>
        </span>
      </Row>
      <Row label={t("project.settings.host.root")} mono>
        {project?.root || "—"}
      </Row>
      <Row label={t("project.settings.host.status")}>
        <span data-host-state={statusKey}>{statusLabel}</span>
      </Row>
      {reason && <Row label={t("project.settings.host.reason")}>{reason}</Row>}
      <Row label={t("project.settings.host.workspace")} mono>
        {(matched && connection?.workspace) || "—"}
      </Row>
      <Row label={t("project.settings.host.endpoint")} mono>
        <span className="project-settings-inline">
          <span>{endpoint || "—"}</span>
          {!!endpoint && (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void copy(endpoint)}
            >
              {t("project.settings.host.copy")}
            </button>
          )}
        </span>
      </Row>
      {project?.host_id && (
        <Row label={t("project.settings.host.hostId")} mono>
          {project.host_id}
        </Row>
      )}
      {project?.workspace_id && (
        <Row label={t("project.settings.host.workspaceId")} mono>
          {project.workspace_id}
        </Row>
      )}
      <Row label={t("project.settings.host.catalog")}>
        {catalogError
          ? t("project.settings.host.catalogError")
          : catalogReady
            ? t("project.settings.host.catalogReady", {
                count: state.agents.length,
              })
            : t("project.settings.host.catalogPending")}
      </Row>
      <div className="settings-actions-row">
        <button
          type="button"
          className="ghost-btn"
          data-testid="project-host-reconnect"
          onClick={() => {
            dispatch({ type: "DismissPopup" });
            dispatch({ type: "OpenRemoteConnectDialog", projectId });
          }}
        >
          {t("project.settings.host.manage")}
        </button>
        <button
          type="button"
          className="ghost-btn"
          disabled={!matched || connection?.state !== "ready"}
          onClick={() => dispatch({ type: "RefreshHostState", projectId })}
        >
          {t("project.settings.host.refresh")}
        </button>
        <button
          type="button"
          className="ghost-btn"
          disabled={!matched}
          onClick={() => dispatch({ type: "RetryHostCatalog", projectId })}
        >
          {t("project.settings.host.retryCatalog")}
        </button>
      </div>
    </div>
  );
}

function ReferencesPane({ projectId }: { projectId: string }) {
  return <ReferencesSettings projectId={projectId} />;
}

function PermissionsPane({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const current = state.sessions.find((item) => item.id === state.sessionId);
  const matches = !!current && current.projectID === projectId;
  return (
    <div>
      <h4 className="project-settings-pane-title">
        {t("project.settings.perm.projectDefault")}
      </h4>
      <OwnerSettings scope={{ kind: "project", id: projectId }} />
      <button
        type="button"
        className="ghost-btn"
        disabled={!matches}
        title={!matches ? t("sessionPermissions.projectMismatch") : undefined}
        onClick={() => dispatch({ type: "OpenSessionPermissionsDialog" })}
      >
        {t("sessionPermissions.openSession")}
      </button>
    </div>
  );
}
function AgentsPane({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const matched =
    state.hostConnection?.projectId === projectId &&
    state.hostConnection.state === "ready";
  const agents: AgentInfo[] = matched ? state.agents : [];
  const hasSession = !!state.sessionId;
  return (
    <div>
      <h4 className="project-settings-pane-title">
        {t("project.settings.agents.heading")}
      </h4>
      {!matched && tip("warn", t("project.settings.agents.emptyHost"))}
      {matched &&
        !agents.length &&
        tip("info", t("project.settings.agents.empty"))}
      {hasSession && tip("info", t("project.settings.agents.sessionNote"))}
      <div className="project-agent-list" data-testid="project-agent-list">
        {agents.map((agent) => {
          const modes =
            agent.modes?.filter((mode) => mode.role !== "sub_agent") ?? [];
          const current = state.draftAgent === agent.name;
          const component =
            typeof agent.component === "string"
              ? agent.component.split(/[\\/]/).pop()
              : "—";
          return (
            <div className="project-agent-row" key={agent.name}>
              <div className="project-agent-main">
                <span className="project-agent-name">{agent.name}</span>
                <span className="project-agent-component monospace-text">
                  {component}
                </span>
                <span className="project-agent-modes">
                  {t("project.settings.agents.modes")}: {modes.length}
                </span>
                {current && (
                  <span className="project-agent-current">
                    {t("project.settings.agents.current")}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="ghost-btn"
                disabled={hasSession || !modes.length}
                title={
                  hasSession ? t("composer.agent.disabledSession") : undefined
                }
                onClick={() =>
                  dispatch({ type: "SetAgent", value: agent.name })
                }
              >
                {t("project.settings.agents.setDefault")}
              </button>
            </div>
          );
        })}
      </div>
      {/* TODO(T3): WASM agent upload / install API. */}
      <div className="settings-actions-row">
        <button
          type="button"
          className="ghost-btn"
          data-testid="project-agent-upload"
          disabled
          title={t("errors.todo.T3")}
        >
          {t("project.settings.agents.upload")}
        </button>
      </div>
      <p className="settings-description">
        {t("project.settings.agents.uploadHint")}
      </p>
    </div>
  );
}

export function ProjectSettingsDialog() {
  const { state, dispatch } = useApp();
  const popup = state.popup;
  const projectId = String(popup.projectId ?? "");
  const tab = (popup.tab as ProjectTab) || "host";
  const project = state.projects.find((item) => item.id === projectId);
  const dialog = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const title = project?.name
    ? t("project.settings.titleWithName", { name: project.name })
    : t("project.settings.title");
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [tab]);
  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        event.stopPropagation();
        trapFocus(dialog.current, event);
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: "DismissPopup" });
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener && opener.isConnected) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pane = useMemo(() => {
    if (tab === "references") return <ReferencesPane projectId={projectId} />;
    if (tab === "permissions")
      return (
        <PermissionsPane
          projectId={projectId}
          key={JSON.stringify([
            projectId,
            state.apiBase,
            state.authSession,
            state.sessionId,
          ])}
        />
      );
    if (tab === "agents") return <AgentsPane projectId={projectId} />;
    return <HostPane project={project} projectId={projectId} />;
  }, [
    tab,
    project,
    projectId,
    state.apiBase,
    state.authSession,
    state.sessionId,
  ]);
  return (
    <div className="overlay" onClick={() => dispatch({ type: "DismissPopup" })}>
      <div
        className="settings-dialog project-settings-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t("project.settings.title")}
        data-testid="project-settings"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="settings-nav">
          <div className="settings-nav-title" title={project?.name}>
            {t("project.settings.title")}
          </div>
          <div className="settings-nav-group">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="settings-nav-item"
                data-active={tab === item.id}
                data-testid={`project-settings-tab-${item.id}`}
                role="tab"
                aria-selected={tab === item.id}
                onClick={() =>
                  dispatch({ type: "SetProjectSettingsTab", value: item.id })
                }
              >
                <span>{t(item.labelKey)}</span>
              </button>
            ))}
          </div>
        </aside>
        <section className="settings-content-wrapper">
          <div className="settings-header">
            <h3 className="settings-tab-heading" title={project?.name}>
              {title}
            </h3>
            <button
              className="settings-close-btn"
              title={t("project.settings.close")}
              aria-label={t("project.settings.close")}
              onClick={() => dispatch({ type: "DismissPopup" })}
            >
              <Icon name="close" size={18} />
            </button>
          </div>
          <div className="settings-body" ref={body}>
            <div
              className="settings-tab-pane project-settings-pane"
              data-testid="project-settings-pane"
              role="tabpanel"
            >
              {pane}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
