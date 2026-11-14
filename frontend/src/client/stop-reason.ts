import { t } from "../i18n";

export const cancelReasons = new Set([
  "user_requested",
  "host_detached",
  "session_closed",
  "client_tool_disconnected",
]);

/** Render only explicit backend evidence; a missing cause never implies user stop. */
export function stopReasonText(value: {
  reason?: unknown;
  detail?: unknown;
}): string {
  if (typeof value.detail === "string" && value.detail.trim())
    return value.detail;
  if (typeof value.reason === "string" && value.reason.trim()) {
    if (cancelReasons.has(value.reason)) return t(`stopReason.${value.reason}`);
    if (value.reason === "cancelled") return t("stopReason.cancelled");
    return value.reason;
  }
  return "";
}
