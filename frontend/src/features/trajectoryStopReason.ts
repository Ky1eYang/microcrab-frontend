import type { FeatureBlock } from "./shared";
import { failureText } from "../client/failure";
import { stopReasonText } from "../client/stop-reason";
import { t } from "../i18n";

export function terminalSummary(block: FeatureBlock): string {
  if (block.payload.failure) return failureText(block.payload.failure);
  const reason = stopReasonText(block.payload.stopReason ?? {});
  if (reason) return reason;
  if (block.payload.auditStatus === "cancelled" || block.stream === "cancelled")
    return t("stopReason.cancelled");
  if (block.payload.auditStatus === "failed" || block.stream === "error")
    return t("stopReason.failed");
  return "";
}
