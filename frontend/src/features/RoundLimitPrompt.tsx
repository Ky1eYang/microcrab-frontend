import { useState } from "react";
import type { ClientBinding } from "../client/client-tool-controller";
import { useApp } from "../state";
import { t } from "../i18n";
import type { RoundLimitRequestView } from "../client/types";

// Context checkpoints travel as bytes; only this presentation converts them.
function mib(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function labels(request: RoundLimitRequestView) {
  switch (request.kind) {
    case "tool_calls":
      return {
        heading: "roundLimit.toolCalls.heading",
        description: "roundLimit.toolCalls.description",
        continueLabel: "roundLimit.toolCalls.continue",
      };
    case "context_bytes":
      return {
        heading: "roundLimit.context.heading",
        description: "roundLimit.context.description",
        continueLabel: "roundLimit.context.continue",
      };
    default:
      return {
        heading: "roundLimit.heading",
        description: "roundLimit.description",
        continueLabel: "roundLimit.continue",
      };
  }
}

export function InteractionParticipation() {
  const { state, dispatch } = useApp();
  const [takingOver, setTakingOver] = useState(false);
  const binding = state.clientTools as ClientBinding | null;
  const participant = state.connection === "ws" && binding?.role === "participant" && binding.can_interact === true;
  const hostParticipant = state.hostConnection?.browserParticipant &&
    state.hostConnection.conversationId === state.sessionId && state.hostConnection.hostFlavor === "browser_sandbox";
  const takeover = async (type: string) => {
    if (takingOver) return;
    setTakingOver(true);
    try { await dispatch({ type }); } finally { setTakingOver(false); }
  };
  if (!participant && !hostParticipant) return null;
  return (
    <div className="composer-stack inline-notice" data-testid="interaction-participant">
      <p>{t("interaction.participant")}</p>
      <div className="settings-actions-row">
        {participant && <button type="button" className="ghost-btn"
          disabled={takingOver || state.transcript.sessionStatus !== "idle"}
          onClick={() => void takeover("TakeOverClientTools")}>{t("interaction.takeoverExecutor")}</button>}
        {hostParticipant && <button type="button" className="ghost-btn"
          disabled={takingOver || state.transcript.sessionStatus !== "idle"}
          onClick={() => void takeover("TakeOverBrowserHost")}>{t("interaction.takeoverHost")}</button>}
      </div>
    </div>
  );
}

export function RoundLimitPrompt() {
  const { state, dispatch } = useApp();
  return (
    <>
      {state.roundLimitRequests?.map((request) => {
        const copy = labels(request);
        const bytes = request.kind === "context_bytes";
        const used = bytes ? mib(request.used) : request.used;
        const block = bytes ? mib(request.block) : request.block;
        return (
          <article
            className="flow-card"
            key={request.request_id}
            data-testid="round-limit-request"
            data-kind={request.kind}
            data-request-id={request.request_id}
            data-status={
              request.submitting
                ? "submitting"
                : request.observer
                  ? "observer"
                  : "ready"
            }
            aria-busy={request.submitting || undefined}
          >
            <h3>{t(copy.heading)}</h3>
            <p>{t(copy.description, { used, block, additional: block })}</p>
            {request.session_id !== request.parent_session_id && (
              <p className="flow-card-meta">
                {t("roundLimit.child", { id: request.session_id })}
              </p>
            )}
            {request.observer && (
              <p className="inline-notice" role="status">
                {t("roundLimit.observer")}
              </p>
            )}
            {request.submitting && (
              <p className="inline-notice" role="status">
                {t("roundLimit.submitting")}
              </p>
            )}
            <div className="settings-actions-row flow-card-actions">
              <button
                className="primary-btn"
                type="button"
                disabled={request.disabled}
                onClick={() =>
                  dispatch({
                    type: "ReplyRoundLimit",
                    requestId: request.request_id,
                    decision: "continue",
                  })
                }
              >
                {t(copy.continueLabel, { used, block, additional: block })}
              </button>
              <button
                className="ghost-btn"
                type="button"
                disabled={request.disabled}
                onClick={() =>
                  dispatch({
                    type: "ReplyRoundLimit",
                    requestId: request.request_id,
                    decision: "stop",
                  })
                }
              >
                {t("roundLimit.stop")}
              </button>
            </div>
          </article>
        );
      })}
    </>
  );
}
