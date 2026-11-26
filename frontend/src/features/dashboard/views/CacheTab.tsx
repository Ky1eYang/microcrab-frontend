import React, { useEffect, useState } from "react";
import type { ApiClient } from "../../../client/api";
import {
  formatTokenCount,
  formatUsdEstimate,
  usageQuery,
  type DashboardDiagnosticsReport,
  type DashboardSummaryReport,
  type UsageRange,
} from "../../../client/dashboard-usage";
import { t } from "../../../i18n";
import { useAppFields } from "../../../state";

function formatPct(rate: number | null | undefined, unknownText: string) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return unknownText;
  }
  return `${(rate * 100).toFixed(1)}%`;
}

export const CacheTab: React.FC<{
  owner: string;
  api: ApiClient;
  refreshSignal?: number;
}> = ({ owner, api, refreshSignal = 0 }) => {
  const { state } = useAppFields(["accountPreferences"]);
  const unknownText = t("usage.unknown");
  const defaultRange: UsageRange = state.accountPreferences?.dashboard_default_range ?? "7d";
  const defaultWarn = state.accountPreferences?.low_cache_hit_warn_pct ?? undefined;

  const [range, setRange] = useState<UsageRange>(defaultRange);
  const [rangeOverride, setRangeOverride] = useState(false);
  const effectiveRange = rangeOverride ? range : defaultRange;
  const [warnInput, setWarnInput] = useState<string>(defaultWarn?.toString() ?? "");
  const [appliedWarn, setAppliedWarn] = useState<number | undefined>(defaultWarn);
  const [diag, setDiag] = useState<DashboardDiagnosticsReport | null>(null);
  const [summary, setSummary] = useState<DashboardSummaryReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [simRate, setSimRate] = useState<number>(80);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    const now = Date.now();
    const diagQuery = usageQuery(
      { range: effectiveRange, source: "all", low_cache_hit_warn_pct: appliedWarn },
      now,
    );
    const sumQuery = usageQuery({ range: effectiveRange, source: "all" }, now);
    Promise.all([
      api.readDashboardReport(owner, "cache-diagnostics", diagQuery, abort.signal),
      api.readDashboardReport(owner, "summary", sumQuery, abort.signal),
    ])
      .then(
        ([diagData, sumData]) => {
          if (!abort.signal.aborted) {
            setDiag(diagData);
            setSummary(sumData);
          }
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
  }, [api, owner, effectiveRange, appliedWarn, refreshSignal]);

  if (loading && !diag) {
    return (
      <div className="sb-view-container">
        <div className="sb-card p-6 text-xs text-neutral-400" role="status">
          {t("console.loading")}
        </div>
      </div>
    );
  }

  if (error && !diag) {
    return (
      <div className="sb-view-container">
        <div className="sb-card p-4 border-rose-500/20 text-xs text-rose-400" role="alert">
          {error}
        </div>
      </div>
    );
  }

  if (!diag || !summary) return null;

  const kpi = summary.kpi;
  const estCost = kpi.estimated_cost_usd;
  const estSaved = kpi.estimated_saved_usd;
  const baseUncached =
    estCost !== null ? estCost + (estSaved ?? 0) : null;
  const simSaved =
    baseUncached !== null ? Math.max(0, baseUncached * (simRate / 100) * 0.9) : null;
  const simActual =
    baseUncached !== null && simSaved !== null ? Math.max(0, baseUncached - simSaved) : null;

  return (
    <div className="sb-view-container space-y-4">
      {error && (
        <div className="sb-card p-3 border-rose-500/20 text-xs text-rose-400" role="alert">
          {error}
        </div>
      )}

      {/* Filter & Threshold Control Row */}
      <div className="sb-card px-4 py-3 flex flex-wrap items-center justify-between gap-3">
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

        <form
          className="flex items-center gap-2 text-xs"
          onSubmit={(e) => {
            e.preventDefault();
            const n = warnInput.trim() === "" ? undefined : Number(warnInput);
            setAppliedWarn(n && Number.isInteger(n) && n >= 1 && n <= 99 ? n : undefined);
          }}
        >
          <label htmlFor="cache-warn-pct" className="text-neutral-400">
            {t("usage.cache.warnThreshold")}:
          </label>
          <input
            id="cache-warn-pct"
            type="number"
            min={1}
            max={99}
            className="sb-input w-20"
            value={warnInput}
            placeholder="60"
            onChange={(e) => setWarnInput(e.target.value)}
          />
          <button type="submit" className="sb-btn sb-btn-secondary sb-btn-sm">
            {t("usage.cache.apply")}
          </button>
        </form>
      </div>

      {/* 4-Dimensional Cache Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="sb-card p-4">
          <div className="text-xs text-neutral-400">{t("usage.kpi.cacheRate")}</div>
          <div className="text-xl font-bold text-emerald-400 mono-num mt-1">
            {formatPct(kpi.reported_cache.cache_hit_rate, unknownText)}
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5 font-mono">
            {formatTokenCount(kpi.reported_cache.cache_read_tokens, unknownText)} /{" "}
            {formatTokenCount(kpi.reported_cache.input_tokens, unknownText)}
          </div>
        </div>

        <div className="sb-card p-4">
          <div className="text-xs text-neutral-400">{t("usage.cache.pairedSamples")}</div>
          <div className="text-xl font-bold text-cyan-400 mono-num mt-1">
            {kpi.reported_cache.paired_samples} / {kpi.reported_cache.attempted_samples}
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5 font-mono">
            {t("usage.cache.reportedOnlyNote")}
          </div>
        </div>

        <div className="sb-card p-4">
          <div className="text-xs text-neutral-400">{t("usage.cache.writeTokens")}</div>
          <div className="text-xl font-bold text-purple-400 mono-num mt-1">
            {formatTokenCount(kpi.usage.cache_write_tokens.reported_total, unknownText)}
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5 font-mono">
            {t("usage.kpi.latency")}:{" "}
            {kpi.average_latency_ms !== null
              ? `${Math.round(kpi.average_latency_ms)}ms`
              : unknownText}
          </div>
        </div>

        <div className="sb-card p-4">
          <div className="text-xs text-neutral-400">{t("usage.cache.estimatedSaved")}</div>
          <div className="text-xl font-bold text-emerald-400 mono-num mt-1">
            {formatUsdEstimate(kpi.estimated_saved_usd, unknownText)}
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5 font-mono">
            {t("usage.openrouterShort")}
          </div>
        </div>
      </div>

      {/* Main Grid: Left Model Details, Right Diagnostics & Interactive Simulator */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-7 sb-card p-4 md:p-5">
          <div className="flex items-center justify-between mb-3.5">
            <h3 className="text-xs font-semibold text-neutral-200">
              {t("usage.cache.modelTableTitle")}
            </h3>
            <span className="text-[11px] text-neutral-500 font-mono">
              {t("usage.cache.tableSub")}
            </span>
          </div>

          <div className="overflow-x-auto">
            {diag.models.length === 0 ? (
              <p className="text-xs text-neutral-500 py-6 text-center" role="status">
                {t("usage.emptyWindow")}
              </p>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-dash-line bg-dash-terminal text-[11px] text-neutral-400 font-mono">
                    <th className="py-2.5 px-3 font-medium">{t("usage.col.model")}</th>
                    <th className="py-2.5 px-3 text-right font-medium">{t("usage.cache.pairedInput")}</th>
                    <th className="py-2.5 px-3 text-right font-medium">Cache Read</th>
                    <th className="py-2.5 px-3 text-right font-medium">Cache Write</th>
                    <th className="py-2.5 px-3 text-right font-medium">{t("usage.kpi.cacheRate")}</th>
                    <th className="py-2.5 px-3 text-right font-medium">{t("usage.cache.estimatedSaved")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dash-line font-mono">
                  {diag.models.map((row) => {
                    const rate = row.reported_cache.cache_hit_rate;
                    const ratePct = rate !== null ? rate * 100 : null;
                    const modelName = row.provider_id && row.model
                      ? `${row.provider_id}/${row.model}`
                      : row.model ?? row.provider_id ?? unknownText;
                    return (
                      <tr key={modelName} className="hover:bg-dash-soft transition-colors">
                        <td className="py-2.5 px-3 font-sans text-neutral-200 font-medium">
                          {modelName}
                        </td>
                        <td className="py-2.5 px-3 text-right text-neutral-300">
                          {formatTokenCount(row.reported_cache.input_tokens, unknownText)}
                        </td>
                        <td className="py-2.5 px-3 text-right text-cyan-400">
                          {formatTokenCount(row.reported_cache.cache_read_tokens, unknownText)}
                        </td>
                        <td className="py-2.5 px-3 text-right text-amber-400">
                          {formatTokenCount(row.usage.cache_write_tokens.reported_total, unknownText)}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <span
                            className={`font-semibold ${
                              ratePct === null
                                ? "text-neutral-400"
                                : ratePct >= 90
                                  ? "text-emerald-400"
                                  : ratePct >= 70
                                    ? "text-amber-400"
                                    : "text-rose-400"
                            }`}
                          >
                            {formatPct(rate, unknownText)}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right text-purple-400 font-semibold">
                          {formatUsdEstimate(row.estimated_saved_usd, unknownText)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="lg:col-span-5 space-y-4">
          {/* Real Cache Diagnostics */}
          <div className="sb-card p-4 md:p-5 space-y-3">
            <h3 className="text-xs font-semibold text-neutral-200">
              {t("usage.cache.diagnosticsTitle")}
            </h3>
            {diag.diagnostics.length === 0 ? (
              <p className="text-xs text-neutral-500" role="status">
                {t("usage.cache.noDiagnostics")}
              </p>
            ) : (
              <div className="space-y-2.5">
                {diag.diagnostics.map((item, idx) => (
                  <div
                    key={`${item.code}-${item.provider_id ?? ""}-${item.model ?? idx}`}
                    className="sb-terminal-box p-3 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-neutral-200 font-medium truncate">
                        {item.provider_id}/{item.model}
                      </span>
                      <span
                        className={`font-mono text-[10px] px-1.5 py-0.5 rounded border ${
                          item.code === "cache_hit_rate_below_threshold"
                            ? "text-amber-400 border-amber-500/20 bg-amber-500/10"
                            : "text-neutral-400 border-neutral-700 bg-neutral-800"
                        }`}
                      >
                        {t(`usage.diag.${item.code}`)}
                      </span>
                    </div>
                    <p className="text-[11px] text-neutral-500 leading-relaxed">
                      {item.code === "cache_hit_rate_below_threshold"
                        ? t("usage.diag.belowThresholdDesc", {
                            actual: formatPct(item.hit_rate, unknownText),
                            threshold: item.threshold_pct ?? 0,
                          })
                        : t("usage.diag.unreportedDesc", {
                            paired: item.paired_samples,
                            attempted: item.attempted_samples ?? 0,
                          })}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Interactive Cache Reference Simulator (anchored on real priced baseline) */}
          <div className="sb-card p-4 md:p-5 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-200 font-semibold">
                {t("usage.cache.simulatorTitle")}
              </span>
              <span className="font-mono text-emerald-400 text-sm font-bold">
                {simRate}%
              </span>
            </div>

            {baseUncached !== null && baseUncached > 0 ? (
              <>
                <div className="text-[11px] text-neutral-500">
                  {t("usage.cache.simulatorHint")}
                </div>
                <input
                  type="range"
                  min={0}
                  max={99}
                  value={simRate}
                  aria-label={t("usage.cache.simulatorTitle")}
                  onChange={(e) => setSimRate(parseInt(e.target.value, 10))}
                  className="sb-slider w-full accent-ink cursor-pointer h-2 bg-dash-soft rounded-lg"
                />
                <div className="sb-terminal-box p-3 grid grid-cols-3 gap-2 text-center text-xs font-mono">
                  <div>
                    <div className="text-[10px] text-neutral-500">{t("usage.cache.simBase")}</div>
                    <div className="text-neutral-300 font-bold mt-1">
                      ${baseUncached.toFixed(4)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-purple-400">{t("usage.cache.simEst")}</div>
                    <div className="text-purple-400 font-bold mt-1">
                      ${(simActual ?? 0).toFixed(4)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-emerald-400">{t("usage.cache.simSaved")}</div>
                    <div className="text-emerald-400 font-bold mt-1">
                      ${(simSaved ?? 0).toFixed(4)}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-[11px] text-neutral-500" role="status">
                {t("usage.cache.simulatorUnavailable")}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
