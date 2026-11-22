import type { ObservedHostDescriptor } from "../client/host";
import type { AppState, NativeHostState, NativeProject } from "../client/types";
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
    if (connection.observeRoute || connection.connected || ["ready", "reconciling"].includes(connection.state)) return;
  }
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  const scope = hostPreferenceScope(state.apiBase, state.authSession);
  return peekHostQuarantine(scope, projectId, hostLocator(scope, project), project.root || ".")?.code;
}


/** Preserve the exact public cause; transport connection alone does not imply progress. */
export function hostStatePatch(view: NativeHostState) {
  const readiness = view.readiness ?? undefined;
  const { connected, ready, reconciling } = view;
  const cause = readiness
    ? readiness.cause
    : (view.reconciliation_error ?? null);
  return {
    readiness,
    connected,
    state: connected && ready && !reconciling
      ? "ready"
      : connected
        ? reconciling
          ? "reconciling"
          : "unready"
        : view.carrier_mode === "detached" ? "detached" : "suspended",
    cause,
    reason: cause?.code,
  };
}

/** Validate authority-bearing fields, but accept the historical GET shape. A
 * legacy connected route cannot identify a peer relay or establish ownership. */
export function projectHostSnapshot(view: NativeHostState, projectId: string, project?: NativeProject) {
  const invalid = () => { throw Error("Invalid Server Host state for the selected Project"); };
  if (!view || (view.project_id !== undefined && view.project_id !== projectId) ||
      typeof view.connected !== "boolean" || typeof view.ready !== "boolean" ||
      (view.reconciling !== undefined && typeof view.reconciling !== "boolean") ||
      (view.ready && !view.connected)) invalid();
  const carrier = view.carrier_mode;
  const generation = view.connection_generation !== undefined
    ? view.connection_generation : view.readiness?.connection_generation;
  if (generation !== undefined && generation !== null &&
      (typeof generation !== "string" || !generation)) invalid();
  const native = carrier === "server_direct_grpc" || carrier === "server_direct_outbound" || carrier === "browser_relay";
  let descriptor: ObservedHostDescriptor | undefined;
  if (carrier !== undefined) {
    if ((!native && carrier !== "detached" && carrier !== "embedded") ||
        typeof view.reconciling !== "boolean" || view.connection_generation === undefined ||
        (native && !generation) || (carrier === "embedded" && generation !== null) ||
        (carrier === "detached" && (view.connected || view.reconciling)) ||
        (view.readiness && view.readiness.connection_generation !== generation)) invalid();
    if (native && view.connected) {
      const value = view.descriptor;
      if (!value || !value.host_id || !value.workspace_id ||
          typeof value.host_id !== "string" || typeof value.workspace_id !== "string" ||
          typeof value.workspace_root !== "string" || typeof value.platform !== "string" ||
          !Array.isArray(value.tool_capabilities) || !value.tool_capabilities.every((item) => typeof item === "string") ||
          !Array.isArray(value.supported_primitives) || !value.supported_primitives.every((item) => typeof item === "string") ||
          (project?.host_id && project.host_id !== value.host_id) ||
          (project?.workspace_id && project.workspace_id !== value.workspace_id))
        throw Error("Server Host descriptor does not match the selected Project");
      const { host_id, workspace_id, workspace_root, platform, tool_capabilities, supported_primitives } = value;
      descriptor = { host_id, workspace_id, workspace_root, platform, tool_capabilities, supported_primitives };
    }
  }
  return {
    ...hostStatePatch(view), carrier, generation, descriptor,
    detached: !generation && (carrier === "detached" ||
      (carrier === undefined && !view.connected && !view.reconciling)),
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
