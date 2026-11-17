import { useState } from "react";
import { useAppFields, workspaceLabel } from "../../../state";
import { sessionActiveTime } from "../../../state/model";
import { hostPreferenceScope } from "../../../client/host-locators";
import type { SessionView } from "../../../client/types";
import { t } from "../../../i18n";
import "../../../styles/recent-sessions.css";
import { Icon } from "../../../shell/Icon";
import {
  readRecentScope,
  recentSessions,
  shortRelativeTime,
  writeRecentScope,
  type RecentScope,
} from "./recent";

/** New-chat C1: recent session cards under the composer, scoped to the
 * current project by default with a local "This project | All projects"
 * preference. Status marks only generating and faulted. */
export function RecentSessions() {
  const { state, dispatch } = useAppFields([
    "sessions",
    "projects",
    "draftWorkspace",
    "apiBase",
    "authSession",
    "resolvedLocale",
  ]);
  const ownerScope =
    hostPreferenceScope(state.apiBase, state.authSession) ??
    JSON.stringify([state.apiBase]);
  const [chosen, setChosen] = useState<{ owner: string; scope: RecentScope }>(
    () => ({ owner: ownerScope, scope: readRecentScope(ownerScope) }),
  );
  const scope =
    chosen.owner === ownerScope ? chosen.scope : readRecentScope(ownerScope);
  const choose = (next: RecentScope) => {
    writeRecentScope(ownerScope, next);
    setChosen({ owner: ownerScope, scope: next });
  };
  const items = recentSessions(state.sessions, scope, state.draftWorkspace);
  const projectName = (id: string | null | undefined) => {
    if (!id) return null;
    const project = state.projects.find((item) => item.id === id);
    return project ? project.name || project.root : null;
  };
  const projectRoot = (id: string | null | undefined) =>
    state.projects.find((item) => item.id === id)?.root;
  const current =
    projectName(state.draftWorkspace.projectId) ??
    workspaceLabel(state.draftWorkspace);
  const scopeLabel = scope === "all" ? t("home.recent.scopeAll") : current;
  // Nothing to recall anywhere: keep New chat quiet.
  if (!recentSessions(state.sessions, "all", state.draftWorkspace, 1).length)
    return null;
  const open = (session: SessionView) => {
    if (session.reachable === false)
      dispatch({
        type: "WarnUnreachableWorkspace",
        value: session.directory || session.title || session.id,
      });
    dispatch({ type: "Attach", value: session.id });
  };
  return (
    <section
      className="recent-sessions"
      data-testid="recent-sessions"
      data-scope={scope}
      aria-labelledby="recent-sessions-title"
    >
      <div className="recent-sessions-head">
        <h2 className="recent-sessions-title" id="recent-sessions-title">
          <span>{t("home.recent.title")}</span>
          <span className="recent-sessions-sep" aria-hidden="true">
            ·
          </span>
          <span className="recent-sessions-scope-name" title={scopeLabel}>
            {scopeLabel}
          </span>
        </h2>
        <div
          className="recent-sessions-switch"
          role="group"
          aria-label={t("home.recent.title")}
        >
          {(["current", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              data-testid={`recent-scope-${value}`}
              aria-pressed={scope === value}
              onClick={() => choose(value)}
            >
              {t(
                value === "current"
                  ? "home.recent.scopeCurrent"
                  : "home.recent.scopeAll",
              )}
            </button>
          ))}
        </div>
      </div>
      {items.length ? (
        <ul className="recent-sessions-grid">
          {items.map((session) => {
            const title = session.title.trim() || session.id;
            const project = projectName(session.projectID);
            const status =
              session.status === "busy"
                ? "running"
                : session.status === "faulted"
                  ? "faulted"
                  : null;
            const time = sessionActiveTime(session);
            return (
              <li key={session.id}>
                <button
                  type="button"
                  className="recent-session-card"
                  data-testid="recent-session-card"
                  data-session-id={session.id}
                  data-status={status ?? undefined}
                  title={title}
                  onClick={() => open(session)}
                >
                  <span className="recent-session-top">
                    <span className="recent-session-mark" aria-hidden={!status}>
                      {status === "running" ? (
                        <Icon
                          name="spinner"
                          size={12}
                          className="animate-spin"
                          aria-label={t("rail.generating")}
                        />
                      ) : status === "faulted" ? (
                        <span
                          className="recent-session-dot"
                          role="img"
                          aria-label={t("home.recent.faulted")}
                        />
                      ) : null}
                    </span>
                    <span className="recent-session-title">{title}</span>
                  </span>
                  <span className="recent-session-meta">
                    {scope === "all" && project && (
                      <span
                        className="recent-session-project"
                        title={[project, projectRoot(session.projectID)]
                          .filter(Boolean)
                          .join("\n")}
                      >
                        <Icon name="folder" size={12} aria-hidden="true" />
                        <span>{project}</span>
                      </span>
                    )}
                    {time > 0 && (
                      <time
                        className="recent-session-time"
                        dateTime={new Date(time).toISOString()}
                      >
                        {shortRelativeTime(time)}
                      </time>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div
          className="recent-sessions-empty"
          data-testid="recent-sessions-empty"
        >
          <p>{t("home.recent.empty")}</p>
          <button
            type="button"
            className="ghost-btn"
            data-testid="recent-view-all"
            onClick={() => choose("all")}
          >
            {t("home.recent.viewAll")}
          </button>
        </div>
      )}
    </section>
  );
}
