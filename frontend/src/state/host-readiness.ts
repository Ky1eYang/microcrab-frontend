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
  const hostFlavor = state.sessionId
    ? state.sessions.find((session) => session.id === state.sessionId)
        ?.hostFlavor
    : state.draftWorkspace.kind === "chat_only" ||
        state.draftWorkspace.kind === "browser_sandbox"
      ? state.draftWorkspace.kind
      : undefined;
  const conversationId =
    !projectId &&
    (state.sessionId || (hostFlavor ? connection?.conversationId : undefined));
  const matched = projectId
    ? connection?.projectId === projectId
    : !!hostFlavor &&
      !!conversationId &&
      connection?.conversationId === conversationId &&
      connection?.hostFlavor === hostFlavor;
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
  return { projectId, hostFlavor, matched, status, ready: status === "ready" };
}
