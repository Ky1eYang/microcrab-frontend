import { expect, test } from "@playwright/test";
import { isNativeStatistics } from "../src/client/statistics";

test("reported cache summaries are optional and reject invalid paired subsets", () => {
  const value = statistics() as any;
  expect(isNativeStatistics(value)).toBe(true);
  const reported = {
    scope: "reported_samples",
    attempted_samples: 51,
    paired_samples: 47,
    input_tokens: 10000,
    cache_read_tokens: 9650,
    cache_hit_rate: 0.965,
  };
  for (const field of ["main_reported_cache", "aggregate_reported_cache"]) {
    value.usage[field] = reported;
    expect(isNativeStatistics(value)).toBe(true);
    for (const invalid of [
      { scope: "total" },
      { attempted_samples: -1 },
      { attempted_samples: Number.MAX_SAFE_INTEGER + 1 },
      { paired_samples: 52 },
      { paired_samples: 1.5 },
      { input_tokens: Number.POSITIVE_INFINITY },
      { input_tokens: 9000 },
      { cache_read_tokens: 10001 },
      { cache_hit_rate: 1.1 },
      { cache_hit_rate: 0.5 },
      { cache_read_tokens: null },
      { paired_samples: 0 },
    ]) {
      value.usage[field] = { ...reported, ...invalid };
      expect(isNativeStatistics(value), JSON.stringify(invalid)).toBe(false);
    }
    value.usage[field] = {
      ...reported,
      paired_samples: 0,
      input_tokens: null,
      cache_read_tokens: null,
      cache_hit_rate: null,
    };
    expect(isNativeStatistics(value)).toBe(true);
    value.usage[field] = {
      ...reported,
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_hit_rate: null,
    };
    expect(isNativeStatistics(value)).toBe(true);
    delete value.usage[field];
  }
});

function statistics() {
  return {
    context: {
      scope: "current_selected_context",
      provenance: "context_budget_json_v1",
      epoch: 0,
      pending_epoch: false,
      fingerprint: "measured",
      bytes: 10,
      limit_bytes: 100,
      remaining_bytes: 90,
      categories: {
        system: 1,
        tools: 1,
        state: 1,
        user: 1,
        assistant: 1,
        tool_result: 1,
        framing: 4,
      },
      counts: {
        items: 1,
        tool_definitions: 1,
        pending_tool_calls: 0,
        state_frames: 1,
        user_messages: 1,
        assistant_messages: 0,
        tool_results: 0,
        tool_calls: 0,
        turns: 1,
        steps: 1,
      },
    },
    activity: {
      scope: "selected_context_history",
      turns: 1,
      steps: 1,
      tool_calls: 0,
      operation: null,
    },
    usage: {
      scope: "append_only_consumption",
      main: {},
      aggregate: {},
      main_cache_hit_rate: null,
      aggregate_cache_hit_rate: null,
    },
    provider: {
      scope: "latest_main_provider_attempt",
      available: true,
      audit_sequence: 1,
      latest_prompt: null,
      timing: {
        request_hash: "request",
        call_id: "call",
        started_at_ms: 1,
        ended_at_ms: 2501,
        elapsed_ms: 2500,
        first_token_ms: 500,
        generation_ms: 2000,
        output_tokens: 20,
        tokens_per_second: 10,
        rate_basis: "generation_interval" as string | null,
        timing_source: "transport_stream" as string | null,
        request_tokens_per_second: 8 as number | null,
      },
    },
    model: {
      context_window_tokens: null,
      measured_headroom_tokens: null,
      headroom_reason: "model_window_unknown",
    },
  };
}

test("snapshot and event validation admit measured generation timing and legacy unknown intervals", () => {
  const value = statistics();
  expect(isNativeStatistics(value)).toBe(true);
  value.provider.timing.rate_basis = null;
  value.provider.timing.timing_source = null;
  expect(isNativeStatistics(value)).toBe(true);
  value.provider.timing.rate_basis = "request_average";
  expect(isNativeStatistics(value)).toBe(true);
});

test("execution clock accepts measured and unknown lifecycles and rejects malformed intervals", () => {
  const value = statistics() as any;
  expect(isNativeStatistics(value)).toBe(true);
  value.activity.execution = {
    active: false,
    started_at_ms: null,
    ended_at_ms: null,
    elapsed_ms: null,
  };
  expect(isNativeStatistics(value)).toBe(true);
  value.activity.execution = {
    active: true,
    started_at_ms: 1000,
    ended_at_ms: null,
    elapsed_ms: null,
  };
  expect(isNativeStatistics(value)).toBe(true);
  value.activity.execution.ended_at_ms = 2000;
  expect(isNativeStatistics(value)).toBe(false);
  value.activity.execution.active = false;
  value.activity.execution.elapsed_ms = 1000;
  expect(isNativeStatistics(value)).toBe(true);
  value.activity.execution.elapsed_ms = -1;
  expect(isNativeStatistics(value)).toBe(false);
  value.activity.execution.elapsed_ms = Number.NaN;
  expect(isNativeStatistics(value)).toBe(false);
});

test("unknown timing sources and invalid measured rates cannot enter authoritative statistics", () => {
  const value = statistics();
  value.provider.timing.timing_source = "invented";
  expect(isNativeStatistics(value)).toBe(false);
  value.provider.timing.timing_source = "transport_stream";
  value.provider.timing.request_tokens_per_second = -1;
  expect(isNativeStatistics(value)).toBe(false);
});
