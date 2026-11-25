import { ExpandableNotice } from "./ExpandableNotice";
import { useAppFields } from "../state";
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

export function RoundLimitPrompt() {
  const { state, dispatch } = useAppFields([
    "roundLimitRequests",
    "resolvedLocale",
  ]);
  return (
    <>
      {state.roundLimitRequests?.map((request) => {
        const copy = labels(request);
        const bytes = request.kind === "context_bytes";
        const used = bytes ? mib(request.used) : request.used;
        const block = bytes ? mib(request.block) : request.block;
        const heading = t(copy.heading);
        const message = [
          `${heading} · ${t(copy.description, { used, block, additional: block })}`,
          request.session_id !== request.parent_session_id
            ? t("roundLimit.child", { id: request.session_id })
            : "",
          request.observer ? t("roundLimit.observer") : "",
          request.submitting ? t("roundLimit.submitting") : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <ExpandableNotice
            as="article"
            role="status"
            className="composer-notification-row"
            tone="warn"
            aria-label={heading}
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
            text={message}
            action={
              <div className="settings-actions-row">
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
            }
          />
        );
      })}
    </>
  );
}
