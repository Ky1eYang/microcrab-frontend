import { useClientPlugins } from "../state";
import {
  sessionTabPlugins,
  selectedSessionPlugin,
} from "../plugins/session-tabs";
import { SessionViewTabs } from "../features/SessionViewTabs";
import { childText } from "../features/childPresentation";
import { hostStatusLabel } from "../features/popups/RemoteConnectDialog";
import { useEffect, useState } from "react";
import { useAppDispatch, useAppSelector } from "../state";
import { hostReadiness } from "../state/host-readiness";
import { Icon } from "./Icon";
import {
  GlyphIcon,
  Icon as FeatureIcon,
  childId,
  isBusy,
  isSubagent,
} from "../features/shared";
import { usePluginDrawerViewport } from "../client/viewport";
import type { NativeExecution } from "../client/types";
import { t } from "../i18n";
import {
  TOOL_STATUS_ICON,
  childDisplayStatus,
  toolDisplayStatus,
} from "../features/tool-status";
import { ExecutionPeek } from "../features/ExecutionPeek";
import {
  executionElapsed,
  executionStatus,
  pendingExecution,
} from "../features/executionContent";

export function Header() {
  const clientPlugins = useClientPlugins();
  const dispatch = useAppDispatch();
  const { state } = useAppSelector(
    (state) => ({
      state,
      busy: isBusy(state.transcript),
      children: JSON.stringify(
        state.transcript.blocks
          .filter(isSubagent)
          .map((block) => [
            childId(block),
            block.tool?.childTarget,
            block.tool?.input?.subagent,
            block.tool?.input?.prompt,
            block.tool?.childBinding,
            block.tool?.status,
            block.temporary,
            block.payload.structured?.status,
          ]),
      ),
    }),
    (before, after) =>
      before.busy === after.busy &&
      before.children === after.children &&
      (
        [
          "rightOverlayOpen",
          "rightRailCollapsed",
          "executionHistory",
          "sessionId",
          "sessions",
          "popup",
          "childList",
          "connection",
          "isCreatingSession",
          "authSession",
          "hostConnection",
          "draftWorkspace",
          "sandboxSession",
          "capabilities",
          "showSubagentsMenu",
          "childListLoading",
          "childListError",
          "showRunningToolsMenu",
          "apiBase",
          "viewMode",
          "sessionPluginTab",
          "resolvedLocale",
        ] as const
      ).every((key) => Object.is(before.state[key], after.state[key])),
  );
  const host = hostReadiness(state);
  const hostLabel = hostStatusLabel(host.status);
  const narrow = usePluginDrawerViewport();
  const rightOpen = narrow ? state.rightOverlayOpen : !state.rightRailCollapsed;
  const [, tick] = useState(0);
  const [peek, setPeek] = useState<NativeExecution | null>(null);
  const tools: NativeExecution[] = (state.executionHistory ?? []).filter(
    (execution: NativeExecution) =>
      execution.session_id === state.sessionId &&
      (pendingExecution(execution) ||
        execution.output_availability === "retained"),
  );
  const ticking = tools.some(
    (execution) =>
      pendingExecution(execution) &&
      execution.elapsed_ms == null &&
      execution.started_at_unix_ms != null,
  );
  const running = tools.some(pendingExecution);
  // Capsule glyph: spinner while any task is active; a check only when every
  // listed task explicitly succeeded; otherwise the most significant outcome.
  const outcomes = tools.map((item) => toolDisplayStatus(item.status));
  const capsuleIcon = running
    ? "spinner"
    : outcomes.every((status) => status === "succeeded")
      ? "check"
      : outcomes.includes("failed")
        ? TOOL_STATUS_ICON.failed
        : outcomes.includes("interrupted")
          ? TOOL_STATUS_ICON.interrupted
          : outcomes.includes("cancelled")
            ? TOOL_STATUS_ICON.cancelled
            : TOOL_STATUS_ICON.unknown;
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  useEffect(() => {
    setPeek(null);
  }, [state.sessionId]);
  const current = state.sessions.find((s) => s.id === state.sessionId);
  const inspection =
    state.popup.type === "subagentDetail" &&
    state.popup.parentId === state.sessionId
      ? state.popup
      : null;
  const title = current?.title || current?.id || "New chat";
  const children = (
    state.childList?.parent_session_id === state.sessionId
      ? state.childList.children
      : []
  ).map((s) => ({
    id: s.id,
    title: childText(s.name) || s.id,
    status: childText(s.status) || "unknown",
  }));
  for (const b of state.transcript.blocks) {
    if (!isSubagent(b)) continue;
    const id = childId(b);
    if (!id || children.some((s) => s.id === id)) continue;
    children.push({
      id,
      title:
        childText(b.tool?.childTarget) ||
        childText(b.tool?.input?.subagent) ||
        childText(b.tool?.input?.prompt) ||
        `SubAgent (${id})`,
      // A streamed delegate receipt does not establish committed child completion.
      status:
        b.tool?.childBinding === "execution"
          ? childText(b.tool.status)
          : b.temporary
            ? "unknown"
            : childText(b.payload.structured?.status) || "unknown",
    });
  }
  const status =
    state.connection === "disconnected"
      ? "disconnected"
      : state.isCreatingSession
        ? "creating"
        : isBusy(state.transcript)
          ? "busy"
          : "idle";
  const emit = (type: string, value?: unknown) => dispatch({ type, value });
  return (
    <header
      className={`header-compound-root${inspection ? " child-inspection-header" : ""}`}
    >
      <div className="header-main-row">
        <div className="header-left-zone">
          {(() => {
            // Multi-depth crumb grammar (G1). Direct parent stays actionable;
            // deeper ancestors are disabled until multi-level nav API exists.
            // TODO(multi-depth-child-nav): enable intermediate ancestor clicks
            // when children API exposes ancestor chains / attach-by-depth.
            type Crumb = {
              key: string;
              label: string;
              current?: boolean;
              disabled?: boolean;
              onClick?: () => void;
              title?: string;
            };
            const ancestors: { id: string; label: string }[] = [];
            const seen = new Set<string>();
            let walk = current;
            while (walk?.parentID && !seen.has(walk.id)) {
              seen.add(walk.id);
              const p = state.sessions.find((s) => s.id === walk!.parentID);
              if (!p) {
                ancestors.unshift({
                  id: walk.parentID,
                  label: walk.parentID,
                });
                break;
              }
              ancestors.unshift({
                id: p.id,
                label: p.title.trim() || p.id,
              });
              walk = p;
            }
            const crumbs: Crumb[] = [];
            if (inspection) {
              for (let i = 0; i < ancestors.length; i++) {
                const a = ancestors[i];
                const isDirectParentOfSession = i === ancestors.length - 1;
                crumbs.push({
                  key: a.id,
                  label: a.label,
                  // Ancestors above the inspected session's parent are not
                  // navigable yet (API only lists direct children).
                  disabled: !isDirectParentOfSession,
                  title: !isDirectParentOfSession
                    ? t("header.ancestorPending")
                    : a.id,
                  onClick: isDirectParentOfSession
                    ? () => emit("Attach", a.id)
                    : undefined,
                });
              }
              crumbs.push({
                key: state.sessionId || "session",
                label: title,
                onClick: () => emit("CloseSubAgentDetail"),
              });
              crumbs.push({
                key: inspection.childId,
                label: childText(inspection.detail?.name) || inspection.childId,
                current: true,
              });
            } else if (ancestors.length) {
              for (let i = 0; i < ancestors.length; i++) {
                const a = ancestors[i];
                const isDirect = i === ancestors.length - 1;
                crumbs.push({
                  key: a.id,
                  label: a.label,
                  disabled: !isDirect,
                  title: !isDirect ? t("header.ancestorPending") : a.id,
                  onClick: isDirect ? () => emit("Attach", a.id) : undefined,
                });
              }
              crumbs.push({
                key: state.sessionId || "session",
                label: title,
                current: true,
              });
            }
            if (!crumbs.length) {
              return (
                <span
                  className="header-crumb-current"
                  title={state.sessionId ? t("header.renameHint") : ""}
                  onDoubleClick={() =>
                    state.sessionId && emit("OpenRename", state.sessionId)
                  }
                >
                  {title}
                </span>
              );
            }
            return (
              <nav
                aria-label={t("header.breadcrumbs")}
                className="child-breadcrumbs"
              >
                {crumbs.map((c, i) => (
                  <span key={c.key} className="header-crumb-segment">
                    {i > 0 && (
                      <span className="header-crumb-sep" aria-hidden="true">
                        /
                      </span>
                    )}
                    {c.current ? (
                      <span
                        className="header-crumb-current"
                        aria-current="page"
                        title={
                          !inspection && state.sessionId
                            ? t("header.renameHint")
                            : undefined
                        }
                        onDoubleClick={() =>
                          !inspection &&
                          state.sessionId &&
                          emit("OpenRename", state.sessionId)
                        }
                      >
                        {c.label}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="header-crumb-parent"
                        disabled={c.disabled}
                        aria-disabled={c.disabled || undefined}
                        title={c.title}
                        onClick={c.onClick}
                      >
                        {c.label}
                      </button>
                    )}
                  </span>
                ))}
                {inspection && (
                  <span className="child-readonly-badge">
                    {t("header.readonly")}
                  </span>
                )}
              </nav>
            );
          })()}
        </div>
        <div className="header-right-zone">
          {state.authSession?.authenticated && host.projectId && (
            <button
              className="header-capsule-btn"
              data-testid="header-host-connection"
              data-host-state={host.status}
              title={
                (host.matched ? state.hostConnection?.workspace : undefined) ??
                t("header.connectBridge")
              }
              onClick={() =>
                dispatch({
                  type: "OpenRemoteConnectDialog",
                  projectId: host.projectId,
                })
              }
            >
              <span
                className="header-host-state-dot"
                aria-hidden="true"
                data-host-state={host.status}
              />
              {[
                "detached",
                "suspended",
                "catalog_error",
                "project_mismatch",
              ].includes(host.status) && (
                <Icon
                  name="warning"
                  size={12}
                  className="header-host-warn-icon"
                  aria-hidden="true"
                />
              )}
              Host · {hostLabel}
            </button>
          )}
          {current &&
            ["client", "client-local"].includes(current.hostKind ?? "") &&
            (current.workspace?.root ?? current.directory) === "/workspace" &&
            current.clientWorkspace?.source !== "native" &&
            current.hostLease?.status === "vacant" &&
            state.sandboxSession !== current.id && (
              <button
                className="header-capsule-btn"
                title={t("header.sandboxTitle")}
                onClick={() => emit("RestoreSandbox")}
              >
                {current.clientWorkspace?.source === "browser-sandbox"
                  ? t("header.sandboxResume")
                  : t("header.sandboxPick")}
              </button>
            )}
          {current &&
            ["client", "client-local", "client-remote"].includes(
              current.hostKind ?? "",
            ) &&
            current.hostLease?.status !== "held" && (
              <span className="status-chip" title={t("header.offlineTitle")}>
                {current.hostLease?.status === "reconnecting"
                  ? t("header.reconnecting")
                  : t("header.unavailable")}
              </span>
            )}
          {(!!children.length ||
            (state.sessionId &&
              state.capabilities?.methods.includes("session.children"))) && (
            <div className="header-popover-anchor">
              <button
                className={`header-capsule-btn header-subagents-btn${state.showSubagentsMenu ? " active" : ""}`}
                title={t("header.subagentsTitle")}
                aria-label={t("header.subagents", { count: children.length })}
                data-testid="header-subagents"
                aria-expanded={state.showSubagentsMenu}
                onClick={(e) => {
                  e.stopPropagation();
                  emit("ToggleSubagentsMenu");
                }}
              >
                <Icon name="users" className="header-capsule-svg-icon" />
                <span className="header-capsule-text header-subagents-full">
                  {t("header.subagents", { count: children.length })}
                </span>
                <span className="header-subagents-count" aria-hidden="true">
                  {children.length}
                </span>
              </button>
              {state.showSubagentsMenu && (
                <div
                  className="header-popover-menu subagents-menu"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="popover-menu-header">
                    <span>
                      {t("header.subagentsCount", { count: children.length })}
                    </span>
                  </div>
                  <div className="popover-menu-list">
                    {state.childListLoading && (
                      <p role="status">{t("header.subagentsLoading")}</p>
                    )}
                    {state.childListError && (
                      <p role="alert">{state.childListError}</p>
                    )}
                    {!children.length && !state.childListLoading && (
                      <p>{t("header.subagentsEmpty")}</p>
                    )}
                    {children.map((s) => (
                      <div
                        className="subagent-menu-item"
                        key={s.id}
                        title={`${s.title} · ${s.id}`}
                        onClick={() => {
                          emit("CloseDropdowns");
                          emit("OpenSubAgentDetail", s.id);
                        }}
                      >
                        <span
                          className={`subagent-status-dot ${(() => {
                            const kind = childDisplayStatus(s.status);
                            return kind === "succeeded" ? "completed" : kind;
                          })()}`}
                          data-status={childDisplayStatus(s.status)}
                          role="img"
                          aria-label={t(
                            `subagent.status.${childDisplayStatus(s.status)}`,
                          )}
                        />
                        <div className="subagent-menu-item-info">
                          <span className="subagent-item-title">{s.title}</span>
                          <span className="subagent-item-id">
                            {s.id} ·{" "}
                            {t(
                              `subagent.status.${childDisplayStatus(s.status)}`,
                            )}
                          </span>
                        </div>
                        <button
                          className="subagent-detail-link"
                          title={t("header.viewDetails")}
                          onClick={(e) => {
                            e.stopPropagation();
                            emit("CloseDropdowns");
                            emit("OpenSubAgentDetail", s.id);
                          }}
                        >
                          {t("header.details")}
                          <GlyphIcon name="external" />
                        </button>
                      </div>
                    ))}
                    {state.childList?.next_cursor && (
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={state.childListLoading}
                        onClick={() => emit("LoadMoreChildren")}
                      >
                        {t("header.moreSubagents")}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          {!!tools.length && (
            <div className="header-popover-anchor">
              <button
                className={`header-capsule-btn header-running-tools-btn${state.showRunningToolsMenu ? " active" : ""}`}
                title={t("execution.headerTitle")}
                data-testid="header-executions"
                aria-expanded={state.showRunningToolsMenu}
                onClick={(e) => {
                  e.stopPropagation();
                  emit("ToggleRunningToolsMenu");
                }}
              >
                <span className="header-capsule-spinner">
                  <FeatureIcon
                    name={capsuleIcon}
                    size={12}
                    strokeWidth={2.5}
                    className={ticking ? "animate-spin" : undefined}
                  />
                </span>
                <span className="header-capsule-text">
                  {t("execution.headerCount", { count: tools.length })}
                </span>
              </button>
              {state.showRunningToolsMenu && (
                <div
                  className="header-popover-menu running-tools-menu"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="popover-menu-header">
                    <span>
                      {t("execution.headerCount", { count: tools.length })}
                    </span>
                    <button
                      disabled={!running}
                      className="tool-interrupt-btn"
                      title={t("header.interruptAll")}
                      onClick={() => {
                        emit("ToggleRunningToolsMenu");
                        emit("Interrupt");
                      }}
                    >
                      {t("header.interrupt")}
                    </button>
                  </div>
                  <div className="popover-menu-list">
                    {tools.map((execution) => {
                      const ms = executionElapsed(execution);
                      return (
                        <button
                          type="button"
                          className="running-tool-item"
                          key={`${execution.session_id}:${execution.execution_id}`}
                          data-testid={`header-execution-${execution.execution_id}`}
                          data-status={execution.status}
                          title={`${execution.tool} · ${executionStatus(execution)} · #${execution.execution_id}`}
                          aria-label={t("execution.peekTitle", {
                            tool: execution.tool,
                            id: execution.execution_id,
                          })}
                          style={{
                            font: "inherit",
                            color: "inherit",
                            textAlign: "inherit",
                          }}
                          onClick={() => {
                            emit("CloseDropdowns");
                            setPeek(execution);
                          }}
                        >
                          <div className="running-tool-left">
                            <FeatureIcon
                              name={
                                pendingExecution(execution)
                                  ? "spinner"
                                  : TOOL_STATUS_ICON[
                                      toolDisplayStatus(execution.status)
                                    ]
                              }
                              data-status={toolDisplayStatus(execution.status)}
                              size={12}
                              className={
                                pendingExecution(execution) &&
                                execution.elapsed_ms == null
                                  ? "animate-spin"
                                  : undefined
                              }
                            />
                            <div className="running-tool-text-group">
                              <div className="running-tool-name">
                                {execution.tool}
                              </div>
                              <div className="running-tool-summary">
                                {executionStatus(execution)} · #
                                {execution.execution_id}
                              </div>
                            </div>
                          </div>
                          <div className="running-tool-right">
                            <span className="running-tool-time">
                              {ms == null
                                ? t("execution.unknownTime")
                                : `${Math.floor(ms / 1000)}s`}
                            </span>
                            <span
                              className="ghost-btn execution-peek-button"
                              aria-hidden="true"
                            >
                              <FeatureIcon name="external" size={14} />
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          <span
            className="status-chip"
            data-state={status}
            title={state.apiBase}
          >
            {t(`header.state.${status}`)}
          </span>
          <button
            className={`header-right-toggle-btn${rightOpen ? " active" : ""}`}
            title={
              rightOpen
                ? t("header.pluginsCollapse")
                : t("header.pluginsExpand")
            }
            aria-label={
              rightOpen
                ? t("header.pluginsCollapse")
                : t("header.pluginsExpand")
            }
            aria-expanded={rightOpen}
            onClick={() =>
              narrow
                ? emit("SetRightOverlay", !state.rightOverlayOpen)
                : emit("ToggleRightRail")
            }
          >
            <Icon name="plugins" size={18} />
          </button>
        </div>
      </div>
      {state.sessionId && !inspection && (
        <SessionViewTabs
          viewMode={state.viewMode === "trajectory" ? "trajectory" : "chat"}
          plugins={sessionTabPlugins(
            clientPlugins.registry?.getSnapshot() ?? [],
            (id) =>
              clientPlugins.registry?.isEnabled(id, state.sessionId) ?? false,
          ).map((p) => p.manifest)}
          selectedPlugin={selectedSessionPlugin(
            state.sessionPluginTab,
            state.sessionId,
            sessionTabPlugins(
              clientPlugins.registry?.getSnapshot() ?? [],
              (id) =>
                clientPlugins.registry?.isEnabled(id, state.sessionId) ?? false,
            ),
          )}
          onSelectPlugin={(id) => emit("SelectPluginTab", id)}
          onSelect={(mode) => emit("SelectViewTab", mode)}
        />
      )}
      {peek && peek.session_id === state.sessionId && (
        <ExecutionPeek execution={peek} onClose={() => setPeek(null)} />
      )}
    </header>
  );
}
