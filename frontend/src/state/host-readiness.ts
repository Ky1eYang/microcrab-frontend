import type { AppState, NativeHostState } from "../client/types";

/** Preserve the exact public cause; transport connection alone does not imply progress. */
export function hostStatePatch(view: NativeHostState) {
  const readiness = view.readiness;
  const connected = readiness?.connected ?? view.connected;
  const ready = readiness?.ready ?? view.ready;
  const reconciling = readiness?.reconciling ?? view.reconciling ?? false;
  const cause = readiness
    ? readiness.cause
    : (view.reconciliation_error ?? null);
  return {
    readiness,
    connected,
    state: ready
      ? "ready"
      : connected
        ? reconciling
          ? "reconciling"
          : "unready"
        : "suspended",
    cause,
    reason: cause?.code,
  };
}

/** Existing sessions keep their pinned Project; a new conversation uses its draft Project. */
export function selectedProjectId(state: AppState): string | undefined {
  return state.sessionId
    ? state.sessions.find((session) => session.id === state.sessionId)
        ?.projectID || undefined
    : state.draftWorkspace.projectId;
}

/** Project-scoped execution readiness includes the Host transport and its component catalog. */
export function hostReadiness(
  state: AppState,
  projectId = selectedProjectId(state),
) {
  const connection = state.hostConnection;
  const conversationId =
    !projectId &&
    (state.sessionId ||
      (state.draftWorkspace.kind === "none"
        ? connection?.conversationId
        : undefined));
  const matched = projectId
    ? connection?.projectId === projectId
    : !!conversationId && connection?.conversationId === conversationId;
  const status =
    !connection || !matched
      ? projectId && connection?.projectId && connection.state !== "detached"
        ? "project_mismatch"
        : "detached"
      : connection.state !== "ready"
        ? connection.state
        : connection.connected === false
          ? "suspended"
          : connection.restoringSession === true
            ? "loading_catalog"
            : connection.catalogReady === true
              ? "ready"
              : connection.catalogError
                ? "catalog_error"
                : "loading_catalog";
  return { projectId, matched, status, ready: status === "ready" };
}
