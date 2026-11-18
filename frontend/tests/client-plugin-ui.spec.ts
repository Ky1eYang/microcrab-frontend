import { selectSidebarPlugin } from "./plugin-sidebar-selection";
import { stateInspection } from "./state-inspection-fixture";
import { expect, test, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { connectHostUI } from "./host-fixture";
import { maintainedPluginBundle } from "./plugin-bundle-fixture";

test("real Component transforms actual Send once, observes unknown admission and retains rejected drafts", async ({
  page,
}) => {
  const backend = await nativeBackend(page, {
    inboxTurn: (command) => ({
      id: command.params.operation_id,
      session_id: "s1",
      method: command.method,
      status: "completed",
      result: { admitted: true },
    }),
  });
  await realAssets(page);
  // Capture the actual provider-owned store only in this served test module.
  // Production code receives no window export and still starts its real sockets.
  await page.route("**/src/main.tsx", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    await route.fulfill({
      response,
      body: `import { AppStore as CapturedPluginStore } from '/src/state/store.ts';
const originalPluginStart = CapturedPluginStore.prototype.start;
CapturedPluginStore.prototype.start = function () { window.pluginSendStore = this; return originalPluginStart.call(this); };
${source}`,
    });
  });
  await page.goto("/#/session/s1/plugins");
  const manager = page.getByTestId("client-plugins-manager");
  await expect(
    manager.locator('article[data-plugin-id="microcrab.fixture"]'),
  ).toBeVisible();
  await manager.locator('[data-plugin-nav-id="microcrab.mcp-bridge"]').click();
  const mcpEnabled = manager
    .locator('article[data-plugin-id="microcrab.mcp-bridge"]')
    .getByLabel("在当前会话启用");
  await mcpEnabled.click();
  await expect(mcpEnabled).not.toBeChecked();
  await manager.locator('[data-plugin-nav-id="microcrab.fixture"]').click();
  const fixtureEnabled = manager
    .locator('article[data-plugin-id="microcrab.fixture"]')
    .getByLabel("在当前会话启用");
  await fixtureEnabled.click();
  await expect(fixtureEnabled).toBeChecked();
  await expect(
    manager.locator('article[data-plugin-id="microcrab.fixture"]'),
  ).toHaveAttribute("data-status", "ready");
  await page.evaluate(async () => {
    const store = (window as any).pluginSendStore;
    await store.plugins.registry.action("microcrab.fixture", "prefix", {
      value: "wire: ",
    });
    await store.plugins.registry.action("microcrab.fixture", "inject", {
      value: { exact: 42 },
    });
    await store.dispatch({ type: "ClosePluginPage" });
  });
  await connectHostUI(page);
  const composer = page.getByTestId("composer").locator("textarea");
  await expect(composer).toBeEnabled();
  await page.evaluate(async () => {
    const store = (window as any).pluginSendStore;
    // @ts-expect-error Browser source imports resolve through the test server.
    const { CommandError } = await import("/src/client/api.ts");
    const request = store.api.request.bind(store.api);
    (window as any).pluginSendCalls = { queue: 0, observe: 0 };
    let last: any;
    store.api.request = async (method: string, params: any, ...rest: any[]) => {
      if (method === "turn.queue") {
        (window as any).pluginSendCalls.queue++;
        last = await request(method, params, ...rest);
        // The actual backend admitted these bytes. Lose only the command reply.
        throw new CommandError(
          "outcome_unknown",
          "Fixture lost admission reply",
          true,
          true,
        );
      }
      if (method === "turn.get" && last && params.operation_id === last.id) {
        (window as any).pluginSendCalls.observe++;
        return last;
      }
      return request(method, params, ...rest);
    };
  });
  await composer.fill("original draft");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  const admitted = backend.commands.filter(
    (command) => command.method === "turn.queue",
  );
  expect(admitted).toHaveLength(1);
  expect(admitted[0].params.activate_if_idle).toBe(true);
  expect(admitted[0].params.input.parts).toEqual([
    { type: "text", text: "wire: original draft" },
  ]);
  expect(admitted[0].params.input.variables.scoped_set).toEqual([
    {
      name: "fixture_value",
      value: { exact: 42 },
      visibility: "invisible",
      persistence: "ephemeral",
    },
    {
      name: "plugins",
      value: [],
      visibility: "visible",
      persistence: "persisted",
      editors: ["client"],
    },
  ]);
  expect(JSON.stringify(admitted[0].params.input.variables)).not.toContain(
    "authorization",
  );
  expect(JSON.stringify(admitted[0].params.input.variables)).not.toContain(
    "endpoint",
  );
  expect(await page.evaluate(() => (window as any).pluginSendCalls)).toEqual({
    queue: 1,
    observe: 1,
  });
  await page.evaluate(async () => {
    const store = (window as any).pluginSendStore;
    await store.plugins.registry.action("microcrab.fixture", "reject", {
      value: true,
    });
  });
  await composer.fill("keep this original draft");
  await composer.press("Enter");
  await expect(page.getByTestId("plugin-submit-notice")).toBeVisible();
  await expect(composer).toHaveValue("keep this original draft");
  expect(
    backend.commands.filter((command) => command.method === "turn.queue"),
  ).toHaveLength(1);
  await page.getByTestId("plugin-bypass-once").click();
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  const queues = backend.commands.filter(
    (command) => command.method === "turn.queue",
  );
  expect(queues).toHaveLength(2);
  expect(queues[1].params.input).toEqual({
    parts: [{ type: "text", text: "keep this original draft" }],
    variables: {
      set: {},
      remove: [],
      scoped_set: [
        {
          name: "plugins",
          value: [],
          visibility: "visible",
          persistence: "persisted",
          editors: ["client"],
        },
      ],
    },
  });
});

