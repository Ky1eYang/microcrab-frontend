import React, { useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../../../client/api";
import {
  formatTokenCount,
  formatUsdEstimate,
  usageQuery,
  type DashboardSummaryReport,
  type UsageRange,
  type UsageSource,
} from "../../../client/dashboard-usage";
import { t } from "../../../i18n";
import { useAppFields } from "../../../state";
import { DonutChart, TrendAreaChart } from "../SvgCharts";
import type { ModelDistribution, ModelMetricMode, TrendPoint } from "../types";

const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

function formatPercent(rate: number | null | undefined, unknownText: string): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return unknownText;
  }
  return `${(rate * 100).toFixed(1)}%`;
}

function formatMs(ms: number | null | undefined, unknownText: string): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return unknownText;
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function formatBucketLabel(tsMs: number, range: UsageRange, locale: string): string {
  const dt = new Date(tsMs);
  if (range === "24h") {
    return dt.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return dt.toLocaleDateString(locale, { month: "2-digit", day: "2-digit" });
}

export const OverviewTab: React.FC<{
  owner: string;
  api: ApiClient;
  refreshSignal?: number;
}> = ({ owner, api, refreshSignal = 0 }) => {
  const { state } = useAppFields(["accountPreferences", "resolvedLocale"]);
  const defaultRange: UsageRange = state.accountPreferences?.dashboard_default_range ?? "7d";
  const [range, setRange] = useState<UsageRange>(defaultRange);
  const [rangeOverride, setRangeOverride] = useState(false);
  const effectiveRange = rangeOverride ? range : defaultRange;
  const [source, setSource] = useState<UsageSource>("all");
  const [donutMetric, setDonutMetric] = useState<ModelMetricMode>("token");
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [report, setReport] = useState<DashboardSummaryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  const unknownText = t("usage.unknown");

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    const query = usageQuery({ range: effectiveRange, source }, Date.now());
    api
      .readDashboardReport(owner, "summary", query, abort.signal)
      .then(
        (data) => {
          if (!abort.signal.aborted) setReport(data);
        },
        (err: unknown) => {
          if (!abort.signal.aborted) {
            setError(err instanceof Error ? err.message : String(err));
          }
        },
      )
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [api, owner, effectiveRange, source, refreshSignal]);

  const modelDist: ModelDistribution[] = useMemo(() => {
    if (!report) return [];
    return report.models.map((row, idx) => {
      const label = row.provider_id && row.model
        ? `${row.provider_id}/${row.model}`
        : row.model ?? row.provider_id ?? unknownText;
      const tokens = row.usage.total_tokens.reported_total ?? 0;
      const cost = row.estimated_cost_usd;
      return {
        model: label,
        platform: row.provider_id ?? unknownText,
        req: row.requests,
        tokenStr: formatTokenCount(row.usage.total_tokens.reported_total, unknownText),
        tokenVal: tokens,
        actual: formatUsdEstimate(cost, unknownText),
        actualVal: cost ?? 0,
        std: row.estimated_saved_usd !== null && cost !== null
          ? formatUsdEstimate(cost + row.estimated_saved_usd, unknownText)
          : unknownText,
        stdVal: (cost ?? 0) + (row.estimated_saved_usd ?? 0),
        color: CHART_COLORS[idx % CHART_COLORS.length],
      };
    });
  }, [report, unknownText]);

  const trendPoints: TrendPoint[] = useMemo(() => {
    if (!report) return [];
    return report.series.map((bucket) => ({
      label: formatBucketLabel(bucket.start_ms, report.range, state.resolvedLocale),
      input: bucket.usage.input_tokens.reported_total ?? 0,
      output: bucket.usage.output_tokens.reported_total ?? 0,
      cacheCreate: bucket.usage.cache_write_tokens.reported_total ?? 0,
      cacheRead: bucket.usage.cache_read_tokens.reported_total ?? 0,
      hitRate:
        bucket.reported_cache.cache_hit_rate !== null
          ? Number((bucket.reported_cache.cache_hit_rate * 100).toFixed(1))
          : 0,
    }));
  }, [report, state.resolvedLocale]);

  if (loading && !report) {
    return (
      <div className="sb-view-container">
        <div className="sb-card p-6 text-xs text-neutral-400" role="status">
          {t("console.loading")}
        </div>
      </div>
    );
  }

  if (error && !report) {
    return (
      <div className="sb-view-container">
        <div className="sb-card p-4 border-rose-500/20 text-xs text-rose-400" role="alert">
          {error}
        </div>
      </div>
    );
  }

  if (!report) return null;

  const kpi = report.kpi;
  const rangeText = `${new Date(report.window.bucket_starts_ms[0] ?? report.window.ends_at_ms).toLocaleDateString(state.resolvedLocale)} – ${new Date(report.window.ends_at_ms).toLocaleDateString(state.resolvedLocale)}`;

  return (
    <div className="sb-view-container space-y-4">
      {error && (
        <div className="sb-card p-3 border-rose-500/20 text-xs text-rose-400" role="alert">
          {error}
        </div>
      )}

      {/* Coverage & OpenRouter reference pricing disclosure */}
      <div className="sb-card p-3 flex flex-wrap items-center justify-between text-xs font-mono text-neutral-400 gap-2">
        <span>
          {t("usage.coverageSummary", {
            days: report.coverage.retention_days,
            cap: report.coverage.capacity_events,
          })}
          {report.coverage.truncated_by_capacity ? ` · ${t("usage.truncatedCapacity")}` : ""}
        </span>
        <span className="text-neutral-500">{t("usage.openrouterEstimateNote")}</span>
      </div>

      {/* 8-Dimensional Real KPI Card Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {/* 1. Requests Volume */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
              <polyline points="17 6 23 6 23 12" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">{t("usage.kpi.requests")}</div>
            <div className="text-xl font-bold text-white mono-num mt-0.5">
              {kpi.requests.toLocaleString()}
            </div>
            <div className="text-[11px] text-neutral-500 mt-0.5 mono-num truncate">
              {t("usage.kpi.todayAndRetained", {
                today: kpi.today_requests.toLocaleString(),
                retained: kpi.retained_requests.toLocaleString(),
              })}
            </div>
          </div>
        </div>

        {/* 2. API Keys */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M21 2l-2 2m-1-1l-3 3m0 0l-1-1m-2 2l-1-1m-2 2a5.5 5.5 0 1 0-7.78 7.78 5.5 5.5 0 0 0 7.78-7.78z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">{t("usage.kpi.keys")}</div>
            <div className="text-xl font-bold text-white mono-num mt-0.5">
              {kpi.total_api_keys === null ? unknownText : kpi.total_api_keys.toLocaleString()}
            </div>
            <div className="text-[11px] text-emerald-400 mt-0.5 mono-num">
              {kpi.active_api_keys === null
                ? unknownText
                : t("usage.kpi.activeCount", { count: kpi.active_api_keys })}
            </div>
          </div>
        </div>

        {/* 3. Sessions */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 shrink-0">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">{t("usage.kpi.sessions")}</div>
            <div className="text-xl font-bold text-white mono-num mt-0.5">
              {kpi.active_sessions === null
                ? `${unknownText} / ${kpi.total_sessions}`
                : `${kpi.active_sessions} / ${kpi.total_sessions}`}
            </div>
            <div className="text-[11px] text-neutral-500 mt-0.5 mono-num truncate">
              {kpi.unavailable_sessions > 0
                ? t("usage.kpi.unavailableSessions", { count: kpi.unavailable_sessions })
                : t("usage.kpi.activeSessionsNote")}
            </div>
          </div>
        </div>

        {/* 4. Estimated Cost & Savings (Reference Estimate) */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 shrink-0">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">{t("usage.kpi.estimatedCost")}</div>
            <div className="mt-0.5 flex items-baseline gap-1.5 flex-wrap">
              <span className="text-xl font-bold text-purple-400 mono-num">
                {formatUsdEstimate(kpi.estimated_cost_usd, unknownText)}
              </span>
            </div>
            <div className="text-[11px] text-emerald-400 mt-0.5 mono-num truncate">
              {t("usage.kpi.savedAndCoverage", {
                saved: formatUsdEstimate(kpi.estimated_saved_usd, unknownText),
                priced: kpi.priced_requests,
                total: kpi.requests,
              })}
            </div>
          </div>
        </div>

        {/* 5. Input & Cache Read Tokens */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 shrink-0">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">{t("usage.kpi.inputTokens")}</div>
            <div className="text-xl font-bold text-white mono-num mt-0.5">
              {formatTokenCount(kpi.usage.input_tokens.reported_total, unknownText)}
            </div>
            <div className="text-[11px] text-neutral-500 mt-0.5 mono-num truncate">
              {t("usage.kpi.cacheReadSub", {
                read: formatTokenCount(kpi.usage.cache_read_tokens.reported_total, unknownText),
                write: formatTokenCount(kpi.usage.cache_write_tokens.reported_total, unknownText),
              })}
            </div>
          </div>
        </div>

        {/* 6. Output & Total Tokens */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 shrink-0">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">{t("usage.kpi.totalTokens")}</div>
            <div className="text-xl font-bold text-white mono-num mt-0.5">
              {formatTokenCount(kpi.usage.total_tokens.reported_total, unknownText)}
            </div>
            <div className="text-[11px] text-neutral-500 mt-0.5 mono-num truncate">
              {t("usage.kpi.outputSub", {
                output: formatTokenCount(kpi.usage.output_tokens.reported_total, unknownText),
                reasoning: formatTokenCount(kpi.usage.reasoning_tokens.reported_total, unknownText),
              })}
            </div>
          </div>
        </div>

        {/* 7. Reported Cache Hit Rate */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 shrink-0">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">{t("usage.kpi.cacheRate")}</div>
            <div className="text-xl font-bold text-purple-400 mono-num mt-0.5">
              {formatPercent(kpi.reported_cache.cache_hit_rate, unknownText)}
            </div>
            <div className="text-[11px] text-neutral-500 mt-0.5 mono-num truncate">
              {t("usage.kpi.pairedSamples", {
                paired: kpi.reported_cache.paired_samples,
                attempted: kpi.reported_cache.attempted_samples,
              })}
            </div>
          </div>
        </div>

        {/* 8. Avg Latency & TTFT */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 shrink-0">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">{t("usage.kpi.latency")}</div>
            <div className="text-xl font-bold text-rose-400 mono-num mt-0.5">
              {formatMs(kpi.average_latency_ms, unknownText)}
            </div>
            <div className="text-[11px] text-neutral-500 mt-0.5 mono-num truncate">
              {t("usage.kpi.ttftSub", {
                ttft: formatMs(kpi.average_ttft_ms, unknownText),
                samples: kpi.latency_samples,
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Protocol / Platform Summary Cards */}
      <div className="sb-card p-4 md:p-5">
        <div className="flex items-center justify-between mb-3.5">
          <h2 className="text-xs font-semibold text-neutral-200 uppercase tracking-wider">
            {t("usage.protocols.title")}
          </h2>
          <span className="text-[11px] text-neutral-500 font-mono">
            {t("usage.protocols.count", { count: report.platforms.length })}
          </span>
        </div>
        {report.platforms.length === 0 ? (
          <p className="text-xs text-neutral-500" role="status">
            {t("usage.emptyWindow")}
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
            {report.platforms.map((plat) => {
              const name = plat.protocol ?? unknownText;
              const badgeColor =
                name === "anthropic"
                  ? "text-amber-400 bg-amber-400/10 border-amber-400/20"
                  : name.startsWith("openai")
                    ? "text-emerald-400 bg-emerald-400/10 border-emerald-400/20"
                    : "text-purple-400 bg-purple-400/10 border-purple-400/20";
              return (
                <div key={name} className="sb-terminal-box p-3.5">
                  <div className="flex items-center justify-between mb-2.5">
                    <span className={`px-2 py-0.5 rounded text-[11px] font-mono border ${badgeColor}`}>
                      {name}
                    </span>
                    <span className="text-[11px] text-neutral-400 font-mono">
                      {formatPercent(plat.reported_cache.cache_hit_rate, unknownText)}
                    </span>
                  </div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center justify-between text-neutral-400">
                      <span>{t("usage.col.requests")}:</span>
                      <strong className="text-white mono-num">
                        {plat.requests.toLocaleString()}
                      </strong>
                    </div>
                    <div className="flex items-center justify-between text-neutral-400">
                      <span>{t("usage.col.tokens")}:</span>
                      <strong className="text-cyan-400 mono-num">
                        {formatTokenCount(plat.usage.total_tokens.reported_total, unknownText)}
                      </strong>
                    </div>
                    <div className="flex items-center justify-between text-neutral-400">
                      <span>{t("usage.col.estimatedCost")}:</span>
                      <strong className="text-emerald-400 mono-num">
                        {formatUsdEstimate(plat.estimated_cost_usd, unknownText)}
                      </strong>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Time Range & Source Filter Bar */}
      <div className="sb-card px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400">{t("usage.filter.range")}:</span>
            <div className="sb-btn-group">
              {(["24h", "7d", "30d"] as UsageRange[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`sb-btn-group-item ${effectiveRange === r ? "active" : ""}`}
                  onClick={() => {
                    setRange(r);
                    setRangeOverride(true);
                  }}
                >
                  {t(`console.range.${r}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400">{t("usage.filter.source")}:</span>
            <div className="sb-btn-group">
              {(["all", "session", "relay"] as UsageSource[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`sb-btn-group-item ${source === s ? "active" : ""}`}
                  onClick={() => setSource(s)}
                >
                  {t(`usage.source.${s}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="text-xs text-neutral-500 font-mono">
          <span>{rangeText}</span>
        </div>
      </div>

      {/* Pure SVG Charts Row: Donut Chart & Multi-Series Trend Chart */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        <div className="xl:col-span-5 sb-card p-4 md:p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-neutral-200">
              {t("usage.models.distribution")}
            </h3>
            <div className="sb-btn-group">
              <button
                type="button"
                className={`sb-btn-group-item ${donutMetric === "token" ? "active" : ""}`}
                onClick={() => setDonutMetric("token")}
              >
                Token
              </button>
              <button
                type="button"
                className={`sb-btn-group-item ${donutMetric === "cost" ? "active" : ""}`}
                onClick={() => setDonutMetric("cost")}
              >
                {t("usage.col.estimatedCost")}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-center my-2">
            <DonutChart
              data={modelDist}
              metric={donutMetric}
              tokenUnit="tokens"
              selectedModel={selectedModel}
              onSelectModel={(m) => setSelectedModel((prev) => (prev === m ? null : m))}
              showLegend={false}
            />
          </div>

          <div className="overflow-x-auto mt-3">
            {modelDist.length === 0 ? (
              <p className="text-xs text-neutral-500 text-center py-4" role="status">
                {t("usage.emptyWindow")}
              </p>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-dash-line text-neutral-500 text-[11px]">
                    <th className="pb-2 font-medium">{t("usage.col.model")}</th>
                    <th className="pb-2 text-right font-medium">{t("usage.col.requests")}</th>
                    <th className="pb-2 text-right font-medium">Token</th>
                    <th className="pb-2 text-right font-medium">{t("usage.col.estimatedCost")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dash-line font-mono">
                  {modelDist.map((m) => {
                    const isSelected = selectedModel === m.model;
                    return (
                      <tr
                        key={m.model}
                        className={`hover:bg-dash-soft cursor-pointer transition-colors ${
                          isSelected ? "bg-emerald-500/10" : ""
                        }`}
                        onClick={() =>
                          setSelectedModel((prev) => (prev === m.model ? null : m.model))
                        }
                      >
                        <td className="py-2 flex items-center gap-2">
                          <span
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: m.color }}
                          />
                          <span className="text-neutral-200 font-sans truncate max-w-[160px]" title={m.model}>
                            {m.model}
                          </span>
                        </td>
                        <td className="py-2 text-right text-neutral-400">
                          {m.req.toLocaleString()}
                        </td>
                        <td className="py-2 text-right text-cyan-400">
                          {m.tokenStr}
                        </td>
                        <td className="py-2 text-right text-purple-400 font-semibold">
                          {m.actual}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="xl:col-span-7 sb-card p-4 md:p-5 flex flex-col justify-between">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
            <div>
              <h3 className="text-xs font-semibold text-neutral-200">
                {t("usage.trend.title")}
              </h3>
              <p className="text-[11px] text-neutral-500 mt-0.5">
                {t("usage.trend.subtitle")}
              </p>
            </div>
          </div>

          <div className="w-full my-auto">
            <TrendAreaChart
              points={trendPoints}
              tokenUnit="tokens"
              timeRangeText={rangeText}
              height={280}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
