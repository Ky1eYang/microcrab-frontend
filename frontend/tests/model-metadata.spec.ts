import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("model choices and active selections retain the current provider-local protocol", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { initialState, modelChoices, selectedModel } =
      await import("/src/state/model.ts");
    const protocols = [
      "openai-compatible",
      "openai",
      "anthropic",
      "google",
    ] as const;
    const items = protocols.map((protocol, index) => ({
      id: "shared-wire-id",
      name: "Gateway " + index,
      provider_id: "gateway-" + index,
      protocol,
      variants: [],
    }));
    const choices = modelChoices({ items });
    const state = initialState();
    state.availableModels = choices;
    const initialDefault = selectedModel(state)?.protocol ?? null;
    state.draftModel = choices[3];
    const draft = selectedModel(state)?.protocol;
    state.sessionId = "s";
    state.sessions = [
      {
        id: "s",
        title: "Selected gateway",
        projectID: null,
        status: "idle",
        model: { id: "shared-wire-id", providerId: "gateway-0" },
      },
    ];
    const active = protocols.map((_, index) => {
      state.sessions[0].model = {
        id: "shared-wire-id",
        providerId: "gateway-" + index,
        variant: "retained-variant",
        protocol: "google",
      };
      const selected = selectedModel(state);
      return {
        providerId: selected?.providerId,
        protocol: selected?.protocol,
        variant: selected?.variant,
      };
    });
    state.sessions[0].model = {
      id: "shared-wire-id",
      providerId: "gateway-1",
      variant: "retained-variant",
      protocol: "google",
    };
    state.availableModels = modelChoices({
      items: items.map((item) =>
        item.provider_id === "gateway-1"
          ? { ...item, protocol: "anthropic" as const }
          : item,
      ),
    });
    const refreshed = selectedModel(state);
    state.sessions[0].model.providerId = "uncatalogued-provider";
    const missing = selectedModel(state);
    return {
      choices: choices.map((choice) => choice.protocol),
      initialDefault,
      draft,
      active,
      refreshed: {
        protocol: refreshed?.protocol,
        variant: refreshed?.variant,
      },
      missing: {
        providerId: missing?.providerId,
        protocol: missing?.protocol ?? null,
      },
    };
  });
  expect(result).toEqual({
    choices: ["openai-compatible", "openai", "anthropic", "google"],
    initialDefault: null,
    draft: "google",
    active: ["openai-compatible", "openai", "anthropic", "google"].map(
      (protocol, index) => ({
        providerId: "gateway-" + index,
        protocol,
        variant: "retained-variant",
      }),
    ),
    refreshed: { protocol: "anthropic", variant: "retained-variant" },
    missing: { providerId: "uncatalogued-provider", protocol: null },
  });
});

test("selected conversation metadata refresh retains pushed statistics without reopening history", async ({
  page,
}) => {
  await nativeBackend(page, { extraMethods: ["model.metadata.refresh"] });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    const calls: string[] = [];
    store.update({ sessionId: "s", statistics: { marker: "current_event" } });
    store.call = async (method: string) => {
      calls.push(method);
      if (method !== "model.metadata.refresh")
        throw Error("unordered_snapshot_forbidden");
      return {
        items: [{ id: "new", name: "New", provider_id: "p", variants: [] }],
      };
    };
    store.attach = async (id: string) => {
      calls.push("ordered:" + id);
      store.update({ statistics: { marker: "fresh_subscription" } });
    };
    await store.dispatch({ type: "RefreshModelMetadata" });
    const result = {
      calls,
      statistics: store.state.statistics,
      error: store.state.modelMetadataError,
    };
    store.stop();
    return result;
  });
  expect(result).toEqual({
    calls: ["model.metadata.refresh"],
    statistics: { marker: "current_event" },
    error: null,
  });
});

test("reconnect releases obsolete refresh pending state and the next refresh remains usable", async ({
  page,
}) => {
  await nativeBackend(page, { extraMethods: ["model.metadata.refresh"] });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    let release!: (value: unknown) => void;
    store.call = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    store.api.browserSession = async () => ({ authenticated: false });
    const pending = store.dispatch({ type: "RefreshModelMetadata" });
    await store.dispatch({ type: "Reconnect" });
    const reset = store.state.modelMetadataPending;
    release({
      items: [
        { id: "obsolete", name: "Obsolete", provider_id: "p", variants: [] },
      ],
    });
    await pending;
    store.call = async () => ({
      items: [{ id: "new", name: "New", provider_id: "p", variants: [] }],
    });
    await store.dispatch({ type: "RefreshModelMetadata" });
    const result = {
      reset,
      pending: store.state.modelMetadataPending,
      id: store.state.availableModels[0].id,
    };
    store.stop();
    return result;
  });
  expect(result).toEqual({ reset: false, pending: false, id: "new" });
});

