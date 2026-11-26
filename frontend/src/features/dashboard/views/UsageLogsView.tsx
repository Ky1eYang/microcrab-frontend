import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ApiClient } from "../../../client/api";
import {
  formatTokenCount,
  formatUsdEstimate,
  usageOutcomes,
  usageQuery,
  type UsageFilters,
  type UsageLog,
  type UsageRange,
  type UsageSource,
} from "../../../client/dashboard-usage";
import { t } from "../../../i18n";
import { useAppFields } from "../../../state";
import { JsonValueView } from "../../content-inspection/JsonValueView";
import { isJsonText } from "../../content-inspection/json-reader-source";

function formatDuration(ms: number | null, unknownText: string) {
  if (ms === null || !Number.isFinite(ms)) return unknownText;
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export const UsageLogsView: React.FC<{
  owner?: string;
  api?: ApiClient;
  refreshSignal?: number;
  initialLogs?: UsageLog[];
}> = ({ owner, api, refreshSignal = 0, initialLogs }) => {
  const { state } = useAppFields(["accountPreferences", "resolvedLocale"]);
  const unknownText = t("usage.unknown");
  const defaultRange: UsageRange = state.accountPreferences?.dashboard_default_range ?? "7d";

  const [draft, setDraft] = useState<UsageFilters>({
    range: defaultRange,
    source: "all",
  });
  const [applied, setApplied] = useState<{ filters: UsageFilters; now: number; rev: number }>({
    filters: { range: defaultRange, source: "all" },
    now: Date.now(),
    rev: 0,
  });
  const [cursors, setCursors] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [logs, setLogs] = useState<UsageLog[]>(initialLogs ?? []);
  const [loading, setLoading] = useState(!initialLogs);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string>(initialLogs?.[0]?.event_id ?? "");
  const [csvState, setCsvState] = useState<{ busy: boolean; notice?: string; error?: string }>({
    busy: false,
  });
  const [copiedMetadata, setCopiedMetadata] = useState(false);
  const exportAbort = useRef<AbortController | null>(null);
  const statusListId = useId();

  useEffect(() => {
    if (initialLogs || !owner || !api) return;
    const abort = new AbortController();
    setLoading(true);
    setError("");
    const query = usageQuery(applied.filters, applied.now);
    query.set("limit", "50");
    if (page > 0 && cursors[page - 1]) query.set("cursor", cursors[page - 1]);
    api
      .readDashboardReport(owner, "logs", query, abort.signal)
      .then(
        (res) => {
          if (!abort.signal.aborted) {
            setLogs(res.items);
            setNextCursor(res.next_cursor);
            setSelectedId((prev) =>
              res.items.some((r) => r.event_id === prev)
                ? prev
                : res.items[0]?.event_id ?? "",
            );
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
  }, [api, owner, applied, page, cursors, refreshSignal, initialLogs]);

  useEffect(() => () => exportAbort.current?.abort(), []);

  const activeLog = useMemo(
    () => logs.find((l) => l.event_id === selectedId) ?? logs[0] ?? null,
    [logs, selectedId],
  );

  const handleApplyFilters = (event?: React.FormEvent) => {
    event?.preventDefault();
    setPage(0);
    setCursors([]);
    setApplied((prev) => ({
      filters: {
        ...draft,
        q: draft.q?.trim() || undefined,
        model: draft.model?.trim() || undefined,
        status: draft.status?.trim() || undefined,
      },
      now: Date.now(),
      rev: prev.rev + 1,
    }));
  };

  const handleResetFilters = () => {
    const clean: UsageFilters = { range: defaultRange, source: "all" };
    setDraft(clean);
    setPage(0);
    setCursors([]);
    setApplied((prev) => ({ filters: clean, now: Date.now(), rev: prev.rev + 1 }));
  };

  const handleExportCsv = async () => {
    if (!owner || !api || exportAbort.current) return;
    const controller = new AbortController();
    exportAbort.current = controller;
    setCsvState({ busy: true });
    try {
      const query = usageQuery(applied.filters, applied.now);
      const res = await api.readDashboardReport(owner, "logs.csv", query, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([res.text], { type: "text/csv;charset=UTF-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `microcrab-usage-${Date.now()}.csv`;
      document.body.append(link);
      try {
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setCsvState({
        busy: false,
        notice: t(res.truncated ? "usage.csvTruncated" : "usage.csvReady"),
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        setCsvState({ busy: false, error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      exportAbort.current = null;
    }
  };

  const safeMetadata = useMemo(() => {
    if (!activeLog) return null;
    return {
      event_id: activeLog.event_id,
      request_id: activeLog.request_id,
      ts_ms: activeLog.ts_ms,
      source: activeLog.source,
      source_id: activeLog.source_id,
      source_label: activeLog.source_label,
      provider_id: activeLog.provider_id,
      model: activeLog.model,
      protocol: activeLog.protocol,
      outcome: activeLog.outcome,
      status_code: activeLog.status_code,
      latency_ms: activeLog.latency_ms,
      ttft_ms: activeLog.ttft_ms,
      cache_hit_rate: activeLog.cache_hit_rate,
      usage: activeLog.usage,
      pricing: activeLog.pricing,
    };
  }, [activeLog]);

  return (
    <div className="sb-view-container space-y-4">
      {/* Filter Toolbar */}
      <search aria-label={t("usage.logs.filters")}>
        <form
          className="sb-card p-3.5 flex flex-wrap items-center justify-between gap-3"
          onSubmit={handleApplyFilters}
        >
          <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[260px]">
            <div className="relative min-w-[180px] flex-1 max-w-sm">
              <input
                type="search"
                maxLength={256}
                placeholder={t("usage.logs.searchPlaceholder")}
                className="sb-input w-full pl-8"
                value={draft.q ?? ""}
                onChange={(e) => setDraft({ ...draft, q: e.target.value })}
              />
              <svg
                className="w-3.5 h-3.5 text-neutral-500 absolute left-2.5 top-2.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>

            <select
              className="sb-select text-xs"
              aria-label={t("usage.filter.range")}
              value={draft.range}
              onChange={(e) => setDraft({ ...draft, range: e.target.value as UsageRange })}
            >
              <option value="24h">{t("console.range.24h")}</option>
              <option value="7d">{t("console.range.7d")}</option>
              <option value="30d">{t("console.range.30d")}</option>
            </select>

            <select
              className="sb-select text-xs"
              aria-label={t("usage.filter.source")}
              value={draft.source}
              onChange={(e) => setDraft({ ...draft, source: e.target.value as UsageSource })}
            >
              <option value="all">{t("usage.source.all")}</option>
              <option value="session">{t("usage.source.session")}</option>
              <option value="relay">{t("usage.source.relay")}</option>
            </select>

            <input
              type="text"
              maxLength={256}
              className="sb-input text-xs"
              placeholder={t("usage.logs.exactModel")}
              value={draft.model ?? ""}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            />

            <input
              type="text"
              maxLength={32}
              list={statusListId}
              className="sb-input text-xs"
              placeholder={t("usage.logs.statusHint")}
              value={draft.status ?? ""}
              onChange={(e) => setDraft({ ...draft, status: e.target.value })}
            />
            <datalist id={statusListId}>
              {usageOutcomes.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button type="submit" className="sb-btn sb-btn-primary sb-btn-sm">
              {t("usage.cache.apply")}
            </button>
            <button
              type="button"
              className="sb-btn sb-btn-ghost sb-btn-sm"
              onClick={handleResetFilters}
            >
              {t("settingsDlg.reset")}
            </button>
            <button
              type="button"
              className="sb-btn sb-btn-secondary sb-btn-sm"
              disabled={csvState.busy || !owner || !api}
              onClick={() => void handleExportCsv()}
            >
              {t("usage.logs.exportCsv")}
            </button>
          </div>
        </form>
      </search>

      {error && (
        <div className="sb-card p-3 border-rose-500/20 text-xs text-rose-400" role="alert">
          {error}
        </div>
      )}
      {csvState.notice && (
        <div className="sb-toast-inline" role="status">
          {csvState.notice}
        </div>
      )}
      {csvState.error && (
        <div className="sb-card p-3 border-rose-500/20 text-xs text-rose-400" role="alert">
          {csvState.error}
        </div>
      )}

      {/* Main Row: Left Table, Right Sticky Inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        <div className="xl:col-span-7 sb-card overflow-hidden">
          <div className="px-4 py-2.5 border-b border-dash-line bg-dash-terminal flex items-center justify-between text-xs gap-2">
            <span className="font-medium text-neutral-200">
              {t("usage.logs.streamCount", { count: logs.length })}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="sb-btn sb-btn-ghost sb-btn-sm"
                disabled={page === 0 || loading}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                {t("usage.logs.prev")}
              </button>
              <span className="font-mono text-[11px] text-neutral-400">
                {t("usage.logs.pageLabel", { page: page + 1 })}
              </span>
              <button
                type="button"
                className="sb-btn sb-btn-ghost sb-btn-sm"
                disabled={!nextCursor || loading}
                onClick={() => {
                  if (!nextCursor) return;
                  setCursors((prev) => [...prev.slice(0, page), nextCursor]);
                  setPage((p) => p + 1);
                }}
              >
                {t("usage.logs.next")}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto max-h-[720px] overflow-y-auto">
            {loading && logs.length === 0 ? (
              <p className="p-6 text-xs text-neutral-400" role="status">
                {t("console.loading")}
              </p>
            ) : logs.length === 0 ? (
              <p className="p-6 text-xs text-neutral-500 text-center" role="status">
                {t("usage.emptyWindow")}
              </p>
            ) : (
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 bg-dash-terminal z-10">
                  <tr className="border-b border-dash-line text-[11px] text-neutral-400 font-medium">
                    <th className="py-2.5 px-3">{t("usage.logs.col.timeSource")}</th>
                    <th className="py-2.5 px-3">{t("usage.logs.col.modelStatus")}</th>
                    <th className="py-2.5 px-3">{t("usage.logs.col.latency")}</th>
                    <th className="py-2.5 px-3">{t("usage.logs.col.tokens")}</th>
                    <th className="py-2.5 px-3 text-right">{t("usage.col.estimatedCost")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-dash-line font-mono">
                  {logs.map((row) => {
                    const isSelected = activeLog?.event_id === row.event_id;
                    const read = row.usage?.cache_read_tokens ?? 0;
                    const uncached = row.usage?.uncached_input_tokens ?? 0;
                    const out = row.usage?.output_tokens ?? 0;
                    const total = read + uncached + out || 1;
                    const pCache = Math.round((read / total) * 100);
                    const pIn = Math.round((uncached / total) * 100);
                    const pOut = Math.max(0, 100 - pCache - pIn);
                    const isOk = row.outcome === "accepted";

                    return (
                      <tr
                        key={row.event_id}
                        onClick={() => setSelectedId(row.event_id)}
                        className={`cursor-pointer transition-colors ${
                          isSelected
                            ? "bg-emerald-500/15 border-l-2 border-emerald-400"
                            : "hover:bg-dash-soft"
                        }`}
                      >
                        <td className="py-2.5 px-3">
                          <div className="text-neutral-200 text-[11px] font-sans font-medium">
                            {new Date(row.ts_ms).toLocaleString(state.resolvedLocale)}
                          </div>
                          <div className="text-neutral-500 text-[10px] truncate max-w-[140px]">
                            {t(`usage.source.${row.source}`)}
                            {row.source_label ? ` · ${row.source_label}` : ""}
                          </div>
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="text-neutral-200 font-sans font-medium truncate max-w-[140px]">
                            {row.model ?? unknownText}
                          </div>
                          <div className="mt-0.5">
                            <span
                              className={`px-1.5 py-0.2 rounded text-[10px] font-mono border ${
                                isOk
                                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                  : "bg-rose-500/10 text-rose-400 border-rose-500/20"
                              }`}
                            >
                              {row.outcome}
                              {row.status_code !== null ? ` · ${row.status_code}` : ""}
                            </span>
                          </div>
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="text-neutral-300 font-semibold">
                            {formatDuration(row.latency_ms, unknownText)}
                          </div>
                          <div className="text-[10px] text-neutral-500">
                            TTFT {formatDuration(row.ttft_ms, unknownText)}
                          </div>
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="w-24 h-2 rounded-full bg-dash-terminal overflow-hidden flex border border-dash-line mb-1">
                            <div className="bg-cyan-400 h-full" style={{ width: `${pCache}%` }} />
                            <div className="bg-blue-500 h-full" style={{ width: `${pIn}%` }} />
                            <div className="bg-emerald-500 h-full" style={{ width: `${pOut}%` }} />
                          </div>
                          <div className="text-[10px] text-emerald-400">
                            {row.cache_hit_rate !== null
                              ? `${(row.cache_hit_rate * 100).toFixed(1)}%`
                              : unknownText}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <div className="text-purple-400 font-bold">
                            {formatUsdEstimate(row.pricing.estimated_cost_usd, unknownText)}
                          </div>
                          <div className="text-neutral-500 text-[10px]">
                            {formatTokenCount(row.usage?.total_tokens, unknownText)}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right: Sticky Inspector (Metadata Only) */}
        <div className="xl:col-span-5 sb-card overflow-hidden sticky top-4">
          <div className="px-3.5 py-2.5 bg-dash-soft border-b border-dash-line flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 font-mono min-w-0">
              <span className="text-emerald-400">~</span>
              <span className="text-neutral-200 font-medium truncate">
                {activeLog?.request_id ?? activeLog?.event_id ?? t("usage.logs.noneSelected")}
              </span>
            </div>
            {activeLog && (
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-mono text-neutral-400 text-[11px]">
                  {formatDuration(activeLog.latency_ms, unknownText)}
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${
                    activeLog.outcome === "accepted"
                      ? "bg-emerald-500/15 text-emerald-400"
                      : "bg-rose-500/10 text-rose-400"
                  }`}
                >
                  {activeLog.status_code ?? activeLog.outcome}
                </span>
              </div>
            )}
          </div>

          {activeLog && safeMetadata && (
            <div className="p-3.5 space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs bg-dash-terminal p-2.5 rounded border border-dash-line font-mono">
                <div>
                  <div className="text-[10px] text-neutral-500 font-sans">
                    {t("usage.logs.inspector.providerModel")}
                  </div>
                  <div className="text-neutral-200 mt-0.5 truncate font-sans font-medium">
                    {activeLog.provider_id ?? unknownText} / {activeLog.model ?? unknownText}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-neutral-500 font-sans">
                    {t("usage.filter.source")}
                  </div>
                  <div className="text-neutral-300 mt-0.5 truncate">
                    {t(`usage.source.${activeLog.source}`)} · {activeLog.source_label ?? activeLog.source_id}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-neutral-500 font-sans">TTFT / Protocol</div>
                  <div className="text-neutral-300 mt-0.5">
                    {formatDuration(activeLog.ttft_ms, unknownText)} · {activeLog.protocol ?? unknownText}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-neutral-500 font-sans">
                    {t("usage.col.estimatedCost")}
                  </div>
                  <div className="text-emerald-400 mt-0.5">
                    {formatUsdEstimate(activeLog.pricing.estimated_cost_usd, unknownText)} (
                    {t("usage.logs.savedPrefix")}{" "}
                    {formatUsdEstimate(activeLog.pricing.estimated_saved_usd, unknownText)})
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
                <div className="bg-dash-terminal px-2.5 py-1.5 rounded border border-dash-line">
                  <div className="text-cyan-400 text-[10px]">Cache Read</div>
                  <div className="text-neutral-200 font-semibold">
                    {formatTokenCount(activeLog.usage?.cache_read_tokens, unknownText)}
                  </div>
                </div>
                <div className="bg-dash-terminal px-2.5 py-1.5 rounded border border-dash-line">
                  <div className="text-blue-400 text-[10px]">Input Total</div>
                  <div className="text-neutral-200 font-semibold">
                    {formatTokenCount(activeLog.usage?.input_tokens, unknownText)}
                  </div>
                </div>
                <div className="bg-dash-terminal px-2.5 py-1.5 rounded border border-dash-line">
                  <div className="text-emerald-400 text-[10px]">Output Total</div>
                  <div className="text-neutral-200 font-semibold">
                    {formatTokenCount(activeLog.usage?.output_tokens, unknownText)}
                  </div>
                </div>
              </div>

              <div className="sb-terminal-box p-3 space-y-2.5 font-mono text-[11px]">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-neutral-500 text-[10px] uppercase tracking-wider font-sans">
                    {t("usage.logs.inspector.metadataTitle")}
                  </span>
                  <button
                    type="button"
                    className="text-[10px] text-neutral-400 hover:text-white"
                    onClick={() => {
                      void navigator.clipboard?.writeText(JSON.stringify(safeMetadata, null, 2));
                      setCopiedMetadata(true);
                      window.setTimeout(() => setCopiedMetadata(false), 2000);
                    }}
                  >
                    {copiedMetadata ? t("common.copied") : t("usage.logs.inspector.copyJson")}
                  </button>
                </div>
                <LogMetadataView key={activeLog.event_id} value={safeMetadata} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

function LogMetadataView({ value }: { value: unknown }) {
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
  const text = () => (
    <pre className="bg-dash-terminal p-2.5 rounded border border-dash-line text-neutral-300 overflow-x-auto leading-relaxed max-h-40">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
  if (!recognized) return text();
  return (
    <JsonValueView
      source={typeof value === "string" ? { kind: "text", text: value } : { kind: "value", value }}
      renderText={text}
      hideRootCopy
    />
  );
}
