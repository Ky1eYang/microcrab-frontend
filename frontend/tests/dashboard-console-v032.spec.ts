import { expect, test, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import type {
  DashboardDiagnosticsReport,
  DashboardLogsReport,
  DashboardSummaryReport,
  UsageAggregate,
} from "../src/client/dashboard-usage";
import type { AccountPreferences } from "../src/client/account-preferences";
import type { RelayKey } from "../src/client/relay-keys";

function zeroAgg(partial: Partial<UsageAggregate> = {}): UsageAggregate {
  const zeroCounter = {
    reported_total: 0,
    reported_samples: 0,
    unreported_samples: 0,
    overflow: false,
  };
  return {
    requests: 0,
    usage: {
      input_tokens: { ...zeroCounter },
      output_tokens: { ...zeroCounter },
      cache_read_tokens: { ...zeroCounter },
      cache_write_tokens: { ...zeroCounter },
      reasoning_tokens: { ...zeroCounter },
      uncached_input_tokens: { ...zeroCounter },
      non_reasoning_output_tokens: { ...zeroCounter },
      total_tokens: { ...zeroCounter },
    },
    reported_cache: {
      scope: "reported_samples",
      attempted_samples: 0,
      paired_samples: 0,
      input_tokens: 0,
      cache_read_tokens: 0,
      cache_hit_rate: null,
    },
    average_latency_ms: null,
    latency_samples: 0,
    average_ttft_ms: null,
    ttft_samples: 0,
    estimated_cost_usd: null,
    estimated_saved_usd: null,
    priced_requests: 0,
    unpriced_requests: 0,
    pricing_coverage: null,
    rough_priced_requests: 0,
    savings_covered_requests: 0,
    ...partial,
  };
}

function fixtureSummary(): DashboardSummaryReport {
  const now = Date.now();
  return {
    range: "7d",
    source: "all",
    window: {
      range: "7d",
      ends_at_ms: now,
      bucket_starts_ms: [now - 86400000, now],
      today_start_ms: now - 3600000,
      time_basis: "utc",
    },
    coverage: {
      retention_days: 30,
      capacity_events: 10000,
      truncated_by_capacity: false,
      observed_since_ms: now - 86400000 * 7,
      oldest_retained_ms: now - 86400000 * 2,
    },
    kpi: {
      ...zeroAgg({
        requests: 12,
        usage: {
          ...zeroAgg().usage,
          input_tokens: { reported_total: 12000, reported_samples: 12, unreported_samples: 0, overflow: false },
          output_tokens: { reported_total: 2400, reported_samples: 12, unreported_samples: 0, overflow: false },
          cache_read_tokens: { reported_total: 8000, reported_samples: 10, unreported_samples: 2, overflow: false },
          cache_write_tokens: { reported_total: 500, reported_samples: 10, unreported_samples: 2, overflow: false },
          reasoning_tokens: { reported_total: 300, reported_samples: 4, unreported_samples: 8, overflow: false },
          total_tokens: { reported_total: 14400, reported_samples: 12, unreported_samples: 0, overflow: false },
        },
        reported_cache: {
          scope: "reported_samples",
          attempted_samples: 12,
          paired_samples: 10,
          input_tokens: 10000,
          cache_read_tokens: 8000,
          cache_hit_rate: 0.8,
        },
        average_latency_ms: 420,
        latency_samples: 12,
        average_ttft_ms: 110,
        ttft_samples: 10,
        estimated_cost_usd: 0.042,
        estimated_saved_usd: 0.018,
        priced_requests: 10,
        unpriced_requests: 2,
        pricing_coverage: 10 / 12,
      }),
      today_requests: 5,
      retained_requests: 12,
      active_sessions: 1,
      total_sessions: 2,
      unavailable_sessions: 0,
      active_api_keys: 1,
      total_api_keys: 2,
    },
    series: [
      {
        start_ms: now - 86400000,
        ...zeroAgg({
          requests: 4,
          usage: { ...zeroAgg().usage, total_tokens: { reported_total: 4000, reported_samples: 4, unreported_samples: 0, overflow: false } },
          reported_cache: { scope: "reported_samples", attempted_samples: 4, paired_samples: 4, input_tokens: 3000, cache_read_tokens: 2100, cache_hit_rate: 0.7 },
        }),
      },
      {
        start_ms: now,
        ...zeroAgg({
          requests: 8,
          usage: { ...zeroAgg().usage, total_tokens: { reported_total: 10400, reported_samples: 8, unreported_samples: 0, overflow: false } },
          reported_cache: { scope: "reported_samples", attempted_samples: 8, paired_samples: 6, input_tokens: 7000, cache_read_tokens: 5900, cache_hit_rate: 0.8428 },
        }),
      },
    ],
    platforms: [
      { protocol: "openai-compatible", ...zeroAgg({ requests: 9, usage: { ...zeroAgg().usage, total_tokens: { reported_total: 10000, reported_samples: 9, unreported_samples: 0, overflow: false } } }) },
      { protocol: "anthropic", ...zeroAgg({ requests: 3, usage: { ...zeroAgg().usage, total_tokens: { reported_total: 4400, reported_samples: 3, unreported_samples: 0, overflow: false } } }) },
    ],
    models: [
      {
        provider_id: "user:alpha",
        model: "gpt-4o",
        ...zeroAgg({
          requests: 10,
          usage: { ...zeroAgg().usage, total_tokens: { reported_total: 12000, reported_samples: 10, unreported_samples: 0, overflow: false } },
          estimated_cost_usd: 0.042,
        }),
      },
      {
        provider_id: "custom:unknown",
        model: "private-local",
        ...zeroAgg({
          requests: 2,
          usage: { ...zeroAgg().usage, total_tokens: { reported_total: 2400, reported_samples: 2, unreported_samples: 0, overflow: false } },
          estimated_cost_usd: null,
        }),
      },
    ],
  };
}

function fixtureDiagnostics(): DashboardDiagnosticsReport {
  const s = fixtureSummary();
  return {
    models: s.models.map((m) => ({
      ...m,
      reported_cache: m.model === "gpt-4o"
        ? { scope: "reported_samples", attempted_samples: 10, paired_samples: 10, input_tokens: 10000, cache_read_tokens: 8000, cache_hit_rate: 0.8 }
        : { scope: "reported_samples", attempted_samples: 2, paired_samples: 0, input_tokens: null, cache_read_tokens: null, cache_hit_rate: null },
    })),
    diagnostics: [
      {
        code: "cache_usage_unreported",
        provider_id: "custom:unknown",
        model: "private-local",
        paired_samples: 0,
        attempted_samples: 2,
      },
    ],
    coverage: s.coverage,
    window: s.window,
  };
}

async function setupConsoleRoutes(page: Page) {
  await nativeBackend(page, { owner: "console-owner" });

  let prefs: AccountPreferences = {
    revision: 1,
    last_operation_id: null,
    dashboard_default_range: "7d",
    low_cache_hit_warn_pct: 60,
    relay_default_selection: null,
    default_conversation_flavor: null,
    theme: null,
    locale: null,
    relay_models: [{ provider_id: "user:alpha", model: "gpt-4o" }],
  };

  let keys: RelayKey[] = [
    {
      id: "rk-1",
      name: "CLI Client",
      key_prefix: "mc_sk_abc123",
      enabled: true,
      revoked: false,
      allowed_providers: null,
      default_model_selection: null,
      created_at_ms: 1700000000000,
      last_used_at_ms: 1700000123000,
      request_count: 5,
      revision: 1,
    },
  ];

  await page.route("**/api/v1/users/*/preferences", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      prefs = {
        ...prefs,
        revision: prefs.revision + 1,
        last_operation_id: body.operation_id,
        dashboard_default_range: body.dashboard_default_range,
        low_cache_hit_warn_pct: body.low_cache_hit_warn_pct,
        relay_default_selection: body.relay_default_selection,
        default_conversation_flavor: body.default_conversation_flavor,
        theme: body.theme,
        locale: body.locale,
      };
    }
    await route.fulfill({ json: prefs });
  });

  await page.route("**/api/v1/users/*/dashboard/summary*", (route) =>
    route.fulfill({ json: fixtureSummary() }),
  );
  await page.route("**/api/v1/users/*/dashboard/cache-diagnostics*", (route) =>
    route.fulfill({ json: fixtureDiagnostics() }),
  );
  await page.route("**/api/v1/users/*/dashboard/logs*", (route) => {
    const logs: DashboardLogsReport = {
      items: [
        {
          event_id: "evt-100",
          ts_ms: Date.now() - 60000,
          source: "relay",
          source_id: "rk-1",
          source_label: "CLI Client (mc_sk_abc123)",
          request_id: "req-100",
          provider_id: "user:alpha",
          model: "gpt-4o",
          protocol: "openai-compatible",
          outcome: "accepted",
          status_code: 200,
          latency_ms: 350,
          ttft_ms: 95,
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_tokens: 800,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            uncached_input_tokens: 200,
            non_reasoning_output_tokens: 200,
            total_tokens: 1200,
            samples: 1,
          },
          cache_hit_rate: 0.8,
          pricing: {
            estimated_cost_usd: 0.005,
            estimated_saved_usd: 0.002,
            rough_input_estimate: false,
          },
        },
      ],
      next_cursor: null,
      coverage: fixtureSummary().coverage,
    };
    return route.fulfill({ json: logs });
  });

  await page.route("**/api/v1/users/*/api-keys", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      const created: RelayKey = {
        id: "rk-2",
        name: body.name,
        key_prefix: "mc_sk_new999",
        enabled: true,
        revoked: false,
        allowed_providers: body.allowed_providers ?? null,
        default_model_selection: body.default_model_selection ?? null,
        created_at_ms: Date.now(),
        last_used_at_ms: null,
        request_count: 0,
        revision: 1,
      };
      keys = [created, ...keys];
      return route.fulfill({
        status: 201,
        json: { key: created, secret: "mc_sk_new999_secret_once_only" },
      });
    }
    return route.fulfill({
      json: { keys },
    });
  });

  await page.route("**/api/v1/users/*/api-keys/*", async (route) => {
    const id = route.request().url().split("/").pop()!;
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON();
      keys = keys.map((k) =>
        k.id === id
          ? {
              ...k,
              enabled: body.enabled ?? k.enabled,
              name: body.name ?? k.name,
              revision: k.revision + 1,
            }
          : k,
      );
      return route.fulfill({ json: { key: keys.find((k) => k.id === id) } });
    }
    if (route.request().method() === "DELETE") {
      keys = keys.map((k) =>
        k.id === id ? { ...k, revoked: true, enabled: false, revision: k.revision + 1 } : k,
      );
      return route.fulfill({ json: { key: keys.find((k) => k.id === id) } });
    }
    return route.continue();
  });

  await page.route("**/api/v1/users/*/library*", (route) =>
    route.fulfill({ json: { items: [], quota: { used_bytes: 0, max_bytes: 1048576, object_count: 0, max_objects: 100 } } }),
  );
  await page.route("**/api/v1/providers", (route) => route.fulfill({ json: { items: [] } }));
}

