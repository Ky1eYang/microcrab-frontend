import type { NativeInbox } from "../client/types";

const BUSY_MUTATION = new Set(["pending", "unknown", "accepted", "running"]);

/** One in-flight set for store admission and the queue dock. */
export function inboxMutationBusy(status: string | undefined): boolean {
  return status != null && BUSY_MUTATION.has(status);
}

export function sessionInboxMutationBusy(
  mutations: Record<string, { status: string }> | undefined,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  return Object.entries(mutations ?? {}).some(
    ([key, value]) =>
      inboxKeySession(key) === sessionId && inboxMutationBusy(value.status),
  );
}

function inboxKeySession(key: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === "string"
      ? parsed[0]
      : undefined;
  } catch {
    return undefined;
  }
}

export function inboxItemKey(
  sessionId: string,
  inboxId: string,
  itemId: string,
) {
  return JSON.stringify([sessionId, inboxId, itemId]);
}

/** Main composer supports text and inline images, without custom variable edits. */
export function inboxInputEditable(
  input: NativeInbox["items"][number]["input"],
) {
  if (input.variables) {
    const variables = input.variables as {
      set?: Record<string, unknown>;
      remove?: unknown[];
    };
    if (
      typeof variables !== "object" ||
      Array.isArray(variables) ||
      Object.keys(variables).some((key) => !["set", "remove"].includes(key)) ||
      (variables.set &&
        (typeof variables.set !== "object" ||
          Array.isArray(variables.set) ||
          Object.keys(variables.set).length > 0)) ||
      (variables.remove &&
        (!Array.isArray(variables.remove) || variables.remove.length > 0))
    )
      return false;
  }
  return input.parts.every(
    (part) =>
      part.type === "text" ||
      (part.type === "image" &&
        (part.source?.type === "data" || part.source?.type === "attachment")),
  );
}
