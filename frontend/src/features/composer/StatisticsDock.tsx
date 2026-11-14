import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "../../state";
import { selectedModel } from "../../state/model";
import { t } from "../../i18n";
import { formatNumber, Icon } from "../shared";
import type { NativeStatistics, NativeUsage } from "../../client/types";
import { OverviewPopover } from "./OverviewPopover";

type Row = [string, string, string?];

/** Whole elapsed seconds: minutes stay two-digit until an hour is reached. */
export function elapsedClock(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
    : `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

export function StatisticsDock({
  statistics,
  scopeId = "statistics",
}: {
  statistics?: NativeStatistics | null;
  scopeId?: string;
} = {}) {
  const { state } = useApp();
  const selection = statistics === undefined ? selectedModel(state) : null;
  const catalog =
    selection &&
    state.availableModels.find(
      (model) =>
        model.id === selection.id && model.providerId === selection.providerId,
    );
  return (
    <StatisticsOverview
      key={`${scopeId}:${state.sessionId ?? "draft"}:${selection?.providerId ?? ""}:${selection?.id ?? ""}:${selection?.variant ?? ""}`}
      statistics={statistics === undefined ? state.statistics : statistics}
      contextWindowTokens={catalog?.contextWindowTokens}
      scopeId={scopeId}
    />
  );
}

/** Explicit measurements only: inspected children pass their own usage, never parent facts. */
export function StatisticsOverview({
  statistics: incoming,
  usage: providedUsage,
  contextWindowTokens,
  right,
  scopeId = "statistics",
}: {
  statistics?: NativeStatistics | null;
  usage?: NativeUsage | null;
  contextWindowTokens?: number | null;
  right?: ReactNode;
  scopeId?: string;
}) {
  const measuredTiming = incoming?.provider.timing;
  const validTiming =
    measuredTiming?.rate_basis === "generation_interval" &&
    typeof measuredTiming.tokens_per_second === "number" &&
    Number.isFinite(measuredTiming.tokens_per_second) &&
    measuredTiming.tokens_per_second >= 0
      ? measuredTiming
      : null;
  const [previous, setPrevious] = useState({
    scopeId,
    statistics: incoming,
    timing: validTiming,
  });
  // Refreshes can briefly omit statistics or precede the next measured interval.
  // Keep committed display facts in this scope until a replacement is available.
  const nextStatistics =
    incoming ?? (previous.scopeId === scopeId ? previous.statistics : null);
  const nextTiming =
    validTiming ?? (previous.scopeId === scopeId ? previous.timing : null);
  if (
    previous.scopeId !== scopeId ||
    previous.statistics !== nextStatistics ||
    previous.timing !== nextTiming
  ) {
    setPrevious({
      scopeId,
      statistics: nextStatistics,
      timing: nextTiming,
    });
  }
  const retained = previous.scopeId === scopeId ? previous : null;
  const stats = incoming ?? retained?.statistics;
  const timing = validTiming ?? retained?.timing;
  const [now, setNow] = useState(Date.now());
  const operation = stats?.activity.operation;
  // Compaction owns a separate command reservation, outside the inbox turn.
  const compactRunning =
    operation?.kind === "session.compact" &&
    operation.ended_at_ms == null &&
    ["accepted", "running"].includes(operation.status);
  const execution =
    stats?.activity.execution?.active || !compactRunning
      ? stats?.activity.execution
      : undefined;
  const startedAt = execution
    ? execution.started_at_ms
    : operation?.started_at_ms;
  const running =
    typeof startedAt === "number" &&
    Number.isFinite(startedAt) &&
    startedAt >= 0 &&
    (execution
      ? execution.active && execution.ended_at_ms == null
      : !!operation &&
        operation.ended_at_ms == null &&
        ["accepted", "running"].includes(operation.status));
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  const label = (key: string) => t(`composer.stats.${key}`);
  const known = (value: number | null | undefined): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  const number = (value: number | null | undefined) =>
    known(value) ? formatNumber(value) : "-";
  const bytes = (value: number) => `${formatNumber(value)} B`;
  const dash = (value: string) => (value === "-" ? "—" : value);
  const time = (value: number) => `${(value / 1000).toFixed(2)} s`;
  const elapsed = running
    ? Math.max(0, now - startedAt!)
    : execution
      ? execution.elapsed_ms
      : operation?.elapsed_ms;
  const speed =
    timing?.rate_basis === "generation_interval" &&
    known(timing.tokens_per_second)
      ? `${timing.tokens_per_second.toFixed(1)} tok/s`
      : "- tok/s";
  const consumption =
    providedUsage === undefined ? stats?.usage.aggregate : providedUsage;
  const reported =
    providedUsage === undefined
      ? stats?.usage.aggregate_reported_cache
      : undefined;
  const strictCacheRate =
    providedUsage === undefined
      ? stats?.usage.aggregate_cache_hit_rate
      : known(consumption?.input_tokens) &&
          consumption.input_tokens > 0 &&
          known(consumption.cache_read_tokens) &&
          consumption.cache_read_tokens <= consumption.input_tokens
        ? consumption.cache_read_tokens / consumption.input_tokens
        : null;
  const cacheRate = known(strictCacheRate)
    ? strictCacheRate
    : reported?.cache_hit_rate;
  const percentage = (value: number | null | undefined) =>
    known(value) ? `${(value * 100).toFixed(1)}%` : "-";
  const coverage = (summary: typeof reported) =>
    summary
      ? t("composer.stats.reportedCoverage", {
          paired: summary.paired_samples,
          attempted: summary.attempted_samples,
        })
      : "-";
  // [!important] Collapsed dock and expanded cache-rate values stay percentage-only.
  // Do not append reported-sample coverage such as "（41/42次已报告）".
  const cacheDisplay = percentage(cacheRate);
  const activity: Row[] = [
    [label("turns"), number(stats?.activity.turns)],
    [label("steps"), number(stats?.activity.steps)],
    [label("toolCalls"), number(stats?.activity.tool_calls)],
    [label("elapsed"), known(elapsed) ? elapsedClock(elapsed) : "-"],
  ];
  activity.push([label("speed"), speed]);
  if (known(timing?.first_token_ms))
    activity.push([label("firstToken"), time(timing.first_token_ms)]);
  if (known(timing?.generation_ms))
    activity.push([label("generation"), time(timing.generation_ms)]);
  activity.push(
    [label("input"), number(consumption?.input_tokens)],
    [label("output"), number(consumption?.output_tokens)],
    [label("cacheRate"), cacheDisplay],
  );

  const context = stats?.context;
  const prompt = stats?.provider.latest_prompt;
  const measuredInput = prompt?.input_tokens;
  const window = stats?.model.context_window_tokens ?? contextWindowTokens;
  const currentTokens = prompt?.freshness === "current" && known(measuredInput);
  const lastRequestTokens =
    prompt?.freshness === "stale" &&
    prompt.freshness_reason === "context_changed_since_request" &&
    known(measuredInput);
  const measuredTokens = currentTokens || lastRequestTokens;
  const tokenValue = (value: number | null | undefined) =>
    known(value) ? `${number(value)} tok` : "-";
  const freshnessHelp =
    known(measuredInput) && !currentTokens
      ? label("lastRequestOnly")
      : undefined;
  const usage: Row[] = [
    [label("cacheRate"), cacheDisplay, label("cacheHelp")],
    [label("input"), number(consumption?.input_tokens)],
    [label("uncachedInput"), number(consumption?.uncached_input_tokens)],
    [label("cacheRead"), number(consumption?.cache_read_tokens)],
  ];
  if (
    known(consumption?.cache_write_tokens) &&
    consumption.cache_write_tokens > 0
  )
    usage.push([label("cacheWrite"), number(consumption.cache_write_tokens)]);
  usage.push(
    [label("output"), number(consumption?.output_tokens)],
    [label("scope.aggregate"), number(consumption?.total_tokens)],
  );
  if (providedUsage === undefined) {
    for (const [scope, summary] of [
      ["main", stats?.usage.main_reported_cache],
      ["aggregate", reported],
    ] as const) {
      if (!summary) continue;
      usage.push(
        [label(`reported.${scope}.coverage`), coverage(summary)],
        [label(`reported.${scope}.input`), number(summary.input_tokens)],
        [
          label(`reported.${scope}.cacheRead`),
          number(summary.cache_read_tokens),
        ],
        [label(`reported.${scope}.rate`), percentage(summary.cache_hit_rate)],
      );
    }
  }
  usage.push([
    label("promptTokens"),
    `${tokenValue(measuredInput)} / ${tokenValue(window)}`,
    freshnessHelp,
  ]);
  if (context) {
    usage.push([
      label("contextBytes"),
      `${bytes(context.bytes)} / ${bytes(context.limit_bytes)}`,
    ]);
    if (known(context.categories.system))
      usage.push([label("category.system"), bytes(context.categories.system)]);
    if (known(context.categories.tools))
      usage.push([label("category.tools"), bytes(context.categories.tools)]);
    const parts = [
      context.categories.state,
      context.categories.user,
      context.categories.assistant,
      context.categories.tool_result,
    ];
    if (parts.every(known))
      usage.push([
        label("conversationBytes"),
        bytes(parts.reduce((sum, value) => sum + value, 0)),
      ]);
    if (known(context.categories.framing))
      usage.push([
        label("category.framing"),
        bytes(context.categories.framing),
      ]);
  }
  // [!important] Do not render measured token headroom here. The field is retained
  // by statistics but has no confirmed product display.
  usage.push([label("modelWindow"), number(window)]);
  const occupancy =
    measuredTokens && known(window) && window > 0
      ? `${((measuredInput / window) * 100).toFixed(1)}%`
      : "-";
  return (
    <div className="composer-dock-row" data-testid="statistics-dock">
      <div className="dock-pills-group">
        {(["activity", "usage"] as const).map((kind) => (
          <OverviewPopover
            key={kind}
            id={`${scopeId}-${kind}`}
            testId={`statistics-${kind}`}
            title={label(kind === "usage" ? "usage" : "activity")}
            titleValue={
              kind === "usage"
                ? tokenValue(consumption?.total_tokens)
                : undefined
            }
            trigger={
              <>
                <Icon
                  name={kind === "activity" ? "activity" : "database"}
                  className="dock-icon"
                />
                {/* [!important] Fixed collapsed usage label: context occupancy and cache
                    hit rate only. Do not add coverage counts or other statistics. */}
                <span
                  className="dock-pill-label"
                  title={kind === "usage" ? freshnessHelp : undefined}
                >
                  {/* Unknown values collapse to one "—"; empty "· -" tails are not rendered.
                      The popover keeps the unknown vs 0 distinction. */}
                  {kind === "activity"
                    ? [
                        `${label("turns")} ${dash(number(stats?.activity.turns))}`,
                        ...(speed === "- tok/s" ? [] : [speed]),
                      ].join(" · ")
                    : [
                        `${label(lastRequestTokens ? "lastRequestContext" : "context")} ${dash(occupancy)}`,
                        ...(cacheDisplay === "-"
                          ? []
                          : [`${label("cacheRate")} ${cacheDisplay}`]),
                      ].join(" · ")}
                </span>
              </>
            }
          >
            {(kind === "activity" ? activity : usage).map(
              ([key, value, help]) => (
                <div key={key} className="dock-stat-row">
                  <span className="dock-stat-label">
                    {key}
                    {help && (
                      <button
                        type="button"
                        className="statistics-help"
                        aria-label={`${key}${t("common.fieldSep")}${help}`}
                        title={help}
                      >
                        ?
                      </button>
                    )}
                  </span>
                  <span className="dock-stat-val">{value}</span>
                </div>
              ),
            )}
          </OverviewPopover>
        ))}
      </div>
      {right}
      {running && (
        <div
          className="running-timer-row"
          data-testid="operation-elapsed"
          role="timer"
          aria-live="off"
        >
          <div className="running-timer-spinner" />
          <span className="running-text-shimmer">
            {label("elapsed")} {elapsedClock(elapsed!)}
          </span>
        </div>
      )}
    </div>
  );
}
