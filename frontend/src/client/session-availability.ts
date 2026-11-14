import type { NativeSessionList } from "./types";
import { isRecord } from "./permissions";

/** Unavailable records are diagnostics, never invented activatable Sessions. */
export function validateSessionList(
  value: unknown,
): asserts value is NativeSessionList {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.unavailable) ||
    typeof value.complete !== "boolean"
  )
    throw Error("session.list: expected items, unavailable and complete");
  for (const [index, entry] of value.unavailable.entries())
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.reason !== "string" ||
      !entry.reason.length
    )
      throw Error(
        `session.list.unavailable[${index}]: expected id and concrete reason`,
      );
  if (value.complete !== (value.unavailable.length === 0))
    throw Error("session.list.complete: inconsistent with unavailable records");
}

export function isUnavailableSessionChange(value: unknown): value is {
  op: "unavailable";
  session_id: string;
  error: { code: "session_configuration_unavailable"; message: string };
} {
  if (!isRecord(value) || value.op !== "unavailable") return false;
  return (
    typeof value.session_id === "string" &&
    isRecord(value.error) &&
    value.error.code === "session_configuration_unavailable" &&
    typeof value.error.message === "string" &&
    value.error.message.length > 0
  );
}
