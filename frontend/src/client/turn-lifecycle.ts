import type { NativeOperation, Transcript } from "./types";

const FOREGROUND_METHODS = new Set([
  "turn.submit",
  "turn.retry",
  "turn.inbox",
  "inbox.resume",
]);

/** Operation receipts own foreground settlement. Neither a Session status update
 * nor a bounded snapshot's omission certifies that an observed Turn has ended. */
export function observeTurnLifecycle(
  transcript: Transcript,
  sessionId: string,
  operation: Pick<NativeOperation, "id" | "session_id" | "method" | "status"> &
    Partial<Pick<NativeOperation, "updated_at_ms">>,
) {
  if (
    operation.session_id !== sessionId ||
    !operation.id ||
    !FOREGROUND_METHODS.has(operation.method)
  )
    return;
  const active =
    operation.status === "accepted" || operation.status === "running";
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(
    operation.status,
  );
  if (!active && !terminal) return;
  if (transcript.turnLifecycle?.sessionId !== sessionId)
    transcript.turnLifecycle = {
      sessionId,
      operations: {},
      activeOperationIds: [],
      completionRevision: 0,
    };
  const lifecycle = transcript.turnLifecycle;
  const previous = lifecycle.operations[operation.id];
  const updatedAt = operation.updated_at_ms;
  const terminalAt =
    terminal &&
    updatedAt != null &&
    Number.isSafeInteger(updatedAt) &&
    updatedAt > 0 &&
    updatedAt <= 8_640_000_000_000_000 &&
    !Object.hasOwn(lifecycle.terminalAt ?? {}, operation.id)
      ? { ...lifecycle.terminalAt, [operation.id]: updatedAt }
      : lifecycle.terminalAt;
  // Terminal evidence cannot be undone by a delayed admission receipt. A later
  // receipt can supply a clock that an earlier, untimed terminal receipt lacked.
  if (previous === "terminal" || (previous === "active" && active)) {
    if (terminalAt !== lifecycle.terminalAt)
      transcript.turnLifecycle = { ...lifecycle, terminalAt };
    return;
  }
  const operations = {
    ...lifecycle.operations,
    [operation.id]: active ? ("active" as const) : ("terminal" as const),
  };
  transcript.turnLifecycle = {
    ...lifecycle,
    terminalAt,
    terminalObservedAt:
      terminal && previous === "active"
        ? { ...lifecycle.terminalObservedAt, [operation.id]: Date.now() }
        : lifecycle.terminalObservedAt,
    operations,
    completionRevision:
      lifecycle.completionRevision +
      (previous === "active" && terminal ? 1 : 0),
    activeOperationIds: Object.keys(operations).filter(
      (id) => operations[id] === "active",
    ),
  };
}