test("logout clears an in-flight metadata refresh without restoring old configured choices", async ({
  page,
}) => {
  await nativeBackend(page, { extraMethods: ["model.metadata.refresh"] });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    let release!: (value: unknown) => void;
    store.call = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    store.api.logout = async () => {};
    store.api.disconnectHost = async () => {};
    store.update({
      availableModels: [{ id: "old" }],
      modelMetadataStatus: { models: 696 },
    });
    const pending = store.dispatch({ type: "RefreshModelMetadata" });
    await store.dispatch({ type: "Logout" });
    release({
      items: [
        { id: "obsolete", name: "Obsolete", provider_id: "p", variants: [] },
      ],
    });
    await pending;
    const result = {
      models: store.state.availableModels,
      pending: store.state.modelMetadataPending,
      status: store.state.modelMetadataStatus,
      error: store.state.modelMetadataError,
    };
    store.stop();
    return result;
  });
  expect(result).toEqual({
    models: [],
    pending: false,
    status: null,
    error: null,
  });
});

for (const width of [390, 1440]) {
  test(`model picker exposes pending and updated metadata without overflow at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await nativeBackend(page, {
      extraMethods: ["model.metadata", "model.metadata.refresh"],
    });
    const items = [
      {
        id: "configured",
        name: "Configured model",
        provider_id: "p",
        variants: [],
      },
    ];
    await page.route("**/api/v1/models", (route) =>
      route.fulfill({
        json: { items, metadata_status: { fetched_at_ms: null, models: 0 } },
      }),
    );
    let release!: () => void;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/v1/models/metadata/refresh", async (route) => {
      await response;
      await route.fulfill({
        json: {
          items,
          metadata_status: { fetched_at_ms: 1710000000000, models: 696 },
        },
      });
    });
    await page.goto("/");
    await page.locator(".composer-model-pill").click();
    await page.getByRole("button", { name: /^选择模型\.\.\./ }).click();
    const refresh = page.getByTestId("model-metadata-refresh");
    await expect(refresh).toBeEnabled();
    await expect(page.getByTestId("model-metadata-status")).toContainText(
      "尚未获取模型信息",
    );
    await refresh.click();
    await expect(refresh).toBeDisabled();
    await expect(refresh).toContainText("正在更新");
    release();
    await expect(refresh).toBeEnabled();
    await expect(page.getByTestId("model-metadata-status")).toContainText(
      "模型信息更新于",
    );
    await expect(page.locator(".model-item-name")).toHaveText(
      "Configured model",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("model picker shows a retained-cache refresh failure until manual refresh succeeds", async ({
  page,
}) => {
  await nativeBackend(page, {
    extraMethods: ["model.metadata", "model.metadata.refresh"],
  });
  const items = [
    {
      id: "configured",
      name: "Configured model",
      provider_id: "p",
      variants: [],
    },
  ];
  await page.route("**/api/v1/models", (route) =>
    route.fulfill({
      json: {
        items,
        metadata_status: {
          fetched_at_ms: 1710000000000,
          models: 696,
          last_error: "model metadata refresh failed",
        },
      },
    }),
  );
  const refreshedAt = 1710086400000;
  await page.route("**/api/v1/models/metadata/refresh", (route) =>
    route.fulfill({
      json: {
        items,
        metadata_status: {
          fetched_at_ms: refreshedAt,
          models: 697,
          last_error: null,
        },
      },
    }),
  );
  await page.goto("/");
  await page.locator(".composer-model-pill").click();
  await page.getByRole("button", { name: /^选择模型\.\.\./ }).click();
  const status = page.getByTestId("model-metadata-status");
  await expect(status).toHaveText("更新失败，保留上次模型信息");
  await expect(page.locator(".model-item-name")).toHaveText("Configured model");
  await page.getByTestId("model-metadata-refresh").click();
  const updatedTime = await page.evaluate(
    (timestamp) => new Date(timestamp).toLocaleString(),
    refreshedAt,
  );
  await expect(status).toHaveText(`模型信息更新于 ${updatedTime}`);
  await expect(status).not.toContainText("更新失败");
  await expect(page.locator(".model-item-name")).toHaveText("Configured model");
});

test("metadata refresh uses canonical HTTP and preserves existing choices on failure", async ({
  page,
}) => {
  await nativeBackend(page, {
    extraMethods: ["model.metadata", "model.metadata.refresh"],
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    const calls: string[] = [];
    let release!: (value: unknown) => void;
    store.call = (method: string) => {
      calls.push(method);
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    store.update({
      availableModels: [
        { id: "old", name: "Old", providerId: "p", variants: [] },
      ],
    });
    const pending = store.dispatch({ type: "RefreshModelMetadata" });
    await store.dispatch({ type: "RefreshModelMetadata" });
    const busy = store.state.modelMetadataPending;
    release({
      items: [{ id: "new", name: "New", provider_id: "p", variants: [] }],
      metadata_status: { models: 696, fetched_at_ms: 123 },
    });
    await pending;
    const updated = {
      id: store.state.availableModels[0].id,
      status: store.state.modelMetadataStatus,
      pending: store.state.modelMetadataPending,
    };
    store.call = async () => {
      throw Error("synthetic fetch failure");
    };
    await store.dispatch({ type: "RefreshModelMetadata" });
    const failed = {
      id: store.state.availableModels[0].id,
      status: store.state.modelMetadataStatus,
      pending: store.state.modelMetadataPending,
      hasError: !!store.state.modelMetadataError,
      concrete: store.state.modelMetadataError.includes(
        "synthetic fetch failure",
      ),
    };
    store.stop();
    return { calls, busy, updated, failed };
  });
  expect(result).toEqual({
    calls: ["model.metadata.refresh"],
    busy: true,
    updated: {
      id: "new",
      status: { models: 696, fetched_at_ms: 123 },
      pending: false,
    },
    failed: {
      id: "new",
      status: { models: 696, fetched_at_ms: 123 },
      pending: false,
      hasError: true,
      concrete: true,
    },
  });
});

test("manual metadata HTTP refresh sends authenticated origin-bound JSON without a socket", async ({
  page,
}) => {
  await nativeBackend(page, {
    extraMethods: ["model.metadata", "model.metadata.refresh"],
  });
  await page.route("**/api/v1/models/metadata/refresh", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["content-type"]).toContain(
      "application/json",
    );
    expect(route.request().postDataJSON()).toEqual({});
    await route.fulfill({ json: { metadata_status: { models: 2 } } });
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { ApiClient } = await import("/src/client/api.ts");
    const api = new ApiClient(location.origin + "/");
    const value = await api.request("model.metadata.refresh");
    api.stop();
    return value;
  });
  expect(result).toEqual({ metadata_status: { models: 2 } });
});

test("obsolete catalog refresh cannot replace a new owner's configured models", async ({
  page,
}) => {
  await nativeBackend(page, {
    extraMethods: ["model.metadata", "model.metadata.refresh"],
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    let release!: (value: unknown) => void;
    store.call = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = store.dispatch({ type: "RefreshModelMetadata" });
    store.lifecycle++;
    store.update({
      availableModels: [{ id: "replacement" }],
      modelMetadataPending: true,
    });
    release({
      items: [
        { id: "obsolete", name: "Obsolete", provider_id: "p", variants: [] },
      ],
    });
    await pending;
    const result = {
      id: store.state.availableModels[0].id,
      pending: store.state.modelMetadataPending,
    };
    store.stop();
    return result;
  });
  expect(result).toEqual({ id: "replacement", pending: true });
});

test("catalog capacity survives bootstrap and refresh before any model request", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    extraMethods: ["model.metadata.refresh"],
  });
  backend.snapshot().messages = [];
  backend.snapshot().session.model = "grok-4.7";
  backend.snapshot().session.model_selection = {
    provider_id: "grok",
    model: "grok-4.7",
    variant: null,
  };
  const items = (limit: number) => [
    {
      id: "grok-4.7",
      name: "Other provider",
      provider_id: "other",
      variants: [],
      context_window_tokens: 999,
    },
    {
      id: "grok-4.7",
      name: "Grok 4.7",
      provider_id: "grok",
      variants: [],
      context_window_tokens: limit,
    },
  ];
  await page.route("**/api/v1/models", (route) =>
    route.fulfill({
      json: {
        items: items(500000),
        default_model_selection: {
          provider_id: "grok",
          model: "grok-4.7",
          variant: null,
        },
      },
    }),
  );
  await page.route("**/api/v1/models/metadata/refresh", (route) =>
    route.fulfill({
      json: {
        items: items(400000),
      },
    }),
  );
  await page.goto("/#session/s1");
  const usage = page.getByTestId("statistics-usage");
  await expect(usage).toContainText("上下文 —");
  await usage.click();
  const details = page.locator("#statistics-usage-details");
  const windowRow = details
    .locator(".dock-stat-row")
    .filter({ hasText: "模型上下文窗口 token" });
  await expect(windowRow).toContainText("500,000");
  await expect(usage).not.toContainText("%");
  await page.keyboard.press("Escape");
  await page.locator(".composer-model-pill").click();
  await page.getByRole("button", { name: /^选择模型\.\.\./ }).click();
  await page.getByTestId("model-metadata-refresh").click();
  await expect(page.getByTestId("model-metadata-refresh")).toBeEnabled();
  await page
    .getByRole("dialog", { name: "选择模型" })
    .getByRole("button", { name: "关闭", exact: true })
    .first()
    .click();
  await usage.click();
  await expect(windowRow).toContainText("400,000");
  await expect(windowRow).not.toContainText("999");
  await expect(usage).not.toContainText("%");
});
