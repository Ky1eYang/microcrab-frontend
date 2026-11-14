import React, { useState } from "react";
import { mockOpsMetrics } from "../../mockData";
import { OpsBarChart } from "../../SvgCharts";

export const OpsMonitoringView: React.FC = () => {
  const [metrics] = useState(mockOpsMetrics);

  return (
    <div className="sb-view-container space-y-4">
      {/* Header Summary */}
      <div className="sb-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold text-neutral-200">
            运维与节点监控 (Ops & Runtime)
          </h2>
          <p className="text-[11px] text-neutral-500 mt-0.5">
            实时网关 QPS 吞吐、Turn 执行耗时、主机
            CPU/内存负载与熔断熔断通道状态
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex h-2.5 w-2.5 relative">
            <span className="absolute inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
          </span>
          <span className="text-xs text-emerald-400 font-mono">
            Live Telemetry
          </span>
        </div>
      </div>

      {/* 4 Ops Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="sb-card p-4">
          <div className="text-xs text-neutral-400">当前吞吐 (QPS)</div>
          <div className="text-xl font-bold text-white mono-num mt-1">
            {metrics.qps.toFixed(1)}{" "}
            <span className="text-xs text-neutral-400 font-normal">req/s</span>
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5 font-mono">
            活动连接数:{" "}
            <span className="text-emerald-400 font-semibold">
              {metrics.activeConnections}
            </span>
          </div>
        </div>

        <div className="sb-card p-4">
          <div className="text-xs text-neutral-400">网关时延 (P95 / P99)</div>
          <div className="text-xl font-bold text-rose-400 mono-num mt-1">
            {metrics.p95LatencyMs}ms
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5 font-mono">
            Avg: {metrics.avgLatencyMs}ms · P99: {metrics.p99LatencyMs}ms
          </div>
        </div>

        <div className="sb-card p-4">
          <div className="text-xs text-neutral-400">系统 CPU 负载</div>
          <div className="text-xl font-bold text-emerald-400 mono-num mt-1">
            {metrics.cpuUsagePercent.toFixed(1)}%
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5 font-mono">
            4 Cores Allocated
          </div>
        </div>

        <div className="sb-card p-4">
          <div className="text-xs text-neutral-400">进程常驻内存</div>
          <div className="text-xl font-bold text-indigo-400 mono-num mt-1">
            {metrics.memoryUsageMb.toFixed(1)} MB
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5 font-mono">
            运行时长: {Math.floor(metrics.uptimeSeconds / 3600)}h{" "}
            {Math.floor((metrics.uptimeSeconds % 3600) / 60)}m
          </div>
        </div>
      </div>

      {/* Pure SVG QPS & Latency Bar Chart */}
      <div className="sb-card p-4 md:p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-neutral-200">
            最近 10 分钟网关 QPS 与 P95 延迟时序 (Realtime Stream)
          </h3>
          <span className="text-[11px] text-neutral-500 font-mono">
            1 分钟桶聚类
          </span>
        </div>
        <div className="w-full">
          <OpsBarChart data={metrics.historySeries} height={220} />
        </div>
      </div>

      {/* Circuit Breakers & Upstream Health */}
      <div className="sb-card p-4 md:p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-neutral-200">
            上游熔断器状态 (Circuit Breaker Status)
          </h3>
          <span className="text-[11px] text-neutral-500 font-mono">
            连续 3 次探活超时自动熔断
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
          {metrics.circuitBreakers.map((cb) => {
            const isClosed = cb.status === "closed";
            const isHalf = cb.status === "half-open";
            return (
              <div key={cb.channel} className="sb-terminal-box p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-neutral-200">
                    {cb.channel}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
                      isClosed
                        ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                        : isHalf
                          ? "text-amber-400 bg-amber-500/10 border-amber-500/20"
                          : "text-rose-400 bg-rose-500/10 border-rose-500/20"
                    }`}
                  >
                    {cb.status.toUpperCase()}
                  </span>
                </div>
                <div className="text-[11px] text-neutral-400 flex items-center justify-between">
                  <span>失败探测计数:</span>
                  <span className="font-mono text-neutral-200">
                    {cb.failedPings}
                  </span>
                </div>
                <div className="text-[11px] text-neutral-500 font-mono">
                  最近故障: {cb.lastFailureTime || "无故障记录 (Healthy)"}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
