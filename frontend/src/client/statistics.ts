import type { NativeStatistics } from "./types";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function nullableNumber(value: unknown): boolean {
  return value === null || number(value);
}
function strings(value: ObjectValue, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === "string");
}
function numbers(
  value: ObjectValue,
  keys: string[],
  nullable = false,
): boolean {
  return keys.every((key) =>
    nullable ? nullableNumber(value[key]) : number(value[key]),
  );
}
function usage(value: unknown): boolean {
  if (!object(value)) return false;
  const fields = [
    "input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "uncached_input_tokens",
    "non_reasoning_output_tokens",
    "total_tokens",
  ];
  return (
    fields.every(
      (key) => value[key] === undefined || nullableNumber(value[key]),
    ) &&
    (value.samples === undefined || number(value.samples))
  );
}
function operation(value: unknown): boolean {
  return (
    value === null ||
    (object(value) &&
      strings(value, ["id", "kind", "status"]) &&
      number(value.started_at_ms) &&
      numbers(value, ["ended_at_ms", "elapsed_ms"], true))
  );
}
function prompt(value: unknown): boolean {
  return (
    value === null ||
    (object(value) &&
      strings(value, ["request_hash", "call_id", "freshness_reason"]) &&
      number(value.epoch) &&
      numbers(
        value,
        ["turn", "round", "input_tokens", "started_at_ms", "ended_at_ms"],
        true,
      ) &&
      ["current", "stale", "unknown"].some(
        (freshness) => value.freshness === freshness,
      ))
  );
}
function timing(value: unknown): boolean {
  return (
    value === null ||
    (object(value) &&
      strings(value, ["request_hash", "call_id"]) &&
      ["request_average", "generation_interval", null].some(
        (basis) => value.rate_basis === basis,
      ) &&
      (value.timing_source === undefined ||
        value.timing_source === null ||
        value.timing_source === "transport_stream") &&
      (value.request_tokens_per_second === undefined ||
        nullableNumber(value.request_tokens_per_second)) &&
      numbers(
        value,
        [
          "started_at_ms",
          "ended_at_ms",
          "elapsed_ms",
          "generation_ms",
          "first_token_ms",
          "output_tokens",
          "tokens_per_second",
        ],
        true,
      ))
  );
}
function ratio(value: unknown): boolean {
  return value === null || (number(value) && value <= 1);
}

function reportedCache(value: unknown): boolean {
  if (value === undefined) return true;
  if (!object(value) || value.scope !== "reported_samples") return false;
  const {
    attempted_samples: attempted,
    paired_samples: paired,
    input_tokens: input,
    cache_read_tokens: cache,
    cache_hit_rate: rate,
  } = value;
  if (
    !Number.isSafeInteger(attempted) ||
    !number(attempted) ||
    !Number.isSafeInteger(paired) ||
    !number(paired) ||
    paired > attempted ||
    !nullableNumber(input) ||
    !nullableNumber(cache) ||
    !ratio(rate)
  )
    return false;
  if (input === null || cache === null)
    return input === null && cache === null && rate === null;
  if (
    !number(input) ||
    !number(cache) ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(cache) ||
    cache > input ||
    paired === 0
  )
    return false;
  return input === 0
    ? rate === null
    : typeof rate === "number" &&
        Math.abs(rate - cache / input) <= Number.EPSILON * 4;
}

/** Events are untyped input; missing/null counts never become invented zeroes. */
export function isNativeStatistics(value: unknown): value is NativeStatistics {
  if (!object(value)) return false;
  const context = value.context,
    activity = value.activity,
    consumption = value.usage,
    provider = value.provider,
    model = value.model;
  if (
    !object(context) ||
    !object(activity) ||
    !object(consumption) ||
    !object(provider) ||
    !object(model)
  )
    return false;
  const categories = context.categories,
    counts = context.counts;
  return (
    context.scope === "current_selected_context" &&
    context.provenance === "context_budget_json_v1" &&
    typeof context.pending_epoch === "boolean" &&
    typeof context.fingerprint === "string" &&
    numbers(context, ["epoch", "bytes", "limit_bytes", "remaining_bytes"]) &&
    object(categories) &&
    numbers(categories, [
      "system",
      "tools",
      "state",
      "user",
      "assistant",
      "tool_result",
      "framing",
    ]) &&
    object(counts) &&
    numbers(counts, [
      "items",
      "tool_definitions",
      "pending_tool_calls",
      "state_frames",
      "user_messages",
      "assistant_messages",
      "tool_results",
      "tool_calls",
      "steps",
    ]) &&
    nullableNumber(counts.turns) &&
    activity.scope === "selected_context_history" &&
    nullableNumber(activity.turns) &&
    numbers(activity, ["steps", "tool_calls"]) &&
    operation(activity.operation) &&
    (activity.execution === undefined ||
      (object(activity.execution) &&
        typeof activity.execution.active === "boolean" &&
        numbers(
          activity.execution,
          ["started_at_ms", "ended_at_ms", "elapsed_ms"],
          true,
        ) &&
        (!activity.execution.active ||
          activity.execution.ended_at_ms === null))) &&
    consumption.scope === "append_only_consumption" &&
    usage(consumption.main) &&
    usage(consumption.aggregate) &&
    ratio(consumption.main_cache_hit_rate) &&
    ratio(consumption.aggregate_cache_hit_rate) &&
    reportedCache(consumption.main_reported_cache) &&
    reportedCache(consumption.aggregate_reported_cache) &&
    provider.scope === "latest_main_provider_attempt" &&
    typeof provider.available === "boolean" &&
    nullableNumber(provider.audit_sequence) &&
    prompt(provider.latest_prompt) &&
    timing(provider.timing) &&
    numbers(
      model,
      ["context_window_tokens", "measured_headroom_tokens"],
      true,
    ) &&
    typeof model.headroom_reason === "string"
  );
}
