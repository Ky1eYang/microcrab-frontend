import { ExternalSpeakersSettings } from "./ExternalSpeakersSettings";
import { OwnerSettings, type ProjectSettingsSection } from "./OwnerSettings";
import { ReferencesSettings } from "./ReferencesSettings";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useApp, useAppStore } from "../../state";
import { Icon } from "../shared";
import { trapFocus, useNarrowViewport } from "../../client/viewport";
import { hostLocator, hostPreferenceScope } from "../../client/host-locators";
import { hostReason, hostStatusLabel } from "./RemoteConnectDialog";
import { hostReadiness } from "../../state/host-readiness";
import { t } from "../../i18n";
import type { AgentInfo, NativeProject } from "../../client/types";
import "../../styles/project-settings.css";

type ProjectTab = ProjectSettingsSection | "host" | "speakers" | "references";

const TABS: readonly ProjectTab[] = [
  "host",
  "agents",
  "models",
  "prompts",
  "speakers",
  "permissions",
  "references",
];
const TAB_ICONS: Record<ProjectTab, string> = {
  host: "database",
  agents: "bot",
  models: "model",
  prompts: "file",
  speakers: "send",
  permissions: "check",
  references: "folder",
};

function ownerSection(tab: ProjectTab): ProjectSettingsSection | null {
  return tab === "agents" ||
    tab === "models" ||
    tab === "prompts" ||
    tab === "permissions"
    ? tab
    : null;
}

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
    <div className="project-host-fact">
      <dt>{label}</dt>
      <dd className={mono ? "monospace-text" : undefined}>{children}</dd>
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
  const statusKey = hostReadiness(state, projectId).status;
  const statusLabel = hostStatusLabel(statusKey);
  const reason =
    matched && connection?.reason
      ? (hostReason[connection.reason] ?? connection.reason)
      : null;
  const scope = hostPreferenceScope(state.apiBase, state.authSession);
  const endpoint =
    (matched && connection?.endpoint) || hostLocator(scope, project) || "";
  const catalogReady = matched && connection?.catalogReady === true;
  const catalogError = matched ? connection?.catalogError : undefined;
  const hostError =
    connection?.projectId === projectId &&
    (!!connection.cause ||
      !!connection.debugError ||
      !!connection.catalogError ||
      connection.state === "error" ||
      [
        "connection_failed",
        "connection_timeout",
        "handshake_timeout",
        "pairing_rejected",
        "resume_rejected",
      ].includes(connection.reason ?? ""));
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
    <div className="settings-section-card" data-testid="project-host-summary">
      <div className="settings-section-head">
        <h4 className="settings-section-title">
          {t("project.settings.host.heading")}
        </h4>
        <span
          className={`badge ${hostError ? "badge-danger" : statusKey === "ready" ? "badge-success" : ""}`}
          data-host-state={statusKey}
        >
          {statusLabel}
        </span>
      </div>
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
                dispatch({ type: "OpenRemoteConnectDialog", projectId });
              }}
            >
              {t("project.settings.host.connect")}
            </button>
          </>,
        )}
      {catalogError && tip("danger", <span>{catalogError}</span>)}
      <dl className="project-host-facts">
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
      </dl>
      <div className="settings-actions-row">
        <button
          type="button"
          className="ghost-btn"
          data-testid="project-host-reconnect"
          onClick={() => {
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

function SessionPermissionsLink({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const current = state.sessions.find((item) => item.id === state.sessionId);
  const matches = !!current && current.projectID === projectId;
  return (
    <div className="settings-section-head project-session-permissions">
      <h4 className="settings-section-title">
        {t("project.settings.perm.projectDefault")}
      </h4>
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
  const [agentQuery, setAgentQuery] = useState("");
  const matched =
    state.hostConnection?.projectId === projectId &&
    state.hostConnection.state === "ready";
  const agents: AgentInfo[] = matched ? state.agents : [];
  const filteredAgents = agents.filter((agent) => {
    const q = agentQuery.trim().toLowerCase();
    return (
      !q ||
      `${agent.name} ${typeof agent.component === "string" ? agent.component : ""}`
        .toLowerCase()
        .includes(q)
    );
  });
  const hasSession = !!state.sessionId;
  return (
    <div className="settings-section-card">
      <div className="settings-section-head">
        <h4 className="settings-section-title">
          {t("project.settings.agents.heading")}
        </h4>
        <span className="limit-source-pill">{filteredAgents.length}</span>
      </div>
      {!matched && tip("warn", t("project.settings.agents.emptyHost"))}
      {matched &&
        !agents.length &&
        tip("info", t("project.settings.agents.empty"))}
      {hasSession && tip("info", t("project.settings.agents.sessionNote"))}
      {(agents.length > 3 || agentQuery.length > 0) && (
        <input
          type="search"
          className="settings-input"
          placeholder={t("uiPolish.searchAgents")}
          aria-label={t("project.settings.agents.heading")}
          value={agentQuery}
          onChange={(e) => setAgentQuery(e.target.value)}
        />
      )}
      {!!agentQuery.trim() && !filteredAgents.length && (
        <p className="settings-description" role="status">
          {t("uiPolish.noMatches")}
        </p>
      )}
      <div className="project-agent-list" data-testid="project-agent-list">
        {filteredAgents.map((agent) => {
          const modes =
            agent.modes?.filter((mode) => mode.role !== "sub_agent") ?? [];
          const current = state.draftAgent === agent.name;
          const component =
            typeof agent.component === "string" ? agent.component : "—";
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
                {!!agent.modes?.length && (
                  <details className="project-agent-mode-details">
                    <summary>
                      {t("project.settings.agents.modeDetails")}
                    </summary>
                    <ul>
                      {agent.modes.map((mode) => (
                        <li key={mode.name}>
                          {mode.name}
                          {(mode.role === "main_agent" ||
                            mode.role === "sub_agent" ||
                            mode.role === "both") &&
                            ` · ${t(`project.settings.agents.role.${mode.role}`)}`}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
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
                {t("project.settings.agents.useInDraft")}
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
  const { state } = useApp();
  const store = useAppStore();
  const api = store.api;
  const projectId = String(state.popup.projectId ?? "");
  const lifecycle = useRef({ api, generation: 0 });
  if (lifecycle.current.api !== api)
    lifecycle.current = { api, generation: lifecycle.current.generation + 1 };
  const identity = JSON.stringify([
    state.apiBase,
    state.authSession?.principal?.owner,
    state.authSession?.authenticated,
    state.authRequired,
    projectId,
    lifecycle.current.generation,
  ]);
  return <ProjectSettingsDocument key={identity} projectId={projectId} />;
}

function ProjectSettingsDocument({ projectId }: { projectId: string }) {
  const { state, dispatch } = useApp();
  const tab = TABS.find((candidate) => candidate === state.popup.tab) ?? "host";
  const section = ownerSection(tab);
  const project = state.projects.find((item) => item.id === projectId);
  const dialog = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const prefix = useId();
  const narrow = useNarrowViewport();
  const [visitedOwner, setVisitedOwner] = useState(false);
  const [visitedReferences, setVisitedReferences] = useState(false);
  const title = project?.name
    ? t("project.settings.titleWithName", { name: project.name })
    : t("project.settings.title");
  const dismiss = () => dispatch({ type: "DismissPopup" });
  const activate = (value: ProjectTab) => {
    if (value !== tab) void dispatch({ type: "SetProjectSettingsTab", value });
  };
  const tabButton = (candidate: ProjectTab) =>
    tabs.current?.querySelector<HTMLButtonElement>(
      `[data-project-tab="${candidate}"]`,
    );
  // Manual activation keeps keyboard browsing from opening a different document
  // or triggering a Speaker leave confirmation before the user selects a tab.
  const browseTabs = (event: ReactKeyboardEvent, index: number) => {
    let next = index;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else if (event.key === (narrow ? "ArrowRight" : "ArrowDown")) next++;
    else if (event.key === (narrow ? "ArrowLeft" : "ArrowUp")) next--;
    else return;
    event.preventDefault();
    tabButton(TABS[(next + TABS.length) % TABS.length])?.focus();
  };
  useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
    if (narrow)
      tabButton(tab)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab, narrow]);
  useLayoutEffect(() => {
    if (section) setVisitedOwner(true);
    if (tab === "references") setVisitedReferences(true);
  }, [tab, section]);
  useEffect(() => {
    const opener = document.activeElement;
    tabs.current
      ?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
      ?.focus();
    const onKey = (event: KeyboardEvent) => {
      const confirmation = dialog.current?.querySelector<HTMLElement>(
        '[role="alertdialog"]',
      );
      if (
        event.key === "Escape" &&
        event.target instanceof Element &&
        event.target.closest('[role="combobox"][aria-expanded="true"]')
      )
        return;
      if (event.key === "Tab") {
        event.stopPropagation();
        trapFocus(confirmation ?? dialog.current, event);
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (confirmation)
        confirmation.querySelector<HTMLButtonElement>("button")?.click();
      else void dismiss();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  const tabId = (item: ProjectTab) => `${prefix}-tab-${item}`;
  const panelId = (item: ProjectTab) => `${prefix}-panel-${item}`;
  return (
    <div className="overlay" onClick={dismiss}>
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
          <div
            className="settings-nav-group"
            ref={tabs}
            role="tablist"
            aria-label={t("project.settings.title")}
            aria-orientation={narrow ? "horizontal" : "vertical"}
          >
            {TABS.map((item, index) => (
              <button
                key={item}
                id={tabId(item)}
                type="button"
                className="settings-nav-item"
                data-active={tab === item}
                data-project-tab={item}
                data-testid={`project-settings-tab-${item}`}
                role="tab"
                tabIndex={tab === item ? 0 : -1}
                aria-selected={tab === item}
                aria-controls={panelId(item)}
                onClick={() => activate(item)}
                onKeyDown={(event) => browseTabs(event, index)}
              >
                <Icon
                  name={TAB_ICONS[item]}
                  size={16}
                  className="settings-nav-icon"
                  aria-hidden="true"
                />
                <span>{t(`project.settings.tab.${item}`)}</span>
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
              type="button"
              title={t("project.settings.close")}
              aria-label={t("project.settings.close")}
              onClick={dismiss}
            >
              <Icon name="close" size={18} />
            </button>
          </div>
          <div className="settings-body" ref={body}>
            <div
              className="settings-tab-pane project-settings-pane"
              data-project-section={tab}
              data-testid="project-settings-pane"
              id={panelId(tab)}
              aria-labelledby={tabId(tab)}
              role="tabpanel"
              tabIndex={0}
            >
              {tab === "host" && (
                <HostPane project={project} projectId={projectId} />
              )}
              {tab === "agents" && <AgentsPane projectId={projectId} />}
              {tab === "permissions" && (
                <SessionPermissionsLink projectId={projectId} />
              )}
              {tab === "speakers" && (
                <ExternalSpeakersSettings
                  scope={{ kind: "project", id: projectId }}
                />
              )}
              {(tab === "references" || visitedReferences) && (
                <div hidden={tab !== "references"}>
                  <ReferencesSettings projectId={projectId} />
                </div>
              )}
              {(section || visitedOwner) && (
                <OwnerSettings
                  scope={{ kind: "project", id: projectId }}
                  projectView={{ section, onSectionChange: activate }}
                />
              )}
            </div>
            {TABS.filter((item) => item !== tab).map((item) => (
              <div
                key={item}
                id={panelId(item)}
                role="tabpanel"
                aria-labelledby={tabId(item)}
                hidden
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
