import React, { useState } from "react";
import { useApp } from "../../../state";
import type { TimeRange, ModelMetricMode, ModelDistribution } from "../types";
import {
  mockRangeDatasets,
  mockPlatformStats,
  mockModelDistribution,
} from "../mockData";
import { DonutChart, TrendAreaChart } from "../SvgCharts";

export interface OverviewTabProps {
  timeRange?: TimeRange;
  onTimeRangeChange?: (range: TimeRange) => void;
  onSelectModel?: (model: string) => void;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({
  timeRange: controlledRange,
  onTimeRangeChange,
  onSelectModel,
}) => {
  const { state } = useApp();
  const board = state.board;
  const [internalRange, setInternalRange] = useState<TimeRange>("24h");
  const activeRange = controlledRange ?? internalRange;
  const setRange = (r: TimeRange) => {
    setInternalRange(r);
    onTimeRangeChange?.(r);
  };

  const [donutMetric, setDonutMetric] = useState<ModelMetricMode>("token");
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const dataset = mockRangeDatasets[activeRange] || mockRangeDatasets["24h"];
  const kpi = dataset.kpi;
  const platformStats = mockPlatformStats;
  const modelDist = mockModelDistribution;

  const handleModelClick = (model: string) => {
    const next = selectedModel === model ? null : model;
    setSelectedModel(next);
    if (next) onSelectModel?.(next);
  };

  return (
    <div className="sb-view-container space-y-4">
      {board.status && (
        <div className="sb-card p-3 flex flex-wrap items-center justify-between text-xs font-mono text-neutral-400 gap-2">
          <span>
            工作区{" "}
            {board.status?.workspaceRoot || board.status?.workspace || ""}
          </span>
          <span className="text-neutral-500">
            keys: {board.status?.keys ?? "-"} · sessions:{" "}
            {board.status?.sessions ?? "-"}
          </span>
        </div>
      )}
      {/* 8-Dimensional KPI Card Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {/* 1. Usable Balance */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">可用余额</div>
            <div className="text-xl font-bold text-emerald-400 mono-num mt-0.5">
              ${kpi.balanceUsd.toFixed(2)}
            </div>
            <div className="text-[11px] text-neutral-500 mt-0.5">
              {kpi.balanceStatus}
            </div>
          </div>
        </div>

        {/* 2. API Keys */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 2l-2 2m-1-1l-3 3m0 0l-1-1m-2 2l-1-1m-2 2a5.5 5.5 0 1 0-7.78 7.78 5.5 5.5 0 0 0 7.78-7.78z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">API 密钥</div>
            <div className="text-xl font-bold text-white mono-num mt-0.5">
              {kpi.totalKeys}
            </div>
            <div className="text-[11px] text-emerald-400 mt-0.5">
              <span>{kpi.activeKeys}</span> 活跃启用
            </div>
          </div>
        </div>

        {/* 3. Requests Volume */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
              <polyline points="17 6 23 6 23 12" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">今日请求数</div>
            <div className="text-xl font-bold text-white mono-num mt-0.5">
              {kpi.todayRequests.toLocaleString()}
            </div>
            <div className="text-[11px] text-neutral-500 mt-0.5 mono-num">
              总计: {kpi.totalRequests.toLocaleString()}
            </div>
          </div>
        </div>

        {/* 4. Cost & Savings */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <line x1="2" y1="10" x2="22" y2="10" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">今日实付消费</div>
            <div className="mt-0.5 flex items-baseline gap-1 flex-wrap">
              <span className="text-xl font-bold text-purple-400 mono-num">
                ${kpi.todayActualCost.toFixed(2)}
              </span>
              <span className="text-[11px] text-neutral-500 line-through mono-num">
                ${kpi.todayStdCost.toFixed(2)}
              </span>
            </div>
            <div className="text-[11px] text-emerald-400 mt-0.5 mono-num truncate">
              节省 ${(kpi.todayStdCost - kpi.todayActualCost).toFixed(2)}
            </div>
          </div>
        </div>

        {/* 5. Today Token Breakdown */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">今日 Token</div>
            <div className="text-xl font-bold text-white mono-num mt-0.5">
              {kpi.todayTokens}
            </div>
            <div className="text-[10px] text-neutral-500 mt-0.5 mono-num truncate">
              缓存:{" "}
              <span className="text-cyan-400">{kpi.todayCacheTokens}</span> ·
              输入: {kpi.todayInputTokens}
            </div>
          </div>
        </div>

        {/* 6. Cumulative Tokens */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400 shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">累计 Token</div>
            <div className="text-xl font-bold text-white mono-num mt-0.5">
              {kpi.totalTokens}
            </div>
            <div className="text-[10px] text-neutral-500 mt-0.5 mono-num truncate">
              缓存:{" "}
              <span className="text-cyan-400">{kpi.totalCacheTokens}</span> ·
              输出: {kpi.totalOutputTokens}
            </div>
          </div>
        </div>

        {/* 7. Realtime RPM & TPM */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">
              性能指标 (Throughput)
            </div>
            <div className="mt-0.5 flex items-baseline gap-1.5">
              <span className="text-xl font-bold text-purple-400 mono-num">
                {kpi.rpm}
              </span>
              <span className="text-xs text-neutral-400 font-mono">RPM</span>
            </div>
            <div className="text-[11px] text-neutral-500 mt-0.5 mono-num">
              TPM:{" "}
              <span className="text-neutral-300 font-semibold">{kpi.tpm}</span>
            </div>
          </div>
        </div>

        {/* 8. Avg Latency & TTFT */}
        <div className="sb-card p-4 flex items-center gap-3.5">
          <div className="w-10 h-10 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 shrink-0">
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-neutral-400">平均响应时延</div>
            <div className="text-xl font-bold text-rose-400 mono-num mt-0.5">
              {kpi.avgLatency}
            </div>
            <div className="text-[11px] text-neutral-500 mt-0.5">
              TTFT 0.68s 首字直出
            </div>
          </div>
        </div>
      </div>

      {/* Platform Summary Cards */}
      <div className="sb-card p-4 md:p-5">
        <div className="flex items-center justify-between mb-3.5">
          <h2 className="text-xs font-semibold text-neutral-200 uppercase tracking-wider">
            平台生态分布 (Platform Ecosystems)
          </h2>
          <span className="text-[11px] text-neutral-500 font-mono">
            3 大核心提供商活跃
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          {platformStats.map((plat) => {
            const isClaude = plat.platform === "Claude";
            const isOpenAI = plat.platform === "OpenAI";
            const badgeColor = isClaude
              ? "text-amber-400 bg-amber-400/10 border-amber-400/20"
              : isOpenAI
                ? "text-emerald-400 bg-emerald-400/10 border-emerald-400/20"
                : "text-purple-400 bg-purple-400/10 border-purple-400/20";

            return (
              <div
                key={plat.platform}
                className="sb-terminal-box p-3.5 hover:border-dash-line transition-colors"
              >
                <div className="flex items-center justify-between mb-2.5">
                  <span
                    className={`px-2 py-0.5 rounded text-[11px] font-mono border ${badgeColor}`}
                  >
                    {plat.platform}
                  </span>
                  <span className="text-[11px] text-neutral-400 font-mono">
                    {plat.activeModelsCount ?? 4} 模型接入
                  </span>
                </div>
                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center justify-between text-neutral-400">
                    <span>请求总数:</span>
                    <strong className="text-white mono-num">
                      {plat.requests.toLocaleString()}
                    </strong>
                  </div>
                  <div className="flex items-center justify-between text-neutral-400">
                    <span>Token 总量:</span>
                    <strong className="text-cyan-400 mono-num">
                      {plat.tokens}
                    </strong>
                  </div>
                  <div className="flex items-center justify-between text-neutral-400">
                    <span>今日 / 累计费用:</span>
                    <span className="mono-num">
                      <strong className="text-emerald-400">
                        ${plat.todayCost.toFixed(2)}
                      </strong>
                      <span className="text-neutral-500">
                        {" "}
                        / ${plat.totalCost.toFixed(2)}
                      </span>
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Time Range Filter Bar */}
      <div className="sb-card px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-400">统计周期:</span>
          <div className="sb-btn-group">
            {(["24h", "7d", "30d"] as TimeRange[]).map((r) => (
              <button
                key={r}
                type="button"
                className={`sb-btn-group-item ${activeRange === r ? "active" : ""}`}
                onClick={() => setRange(r)}
              >
                {r === "24h"
                  ? "最近 24 小时"
                  : r === "7d"
                    ? "最近 7 天"
                    : "最近 30 天"}
              </button>
            ))}
          </div>
        </div>

        <div className="text-xs text-neutral-500 font-mono">
          <span>当前区间：</span>
          <strong className="text-neutral-300">{dataset.rangeText}</strong>
        </div>
      </div>

      {/* Pure SVG Charts Row: Donut Chart & Multi-Series Trend Chart */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* Left: Donut Chart & Model Comparison */}
        <div className="xl:col-span-5 sb-card p-4 md:p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-neutral-200">
              模型占比分布
            </h3>
            {/* Toggle Token / Cost */}
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
                实付费用
              </button>
            </div>
          </div>

          <div className="flex items-center justify-center my-2">
            <DonutChart
              data={modelDist}
              metric={donutMetric}
              selectedModel={selectedModel}
              onSelectModel={handleModelClick}
              showLegend={false}
            />
          </div>

          {/* Model Comparison Table */}
          <div className="overflow-x-auto mt-3">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-dash-line text-neutral-500 text-[11px]">
                  <th className="pb-2 font-medium">模型</th>
                  <th className="pb-2 text-right font-medium">请求</th>
                  <th className="pb-2 text-right font-medium">Token</th>
                  <th className="pb-2 text-right font-medium">实付 / 标准</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dash-line font-mono">
                {modelDist.map((m: ModelDistribution) => {
                  const isSelected = selectedModel === m.model;
                  return (
                    <tr
                      key={m.model}
                      className={`hover:bg-dash-soft cursor-pointer transition-colors ${
                        isSelected ? "bg-emerald-500/10" : ""
                      }`}
                      onClick={() => handleModelClick(m.model)}
                    >
                      <td className="py-2 flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: m.color }}
                        />
                        <span className="text-neutral-200 font-sans truncate max-w-[130px]">
                          {m.model}
                        </span>
                      </td>
                      <td className="py-2 text-right text-neutral-400">
                        {m.req.toLocaleString()}
                      </td>
                      <td className="py-2 text-right text-cyan-400">
                        {m.tokenStr}
                      </td>
                      <td className="py-2 text-right">
                        <span className="text-purple-400 font-semibold">
                          {m.actual}
                        </span>
                        <span className="text-neutral-600 ml-1 text-[10px] line-through">
                          {m.std}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right: Pure SVG Multi-Series Trend Chart */}
        <div className="xl:col-span-7 sb-card p-4 md:p-5 flex flex-col justify-between">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
            <div>
              <h3 className="text-xs font-semibold text-neutral-200">
                用量与命中率趋势 (Timeseries Telemetry)
              </h3>
              <p className="text-[11px] text-neutral-500 mt-0.5">
                支持输入、输出、Cache Read、Cache Write 与命中率折线切换
              </p>
            </div>
          </div>

          <div className="w-full my-auto">
            <TrendAreaChart
              points={dataset.points}
              timeRangeText={dataset.rangeText}
              height={280}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
