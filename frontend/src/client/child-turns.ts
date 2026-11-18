import { CommandError } from "./errors";
import type {
  NativeChildDetail,
  NativeChildSummary,
  NativeOperation,
  NativePart,
} from "./types";

export interface ChildTurnScope {
  parentId: string;
  childId: string;
}
export interface ChildTurnInput {
  parts: NativePart[];
  variables?: unknown;
}
export interface ChildTurnRequest {
  operation_id: string;
  input: ChildTurnInput;
}
export interface ChildTurnOperation extends NativeOperation {
  method: "child.turn.submit";
  status: "accepted" | "completed" | "failed" | "cancelled";
  result: {
    child_id: string;
    server_instance?: string;
    outcome?: {
      content: string;
      rounds: number;
      usage: unknown;
      stop_reason: "model_completed" | "round_limit";
      content_truncated: boolean;
    };
    error?: { code: string; message: string; [key: string]: unknown };
  };
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function childTurnPath(scope: ChildTurnScope) {
  if (!scope.parentId || !scope.childId || scope.parentId === scope.childId)
    throw new CommandError(
      "invalid_request",
      "child.turn: exact distinct parent and child identities are required",
    );
  return `api/v1/sessions/${encodeURIComponent(scope.parentId)}/children/${encodeURIComponent(scope.childId)}/turns`;
}
export function validateChildOperationId(id: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  )
    throw new CommandError(
      "invalid_request",
      "child.turn.operation_id: expected canonical UUID",
    );
}
/** Explicit entry plus these server facts are required; an Agent name never grants input. */
export function childInputAllowed(
  detail: NativeChildDetail | undefined,
  scope: ChildTurnScope,
): boolean {
  return (
    !!detail &&
    detail.id === scope.childId &&
    detail.parent_session_id === scope.parentId &&
    detail.availability === "persisted" &&
    detail.depth === 1 &&
    detail.interaction === "persistent" &&
    detail.current_role === "both" &&
    detail.accepts_user_input === true &&
    typeof detail.agent_id === "string" &&
    !!detail.agent_id
  );
}
export function settledReturnChild(child: NativeChildSummary): boolean {
  return (
    child.interaction === "return" &&
    ["completed", "succeeded", "failed", "cancelled", "interrupted"].includes(
      child.status,
    )
  );
}
export function validateChildTurnOperation(
  value: unknown,
  scope: ChildTurnScope,
  operationId: string,
  owner: string,
): asserts value is ChildTurnOperation {
  if (
    !object(value) ||
    value.id !== operationId ||
    value.session_id !== scope.parentId ||
    value.owner !== owner ||
    value.method !== "child.turn.submit" ||
    !["accepted", "completed", "failed", "cancelled"].includes(
      value.status as string,
    ) ||
    !Number.isSafeInteger(value.version) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    typeof value.payload_hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.payload_hash) ||
    !Number.isSafeInteger(value.created_at_ms) ||
    !Number.isSafeInteger(value.updated_at_ms) ||
    !object(value.result) ||
    value.result.child_id !== scope.childId
  )
    throw new CommandError(
      "invalid_result",
      "child.turn: operation receipt identity or shape mismatch",
    );
  if (value.status === "accepted") {
    if (
      typeof value.result.server_instance !== "string" ||
      !value.result.server_instance
    )
      throw new CommandError(
        "invalid_result",
        "child.turn: accepted receipt lacks server instance",
      );
  } else if (value.status === "completed") {
    const outcome = value.result.outcome;
    if (
      !object(outcome) ||
      typeof outcome.content !== "string" ||
      !Number.isSafeInteger(outcome.rounds) ||
      (outcome.rounds as number) < 0 ||
      !["model_completed", "round_limit"].includes(
        outcome.stop_reason as string,
      ) ||
      typeof outcome.content_truncated !== "boolean" ||
      !Object.hasOwn(outcome, "usage")
    )
      throw new CommandError(
        "invalid_result",
        "child.turn: completed receipt lacks bounded outcome",
      );
  } else if (
    !object(value.result.error) ||
    typeof value.result.error.code !== "string" ||
    typeof value.result.error.message !== "string"
  )
    throw new CommandError(
      "invalid_result",
      "child.turn: terminal error receipt lacks concrete cause",
    );
}
