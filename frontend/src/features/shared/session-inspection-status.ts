import type { AppState } from "../../client/types";

/** A status explanation never stands in for an authenticated inspection scope. */
export function sessionInspectionStatus(
  state: AppState,
  sessionId: string | null,
) {
  if (
    !state.authSession?.authenticated ||
    !state.authSession.principal?.owner ||
    state.authRequired ||
    state.page !== "conversation" ||
    state.popup?.type === "subagentDetail" ||
    state.sessionId !== sessionId
  )
    return undefined;
  if (state.sessionAttachingId) return "session.opening";
  if (!sessionId) return undefined;
  if (state.historyMutationPending) return "session.transport.restoring";
  const recovery = state.sessionTransportRecovery;
  return recovery ? `session.transport.${recovery}` : undefined;
}
