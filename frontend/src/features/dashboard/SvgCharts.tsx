/**
 * Pure SVG Responsive Chart Components for sbclaw Dashboard (v0.3.14)
 * Completely zero third-party chart dependencies, theme-adaptive (dark/light),
 * featuring smooth Bezier curves, interactive tooltips, and dynamic series filtering.
 */

import React, { useState, useMemo, useRef, useCallback } from "react";
import type {
  ModelDistribution,
  TrendPoint,
  OpsMetricsPoint,
  ModelMetricMode,
} from "./types";

// ============================================================================
// Helper Utilities for SVG Geometry & Formatting
// ============================================================================

/** Format numbers cleanly with standard abbreviations (K, M, B) or decimals */
function formatMetricNumber(val: number, isPercent = false): string {
  if (isPercent) {
    return `${val.toFixed(1)}%`;
  }
  if (Math.abs(val) >= 1_000_000) {
    return `${(val / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(val) >= 1_000) {
    return `${(val / 1_000).toFixed(1)}K`;
  }
  if (val % 1 !== 0) {
    return val.toFixed(2);
  }
  return val.toString();
}

function formatTokenScale(val: number, unit: "millions" | "tokens"): string {
  if (unit === "millions") return `${val.toFixed(1)}M`;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return Math.round(val).toLocaleString();
}

/** Cubic Bezier curve path generator with smooth Catmull-Rom interpolation */
function generateSmoothCurve(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1)
    return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;

  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

// ============================================================================
// 1. DonutChart: Model Distribution Ring Chart
// ============================================================================

export interface DonutChartProps {
  data: ModelDistribution[];
  metric?: ModelMetricMode;
  tokenUnit?: "millions" | "tokens";
  onMetricChange?: (metric: ModelMetricMode) => void;
  selectedModel?: string | null;
  onSelectModel?: (model: string) => void;
  showLegend?: boolean;
  className?: string;
}

export const DonutChart: React.FC<DonutChartProps> = ({
  data,
  metric = "token",
  tokenUnit = "millions",
  onMetricChange,
  selectedModel,
  onSelectModel,
  showLegend = true,
  className = "",
}) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Compute total volume according to active metric mode
  const { totalVal, slices } = useMemo(() => {
    const total = data.reduce(
      (sum, item) =>
        sum + (metric === "token" ? item.tokenVal : item.actualVal),
      0,
    );

    let startAngle = -Math.PI / 2; // Start from top 12 o'clock
    const computedSlices = data.map((item, idx) => {
      const val = metric === "token" ? item.tokenVal : item.actualVal;
      const fraction = total > 0 ? val / total : 0;
      const angleSweep = fraction * 2 * Math.PI;
      const endAngle = startAngle + angleSweep;

      const sliceData = {
        item,
        idx,
        val,
        fraction,
        percent: (fraction * 100).toFixed(1),
        startAngle,
        endAngle,
      };

      startAngle = endAngle;
      return sliceData;
    });

    return { totalVal: total, slices: computedSlices };
  }, [data, metric]);

  const cx = 110;
  const cy = 110;
  const baseR = 86;
  const innerR = 56;

  // Active slice for dynamic center inspection
  const activeSlice = hoveredIdx !== null ? slices[hoveredIdx] : null;

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Metric Mode Switcher Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-neutral-200">模型分布</h3>
        {onMetricChange && (
          <div className="flex items-center gap-1 bg-dash-terminal border border-dash-line rounded p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => onMetricChange("token")}
              className={`px-2 py-0.5 rounded transition-colors ${
                metric === "token"
                  ? "bg-dash-soft text-neutral-100 font-medium"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              Token
            </button>
            <button
              type="button"
              onClick={() => onMetricChange("cost")}
              className={`px-2 py-0.5 rounded transition-colors ${
                metric === "cost"
                  ? "bg-dash-soft text-neutral-100 font-medium"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              实际费用
            </button>
          </div>
        )}
      </div>

      {/* Main Grid: SVG Donut on Left, Interactive Legend Table on Right */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center flex-1">
        {/* Donut SVG */}
        <div className="md:col-span-5 relative flex items-center justify-center">
          <svg
            viewBox="0 0 220 220"
            className="w-48 h-48 max-w-full select-none"
            aria-label="Model Distribution Donut Chart"
          >
            {/* Background ring placeholder */}
            <circle
              cx={cx}
              cy={cy}
              r={(baseR + innerR) / 2}
              fill="none"
              stroke="var(--border)"
              strokeWidth={baseR - innerR}
              opacity={0.3}
            />

            {/* Slices */}
            {slices.map((slice) => {
              if (slice.val <= 0 || totalVal <= 0) return null;

              const isHovered = hoveredIdx === slice.idx;
              const isSelected = selectedModel === slice.item.model;
              const rOut = isHovered || isSelected ? baseR + 4 : baseR;
              const rIn = isHovered || isSelected ? innerR - 2 : innerR;

              // Annular sector path computation with slight slice separation gap
              const gap = slices.length > 1 ? 0.02 : 0;
              const a0 = slice.startAngle + gap;
              const a1 = slice.endAngle - gap;

              if (a1 <= a0) return null;

              const x1 = cx + rOut * Math.cos(a0);
              const y1 = cy + rOut * Math.sin(a0);
              const x2 = cx + rOut * Math.cos(a1);
              const y2 = cy + rOut * Math.sin(a1);
              const x3 = cx + rIn * Math.cos(a1);
              const y3 = cy + rIn * Math.sin(a1);
              const x4 = cx + rIn * Math.cos(a0);
              const y4 = cy + rIn * Math.sin(a0);

              const largeArcFlag = a1 - a0 > Math.PI ? 1 : 0;

              const pathD = [
                `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
                `A ${rOut} ${rOut} 0 ${largeArcFlag} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
                `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
                `A ${rIn} ${rIn} 0 ${largeArcFlag} 0 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
                "Z",
              ].join(" ");

              return (
                <path
                  key={slice.item.model}
                  d={pathD}
                  fill={slice.item.color}
                  className="cursor-pointer"
                  opacity={
                    hoveredIdx === null || isHovered || isSelected ? 1 : 0.35
                  }
                  stroke={
                    isHovered || isSelected ? "var(--text)" : "transparent"
                  }
                  strokeWidth={isHovered || isSelected ? 1.5 : 0}
                  onMouseEnter={() => setHoveredIdx(slice.idx)}
                  onMouseLeave={() => setHoveredIdx(null)}
                  onClick={() => onSelectModel?.(slice.item.model)}
                >
                  <title>
                    {`${slice.item.model}: ${
                      metric === "token"
                        ? slice.item.tokenStr
                        : slice.item.actual
                    } (${slice.percent}%)`}
                  </title>
                </path>
              );
            })}

            {/* Dynamic Center Metrics */}
            <g className="pointer-events-none text-center">
              {activeSlice ? (
                <>
                  <text
                    x={cx}
                    y={cy - 12}
                    textAnchor="middle"
                    className="text-[10px] font-mono fill-neutral-400"
                  >
                    {activeSlice.item.model.length > 14
                      ? `${activeSlice.item.model.slice(0, 12)}...`
                      : activeSlice.item.model}
                  </text>
                  <text
                    x={cx}
                    y={cy + 7}
                    textAnchor="middle"
                    className="text-sm font-bold font-mono fill-white"
                  >
                    {metric === "token"
                      ? activeSlice.item.tokenStr
                      : activeSlice.item.actual}
                  </text>
                  <text
                    x={cx}
                    y={cy + 22}
                    textAnchor="middle"
                    className="text-[11px] font-semibold font-mono fill-emerald-400"
                  >
                    {activeSlice.percent}%
                  </text>
                </>
              ) : (
                <>
                  <text
                    x={cx}
                    y={cy - 6}
                    textAnchor="middle"
                    className="text-[11px] font-medium fill-neutral-400"
                  >
                    {metric === "token" ? "总用量" : "参考估算"}
                  </text>
                  <text
                    x={cx}
                    y={cy + 14}
                    textAnchor="middle"
                    className="text-base font-bold font-mono fill-white"
                  >
                    {metric === "token"
                      ? formatTokenScale(totalVal, tokenUnit)
                      : `$${totalVal.toFixed(4)}`}
                  </text>
                </>
              )}
            </g>
          </svg>
        </div>

        {/* Legend Table */}
        {showLegend && (
          <div className="md:col-span-7 overflow-x-auto w-full">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-dash-line text-[11px] text-neutral-400">
                  <th className="pb-1.5 font-medium">模型</th>
                  <th className="pb-1.5 font-medium text-right">请求</th>
                  <th className="pb-1.5 font-medium text-right">
                    {metric === "token" ? "Token" : "实际费用"}
                  </th>
                  <th className="pb-1.5 font-medium text-right">占比</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dash-line text-xs font-mono">
                {slices.map((slice) => {
                  const isHovered = hoveredIdx === slice.idx;
                  const isSelected = selectedModel === slice.item.model;

                  return (
                    <tr
                      key={slice.item.model}
                      onMouseEnter={() => setHoveredIdx(slice.idx)}
                      onMouseLeave={() => setHoveredIdx(null)}
                      onClick={() => onSelectModel?.(slice.item.model)}
                      className={`cursor-pointer transition-colors ${
                        isHovered || isSelected
                          ? "bg-dash-soft"
                          : "hover:bg-dash-soft"
                      }`}
                    >
                      <td className="py-1.5 flex items-center gap-2 text-neutral-200">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: slice.item.color }}
                        />
                        <span
                          className="truncate max-w-[120px]"
                          title={slice.item.model}
                        >
                          {slice.item.model}
                        </span>
                      </td>
                      <td className="py-1.5 text-right text-neutral-400">
                        {slice.item.req.toLocaleString()}
                      </td>
                      <td className="py-1.5 text-right text-neutral-200 font-semibold">
                        {metric === "token"
                          ? slice.item.tokenStr
                          : slice.item.actual}
                      </td>
                      <td className="py-1.5 text-right text-neutral-400">
                        {slice.percent}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 2. TrendAreaChart: Multi-Series Bezier Area/Line Chart
// ============================================================================

export interface TrendAreaChartProps {
  points: TrendPoint[];
  tokenUnit?: "millions" | "tokens";
  height?: number;
  timeRangeText?: string;
  className?: string;
}

interface SeriesItem {
  key: keyof Omit<TrendPoint, "label">;
  label: string;
  color: string;
  yAxis: "left" | "right";
  unit: string;
}

const TREND_SERIES: SeriesItem[] = [
  {
    key: "input",
    label: "Input",
    color: "var(--chart-2)",
    yAxis: "left",
    unit: "M",
  },
  {
    key: "output",
    label: "Output",
    color: "var(--chart-1)",
    yAxis: "left",
    unit: "M",
  },
  {
    key: "cacheCreate",
    label: "Cache Creation",
    color: "var(--chart-4)",
    yAxis: "left",
    unit: "M",
  },
  {
    key: "cacheRead",
    label: "Cache Read",
    color: "var(--chart-6)",
    yAxis: "left",
    unit: "M",
  },
  {
    key: "hitRate",
    label: "Cache Hit Rate",
    color: "var(--chart-3)",
    yAxis: "right",
    unit: "%",
  },
];

export const TrendAreaChart: React.FC<TrendAreaChartProps> = ({
  points,
  tokenUnit = "millions",
  height = 260,
  timeRangeText,
  className = "",
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeSeries, setActiveSeries] = useState<Record<string, boolean>>({
    input: true,
    output: true,
    cacheCreate: true,
    cacheRead: true,
    hitRate: true,
  });

  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const toggleSeries = (key: string) => {
    setActiveSeries((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Dimensions & bounds in SVG coordinate space
  const svgWidth = 840;
  const svgHeight = height;
  const margin = { top: 24, right: 48, bottom: 36, left: 48 };
  const plotWidth = svgWidth - margin.left - margin.right;
  const plotHeight = svgHeight - margin.top - margin.bottom;

  // Calculate scales
  const { maxVolume, coordsBySeries } = useMemo(() => {
    let maxV = 1.0;
    TREND_SERIES.filter(
      (s) => s.yAxis === "left" && activeSeries[s.key],
    ).forEach((s) => {
      points.forEach((p) => {
        const val = Number(p[s.key]) || 0;
        if (val > maxV) maxV = val;
      });
    });
    // Add 15% headroom
    maxV = maxV * 1.15;

    const coords: Record<string, { x: number; y: number }[]> = {};
    TREND_SERIES.forEach((s) => {
      if (!activeSeries[s.key]) {
        coords[s.key] = [];
        return;
      }
      coords[s.key] = points.map((p, i) => {
        const x =
          points.length > 1
            ? margin.left + (i / (points.length - 1)) * plotWidth
            : margin.left + plotWidth / 2;

        let y = margin.top + plotHeight;
        if (s.yAxis === "left") {
          const val = Number(p[s.key]) || 0;
          y = margin.top + plotHeight - (val / maxV) * plotHeight;
        } else {
          // Right axis: hitRate 0..100%
          const val = Math.min(100, Math.max(0, Number(p.hitRate) || 0));
          y = margin.top + plotHeight - (val / 100) * plotHeight;
        }
        return { x, y };
      });
    });

    return { maxVolume: maxV, coordsBySeries: coords };
  }, [points, activeSeries, plotWidth, plotHeight, margin]);

  // Handle SVG mouse movement to find nearest point
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (points.length === 0) return;
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const clientX = e.clientX - rect.left;
      const scaleX = svgWidth / rect.width;
      const svgX = clientX * scaleX;

      // Find closest point index
      let closestIdx = 0;
      let minDiff = Infinity;
      points.forEach((_, i) => {
        const ptX =
          points.length > 1
            ? margin.left + (i / (points.length - 1)) * plotWidth
            : margin.left + plotWidth / 2;
        const diff = Math.abs(svgX - ptX);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = i;
        }
      });

      setHoveredIdx(closestIdx);
    },
    [points, plotWidth, margin, svgWidth],
  );

  const handleMouseLeave = () => {
    setHoveredIdx(null);
  };

  // Y-ticks (Left for Token Volume, Right for Hit Rate)
  const yTicks = [0, 0.25, 0.5, 0.75, 1.0];
  const hoveredPoint = hoveredIdx !== null ? points[hoveredIdx] : null;
  const hoveredX =
    hoveredIdx !== null && points.length > 1
      ? margin.left + (hoveredIdx / (points.length - 1)) * plotWidth
      : null;

  return (
    <div ref={containerRef} className={`flex flex-col h-full ${className}`}>
      {/* Header Bar: Title + Series Toggles */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-neutral-200">
            Token 使用趋势
          </h3>
          {timeRangeText && (
            <span className="text-[11px] text-neutral-500 font-mono hidden md:inline">
              {timeRangeText}
            </span>
          )}
        </div>

        {/* Series Toggles */}
        <div className="flex flex-wrap items-center gap-2.5 select-none">
          {TREND_SERIES.map((s) => {
            const isActive = activeSeries[s.key];
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => toggleSeries(s.key)}
                className={`flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded border ${
                  isActive
                    ? "border-transparent text-neutral-200 font-medium"
                    : "border-transparent text-neutral-500 opacity-50 hover:opacity-80"
                }`}
                style={{
                  backgroundColor: isActive
                    ? "color-mix(in srgb, var(--text) 5%, transparent)"
                    : "transparent",
                }}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full border-2"
                  style={{
                    borderColor: s.color,
                    backgroundColor: isActive ? s.color : "transparent",
                  }}
                />
                <span>{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* SVG Canvas Container */}
      <div className="relative flex-1 w-full min-h-[200px]">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="w-full h-full select-none overflow-visible"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          <defs>
            {/* Gradients for each active area fill */}
            {TREND_SERIES.map((s) => (
              <linearGradient
                key={`grad-${s.key}`}
                id={`grad-${s.key}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={s.color} stopOpacity="0.25" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0.01" />
              </linearGradient>
            ))}
          </defs>

          {/* Grid lines and horizontal ticks */}
          {yTicks.map((ratio) => {
            const y = margin.top + plotHeight - ratio * plotHeight;
            const leftVal = ratio * maxVolume;
            const rightVal = Math.round(ratio * 100);

            return (
              <g key={ratio}>
                <line
                  x1={margin.left}
                  y1={y}
                  x2={margin.left + plotWidth}
                  y2={y}
                  stroke="var(--border)"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                  opacity={0.6}
                />
                {/* Left Y Axis Label (Volume) */}
                <text
                  x={margin.left - 8}
                  y={y + 3.5}
                  textAnchor="end"
                  className="text-[10px] font-mono fill-neutral-400"
                >
                  {formatMetricNumber(leftVal)}
                </text>
                {/* Right Y Axis Label (Hit Rate %) */}
                <text
                  x={margin.left + plotWidth + 8}
                  y={y + 3.5}
                  textAnchor="start"
                  className="text-[10px] font-mono fill-purple-400"
                >
                  {rightVal}%
                </text>
              </g>
            );
          })}

          {/* X Axis Labels */}
          {points.map((p, i) => {
            // Decimate labels for dense points (e.g. 24h or 30d)
            const shouldRenderLabel =
              points.length <= 8
                ? true
                : points.length <= 16
                  ? i % 2 === 0 || i === points.length - 1
                  : points.length <= 25
                    ? i % 4 === 0 || i === points.length - 1
                    : i % 5 === 0 || i === points.length - 1;

            if (!shouldRenderLabel) return null;

            const x =
              points.length > 1
                ? margin.left + (i / (points.length - 1)) * plotWidth
                : margin.left + plotWidth / 2;

            return (
              <text
                key={p.label + i}
                x={x}
                y={margin.top + plotHeight + 18}
                textAnchor="middle"
                className="text-[10px] font-mono fill-neutral-400"
              >
                {p.label}
              </text>
            );
          })}

          {/* Area & Stroke Paths for Each Visible Series */}
          {TREND_SERIES.map((s) => {
            const pts = coordsBySeries[s.key];
            if (!pts || pts.length === 0) return null;

            const curveD = generateSmoothCurve(pts);
            const baselineY = margin.top + plotHeight;
            const areaD = `${curveD} L ${pts[pts.length - 1].x.toFixed(1)} ${baselineY} L ${pts[0].x.toFixed(1)} ${baselineY} Z`;

            return (
              <g key={s.key} className="transition-opacity duration-200">
                {/* Gradient Area Fill (except for rate series where line is clearer) */}
                {s.yAxis === "left" && (
                  <path
                    d={areaD}
                    fill={`url(#grad-${s.key})`}
                    className="pointer-events-none"
                  />
                )}
                {/* Curve Stroke Line */}
                <path
                  d={curveD}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.key === "hitRate" ? 2.5 : 1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="pointer-events-none"
                />
              </g>
            );
          })}

          {/* Hover Indicator Vertical Line & Data Markers */}
          {hoveredX !== null && hoveredIdx !== null && (
            <g className="pointer-events-none">
              <line
                x1={hoveredX}
                y1={margin.top}
                x2={hoveredX}
                y2={margin.top + plotHeight}
                stroke="var(--text)"
                strokeDasharray="4 4"
                strokeWidth="1.2"
                opacity={0.4}
              />

              {/* Point Marker Circles */}
              {TREND_SERIES.map((s) => {
                if (!activeSeries[s.key]) return null;
                const pt = coordsBySeries[s.key]?.[hoveredIdx];
                if (!pt) return null;

                return (
                  <circle
                    key={s.key}
                    cx={pt.x}
                    cy={pt.y}
                    r={4}
                    fill={s.color}
                    stroke="var(--surface)"
                    strokeWidth={2}
                    className="pointer-events-none"
                  />
                );
              })}
            </g>
          )}
        </svg>

        {/* Floating Tooltip Card */}
        {hoveredPoint && hoveredX !== null && (
          <div
            className="absolute top-2 pointer-events-none z-30 text-xs bg-dash-terminal border border-dash-line rounded-lg p-2.5 text-neutral-200 font-mono space-y-1.5"
            style={{
              left: `${Math.min(
                Math.max(10, (hoveredX / svgWidth) * 100),
                75,
              )}%`,
            }}
          >
            <div className="font-bold text-white text-[11px] pb-1 border-b border-dash-line flex items-center justify-between gap-4">
              <span>{hoveredPoint.label}</span>
              <span className="text-[10px] text-neutral-400 font-normal">
                指标快照
              </span>
            </div>
            <div className="space-y-1 text-[11px]">
              {TREND_SERIES.map((s) => {
                if (!activeSeries[s.key]) return null;
                const val = hoveredPoint[s.key];
                return (
                  <div
                    key={s.key}
                    className="flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-1.5">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: s.color }}
                      />
                      <span className="text-neutral-400">{s.label}:</span>
                    </div>
                    <span className="font-semibold text-white">
                      {s.unit === "%"
                        ? `${Number(val).toFixed(1)}%`
                        : formatTokenScale(Number(val) || 0, tokenUnit)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 3. OpsBarChart: Throughput QPS & Latency Composite Chart
// ============================================================================

export interface OpsBarChartProps {
  data: OpsMetricsPoint[];
  height?: number;
  title?: string;
  className?: string;
}

export const OpsBarChart: React.FC<OpsBarChartProps> = ({
  data,
  height = 220,
  title = "吞吐 QPS 与时延趋势",
  className = "",
}) => {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const svgWidth = 640;
  const svgHeight = height;
  const margin = { top: 20, right: 48, bottom: 32, left: 44 };
  const plotWidth = svgWidth - margin.left - margin.right;
  const plotHeight = svgHeight - margin.top - margin.bottom;

  // Max bounds
  const { maxQps, maxLatency, coords } = useMemo(() => {
    let qMax = 10;
    let lMax = 100;
    data.forEach((d) => {
      if (d.qps > qMax) qMax = d.qps;
      if (d.latencyMs > lMax) lMax = d.latencyMs;
    });

    qMax = Math.ceil(qMax * 1.2);
    lMax = Math.ceil(lMax * 1.25);

    const calculated = data.map((d, i) => {
      const x =
        data.length > 1
          ? margin.left + (i / (data.length - 1)) * plotWidth
          : margin.left + plotWidth / 2;
      const barH = (d.qps / qMax) * plotHeight;
      const barY = margin.top + plotHeight - barH;
      const latencyY =
        margin.top + plotHeight - (d.latencyMs / lMax) * plotHeight;

      return { x, barH, barY, latencyY, item: d };
    });

    return { maxQps: qMax, maxLatency: lMax, coords: calculated };
  }, [data, plotWidth, plotHeight, margin]);

  // Latency smooth curve line
  const latencyCurve = useMemo(() => {
    const pts = coords.map((c) => ({ x: c.x, y: c.latencyY }));
    return generateSmoothCurve(pts);
  }, [coords]);

  const barWidth = Math.max(
    10,
    Math.min(28, (plotWidth / (data.length || 1)) * 0.48),
  );
  const hoveredItem = hoveredIdx !== null ? coords[hoveredIdx] : null;

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-neutral-200">{title}</h3>
        <div className="flex items-center gap-3 text-[11px] font-mono text-neutral-400">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded bg-emerald-500" />
            <span>QPS (条/秒)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-0.5 bg-amber-400" />
            <span>时延 (ms)</span>
          </div>
        </div>
      </div>

      {/* SVG Container */}
      <div className="relative flex-1 w-full min-h-[170px]">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="w-full h-full select-none overflow-visible"
        >
          <defs>
            <linearGradient id="qpsBarGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.85" />
              <stop
                offset="100%"
                stopColor="var(--chart-6)"
                stopOpacity="0.35"
              />
            </linearGradient>
            <linearGradient id="qpsBarHoverGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="1" />
              <stop
                offset="100%"
                stopColor="var(--chart-6)"
                stopOpacity="0.65"
              />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          {[0, 0.33, 0.66, 1.0].map((ratio) => {
            const y = margin.top + plotHeight - ratio * plotHeight;
            const qVal = Math.round(ratio * maxQps);
            const lVal = Math.round(ratio * maxLatency);

            return (
              <g key={ratio}>
                <line
                  x1={margin.left}
                  y1={y}
                  x2={margin.left + plotWidth}
                  y2={y}
                  stroke="var(--border)"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                  opacity={0.5}
                />
                <text
                  x={margin.left - 6}
                  y={y + 3.5}
                  textAnchor="end"
                  className="text-[10px] font-mono fill-neutral-400"
                >
                  {qVal}
                </text>
                <text
                  x={margin.left + plotWidth + 6}
                  y={y + 3.5}
                  textAnchor="start"
                  className="text-[10px] font-mono fill-amber-400"
                >
                  {lVal}
                </text>
              </g>
            );
          })}

          {/* QPS Bars */}
          {coords.map((c, i) => {
            const isHovered = hoveredIdx === i;
            return (
              <rect
                key={c.item.time + i}
                x={c.x - barWidth / 2}
                y={c.barY}
                width={barWidth}
                height={Math.max(2, c.barH)}
                rx={3}
                fill={isHovered ? "url(#qpsBarHoverGrad)" : "url(#qpsBarGrad)"}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
              />
            );
          })}

          {/* Latency Smooth Line */}
          <path
            d={latencyCurve}
            fill="none"
            stroke="var(--chart-4)"
            strokeWidth={2}
            strokeLinecap="round"
            className="pointer-events-none"
          />

          {/* Latency Markers */}
          {coords.map((c, i) => {
            const isHovered = hoveredIdx === i;
            return (
              <circle
                key={`dot-${c.item.time}-${i}`}
                cx={c.x}
                cy={c.latencyY}
                r={isHovered ? 4.5 : 2.5}
                fill="var(--chart-4)"
                stroke="var(--surface)"
                strokeWidth={1.5}
                className="pointer-events-none"
              />
            );
          })}

          {/* X-Axis Time Labels */}
          {coords.map((c, i) => {
            const shouldRender =
              coords.length <= 10
                ? true
                : i % 2 === 0 || i === coords.length - 1;

            if (!shouldRender) return null;

            return (
              <text
                key={`label-${c.item.time}-${i}`}
                x={c.x}
                y={margin.top + plotHeight + 16}
                textAnchor="middle"
                className="text-[10px] font-mono fill-neutral-400"
              >
                {c.item.time}
              </text>
            );
          })}
        </svg>

        {/* Hover Tooltip Card */}
        {hoveredItem && (
          <div
            className="absolute top-1 pointer-events-none z-30 text-xs bg-dash-surface border border-dash-line rounded-md p-2 text-neutral-200 font-mono space-y-1"
            style={{
              left: `${Math.min(
                Math.max(8, (hoveredItem.x / svgWidth) * 100),
                78,
              )}%`,
            }}
          >
            <div className="font-semibold text-white text-[11px] pb-0.5 border-b border-dash-line">
              {hoveredItem.item.time}
            </div>
            <div className="flex items-center justify-between gap-3 text-[11px]">
              <span className="text-emerald-400">QPS:</span>
              <span className="font-bold text-white">
                {hoveredItem.item.qps}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 text-[11px]">
              <span className="text-amber-400">平均耗时:</span>
              <span className="font-bold text-white">
                {hoveredItem.item.latencyMs}ms
              </span>
            </div>
            {hoveredItem.item.errorRate > 0 && (
              <div className="flex items-center justify-between gap-3 text-[11px]">
                <span className="text-rose-400">错误率:</span>
                <span className="font-bold text-rose-300">
                  {(hoveredItem.item.errorRate * 100).toFixed(1)}%
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
