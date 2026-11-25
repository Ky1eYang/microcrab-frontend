import type { NativeHistoryView } from "./types";

export function responseHistoryScope(
  view: NativeHistoryView | undefined,
): string {
  return JSON.stringify(view ? [view.lineage, view.epoch] : null);
}

export function responseCompletionTime(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 8_640_000_000_000_000
    ? value
    : undefined;
}

// The caller supplies the owning Session and selected-history scope. Never
// substitute a provider call ID, row position or the rendered text for either ID.
export function responseIdentity(
  messageId: string,
  sourceId: string | undefined,
): string | undefined {
  return typeof sourceId === "string" && sourceId && messageId
    ? JSON.stringify([sourceId, messageId])
    : undefined;
}
