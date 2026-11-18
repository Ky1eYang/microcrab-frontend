import type { AppState, NativeHostState } from "../client/types";
import { hostLocator, hostPreferenceScope } from "../client/host-locators";
import { hostTerminalCode, peekHostQuarantine } from "../client/host-quarantine";

/** Terminal hints belong to one candidate of one owner Project, never its Host group. */
export function projectHostTerminal(
  state: Pick<AppState, "hostConnection" | "projects" | "apiBase" | "authSession">,
  projectId: string | undefined,
) {
  if (!projectId) return;
  const connection = state.hostConnection;
  if (connection?.projectId === projectId) {
    if (["connecting", "pairing"].includes(connection.state)) return;
    const code = connection.cause?.code ?? connection.reason;
    if (hostTerminalCode(code)) return code;
    if (["ready", "reconciling"].includes(connection.state)) return;
  }
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  const scope = hostPreferenceScope(state.apiBase, state.authSession);
  return peekHostQuarantine(scope, projectId, hostLocator(scope, project), project.root || ".")?.code;
}


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
  const status = projectHostTerminal(state, projectId) ?? (
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
                : "loading_catalog"
  );
  return { projectId, hostFlavor, matched, status, ready: status === "ready" };
}
