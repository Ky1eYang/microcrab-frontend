export const usageRanges = ["24h", "7d", "30d"] as const;
export type UsageRange = (typeof usageRanges)[number];

export const usageSources = ["all", "session", "relay"] as const;
export type UsageSource = (typeof usageSources)[number];

export const usageOutcomes = [
  "accepted",
  "unavailable",
  "invalid_response",
  "limit_exceeded",
  "cancelled",
  "timed_out",
] as const;
export type UsageOutcome = (typeof usageOutcomes)[number];

export const usageCounters = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "uncached_input_tokens",
  "non_reasoning_output_tokens",
  "total_tokens",
] as const;
export type UsageCounter = (typeof usageCounters)[number];

export interface CounterAggregate {
  reported_total: number | null;
  reported_samples: number;
  unreported_samples: number;
  overflow: boolean;
}

export interface ReportedCacheSummary {
  scope: "reported_samples";
  attempted_samples: number;
  paired_samples: number;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_hit_rate: number | null;
}

export interface UsageAggregate {
  requests: number;
  usage: Record<UsageCounter, CounterAggregate>;
  reported_cache: ReportedCacheSummary;
  average_latency_ms: number | null;
  latency_samples: number;
  average_ttft_ms: number | null;
  ttft_samples: number;
  estimated_cost_usd: number | null;
  estimated_saved_usd: number | null;
  priced_requests: number;
  unpriced_requests: number;
  pricing_coverage: number | null;
  rough_priced_requests: number;
  savings_covered_requests: number;
}

export interface UsageBucket extends UsageAggregate {
  start_ms: number;
}

export interface UsagePlatformRow extends UsageAggregate {
  protocol: string | null;
}

export interface UsageModelRow extends UsageAggregate {
  provider_id: string | null;
  model: string | null;
}

export interface DashboardCoverage {
  retention_days: number;
  capacity_events: number;
  truncated_by_capacity: boolean;
  observed_since_ms: number;
  oldest_retained_ms: number | null;
}

export interface DashboardWindow {
  range: UsageRange;
  ends_at_ms: number;
  bucket_starts_ms: number[];
  today_start_ms: number;
  time_basis: string;
}

export interface DashboardSummaryReport {
  range: UsageRange;
  source: UsageSource;
  window: DashboardWindow;
  coverage: DashboardCoverage;
  kpi: UsageAggregate & {
    today_requests: number;
    retained_requests: number;
    active_sessions: number | null;
    total_sessions: number;
    unavailable_sessions: number;
    active_api_keys: number | null;
    total_api_keys: number | null;
  };
  series: UsageBucket[];
  platforms: UsagePlatformRow[];
  models: UsageModelRow[];
}

export interface CacheDiagnosticItem {
  code: "cache_usage_unreported" | "cache_hit_rate_below_threshold";
  provider_id: string | null;
  model: string | null;
  paired_samples: number;
  attempted_samples?: number;
  threshold_pct?: number;
  hit_rate?: number;
}

export interface DashboardDiagnosticsReport {
  models: UsageModelRow[];
  diagnostics: CacheDiagnosticItem[];
  coverage: DashboardCoverage;
  window: DashboardWindow;
}

export interface UsageLog {
  event_id: string;
  ts_ms: number;
  source: "session" | "relay";
  source_id: string;
  source_label: string | null;
  request_id: string | null;
  provider_id: string | null;
  model: string | null;
  protocol: string | null;
  outcome: UsageOutcome;
  status_code: number | null;
  latency_ms: number | null;
  ttft_ms: number | null;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    reasoning_tokens: number | null;
    uncached_input_tokens: number | null;
    non_reasoning_output_tokens: number | null;
    total_tokens: number | null;
    samples: number;
  } | null;
  cache_hit_rate: number | null;
  pricing: {
    estimated_cost_usd: number | null;
    estimated_saved_usd: number | null;
    rough_input_estimate: boolean;
  };
}

export interface DashboardLogsReport {
  items: UsageLog[];
  next_cursor: string | null;
  coverage: DashboardCoverage;
}

export interface DashboardReports {
  summary: DashboardSummaryReport;
  "cache-diagnostics": DashboardDiagnosticsReport;
  logs: DashboardLogsReport;
  "logs.csv": { text: string; truncated: boolean };
}

export interface UsageFilters {
  range: UsageRange;
  source: UsageSource;
  model?: string;
  status?: string;
  q?: string;
  low_cache_hit_warn_pct?: number;
}

function browserBuckets(range: UsageRange, nowMs: number) {
  const now = new Date(nowMs);
  const starts: number[] = [];
  if (range === "24h") {
    const currentHour = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      now.getHours(),
      0,
      0,
      0,
    ).getTime();
    for (let i = 23; i >= 0; i--) {
      starts.push(currentHour - i * 3600_000);
    }
  } else {
    const count = range === "7d" ? 7 : 30;
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      starts.push(d.getTime());
    }
  }
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  return { starts, todayStart };
}

export function usageQuery(filters: UsageFilters, nowMs = Date.now()): URLSearchParams {
  const params = new URLSearchParams();
  params.set("range", filters.range);
  params.set("source", filters.source);
  const { starts, todayStart } = browserBuckets(filters.range, nowMs);
  params.set("bucket_starts_ms", starts.join(","));
  params.set("today_start_ms", String(todayStart));
  if (filters.model?.trim()) params.set("model", filters.model.trim());
  if (filters.status?.trim()) params.set("status", filters.status.trim());
  if (filters.q?.trim()) params.set("q", filters.q.trim());
  if (
    typeof filters.low_cache_hit_warn_pct === "number" &&
    Number.isInteger(filters.low_cache_hit_warn_pct) &&
    filters.low_cache_hit_warn_pct >= 1 &&
    filters.low_cache_hit_warn_pct <= 99
  ) {
    params.set("low_cache_hit_warn_pct", String(filters.low_cache_hit_warn_pct));
  }
  return params;
}

export function formatTokenCount(count: number | null | undefined, unknownText: string): string {
  if (count === null || count === undefined || !Number.isFinite(count)) {
    return unknownText;
  }
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 10_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toLocaleString();
}

export function formatUsdEstimate(value: number | null | undefined, unknownText: string, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return unknownText;
  }
  return `$${value.toFixed(digits)}`;
}
