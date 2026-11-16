import type { NativeOperation } from "./types";

/** Receipt method identifies the work that failed; error text/code does not.
 * Runtime attempts belong to the conversation even when they fail before a model
 * request. Other commands keep their request owner's feedback and receipt semantics.
 * Unknown methods fail closed to request feedback rather than inventing a turn. */
export function operationFailureRoute(
  operation: Pick<NativeOperation, "method">,
): "conversation" | "request" | "silent" {
  switch (operation.method) {
    case "turn.submit":
    case "turn.retry":
    case "turn.inbox":
    case "inbox.resume":
    case "session.compact":
    case "session.retry_agent_init":
    case "session.retry_auto_compaction":
      return "conversation";
    case "session.auto_rename":
      return "silent";
    default:
      return "request";
  }
}
