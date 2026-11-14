import React, { useState } from "react";
import { mockCacheStats } from "../mockData";
import { t } from "../../../i18n";

export const CacheTab: React.FC = () => {
  const stats = mockCacheStats;

  // Simulator state: default 96%
  const [simRate, setSimRate] = useState<number>(96);

  // Dynamic calculation per formula:
  // std = 277.37
  // actual = Math.max(12.5, std * (1 - (rate / 100) * 0.90))
  // saved = std - actual
  const stdCost = stats.todayStdCost; // 277.37
  const simActualCost = Math.max(12.5, stdCost * (1 - (simRate / 100) * 0.9));
  const simSavedCost = stdCost - simActualCost;

  return (
    <div className="sb-view-container space-y-4">
      <p
        style={{
          borderLeft: "2px solid var(--warn)",
          paddingLeft: "var(--sp-3)",
          color: "var(--text-2)",
          fontSize: "var(--fs-sm)",
        }}
        role="note"
        data-testid="cache-sample-notice"
      >
        {t("dashboard.cache.sampleData")}
      </p>
      {/* 4-Dimensional Cache Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {/* 1. Today Hit Rate */}
        <div className="sb-card p-4">
          <div className="text-xs text-neutral-400">今日缓存命中率</div>
          <div className="text-xl font-bold text-emerald-400 mono-num mt-1">
            {stats.todayHitRate.toFixed(1)}%
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5 font-mono">
            {stats.todayHitTokens} 命中 / {stats.todayTotalTokens} 总计
          </div>
        </div>

        {/* 2. Cumulative Hit Rate */}
        <div className="sb-card p-4">
          <div className="text-xs text-neutral-400">累计缓存命中率</div>
          <div className="text-xl font-bold text-cyan-400 mono-num mt-1">
            {stats.totalHitRate.toFixed(1)}%
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5 font-mono">
            {stats.totalHitTokens} 命中 / {stats.totalTotalTokens} 总计
          </div>
        </div>

        {/* 3. Latency Saved */}
        <div className="sb-card p-4">
          <div className="text-xs text-neutral-400">预估节省时延</div>
          <div className="text-xl font-bold text-purple-400 mono-num mt-1">
            ~1.45s / req
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5 font-mono">
            跳过模型重算直接读取缓存
          </div>
        </div>

        {/* 4. Cost Saved */}
        <div className="sb-card p-4">
          <div className="text-xs text-neutral-400">今日节省金额折算</div>
          <div className="text-xl font-bold text-emerald-400 mono-num mt-1">
            ${stats.todaySavedCost.toFixed(2)}
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5 font-mono">
            累计节省:{" "}
            <span className="text-neutral-300">
              ${stats.totalSavedCost.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Main Grid: Left Model Details, Right Diagnosis & Simulator */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Left: Model Cache Breakdown Table */}
        <div className="lg:col-span-7 sb-card p-4 md:p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3.5">
              <h3 className="text-xs font-semibold text-neutral-200">
                各模型缓存命中率与折算明细 (Model Cache Breakdown)
              </h3>
              <span className="text-[11px] text-neutral-500 font-mono">
                自动对齐 Prompt Caching
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-dash-line bg-dash-terminal text-[11px] text-neutral-400 font-mono">
                    <th className="py-2.5 px-3 font-medium">模型名称</th>
                    <th className="py-2.5 px-3 text-right font-medium">
                      总输入
                    </th>
                    <th className="py-2.5 px-3 text-right font-medium">
                      Cache Read
                    </th>
                    <th className="py-2.5 px-3 text-right font-medium">
                      Cache Write
                    </th>
                    <th className="py-2.5 px-3 text-right font-medium">
                      命中率
                    </th>
                    <th className="py-2.5 px-3 text-right font-medium">
                      节省金额
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dash-line font-mono">
                  {stats.modelBreakdown.map((row) => (
                    <tr
                      key={row.model}
                      className="hover:bg-dash-soft transition-colors"
                    >
                      <td className="py-2.5 px-3 font-sans text-neutral-200 font-medium">
                        {row.model}
                      </td>
                      <td className="py-2.5 px-3 text-right text-neutral-300">
                        {row.totalInput}
                      </td>
                      <td className="py-2.5 px-3 text-right text-cyan-400">
                        {row.cacheRead}
                      </td>
                      <td className="py-2.5 px-3 text-right text-amber-400">
                        {row.cacheWrite}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <span
                          className={`font-semibold ${
                            row.hitRate >= 90
                              ? "text-emerald-400"
                              : row.hitRate >= 70
                                ? "text-amber-400"
                                : "text-rose-400"
                          }`}
                        >
                          {row.hitRate.toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right text-purple-400 font-semibold">
                        ${row.savedCost.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right: 4 Root Cause Cards & Simulator */}
        <div className="lg:col-span-5 space-y-4">
          {/* Root Cause Cards */}
          <div className="sb-card p-4 md:p-5 space-y-3">
            <h3 className="text-xs font-semibold text-neutral-200">
              缓存未命中 (Cache Miss) 根因追踪与诊断
            </h3>
            <div className="space-y-2.5">
              {stats.rootCauses.map((cause) => (
                <div
                  key={cause.id}
                  className="sb-terminal-box p-3 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-neutral-200 font-medium">
                      {cause.title}
                    </span>
                    <span
                      className={`font-mono text-[10px] px-1.5 py-0.5 rounded border ${
                        cause.statusColor === "emerald"
                          ? "text-emerald-400 border-emerald-500/20 bg-emerald-500/10"
                          : cause.statusColor === "amber"
                            ? "text-amber-400 border-amber-500/20 bg-amber-500/10"
                            : "text-neutral-400 border-neutral-700 bg-neutral-800"
                      }`}
                    >
                      {cause.status}
                    </span>
                  </div>
                  <p className="text-[11px] text-neutral-500 leading-relaxed">
                    {cause.desc}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Interactive Cache Bill Simulator */}
          <div className="sb-card p-4 md:p-5 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-200 font-semibold">
                命中率账单动态测算 (Simulator)
              </span>
              <span className="font-mono text-emerald-400 text-sm font-bold">
                {simRate}%
              </span>
            </div>

            <div className="text-[11px] text-neutral-500">
              拖动滑块模拟今日 {stats.todayTotalTokens} Token
              在不同命中率下的真实扣费与节省量：
            </div>

            <input
              type="range"
              min="0"
              max="99"
              value={simRate}
              onChange={(e) => setSimRate(parseInt(e.target.value, 10))}
              className="sb-slider w-full accent-ink cursor-pointer h-2 bg-dash-soft rounded-lg"
            />

            <div className="sb-terminal-box p-3 grid grid-cols-3 gap-2 text-center text-xs font-mono">
              <div>
                <div className="text-[10px] text-neutral-500">未缓存标准</div>
                <div className="text-neutral-300 font-bold mt-1">
                  ${stdCost.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-purple-400">测算实付</div>
                <div className="text-purple-400 font-bold mt-1">
                  ${simActualCost.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-emerald-400">测算节省</div>
                <div className="text-emerald-400 font-bold mt-1">
                  ${simSavedCost.toFixed(2)}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
