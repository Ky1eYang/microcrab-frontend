import type { DraftWorkspace, SessionView } from "../../../client/types";
import { sessionActiveTime } from "../../../state/model";

export type RecentScope = "current" | "all";
export const RECENT_LIMIT = 6;
const KEY = "microcrab.recent-sessions-scope.v1:";

/** Local browser preference only: not per project, not server, not URL. */
export function readRecentScope(ownerScope: string): RecentScope {
  try {
    return localStorage.getItem(KEY + ownerScope) === "all" ? "all" : "current";
  } catch {
    return "current";
  }
}

export function writeRecentScope(ownerScope: string, scope: RecentScope) {
  try {
    localStorage.setItem(KEY + ownerScope, scope);
  } catch {
    /* Storage may be unavailable; the in-memory choice still applies. */
  }
}

/** Does this session belong to the workspace currently picked on New chat? */
export function inCurrentWorkspace(
  session: SessionView,
  workspace: DraftWorkspace,
) {
  if (workspace.projectId) return session.projectID === workspace.projectId;
  if (workspace.kind === "chat_only" || workspace.kind === "browser_sandbox")
    return (
      !session.projectID &&
      (session.hostFlavor ?? "chat_only") === workspace.kind
    );
  return false;
}

/** Unarchived top-level sessions, newest activity first, at most six. */
export function recentSessions(
  sessions: readonly SessionView[],
  scope: RecentScope,
  workspace: DraftWorkspace,
  limit = RECENT_LIMIT,
) {
  return sessions
    .filter(
      (session) =>
        !session.parentID &&
        !session.archived &&
        (scope === "all" || inCurrentWorkspace(session, workspace)),
    )
    .sort((a, b) => sessionActiveTime(b) - sessionActiveTime(a))
    .slice(0, limit);
}

export function shortRelativeTime(time: number, now = Date.now()) {
  const seconds = Math.max(0, (now - time) / 1000);
  return seconds < 60
    ? "now"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h`
        : `${Math.floor(seconds / 86400)}d`;
}
