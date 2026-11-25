import { JsonValueView } from "../../content-inspection/JsonValueView";
import { isJsonText } from "../../content-inspection/json-reader-source";
import React, { useEffect, useState, useMemo } from "react";
import type { CallLog } from "../types";
import { mockCallLogs } from "../mockData";

export const UsageLogsView: React.FC = () => {
  const [logs] = useState<CallLog[]>(mockCallLogs);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedPlatform, setSelectedPlatform] = useState("ALL");
  const [selectedModel, setSelectedModel] = useState("ALL");
  const [selectedStatus, setSelectedStatus] = useState("ALL");

  // Selected row for inspector: default to the first row
  const [selectedLogId, setSelectedLogId] = useState<string>(logs[0]?.id || "");
  const [copiedSection, setCopiedSection] = useState<"args" | "output" | null>(
    null,
  );

  // Filter logs
  const filteredLogs = useMemo(() => {
    return logs.filter((item) => {
      if (selectedPlatform !== "ALL" && item.platform !== selectedPlatform) {
        return false;
      }
      if (selectedModel !== "ALL" && item.model !== selectedModel) {
        return false;
      }
      if (selectedStatus !== "ALL") {
        if (selectedStatus === "200" && item.statusCode !== 200) return false;
        if (selectedStatus === "429" && item.statusCode !== 429) return false;
        if (selectedStatus === "500" && item.statusCode !== 500) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchId = item.id.toLowerCase().includes(q);
        const matchModel = item.model.toLowerCase().includes(q);
        const matchKey = item.keyName.toLowerCase().includes(q);
        if (!matchId && !matchModel && !matchKey) return false;
      }
      return true;
    });
  }, [logs, searchQuery, selectedPlatform, selectedModel, selectedStatus]);

  // Selected log item
  const activeLog = useMemo(() => {
    return (
      logs.find((l) => l.id === selectedLogId) || filteredLogs[0] || logs[0]
    );
  }, [logs, selectedLogId, filteredLogs]);

  // CSV export handler
  const handleExportCsv = () => {
    const headers = [
      "RequestID",
      "Time",
      "Platform",
      "Model",
      "UncachedInput",
      "CacheRead",
      "Output",
      "HitRate",
      "ActualCost",
      "StdCost",
      "Duration",
      "Status",
    ];
    const rows = filteredLogs.map((r) => [
      r.id,
      r.time,
      r.platform,
      r.model,
      r.inputUncached,
      r.cacheRead,
      r.output,
      `${r.hitRate}%`,
      r.actualCost,
      r.stdCost,
      r.duration,
      r.statusCode,
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((e) => e.join(",")),
    ].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", `sbclaw_usage_logs_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleResetFilters = () => {
    setSearchQuery("");
    setSelectedPlatform("ALL");
    setSelectedModel("ALL");
    setSelectedStatus("ALL");
  };

  const copyToClipboard = (text: string, section: "args" | "output") => {
    navigator.clipboard?.writeText(text);
    setCopiedSection(section);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  return (
    <div className="sb-view-container space-y-4">
      {/* Filter Toolbar */}
      <div className="sb-card p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[280px]">
          {/* Search Box */}
          <div className="relative min-w-[200px] flex-1 max-w-sm">
            <input
              type="text"
              placeholder="搜索 Request ID / 密钥 / 模型..."
              className="sb-input w-full pl-8"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <svg
              className="w-3.5 h-3.5 text-neutral-500 absolute left-2.5 top-2.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </div>

          {/* Platform Select */}
          <select
            className="sb-select text-xs"
            value={selectedPlatform}
            onChange={(e) => setSelectedPlatform(e.target.value)}
          >
            <option value="ALL">全部平台 (Platform)</option>
            <option value="Anthropic">Anthropic (Claude)</option>
            <option value="OpenAI">OpenAI</option>
            <option value="Grok">Grok (xAI)</option>
          </select>

          {/* Model Select */}
          <select
            className="sb-select text-xs"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
          >
            <option value="ALL">全部模型 (Model)</option>
            <option value="claude-3-7-sonnet">claude-3-7-sonnet</option>
            <option value="claude-3-5-sonnet">claude-3-5-sonnet</option>
            <option value="gpt-6-astra">gpt-6-astra</option>
            <option value="gpt-4o">gpt-4o</option>
            <option value="grok-3-super">grok-3-super</option>
          </select>

          {/* Status Select */}
          <select
            className="sb-select text-xs"
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
          >
            <option value="ALL">状态码 (Status)</option>
            <option value="200">200 OK</option>
            <option value="429">429 Rate Limited</option>
            <option value="500">500 Server Error</option>
          </select>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            className="sb-btn sb-btn-ghost sb-btn-sm"
            onClick={handleResetFilters}
          >
            重置
          </button>
          <button
            type="button"
            className="sb-btn sb-btn-secondary sb-btn-sm"
            onClick={handleExportCsv}
          >
            导出 CSV
          </button>
        </div>
      </div>

      {/* Main Row: Left Table, Right Inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        {/* Left: Stream Table */}
        <div className="xl:col-span-7 sb-card overflow-hidden">
          <div className="px-4 py-2.5 border-b border-dash-line bg-dash-terminal flex items-center justify-between text-xs">
            <span className="font-medium text-neutral-200">
              调用流水 ({filteredLogs.length})
            </span>
            <span className="text-neutral-500 font-mono text-[11px]">
              点击行以在检查器中查看入参与响应
            </span>
          </div>

          <div className="overflow-x-auto max-h-[720px] overflow-y-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-dash-terminal z-10">
                <tr className="border-b border-dash-line text-[11px] text-neutral-400 font-medium">
                  <th className="py-2.5 px-3">时间 / ID</th>
                  <th className="py-2.5 px-3">模型 / 状态</th>
                  <th className="py-2.5 px-3">耗时 / TTFT</th>
                  <th className="py-2.5 px-3">Token 分布</th>
                  <th className="py-2.5 px-3 text-right">消费</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dash-line font-mono">
                {filteredLogs.map((row) => {
                  const isSelected = activeLog?.id === row.id;
                  const total =
                    (row.cacheRead || 0) +
                      (row.inputUncached || 0) +
                      (row.output || 0) || 1;
                  const pCache = Math.round(
                    ((row.cacheRead || 0) / total) * 100,
                  );
                  const pIn = Math.round(
                    ((row.inputUncached || 0) / total) * 100,
                  );
                  const pOut = Math.max(0, 100 - pCache - pIn);

                  return (
                    <tr
                      key={row.id}
                      onClick={() => setSelectedLogId(row.id)}
                      className={`cursor-pointer transition-colors ${
                        isSelected
                          ? "bg-emerald-500/15 border-l-2 border-emerald-400"
                          : "hover:bg-dash-soft"
                      }`}
                    >
                      <td className="py-2.5 px-3">
                        <div className="text-neutral-200 text-[11px] font-sans font-medium">
                          {row.time}
                        </div>
                        <div className="text-neutral-500 text-[10px] truncate max-w-[110px]">
                          {row.id}
                        </div>
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="text-neutral-200 font-sans font-medium truncate max-w-[130px]">
                          {row.model}
                        </div>
                        <div className="mt-0.5">
                          {row.statusCode === 200 ? (
                            <span className="px-1.5 py-0.2 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                              200 OK
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.2 rounded text-[10px] bg-rose-500/10 text-rose-400 border border-rose-500/20 font-mono">
                              {row.statusCode}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="text-neutral-300 font-semibold">
                          {row.duration}
                        </div>
                        <div className="text-[10px] text-neutral-500">
                          TTFT {row.ttft}
                        </div>
                      </td>
                      <td className="py-2.5 px-3">
                        {/* 3-Color Token Ratio Bar */}
                        <div className="w-24 h-2 rounded-full bg-dash-terminal overflow-hidden flex border border-dash-line mb-1">
                          <div
                            className="bg-cyan-400 h-full"
                            style={{ width: `${pCache}%` }}
                            title={`Cache Read: ${row.cacheRead.toLocaleString()}`}
                          />
                          <div
                            className="bg-blue-500 h-full"
                            style={{ width: `${pIn}%` }}
                            title={`Uncached In: ${row.inputUncached.toLocaleString()}`}
                          />
                          <div
                            className="bg-emerald-500 h-full"
                            style={{ width: `${pOut}%` }}
                            title={`Output: ${row.output.toLocaleString()}`}
                          />
                        </div>
                        <div className="text-[10px] text-emerald-400">
                          {row.hitRate}% 命中
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <div className="text-purple-400 font-bold">
                          ${row.actualCost.toFixed(4)}
                        </div>
                        <div className="text-neutral-600 line-through text-[10px]">
                          ${row.stdCost.toFixed(4)}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right: Sticky Inspector */}
        <div className="xl:col-span-5 sb-card overflow-hidden sticky top-4">
          <div className="px-3.5 py-2.5 bg-dash-soft border-b border-dash-line flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 font-mono min-w-0">
              <span className="text-emerald-400">~</span>
              <span className="text-neutral-200 font-medium truncate">
                {activeLog?.id || "未选定请求"}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="font-mono text-neutral-400 text-[11px]">
                {activeLog?.duration}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono text-[10px]">
                {activeLog?.statusCode} OK
              </span>
            </div>
          </div>

          {activeLog && (
            <div className="p-3.5 space-y-3">
              {/* Telemetry Grid */}
              <div className="grid grid-cols-2 gap-2 text-xs bg-dash-terminal p-2.5 rounded border border-dash-line font-mono">
                <div>
                  <div className="text-[10px] text-neutral-500 font-sans">
                    平台 / 模型
                  </div>
                  <div className="text-neutral-200 mt-0.5 truncate font-sans font-medium">
                    {activeLog.platform} / {activeLog.model}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-neutral-500 font-sans">
                    调用密钥
                  </div>
                  <div className="text-neutral-300 mt-0.5 truncate">
                    {activeLog.keyName}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-neutral-500 font-sans">
                    首字延迟 / 生成速率
                  </div>
                  <div className="text-neutral-300 mt-0.5">
                    TTFT {activeLog.ttft} · {activeLog.tps} t/s
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-neutral-500 font-sans">
                    缓存折算
                  </div>
                  <div className="text-emerald-400 mt-0.5">
                    命中 {activeLog.hitRate}% (省 $
                    {(activeLog.stdCost - activeLog.actualCost).toFixed(4)})
                  </div>
                </div>
              </div>

              {/* 3-Color Token Breakdown */}
              <div className="space-y-1.5">
                <div className="w-full h-2 rounded-full bg-dash-terminal overflow-hidden flex border border-dash-line">
                  {(() => {
                    const total =
                      (activeLog.cacheRead || 0) +
                        (activeLog.inputUncached || 0) +
                        (activeLog.output || 0) || 1;
                    const pCache = Math.round(
                      ((activeLog.cacheRead || 0) / total) * 100,
                    );
                    const pIn = Math.round(
                      ((activeLog.inputUncached || 0) / total) * 100,
                    );
                    const pOut = Math.max(0, 100 - pCache - pIn);
                    return (
                      <>
                        <div
                          className="bg-cyan-400 h-full"
                          style={{ width: `${pCache}%` }}
                        />
                        <div
                          className="bg-blue-500 h-full"
                          style={{ width: `${pIn}%` }}
                        />
                        <div
                          className="bg-emerald-500 h-full"
                          style={{ width: `${pOut}%` }}
                        />
                      </>
                    );
                  })()}
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
                  <div className="bg-dash-terminal px-2.5 py-1.5 rounded border border-dash-line">
                    <div className="text-cyan-400 text-[10px]">Cache Read</div>
                    <div className="text-neutral-200 font-semibold">
                      {activeLog.cacheRead.toLocaleString()}
                    </div>
                  </div>
                  <div className="bg-dash-terminal px-2.5 py-1.5 rounded border border-dash-line">
                    <div className="text-blue-400 text-[10px]">Uncached In</div>
                    <div className="text-neutral-200 font-semibold">
                      {activeLog.inputUncached.toLocaleString()}
                    </div>
                  </div>
                  <div className="bg-dash-terminal px-2.5 py-1.5 rounded border border-dash-line">
                    <div className="text-emerald-400 text-[10px]">Output</div>
                    <div className="text-neutral-200 font-semibold">
                      {activeLog.output.toLocaleString()}
                    </div>
                  </div>
                </div>
              </div>

              {/* JSON Inspector Blocks */}
              <div className="sb-terminal-box p-3 space-y-2.5 font-mono text-[11px]">
                {/* Arguments */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-neutral-500 text-[10px] uppercase tracking-wider font-sans">
                      ARGUMENTS (REQUEST)
                    </span>
                    <button
                      type="button"
                      className="text-[10px] text-neutral-400 hover:text-white"
                      onClick={() =>
                        copyToClipboard(
                          typeof activeLog.argsJson === "string"
                            ? activeLog.argsJson
                            : JSON.stringify(activeLog.argsJson, null, 2),
                          "args",
                        )
                      }
                    >
                      {copiedSection === "args" ? "已复制 ✓" : "复制 JSON"}
                    </button>
                  </div>
                  <LogDetailsValue key={`${activeLog.id}:args`} value={activeLog.argsJson} />
                </div>

                {/* Output */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-neutral-500 text-[10px] uppercase tracking-wider font-sans">
                      OUTPUT (TELEMETRY)
                    </span>
                    <button
                      type="button"
                      className="text-[10px] text-neutral-400 hover:text-white"
                      onClick={() =>
                        copyToClipboard(
                          typeof activeLog.outputJson === "string"
                            ? activeLog.outputJson
                            : JSON.stringify(activeLog.outputJson, null, 2),
                          "output",
                        )
                      }
                    >
                      {copiedSection === "output" ? "已复制 ✓" : "复制 JSON"}
                    </button>
                  </div>
                  <LogDetailsValue key={`${activeLog.id}:output`} value={activeLog.outputJson} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

function LogDetailsValue({ value }: { value: CallLog["argsJson"] }) {
  const [validated, setValidated] = useState<string>();
  useEffect(() => {
    if (typeof value !== "string") return;
    const controller = new AbortController();
    void isJsonText(value, controller.signal).then((recognized) => {
      if (!controller.signal.aborted) setValidated(recognized ? value : undefined);
    });
    return () => controller.abort();
  }, [value]);
  const recognized = typeof value !== "string" || validated === value;
  const text = () => <pre className="bg-dash-terminal p-2.5 rounded border border-dash-line text-neutral-300 overflow-x-auto leading-relaxed max-h-40">
    {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
  </pre>;
  if (!recognized) return text();
  return <JsonValueView
    source={typeof value === "string" ? { kind: "text", text: value } : { kind: "value", value }}
    renderText={text}
    hideRootCopy
  />;
}
