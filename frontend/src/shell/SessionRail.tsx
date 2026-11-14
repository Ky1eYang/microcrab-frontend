import {
  isConversation,
  projectIdentity,
  sessionProject,
  UNKNOWN_PROJECT,
} from "../client/projects";
import { useEffect, useRef, useState } from "react";
import type { SessionView } from "../client/types";
import { useAppFields, sessionActiveTime } from "../state";
import { Icon } from "./Icon";
import { t } from "../i18n";
import { hostReason } from "../features/popups/RemoteConnectDialog";
import { UserCard } from "./UserCard";
import { GlyphIcon } from "../features/shared";
import { focusFirst, trapFocus, useNarrowViewport } from "../client/viewport";

const label = (s: SessionView) => s.title.trim() || s.id;
const basename = (path: string) =>
  path.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() || path;
function relativeTime(time?: number | null) {
  const seconds = Math.max(0, (Date.now() - (time ?? Date.now())) / 1000);
  return seconds < 60
    ? "now"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h`
        : `${Math.floor(seconds / 86400)}d`;
}

function SessionRow({
  session,
  onPick,
}: {
  session: SessionView;
  onPick?: () => void;
}) {
  const { state, dispatch } = useAppFields([
    "authSession",
    "capabilities",
    "compactInflight",
    "connection",
    "forkPending",
    "forkUnknown",
    "isCreatingSession",
    "menuSession",
    "modelSelectionPending",
    "resolvedLocale",
    "sessionAttachingId",
    "sessionId",
    "transcript",
  ]);
  const active = state.sessionId === session.id;
  const loading = state.sessionAttachingId === session.id;
  const busy = active
    ? state.transcript.sessionStatus === "busy"
    : session.status === "busy";
  const menu = state.menuSession === session.id;
  const canFork =
    active &&
    !session.parentID &&
    !session.archived &&
    state.connection === "ws" &&
    !!state.authSession?.authenticated &&
    state.transcript.sessionStatus === "idle" &&
    state.capabilities?.methods.includes("session.fork") === true &&
    !state.forkPending &&
    !state.forkUnknown?.[session.id] &&
    !state.isCreatingSession &&
    !state.compactInflight &&
    !state.modelSelectionPending;
  const act = (type: string) => dispatch({ type, value: session.id });
  return (
    <div
      className="session-item-row"
      data-testid="session-item"
      data-active={active}
      data-loading={loading}
      aria-busy={loading}
      data-menu-open={menu}
      onClick={() => {
        if (session.reachable === false)
          dispatch({
            type: "WarnUnreachableWorkspace",
            value: session.directory || label(session),
          });
        act("Attach");
        onPick?.();
      }}
    >
      <span className="session-status-slot">
        {loading ? (
          <span className="session-status-spinner" title={t("session.opening")}>
            <Icon
              name="spinner"
              className="animate-spin"
              size={12}
              strokeWidth={2.5}
              aria-hidden="true"
            />
          </span>
        ) : session.reachable === false ? (
          <span
            className="session-status-unreachable"
            data-testid="session-status-unreachable"
            role="img"
            aria-label={t("rail.workspaceOffline")}
            title={t("rail.workspaceOffline")}
          >
            <Icon name="warning" size={12} aria-hidden="true" />
          </span>
        ) : busy ? (
          <span className="session-status-spinner" title={t("rail.generating")}>
            <Icon
              name="spinner"
              className="animate-spin"
              size={12}
              strokeWidth={2.5}
            />
          </span>
        ) : (
          active && (
            <span className="session-status-dot" title={t("rail.active")} />
          )
        )}
      </span>
      <span
        className="session-item-title"
        title={label(session)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          act("OpenRename");
        }}
      >
        {label(session)}
      </span>
      <span className="session-item-time">
        {relativeTime(session.time?.updated)}
      </span>
      <div className="session-item-actions">
        <button
          className="session-action-icon-btn session-action-delete"
          title={t("rail.deleteSession")}
          aria-label={t("rail.deleteSession")}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            act("OpenDelete");
          }}
        >
          <Icon name="trash" size={13} />
        </button>
        <button
          className="session-action-icon-btn session-action-more"
          title={t("rail.moreActions")}
          type="button"
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={(e) => {
            e.stopPropagation();
            act("OpenMenu");
          }}
        >
          ⋮
        </button>
      </div>
      {menu && (
        <div className="session-menu" onClick={(e) => e.stopPropagation()}>
          <button
            className="session-menu-item"
            onClick={() => act("OpenRename")}
          >
            <Icon name="edit" size={14} />
            <span>{t("rail.rename")}</span>
          </button>
          <button
            className="session-menu-item"
            title={
              state.forkUnknown?.[session.id]
                ? t("rail.forkUnknown")
                : canFork
                  ? t("rail.forkHint")
                  : t("rail.forkUnavailable")
            }
            disabled={!canFork}
            onClick={() => act("ForkSession")}
          >
            <Icon name="compact" size={14} />
            <span>{t("rail.fork")}</span>
          </button>
          <button
            className="session-menu-item"
            onClick={() => act("OpenCompact")}
          >
            <Icon name="compact" size={14} />
            <span>{t("rail.compact")}</span>
          </button>
          <button
            className="session-menu-item"
            onClick={() => act("OpenArchive")}
          >
            <Icon name="layers" size={14} />
            <span>{t("sessionRail.archive")}</span>
          </button>
          <button
            className="session-menu-item danger-item"
            onClick={() => act("OpenDelete")}
          >
            <Icon name="trash" size={14} />
            <span>{t("rail.deleteSession")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function SessionRail() {
  const { state, dispatch } = useAppFields([
    "capabilities",
    "conversationIds",
    "filter",
    "hostConnection",
    "knownProjects",
    "menuProject",
    "menuSession",
    "page",
    "railCollapsed",
    "resolvedLocale",
    "sessionId",
    "sessions",
  ]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expandedMore, setExpandedMore] = useState<Set<string>>(new Set());
  const emit = (type: string, value?: unknown) => dispatch({ type, value });
  const narrow = useNarrowViewport();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawer = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const drawerActive = narrow && drawerOpen;
  const closeDrawer = () => {
    setDrawerOpen(false);
    trigger.current?.focus();
  };
  // Closing the drawer by any path (backdrop, Esc, navigation, widening) also
  // closes its rail menus, so their click-outside backdrop never outlives it.
  const wasDrawer = useRef(drawerActive);
  useEffect(() => {
    if (wasDrawer.current && !drawerActive) {
      if (state.menuSession) emit("CloseMenu");
      if (state.menuProject) emit("CloseProjectMenu");
    }
    wasDrawer.current = drawerActive;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerActive]);
  // Narrow layout: picking any session (including the open one) closes the drawer.
  const pickSession = () => {
    if (drawerActive) closeDrawer();
  };
  // Narrow layout: the drawer closes after navigation (session, page change).
  const navKey = `${state.page}:${state.sessionId ?? ""}`;
  const lastNav = useRef(navKey);
  useEffect(() => {
    if (lastNav.current === navKey) return;
    lastNav.current = navKey;
    if (drawerActive) closeDrawer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navKey]);
  useEffect(() => {
    if (!narrow) setDrawerOpen(false);
  }, [narrow]);
  useEffect(() => {
    if (!drawerActive) return;
    focusFirst(drawer.current);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
        return;
      }
      trapFocus(drawer.current, event);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerActive]);
  const toggleRail = () => {
    if (narrow) {
      if (drawerOpen) closeDrawer();
      else setDrawerOpen(true);
    } else emit("ToggleRail");
  };
  const collapsedRail = (
    <nav
      className="session-rail collapsed-rail"
      aria-label={t("rail.collapsedLabel")}
      data-testid="session-rail"
      data-collapsed="true"
    >
      <div className="rail-top-actions">
        <button
          ref={trigger}
          className="rail-icon-btn"
          title={t("rail.expand")}
          aria-label={t("rail.expand")}
          aria-expanded={narrow ? drawerOpen : false}
          onClick={toggleRail}
        >
          <Icon name="sidebar" size={18} />
        </button>
        <button
          className="rail-icon-btn primary-icon-btn"
          title={t("rail.newConversation")}
          aria-label={t("rail.newConversation")}
          onClick={() => emit("NewChat")}
        >
          <Icon name="plus" size={18} />
        </button>
        <button
          className="rail-icon-btn"
          data-active={state.page === "dashboard"}
          title={t("rail.dashboard")}
          aria-label={t("rail.dashboard")}
          onClick={() => emit("OpenDashboard")}
        >
          <Icon name="dashboard" size={18} />
        </button>
        <button
          className="rail-icon-btn"
          title={t("rail.search")}
          aria-label={t("rail.search")}
          onClick={() => emit("OpenSearch")}
        >
          <Icon name="search" size={18} />
        </button>
      </div>
      <div className="rail-bottom-actions">
        <UserCard compact />
      </div>
    </nav>
  );
  const groups = new Map<string, SessionView[]>();
  for (const p of state.knownProjects) {
    const key = projectIdentity(p);
    if (key !== UNKNOWN_PROJECT) groups.set(key, []);
  }
  const conversations: SessionView[] = [];
  const sessions = state.sessions.filter(
    (s) =>
      !s.parentID &&
      (!state.filter ||
        label(s).toLowerCase().includes(state.filter.toLowerCase())),
  );
  for (const session of sessions) {
    if (
      isConversation(session, state.conversationIds) ||
      !groups.has(sessionProject(session))
    )
      conversations.push(session);
    else {
      const normalized = sessionProject(session);
      groups.set(normalized, [...(groups.get(normalized) || []), session]);
    }
  }
  const expandedRail = (
    <nav
      ref={drawer}
      className={`session-rail expanded-rail${drawerActive ? " rail-drawer" : ""}`}
      aria-label={t("rail.sessions")}
      data-testid="session-rail"
      data-collapsed="false"
      {...(drawerActive
        ? { role: "dialog", "aria-modal": true, tabIndex: -1 }
        : {})}
    >
      <div className="session-rail-header">
        <div className="rail-header-brand">
          <span className="rail-brand">microcrab</span>
        </div>
        <div className="rail-header-tools">
          <button
            className="rail-tool-btn"
            title={t("rail.collapse")}
            aria-label={t("rail.collapse")}
            onClick={toggleRail}
          >
            <Icon name="sidebar" />
          </button>
        </div>
      </div>
      <div className="rail-new-chat-container">
        <button
          className="session-rail-new-btn"
          data-active={state.page === "home"}
          onClick={() => emit("NewChat")}
        >
          <Icon name="plus" />
          <span>{t("rail.newConversation")}</span>
        </button>
      </div>
      <div className="session-rail-subnav">
        <button
          className="subnav-item-btn"
          data-active={state.page === "dashboard"}
          title={t("rail.dashboard")}
          onClick={() => emit("OpenDashboard")}
        >
          <Icon name="dashboard" size={15} />
          <span>{t("rail.dashboard")}</span>
        </button>
        <button
          className="subnav-item-btn"
          title={t("rail.history")}
          onClick={() => emit("OpenSearch")}
        >
          <Icon name="history" size={15} />
          <span>{t("rail.history")}</span>
        </button>
      </div>
      <div className="session-rail-scroll-content">
        {!!groups.size && (
          <div className="rail-section-group">
            <div className="rail-section-header-row">
              <span className="rail-section-title">{t("rail.projects")}</span>
            </div>
            {[...groups]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([id, groupRows]) => {
                const rows = [...groupRows].sort(
                  (a, b) =>
                    sessionActiveTime(b as any) - sessionActiveTime(a as any),
                );
                const project = state.knownProjects.find(
                  (p) => projectIdentity(p) === id,
                );
                const path =
                  project?.path ??
                  rows[0]?.workspace?.root ??
                  rows[0]?.directory ??
                  project?.workspace ??
                  project?.id ??
                  id;
                const open = !collapsed.has(id),
                  showAll = expandedMore.has(id),
                  menu = state.menuProject === id,
                  name =
                    id === UNKNOWN_PROJECT
                      ? "Unknown Project"
                      : (project?.name ?? basename(path));
                return (
                  <div className="rail-project-folder" key={id}>
                    <div
                      className="rail-project-row"
                      data-menu-open={menu}
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          next.has(id) ? next.delete(id) : next.add(id);
                          return next;
                        })
                      }
                    >
                      <span className="rail-icon-slot">
                        <Icon
                          className="rail-project-folder-icon"
                          name="folder"
                          size={14}
                        />
                        <Icon
                          className={`rail-project-chevron${open ? " expanded" : ""}`}
                          name="chevron"
                          size={12}
                          strokeWidth={2.5}
                        />
                      </span>
                      <span className="rail-project-title" title={name}>
                        {name}
                      </span>
                      {(project?.host_connected === false ||
                        project?.status === "offline" ||
                        (!!rows.length &&
                          rows.every((s) => s.reachable === false))) && (
                        <button
                          type="button"
                          className="project-host-warn"
                          data-testid="project-host-warn"
                          aria-label={t("rail.hostOffline")}
                          title={(() => {
                            const conn = state.hostConnection;
                            const reason =
                              project && conn && conn.projectId === project.id
                                ? conn.reason
                                : undefined;
                            return reason
                              ? (hostReason[reason] ?? reason)
                              : t("rail.hostOffline");
                          })()}
                          onClick={(e) => {
                            e.stopPropagation();
                            // Same as the project menu: open the dialog without
                            // resumeProject side effects from SelectKnownProject.
                            dispatch({
                              type: "OpenRemoteConnectDialog",
                              projectId: id,
                            });
                          }}
                        >
                          <Icon name="warning" size={14} aria-hidden="true" />
                        </button>
                      )}
                      <div
                        className="rail-project-actions"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          className="rail-project-btn rail-project-more-btn"
                          title={t("rail.moreActions")}
                          type="button"
                          aria-haspopup="menu"
                          aria-expanded={menu}
                          onClick={() =>
                            emit(
                              menu ? "CloseProjectMenu" : "OpenProjectMenu",
                              id,
                            )
                          }
                        >
                          ⋮
                        </button>
                        <button
                          className="rail-project-btn rail-project-add-btn"
                          title={t("rail.newInProject", { name })}
                          disabled={id === UNKNOWN_PROJECT}
                          type="button"
                          onClick={() => emit("CreateSessionInProject", id)}
                        >
                          +
                        </button>
                      </div>
                      {menu && (
                        <div
                          className="session-menu project-menu"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            className="session-menu-item"
                            data-testid="project-menu-settings"
                            disabled={id === UNKNOWN_PROJECT}
                            title={
                              id === UNKNOWN_PROJECT
                                ? t("project.menu.settingsDisabled")
                                : undefined
                            }
                            onClick={() => {
                              emit("CloseProjectMenu");
                              dispatch({
                                type: "OpenProjectSettings",
                                value: id,
                              });
                            }}
                          >
                            <Icon name="settings" size={14} />
                            <span>{t("project.menu.settings")}</span>
                          </button>
                          <button
                            className="session-menu-item"
                            onClick={() => {
                              emit("CloseProjectMenu");
                              dispatch({
                                type: "OpenRemoteConnectDialog",
                                projectId: id,
                              });
                            }}
                          >
                            <Icon name="check" size={14} />
                            <span>{t("rail.connectHost")}</span>
                          </button>
                          <button
                            className="session-menu-item"
                            disabled={id === UNKNOWN_PROJECT}
                            onClick={() => emit("RenameProjectGroup", id)}
                          >
                            <Icon name="edit" size={14} />
                            <span>{t("rail.renameProject")}</span>
                          </button>
                          <button
                            className="session-menu-item"
                            onClick={() => emit("CreateSessionInProject", id)}
                            disabled={id === UNKNOWN_PROJECT}
                          >
                            <Icon name="plus" size={14} />
                            <span>{t("rail.newSessionHere")}</span>
                          </button>
                          <button
                            className="session-menu-item"
                            disabled={id === UNKNOWN_PROJECT}
                            onClick={() => {
                              void navigator.clipboard
                                .writeText(path)
                                .catch(() =>
                                  dispatch({
                                    type: "WarnUnreachableWorkspace",
                                    value: t("rail.clipboardUnavailable"),
                                  }),
                                );
                              emit("CloseProjectMenu");
                            }}
                          >
                            <Icon name="copy" size={14} />
                            <span>{t("rail.copyPath")}</span>
                          </button>
                          <div className="dropdown-divider" />
                          <button
                            className="session-menu-item danger-item"
                            disabled={
                              id === UNKNOWN_PROJECT ||
                              !state.capabilities?.methods.includes(
                                "project.delete",
                              )
                            }
                            title={t("sessionRail.deleteProject")}
                            onClick={() => emit("DeleteProjectGroup", id)}
                          >
                            <Icon name="trash" size={14} />
                            <span>{t("rail.deleteProject")}</span>
                          </button>
                        </div>
                      )}
                    </div>
                    {open && (
                      <div className="rail-project-nested-sessions">
                        {!rows.length ? (
                          <div className="rail-project-empty-hint">
                            {t("rail.noSessions")}
                          </div>
                        ) : (
                          (showAll ? rows : rows.slice(0, 3)).map((s) => (
                            <SessionRow
                              key={s.id}
                              session={s}
                              onPick={pickSession}
                            />
                          ))
                        )}
                        {rows.length > 3 && !showAll && (
                          <button
                            className="project-expand-more-btn"
                            type="button"
                            onClick={() =>
                              setExpandedMore((prev) => new Set([...prev, id]))
                            }
                          >
                            <span>
                              {t("rail.showMore", { count: rows.length - 3 })}
                            </span>
                            <GlyphIcon
                              name="chevron"
                              dir="down"
                              className="chevron-down"
                            />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}
        <div className="rail-section-group">
          <div className="rail-section-header-row">
            <span className="rail-section-title">
              {t("rail.conversations")}
            </span>
            <div className="rail-section-header-actions">
              <button
                className="rail-sec-action-btn"
                title={t("rail.newDefault")}
                data-testid="sessions-new-chat"
                onClick={() => emit("NewBrowserChat")}
              >
                <Icon name="plus" size={13} />
              </button>
            </div>
          </div>
          <div className="rail-conversations-list">
            {conversations.length ? (
              [...conversations]
                .sort(
                  (a, b) =>
                    sessionActiveTime(b as any) - sessionActiveTime(a as any),
                )
                .map((s) => (
                  <SessionRow key={s.id} session={s} onPick={pickSession} />
                ))
            ) : (
              <div className="rail-empty-hint">{t("rail.noOrdinary")}</div>
            )}
          </div>
        </div>
      </div>
      <div className="session-rail-footer">
        <UserCard />
      </div>
    </nav>
  );
  if (narrow)
    return (
      <>
        {collapsedRail}
        {drawerOpen && (
          <>
            <div
              className="rail-drawer-backdrop"
              data-testid="rail-drawer-backdrop"
              aria-hidden="true"
              onClick={closeDrawer}
            />
            {expandedRail}
          </>
        )}
      </>
    );
  return state.railCollapsed ? collapsedRail : expandedRail;
}
