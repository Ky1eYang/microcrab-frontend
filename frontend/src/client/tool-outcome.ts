import type { Block } from "./types";

/** A return message settles the call, but does not certify successful execution. */
export function executionToolOutcome(status: unknown) {
  switch (status) {
    case "failed":
    case "cancelled":
    case "interrupted":
      return status;
    default:
      return undefined;
  }
}

export function settledToolStatus(block: Block): string {
  return (
    block.payload.observedToolOutcome ??
    executionToolOutcome(block.execution?.status) ??
    "completed"
  );
}