for (const width of [1440, 390]) {
  test(`Console layout, tabs, reference estimates, and conversation state retention at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await setupConsoleRoutes(page);
    await page.goto("/#session/s1");

    // Enter a draft into the conversation composer, then navigate into Console and back.
    const composer = page.locator("textarea").first();
    await composer.fill("Draft stays intact during console tour");

    const railMenu = page.locator('.shell [data-testid="header-open-rail"]');
    if (await railMenu.isVisible()) await railMenu.click();
    await page.locator('.shell [data-testid="nav-dashboard"]').filter({ visible: true }).first().click();

    await expect(page.getByTestId("dashboard")).toBeVisible();
    // Ensure old admin/fake mock tabs do not exist and OpenRouter reference note appears.
    await expect(page.getByTestId("dashboard")).not.toContainText("余额");
    await expect(page.getByTestId("dashboard")).toContainText("OpenRouter");
    await expect(page.getByTestId("dashboard")).toContainText("未知");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);

    const openMobileDashDrawerIfNeeded = async () => {
      const btn = page.locator('[data-testid="dashboard"] [data-testid="header-open-rail"]');
      if (await btn.isVisible()) await btn.click();
    };

    // Switch to Cache sub-tab
    await page.getByRole("tab", { name: "缓存分析" }).click();
    await expect(page.getByTestId("dashboard")).toContainText("80.0%");

    // API Keys lifecycle + one-time reveal + native dialog revoke
    await openMobileDashDrawerIfNeeded();
    await page.getByTestId("dashboard-nav-keys").click();
    await page.getByTestId("relay-key-quick-name").fill("New Automation Key");
    await page.getByTestId("relay-key-quick-create").click();
    await expect(page.getByTestId("relay-key-secret-banner")).toContainText(
      "mc_sk_new999_secret_once_only",
    );
    await expect(page.getByTestId("relay-key-row-rk-2")).toContainText("尚未使用");

    // Usage Logs & Plugins & Console Preferences sync
    await openMobileDashDrawerIfNeeded();
    await page.getByTestId("dashboard-nav-logs").click();
    await expect(page.getByTestId("dashboard")).toContainText("CLI Client");

    await openMobileDashDrawerIfNeeded();
    await page.getByTestId("dashboard-nav-plugins").click();
    await expect(page.getByTestId("client-plugins-manager")).toBeVisible();

    await openMobileDashDrawerIfNeeded();
    await page.getByTestId("dashboard-nav-settings").click();
    await page.getByTestId("console-settings-tab-preferences").click();
    await page.getByLabel("仪表盘默认时间范围").selectOption("30d");
    await page.getByTestId("preferences-save").click();
    await expect(page.getByTestId("dashboard")).toContainText("账号偏好已保存");

    // Return to originating conversation and verify composer draft survived
    await openMobileDashDrawerIfNeeded();
    await page.getByTestId("dashboard-back").click();
    await expect(composer).toHaveValue("Draft stays intact during console tour");
  });
}

test("SettingsDialog preserves essentials and redirects moved owner config to Console", async ({
  page,
}) => {
  await setupConsoleRoutes(page);
  await page.goto("/#session/s1");
  await page.getByRole("button", { name: "Test User", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();

    await expect(page.getByRole("button", { name: "当前会话配置", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "界面外观", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "后端连接", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "客户端工具", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "客户端信息", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "模型服务商", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "会话默认设置", exact: true })).toHaveCount(0);
});
