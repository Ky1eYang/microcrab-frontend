import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tokenUsage } from "../src/features/views";
import { StatisticsOverview } from "../src/features/composer/StatisticsDock";
import { CacheTab } from "../src/features/dashboard/views/CacheTab";
import { setActiveLocale } from "../src/i18n";
import type { NativeStatistics } from "../src/client/types";
import type { FeatureBlock } from "../src/features/shared";

const receipt = (tokens: Record<string, unknown>) =>
  ({
    payload: { providerMetadata: { tokens } },
  }) as unknown as FeatureBlock;
const summary = {
  scope: "reported_samples" as const,
  attempted_samples: 51,
  paired_samples: 47,
  input_tokens: 10000,
  cache_read_tokens: 9650,
  cache_hit_rate: 0.965,
};
const statistics = () =>
  ({
    activity: { operation: null },
    provider: { timing: null, latest_prompt: null },
    model: {},
    usage: {
      aggregate: {},
      main: {},
      aggregate_cache_hit_rate: null,
      main_cache_hit_rate: null,
      aggregate_reported_cache: summary,
      main_reported_cache: summary,
    },
  }) as unknown as NativeStatistics;

test("canonical cache receipt counts take precedence, preserve null, and display known zero", () => {
  expect(
    tokenUsage(
      receipt({
        input_tokens: 100,
        output_tokens: 5,
        total_tokens: 106,
        cache_read_tokens: 90,
        cache_write_tokens: 0,
        cache: { read: 1, write: 2 },
        total: 999,
      }),
    ),
  ).toMatchObject({
    input: 100,
    output: 5,
    total: 106,
    cacheRead: 90,
    cacheWrite: 0,
  });
  expect(
    tokenUsage(
      receipt({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      }),
    ),
  ).toMatchObject({
    total: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  expect(
    tokenUsage(
      receipt({
        total_tokens: null,
        total: 999,
        cache_read_tokens: null,
        cache: { read: 90 },
        input_tokens: 100,
      }),
    ),
  ).toMatchObject({ total: null, cacheRead: null, output: null });
  expect(tokenUsage(receipt({ cache_read_tokens: null }))).toBeNull();
  expect(tokenUsage(receipt({}))).toBeNull();
  expect(tokenUsage(receipt({ cache_read_input_tokens: 20 }))).toMatchObject({
    cacheRead: 20,
    input: null,
    total: null,
  });
});

test("dock qualifies paired rates and prefers exact aggregate rates", () => {
  setActiveLocale("zh-CN");
  const stats = statistics();
  const html = () =>
    renderToStaticMarkup(
      createElement(StatisticsOverview, { statistics: stats }),
    );
  expect(html()).toContain("缓存命中率 96.5%");
  expect(html()).not.toContain("47/51次已报告");
  stats.usage.aggregate_cache_hit_rate = 0;
  expect(html()).toContain("缓存命中率 0.0%");
  expect(html()).not.toContain("47/51次已报告");
  stats.usage.aggregate_cache_hit_rate = null;
  delete stats.usage.aggregate_reported_cache;
  // Unknown rate is omitted from the chip (P2 #5); the popover keeps the distinction.
  expect(html()).not.toContain("缓存命中率");
  stats.usage.aggregate_reported_cache = {
    ...summary,
    paired_samples: 0,
    input_tokens: null,
    cache_read_tokens: null,
    cache_hit_rate: null,
  };
  // Unknown rate is omitted from the chip (P2 #5); the popover keeps the distinction.
  expect(html()).not.toContain("缓存命中率");
  expect(html()).not.toContain("缓存命中率 0.0%");
});

test("explicit child usage never borrows parent cache summaries or rates", () => {
  setActiveLocale("zh-CN");
  const stats = statistics();
  for (const usage of [null, {}, { input_tokens: 100, cache_read_tokens: 0 }]) {
    const html = renderToStaticMarkup(
      createElement(StatisticsOverview, {
        statistics: stats,
        usage,
      }),
    );
    expect(html).not.toContain("96.5%");
    expect(html).not.toContain("47/51");
    if (usage?.cache_read_tokens === 0) expect(html).toContain("缓存命中率 0.0%");
    else expect(html).not.toContain("缓存命中率");
  }
});

for (const locale of ["en", "zh-CN"] as const) {
  test(`cache dashboard visibly identifies sample data in ${locale}`, () => {
    setActiveLocale(locale);
    const html = renderToStaticMarkup(createElement(CacheTab));
    expect(html).toContain('data-testid="cache-sample-notice"');
    expect(html).toContain(locale === "en" ? "Sample data:" : "示例数据：");
    expect(html).toContain(
      locale === "en"
        ? "do not reflect actual session usage"
        : "不代表实际会话用量",
    );
    setActiveLocale("zh-CN");
  });
}
