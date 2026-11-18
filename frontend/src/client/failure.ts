import { t } from "../i18n";
import { cancelReasons } from "./stop-reason";
import { diagnosticDetails, diagnosticText } from "./diagnostics";

export interface NativeWireError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
const reasons = new Set([
  "turn_deadline",
  "tool_result_reservation",
  "provider_response",
  "context_bytes",
  "input_bytes",
  "custom_variable_bytes",
  "recovery_bytes",
  "execution_inspection",
  "plugin_rewrite",
  "rounds",
  "tool_calls",
  "host_operations",
  "tool_arguments",
  "tool_output",
  "pending_executions",
  "execution_history",
  "execution_buffers",
  "processes",
  "cache_bytes",
  "cache_points",
  "attachment_bytes",
  "attachment_count",
  "image_pixels",
  "image_side",
  "inbox_bytes",
  "inbox_entries",
  "state_delivery_bytes",
  "reference_bytes",
  "reference_count",
  "wasm_bytes",
  "operation_deadline",
  "provider_request",
  "arithmetic",
  "other",
]);
const timeoutFacts = [
  "timeout_ms",
  "elapsed_ms",
  "first_token_ms",
  "streamed_bytes",
  "streamed_chars",
] as const;
/** Explicit typed projection; incoming descriptions are sanitized presentation copies. */
export function wireFailure(value: unknown): NativeWireError {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const failure: NativeWireError = {
    code: diagnosticText(raw.code, 128) || "operation_failed",
    message: diagnosticText(raw.message) || t("failure.generic"),
  };
  if (
    raw.details &&
    typeof raw.details === "object" &&
    !Array.isArray(raw.details)
  ) {
    const safe = diagnosticDetails(raw.details);
    const source = raw.details as Record<string, unknown>;
    if (safe.provider_code === "empty_assistant_response" && typeof source.reasoning_present === "boolean")
      safe.reasoning_present = source.reasoning_present;
    if (
      failure.code === "limit" &&
      (typeof safe.reason !== "string" || !reasons.has(safe.reason))
    ) {
      delete safe.reason;
      delete safe.pre_effect;
    }
    if (
      typeof safe.cancel_reason !== "string" ||
      !cancelReasons.has(safe.cancel_reason)
    )
      delete safe.cancel_reason;
    if (
      typeof safe.host_detach_code !== "string" ||
      ![
        "disconnected",
        "replaced",
        "lease_expired",
        "binding_mismatch",
        "unavailable",
      ].includes(safe.host_detach_code)
    )
      delete safe.host_detach_code;
    failure.details = safe;
  }
  return failure;
}
export function failureBlockText(value: unknown): string {
  return `${t(wireFailure(value).code === "cancelled" ? "stopReason.heading" : "failure.heading")}\n\n${failureText(value)}`;
}
export function failureText(value: unknown): string {
  const failure = wireFailure(value),
    details = failure.details ?? {};
  if (failure.code === "provider" && details.provider_code === "empty_assistant_response")
    return t(details.reasoning_present === true ? "failure.emptyReasoningResponse" : "failure.emptyResponse");
  if (failure.code === "cancelled") {
    const reason = details.cancel_reason;
    if (typeof reason !== "string" || !cancelReasons.has(reason))
      return failure.message;
    const hostCode = details.host_detach_code;
    const label =
      reason === "host_detached" && typeof hostCode === "string"
        ? t(`stopReason.host.${hostCode}`)
        : t(`stopReason.${reason}`);
    return label === failure.message ? label : `${label}\n\n${failure.message}`;
  }
  if (failure.code === "continuation_pending")
    return t("composer.inbox.sendContinuation");
  const reason =
    failure.code === "limit" &&
    typeof details.reason === "string" &&
    reasons.has(details.reason)
      ? details.reason
      : undefined;
  const lines = [
    reason
      ? t(`failure.limit.${reason}`)
      : failure.code === "provider_timeout"
        ? t("failure.providerTimeout", { message: failure.message })
        : [
              "provider",
              "provider_error",
              "provider_status",
              "transport",
            ].includes(failure.code)
          ? t("failure.provider", { message: failure.message })
          : failure.message,
  ];
  if (reason && failure.message !== lines[0]) lines.push(failure.message);
  if (typeof details.calls === "number")
    lines.push(t("failure.calls", { count: details.calls }));
  for (const key of ["required_bytes", "budget_bytes"] as const) {
    const bytes = details[key];
    if (typeof bytes === "number")
      lines.push(
        t(`failure.${key}`, { bytes, mib: (bytes / (1024 * 1024)).toFixed(1) }),
      );
  }
  for (const key of [
    "required_count",
    "budget_count",
    "line",
    "column",
    "raw_os_error",
    "kind",
    "category",
    "provider_type",
    "provider_status",
    "provider_code",
    "tool_code",
    "cause",
    "operation",
    "stage",
    "finish_reason",
    "block_reason",
  ] as const) {
    const fact = details[key];
    if (typeof fact === "number" || typeof fact === "string")
      lines.push(t(`failure.${key}`, { value: fact }));
  }
  if (reason && details.pre_effect === true) lines.push(t("failure.preEffect"));
  if (failure.code === "provider_timeout" && details.reason === "idle_timeout")
    lines.push(t("failure.idleTimeout"));
  for (const key of timeoutFacts)
    if (typeof details[key] === "number")
      lines.push(t(`failure.${key}`, { value: details[key] as number }));
  if (
    failure.code !== "limit" &&
    typeof details.reason === "string" &&
    details.reason !== "idle_timeout" &&
    details.reason !== failure.message
  )
    lines.push(details.reason);
  if (details.diagnostic && typeof details.diagnostic === "object") {
    const diagnostic = details.diagnostic as Record<string, unknown>;
    for (const key of [
      "code",
      "message",
      "layer",
      "phase",
      "effects",
      "operation_effects",
      "operation",
      "limit_owner",
      "requested_timeout_ms",
      "effective_timeout_ms",
      "json_line",
      "json_column",
      "reason",
      "evidence_id",
      "elapsed_ms",
    ] as const) {
      const fact = diagnostic[key];
      if (typeof fact === "string" || typeof fact === "number")
        lines.push(t(`failure.${key}`, { value: fact }));
    }
    if (typeof diagnostic.retryable === "boolean")
      lines.push(
        t(diagnostic.retryable ? "failure.retryable" : "failure.notRetryable"),
      );
    if (Array.isArray(diagnostic.causes))
      lines.push(
        ...diagnostic.causes.filter((v): v is string => typeof v === "string"),
      );
  }
  if (Array.isArray(details.causes))
    lines.push(
      ...details.causes.filter((v): v is string => typeof v === "string"),
    );
  return lines.join("\n\n");
}
