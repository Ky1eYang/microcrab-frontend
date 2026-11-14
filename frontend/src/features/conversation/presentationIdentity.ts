import type { NativeHistoryView } from "../../client/types";
import type { FeatureBlock } from "../shared";

/** Presentation identity is independent of request/permission epoch fences. */
export function presentationIdentity(
  block: FeatureBlock & { displayGraphId?: string },
) {
  // Graph identity precedes canonical admission. Binding a producer to a
  // canonical message annotates that same durable row; it does not replace it.
  if (block.displayGraphId)
    return JSON.stringify([
      block.sessionId,
      block.kind,
      "graph",
      block.displayGraphId,
      block.id,
    ]);
  // Audit request hashes identify bodies shared by independent invocations.
  // The audit owner supplies the exact invocation witness separately.
  if (typeof block.payload.auditIdentity === "string")
    return JSON.stringify([
      block.sessionId,
      block.kind,
      "audit",
      block.payload.auditIdentity,
    ]);
  if (
    ["model-request", "model-generation"].includes(block.kind) &&
    typeof block.payload.auditTimingKey === "string"
  )
    return JSON.stringify([
      block.sessionId,
      block.kind,
      "audit-model",
      block.payload.auditTimingKey,
    ]);
  const message =
    block.preview?.canonicalMessageId ??
    (!block.preview && !block.temporary ? block.messageId : null);
  return JSON.stringify([
    block.sessionId,
    block.kind,
    message ? "canonical" : "display",
    message || block.id,
    block.partId,
    block.callId ?? block.tool?.callId ?? block.tool?.id ?? null,
  ]);
}

export function presentationIdentityChanged(
  before: string,
  block: FeatureBlock,
) {
  const after = presentationIdentity(block);
  if (before === after) return false;
  const previous = JSON.parse(before);
  const next = JSON.parse(after);
  // The projector may bind a native display row to its canonical message in
  // place. The caller has already matched that exact native row id.
  return !(
    previous[2] === "display" &&
    next[2] === "canonical" &&
    [0, 1, 4, 5].every((index) => previous[index] === next[index])
  );
}

export function historyBranchReplaced(
  before: NativeHistoryView | undefined,
  after: NativeHistoryView | undefined,
) {
  // First metadata hydration supplies authority; it does not remove received rows.
  return Boolean(
    before &&
    after &&
    (before.lineage !== after.lineage || after.epoch < before.epoch),
  );
}
