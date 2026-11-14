import type { PermissionSettled } from "./types";
import { isRecord } from "./permissions";

const FIELDS = [
  "request_id",
  "parent_session_id",
  "session_id",
  "call_id",
  "revision",
  "agent",
  "mode",
  "tool",
  "owning_session_id",
  "controller_id",
  "source",
  "review_reason",
  "decision",
  "reason",
  "remembered",
];
/** Safe final receipts contain attribution only, never original arguments. */
export function validatePermissionDecision(
  value: unknown,
  parent: string,
): asserts value is PermissionSettled {
  if (!isRecord(value)) throw Error("permission.decision: expected object");
  for (const key of Object.keys(value))
    if (!FIELDS.includes(key))
      throw Error(`permission.decision.${key}: unknown field`);
  if (value.parent_session_id !== parent)
    throw Error(
      "permission.decision.parent_session_id: expected selected parent Session",
    );
  if (typeof value.request_id !== "string" || !value.request_id)
    throw Error("permission.decision.request_id: expected nonempty string");
  if (value.decision !== "allow" && value.decision !== "deny")
    throw Error("permission.decision.decision: expected allow or deny");
  for (const field of [
    "session_id",
    "call_id",
    "agent",
    "mode",
    "tool",
    "owning_session_id",
    "review_reason",
    "reason",
  ])
    if (
      value[field] !== undefined &&
      value[field] !== null &&
      (typeof value[field] !== "string" ||
        new TextEncoder().encode(value[field] as string).length > 4096)
    )
      throw Error(`permission.decision.${field}: expected bounded string`);
  for (const field of ["revision", "controller_id"])
    if (
      value[field] !== undefined &&
      (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0)
    )
      throw Error(
        `permission.decision.${field}: expected nonnegative safe integer`,
      );
  if (
    value.source !== undefined &&
    !["user", "review", "unavailable", "cancelled", "timeout"].includes(
      String(value.source),
    )
  )
    throw Error("permission.decision.source: unknown source");
  if (value.remembered !== undefined && typeof value.remembered !== "boolean")
    throw Error("permission.decision.remembered: expected boolean");
}
/** Snapshot restoration and live settlement share bounded factual retention;
 * callers decide whether a newly received live receipt merits a notification. */
export function retainPermissionDecisions(
  previous: PermissionSettled[],
  incoming: unknown,
  parent: string,
): PermissionSettled[] {
  if (!Array.isArray(incoming) || incoming.length > 1024)
    throw Error("permission.decisions: expected bounded array");
  const rows = new Map(
    previous
      .filter((row) => row.parent_session_id === parent)
      .map((row) => [row.request_id, row]),
  );
  for (const row of incoming) {
    validatePermissionDecision(row, parent);
    rows.set(row.request_id, row);
  }
  return [...rows.values()].slice(-128);
}
