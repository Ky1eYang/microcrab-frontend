/** Display mapping for tool execution outcomes. Only explicit successful
 * terminal facts map to `succeeded`; an absent or unrecognised status is
 * `unknown`, never success. Retention/output state is orthogonal. */
export type ToolDisplayStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "interrupted"
  | "unknown";

const MAP: Record<string, ToolDisplayStatus> = {
  pending: "pending",
  queued: "pending",
  running: "running",
  in_progress: "running",
  started: "running",
  progress: "running",
  awaiting_approval: "awaiting_approval",
  waiting_approval: "awaiting_approval",
  permission: "awaiting_approval",
  waiting: "waiting",
  paused: "waiting",
  completed: "succeeded",
  succeeded: "succeeded",
  success: "succeeded",
  done: "succeeded",
  result: "succeeded",
  error: "failed",
  failed: "failed",
  cancelling: "cancelling",
  canceling: "cancelling",
  cancelled: "cancelled",
  canceled: "cancelled",
  interrupted: "interrupted",
};

export function toolDisplayStatus(raw: unknown): ToolDisplayStatus {
  if (typeof raw !== "string" || !raw.trim()) return "unknown";
  return MAP[raw.trim().toLowerCase()] ?? "unknown";
}

export const TOOL_STATUS_ICON: Record<ToolDisplayStatus, string> = {
  pending: "status-pending",
  running: "spinner",
  awaiting_approval: "clock",
  waiting: "clock",
  succeeded: "check",
  failed: "status-failed",
  cancelling: "spinner",
  cancelled: "status-cancelled",
  interrupted: "status-stopped",
  unknown: "status-unknown",
};

export const isActiveToolStatus = (status: ToolDisplayStatus) =>
  status === "running" || status === "cancelling";

/** Summarise outcomes of a group without reporting generic success. */
export function toolOutcomeCounts(statuses: ToolDisplayStatus[]) {
  const counts: Partial<Record<ToolDisplayStatus, number>> = {};
  for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

/** Child (subagent) display status. Only explicit successful terminal facts
 * show success; `idle` is a session state, not an outcome. Absent → unknown. */
export type ChildDisplayStatus =
  | "loading"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "idle"
  | "unknown";

const CHILD_MAP: Record<string, ChildDisplayStatus> = {
  pending: "loading",
  queued: "loading",
  creating: "loading",
  starting: "loading",
  running: "running",
  busy: "running",
  thinking: "running",
  waiting: "running",
  in_progress: "running",
  cancelling: "cancelling",
  canceling: "cancelling",
  completed: "succeeded",
  succeeded: "succeeded",
  success: "succeeded",
  done: "succeeded",
  failed: "failed",
  error: "failed",
  cancelled: "cancelled",
  canceled: "cancelled",
  interrupted: "interrupted",
  idle: "idle",
};

export function childDisplayStatus(raw: unknown): ChildDisplayStatus {
  if (typeof raw !== "string" || !raw.trim()) return "unknown";
  return CHILD_MAP[raw.trim().toLowerCase()] ?? "unknown";
}

export const CHILD_STATUS_ICON: Record<ChildDisplayStatus, string> = {
  loading: "status-pending",
  running: "spinner",
  cancelling: "spinner",
  succeeded: "check",
  failed: "status-failed",
  cancelled: "status-cancelled",
  interrupted: "status-stopped",
  idle: "status-pending",
  unknown: "status-unknown",
};