async function realAssets(page: Page) {
  const index = await maintainedPluginBundle(page);
  expect(index.version).toBe(1);
  expect(index.plugins.map((entry: { id: string }) => entry.id)).toEqual(
    expect.arrayContaining(["microcrab.state-viewer", "microcrab.fixture"]),
  );
  return index;
}

test("real Viewer renders pure values, reveals invisible values locally and preserves Session navigation", async ({
  page,
}) => {
  await nativeBackend(page);
  let valuesReads = 0;
  let metadataReads = 0;
  await page.route("**/api/v1/sessions/s1/state/inspection", (route) => {
    valuesReads++;
    metadataReads++;
    return route.fulfill({
      json: stateInspection(
        {
          visible_key: "visible-value",
          hidden_key: "original-hidden-value",
          ephemeral_key: { exact: 42 },
        },
        {
          visible_key: { visibility: "visible", persistence: "persisted" },
          hidden_key: { visibility: "invisible", persistence: "persisted" },
          ephemeral_key: { visibility: "invisible", persistence: "ephemeral" },
        },
      ),
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem("microcrab.ui.rightRailCollapsed", "false");
  });
  await realAssets(page);
  await page.goto("/#/session/s1/plugins");
  const manager = page.getByTestId("client-plugins-manager");
  await manager
    .locator('[data-plugin-nav-id="microcrab.state-viewer"]')
    .click();
  await expect(
    manager.locator('article[data-plugin-id="microcrab.state-viewer"]'),
  ).toBeVisible();
  await manager.getByRole("button", { name: "返回", exact: true }).click();
  const sidebar = page.getByTestId("client-plugin-sidebar");
  const viewerTab = sidebar.getByRole("tab", {
    name: "State Viewer",
    exact: true,
  });
  const mcpTab = sidebar.getByRole("tab", { name: "MCP bridge", exact: true });
  // Both real bundled capabilities are enabled: the visual provider remains the
  // default, while explicit tool-provider configuration selection stays stable.
  await expect(mcpTab).toBeVisible();
  await expect(viewerTab).toHaveAttribute("aria-selected", "true");
  await mcpTab.click();
  const serverId = sidebar.getByLabel("服务器 ID", { exact: true });
  await serverId.fill("explicit-selection");
  await expect(mcpTab).toHaveAttribute("aria-selected", "true");
  await expect(serverId).toHaveValue("explicit-selection");
  await expect(sidebar.getByTestId("plugin-expand")).toHaveCount(0);
  await expect(
    page.locator('[role="tab"]').filter({ hasText: "MCP bridge" }),
  ).toHaveCount(1);
  await viewerTab.click();
  const viewer = page.locator(
    '[data-testid="client-plugin-sidebar"] .plugin-renderer[data-plugin-id="microcrab.state-viewer"]',
  );
  await expect(
    viewer.getByText('"visible-value"', { exact: false }),
  ).toBeVisible();
  await expect(
    viewer.getByText("original-hidden-value", { exact: false }),
  ).toHaveCount(0);
  const reads = [valuesReads, metadataReads];
  await viewer.getByRole("button", { name: "显示模型不可见的值" }).click();
  await expect(
    viewer.getByText("original-hidden-value", { exact: false }),
  ).toBeVisible();
  expect([valuesReads, metadataReads]).toEqual(reads);
  await viewer.getByRole("searchbox").fill("ephemeral_key");
  await expect(viewer.getByText('"exact"', { exact: false })).toBeVisible();
  await expect(
    viewer.getByText("original-hidden-value", { exact: false }),
  ).toHaveCount(0);
  await page.getByTestId("plugins-manage").click();
  await manager.locator('[data-plugin-nav-id="microcrab.fixture"]').click();
  const fixture = manager.locator(
    'article[data-plugin-id="microcrab.fixture"]',
  );
  await fixture.getByLabel("在当前会话启用").click();
  await expect(fixture.getByLabel("在当前会话启用")).toBeChecked();
  await manager.getByRole("button", { name: "返回", exact: true }).click();
  await selectSidebarPlugin(sidebar, "Component fixture");
  await page
    .getByTestId("client-plugin-sidebar")
    .getByRole("button", { name: "Increment", exact: true })
    .click();
  await expect(
    page.getByTestId("client-plugin-sidebar").getByText("1", { exact: true }),
  ).toBeVisible();
  await page.getByTestId("plugin-expand").click();
  await expect(page).toHaveURL(/session\/s1$/);
  await expect(page.getByTestId("plugin-workspace-dialog")).toBeVisible();
  await expect(
    page.getByTestId("expanded-plugin-page").getByText("1", { exact: true }),
  ).toBeVisible();
  await page
    .getByTestId("content-dialog")
    .getByRole("button", { name: "关闭", exact: true })
    .click();
  await expect(page.getByTestId("plugin-workspace-dialog")).toHaveCount(0);
  await page.getByTestId("plugins-manage").click();
  await manager.locator('[data-plugin-nav-id="microcrab.fixture"]').click();
  await expect(manager).toBeVisible();
  await page.reload();
  await manager.locator('[data-plugin-nav-id="microcrab.fixture"]').click();
  await expect(
    manager
      .locator('article[data-plugin-id="microcrab.fixture"]')
      .getByLabel("在当前会话启用"),
  ).toBeChecked();
});

test("real Component preprocessing caches exact operations and fences Session changes", async ({
  page,
}) => {
  await nativeBackend(page);
  const assets = await realAssets(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    // @ts-expect-error Browser source imports are resolved by the existing Vite test server.
    const { ClientPlugins } = await import("/src/state/client-plugins.ts");
    // @ts-expect-error Browser source imports are resolved by the existing Vite test server.
    const { initialState } = await import("/src/state/model.ts");
    const bridge = new ClientPlugins(() => ({ request: async () => ({}) }));
    const state = {
      ...initialState(),
      authSession: {
        authenticated: true,
        principal: { owner: "plugin-preprocess-test" },
      },
      sessionId: "s1",
    };
    bridge.sync(state);
    await bridge.ready;
    const registry = bridge.registry;
    const mcpTargets = registry
      .getSnapshot()
      .find((p: any) => p.manifest.id === "microcrab.mcp-bridge")!.manifest
      .targets;
    await registry.setEnabled("microcrab.state-viewer", "s1", false);
    await registry.setEnabled("microcrab.fixture", "s1", true);
    await registry.setEnabled("microcrab.mcp-bridge", "s1", true);
    await registry.action("microcrab.fixture", "prefix", {
      value: "checked: ",
    });
    await registry.action("microcrab.fixture", "inject", {
      value: { original: 42 },
    });
    const original = {
      parts: [
        { type: "text", text: "first" },
        {
          type: "image",
          source: { type: "attachment", attachment_id: "image-one" },
        },
        { type: "text", text: "second" },
      ],
    };
    const first = await bridge.preprocess(
      original,
      "exact-operation",
      "s1",
      () => true,
    );
    await registry.action("microcrab.fixture", "prefix", {
      value: "changed: ",
    });
    const cached = await bridge.preprocess(
      original,
      "exact-operation",
      "s1",
      () => true,
    );
    const fenced = await bridge.preprocess(
      original,
      "cancelled-operation",
      "s1",
      () => false,
    );
    await registry.action("microcrab.fixture", "reject", { value: true });
    let rejected = false;
    try {
      await bridge.preprocess(original, "rejected-operation", "s1", () => true);
    } catch {
      rejected = true;
    }
    bridge.allowBypassOnce();
    const bypassed = await bridge.preprocess(
      original,
      "bypass-operation",
      "s1",
      () => true,
    );
    const bypassConsumed = !bridge.bypass;
    bridge.dispose();
    return {
      first,
      cached,
      fenced,
      rejected,
      bypassed,
      bypassConsumed,
      original,
      mcpTargets,
    };
  });
  expect(result.mcpTargets).toEqual(["sidebar", "setting-page"]);
  expect(result.first).toEqual(result.cached);
  expect(result.first.parts).toEqual([
    { type: "text", text: "checked: first\nsecond" },
    result.original.parts[1],
  ]);
  const mcpArtifact = assets.plugins.find(
    (entry: { id: string }) => entry.id === "microcrab.mcp-bridge",
  ).sha256;
  const inventory = {
    name: "plugins",
    value: [
      {
        id: "microcrab.mcp-bridge",
        name: "MCP bridge",
        version: "0.1.17",
        artifact: mcpArtifact,
        description:
          "Multi-server MCP tools. List servers and tools; describe(server) lists tools, describe(server, tool) returns schema and call_pin. Call with only pin and arguments. Expired references require describe again; never retry uncertain effects.",
      },
    ],
    visibility: "visible",
    persistence: "persisted",
    editors: ["client"],
  };
  expect(result.first.variables.scoped_set).toEqual([
    {
      name: "fixture_value",
      value: { original: 42 },
      visibility: "invisible",
      persistence: "ephemeral",
    },
    inventory,
  ]);
  expect(JSON.stringify(result.first.variables)).not.toContain("authorization");
  expect(JSON.stringify(result.first.variables)).not.toContain("endpoint");
  expect(result.fenced).toBeNull();
  expect(result.rejected).toBeTruthy();
  expect(result.bypassed).toEqual({
    ...result.original,
    variables: { set: {}, remove: [], scoped_set: [inventory] },
  });
  expect(result.bypassConsumed).toBeTruthy();
});
