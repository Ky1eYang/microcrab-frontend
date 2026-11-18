import { selectSidebarPlugin } from "./plugin-sidebar-selection";
import { maintainedPluginBundle } from "./plugin-bundle-fixture";
import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test.beforeEach(async ({ page }) => {
  await maintainedPluginBundle(page);
});
import { connectHostUI } from "./host-fixture";

test("declared Session plugin tab preserves the conversation node, draft and route and falls back when disabled", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.route("**/src/main.tsx", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `import { AppStore as SurfaceStore } from '/src/state/store.ts';
const surfaceStart = SurfaceStore.prototype.start;
SurfaceStore.prototype.start = function () { window.surfaceStore = this; return surfaceStart.call(this); };
${await response.text()}`,
    });
  });
  await page.goto("/#/session/s1/plugins");
  const manager = page.getByTestId("client-plugins-manager");
  await manager.locator('[data-plugin-nav-id="microcrab.fixture"]').click();
  const fixture = manager.locator(
    'article[data-plugin-id="microcrab.fixture"]',
  );
  await fixture.getByLabel("在当前会话启用").click();
  await expect(fixture.getByLabel("在当前会话启用")).toBeChecked();
  await expect(fixture).toHaveAttribute("data-status", "ready");
  await page.evaluate(() =>
    (window as any).surfaceStore.dispatch({ type: "ClosePluginPage" }),
  );
  await connectHostUI(page);
  await expect(
    page.getByTestId("session-plugin-tab").filter({ hasText: "State Viewer" }),
  ).toHaveCount(0);
  const composer = page.getByTestId("composer").locator("textarea");
  await composer.fill("surface draft survives");
  await composer.evaluate((node) =>
    node.setAttribute("data-surface-survivor", "yes"),
  );
  const url = page.url();
  const socketCount = await page.evaluate(
    () => (window as any).surfaceStore.getSnapshot().sessionId,
  );
  await page
    .getByTestId("session-plugin-tab")
    .filter({ hasText: "Component fixture" })
    .click();
  await expect(page.getByTestId("session-plugin-panel")).toBeVisible();
  await expect(composer).toBeHidden();
  await expect(composer).toHaveAttribute("data-surface-survivor", "yes");
  await expect(composer).toHaveValue("surface draft survives");
  expect(page.url()).toBe(url);
  await page
    .getByTestId("session-plugin-panel")
    .getByRole("button", { name: "Use HTML", exact: true })
    .click();
  const html = page
    .getByTestId("session-plugin-panel")
    .getByTestId("plugin-webview");
  await expect(html).toHaveAttribute("data-status", "ready");
  const mountedSurface = await page.evaluate(
    () =>
      (window as any).surfaceStore.plugins.registry.view(
        "microcrab.fixture",
        "session-tab",
      ).vars.last_action_context.surface,
  );
  expect(mountedSurface.target).toBe("session-tab");
  expect(mountedSurface.surface_id).toBeTruthy();
  expect(mountedSurface.surface_id).not.toBe("default:session-tab");
  await html
    .contentFrame()
    .getByRole("button", { name: "Fixture HTML", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).surfaceStore.plugins.registry.view(
            "microcrab.fixture",
            "session-tab",
          ).vars.last_action_context,
      ),
    )
    .toMatchObject({
      surface: mountedSurface,
    });
  await expect(composer).toHaveValue("surface draft survives");
  await page.evaluate(async (surface) => {
    const registry = (window as any).surfaceStore.plugins.registry;
    registry.setVariable("microcrab.fixture", "empty_view", true, surface);
    await registry.render("microcrab.fixture", "session-tab", true, surface);
  }, mountedSurface);
  await expect(
    page
      .getByTestId("session-plugin-panel")
      .locator("iframe, .plugin-renderer"),
  ).toHaveCount(0);
  await expect(page.getByTestId("session-plugin-panel")).toBeVisible();
  await page.evaluate(async (surface) => {
    const registry = (window as any).surfaceStore.plugins.registry;
    registry.setVariable("microcrab.fixture", "empty_view", false, surface);
    registry.setVariable("microcrab.fixture", "html_mode", false, surface);
    await registry.render("microcrab.fixture", "session-tab", true, surface);
  }, mountedSurface);
  await expect(
    page
      .getByTestId("session-plugin-panel")
      .getByRole("button", { name: "Increment", exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const store = (window as any).surfaceStore;
    await store.plugins.registry.setEnabled("microcrab.fixture", "s1", false);
  });
  await expect(page.getByTestId("session-plugin-panel")).toHaveCount(0);
  await expect(composer).toBeVisible();
  await expect(composer).toHaveAttribute("data-surface-survivor", "yes");
  await expect(composer).toHaveValue("surface draft survives");
  expect(
    await page.evaluate(
      () => (window as any).surfaceStore.getSnapshot().sessionId,
    ),
  ).toBe(socketCount);
});

test("checked State API uses authenticated paths, forwards abort and observes unknown writes without replay", async ({
  page,
}) => {
  await nativeBackend(page);
  const writes: unknown[] = [];
  let observations = 0;
  await page.route("**/api/v1/sessions/s1/variables", async (route) => {
    writes.push(route.request().postDataJSON());
    await route.abort("failed");
  });
  await page.route(
    "**/api/v1/sessions/s1/variables/operations/op-one",
    (route) => {
      observations++;
      return route.fulfill({
        json: { operation_id: "op-one", status: "unknown" },
      });
    },
  );
  await page.goto("/");
  const result = await page.evaluate(async () => {
    // @ts-expect-error Browser source import is resolved by the existing test server.
    const { ApiClient } = await import("/src/client/api.ts");
    const api = new ApiClient(location.origin);
    const payload = {
      operation_id: "op-one",
      expected: { runtime_instance_id: "incarnation", variables_revision: "3" },
      change: { set: { exact: null } },
    };
    let unknown = false;
    try {
      await api.request("session.variables.patch", payload, "s1");
    } catch (error) {
      unknown = (error as any).outcomeUnknown;
    }
    const observation = await api.request(
      "session.variables.operation",
      { operation_id: "op-one" },
      "s1",
    );
    const controller = new AbortController();
    controller.abort();
    let aborted = false;
    try {
      await api.request(
        "state.inspection",
        {},
        "s1",
        undefined,
        undefined,
        controller.signal,
      );
    } catch {
      aborted = true;
    }
    return { unknown, observation, aborted, payload };
  });
  expect(result.unknown).toBe(true);
  expect(result.observation.status).toBe("unknown");
  expect(result.aborted).toBe(true);
  expect(writes).toEqual([result.payload]);
  expect(observations).toBe(1);
});

test("State broker rejects cross-Session and spoofed fields and fences history completions", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    // @ts-expect-error Browser source import is resolved by the existing test server.
    const { ClientPlugins } = await import("/src/state/client-plugins.ts");
    // @ts-expect-error Browser source import is resolved by the existing test server.
    const { CommandError } = await import("/src/client/errors.ts");
    let release: (value: unknown) => void = () => {};
    const requests: any[] = [];
    let behavior = "wait";
    const bridge: any = new ClientPlugins(() => ({
      request: (...args: any[]) => {
        requests.push(args);
        if (behavior === "reject")
          return Promise.reject(
            new CommandError(
              "variable_conflict",
              "State changed",
              false,
              false,
              { operation_id: "op" },
            ),
          );
        if (behavior === "unknown")
          return Promise.reject(
            new CommandError("disconnected", "Receipt lost", true, true),
          );
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    }));
    bridge.session = "s1";
    const controller = new AbortController();
    const effect = {
      kind: "state-inspection",
      payload: {},
      sessionId: "s1",
      context: { session_id: "s1" },
      signal: controller.signal,
    };
    let crossSession = false,
      spoofed = false,
      historyFenced = false;
    try {
      await bridge.effect({ ...effect, context: { session_id: "s2" } }, 0);
    } catch {
      crossSession = true;
    }
    try {
      await bridge.effect(
        {
          ...effect,
          kind: "state-change",
          payload: {
            operation_id: "op",
            expected: {},
            change: {},
            role: "runtime",
          },
        },
        0,
      );
    } catch {
      spoofed = true;
    }
    const pending = bridge.effect(effect, 0);
    const forwarded = requests[0][5] === controller.signal;
    bridge.resetHistory();
    release({ values: {} });
    try {
      await pending;
    } catch {
      historyFenced = true;
    }
    behavior = "reject";
    const change = {
      ...effect,
      kind: "state-change",
      payload: { operation_id: "op", expected: {}, change: {} },
    };
    const rejected = await bridge.effect(change, 0);
    behavior = "unknown";
    const unknown = await bridge.effect(change, 0);
    return {
      crossSession,
      spoofed,
      forwarded,
      historyFenced,
      rejected,
      unknown,
      requests: requests.length,
    };
  });
  expect(result).toMatchObject({
    crossSession: true,
    spoofed: true,
    forwarded: true,
    historyFenced: true,
    requests: 3,
  });
  expect(result.rejected).toMatchObject({
    operation_id: "op",
    status: "rejected",
    reason: { code: "variable_conflict" },
  });
  expect(result.unknown).toMatchObject({
    operation_id: "op",
    status: "unknown",
  });
});

test("real block slots retain exact before/after placement and action context across native and HTML outputs", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.route("**/src/main.tsx", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `import { AppStore as SlotStore } from '/src/state/store.ts';
const slotStart = SlotStore.prototype.start;
SlotStore.prototype.start = function () { window.slotStore = this; return slotStart.call(this); };
${await response.text()}`,
    });
  });
  await page.addInitScript(() =>
    localStorage.setItem("microcrab.ui.rightRailCollapsed", "false"),
  );
  await page.goto("/#/session/s1/plugins");
  const manager = page.getByTestId("client-plugins-manager");
  await manager.locator('[data-plugin-nav-id="microcrab.fixture"]').click();
  const fixture = manager.locator(
    'article[data-plugin-id="microcrab.fixture"]',
  );
  await fixture.getByLabel("在当前会话启用").click();
  await expect(fixture.getByLabel("在当前会话启用")).toBeChecked();
  await expect(fixture).toHaveAttribute("data-status", "ready");
  await page.evaluate(() =>
    (window as any).slotStore.dispatch({ type: "ClosePluginPage" }),
  );
  await selectSidebarPlugin(
    page.getByTestId("client-plugin-sidebar"),
    "Component fixture",
  );
  const blockId = await page.evaluate(
    () =>
      (window as any).slotStore
        .getSnapshot()
        .transcript.blocks.find(
          (block: any) => block.payload.text === "历史提问",
        ).id,
  );
  const publish = async (html: boolean) =>
    page.evaluate(
      async ({ blockId, html }) => {
        const registry = (window as any).slotStore.plugins.registry;
        await registry.action("microcrab.fixture", "html-mode", {
          value: html,
        });
        await registry.action("microcrab.fixture", "publish-slots", {
          block_id: blockId,
        });
      },
      { blockId, html },
    );
  const row = page
    .locator(".message-turn-container.user-turn")
    .filter({ hasText: "历史提问" });
  const message = row.getByTestId("chat-message");
  await message.evaluate((node) =>
    node.setAttribute("data-slot-survivor", "yes"),
  );
  const slots = row.locator(`[data-plugin-block-id="${blockId}"]`);
  await publish(false);
  const before = slots.getByRole("button", {
    name: "Fixture before",
    exact: true,
  });
  const after = slots.getByRole("button", {
    name: "Fixture after",
    exact: true,
  });
  await expect(before).toBeVisible();
  await expect(after).toBeVisible();
  expect(
    await row.evaluate((node) => {
      const message = node.querySelector('[data-testid="chat-message"]')!;
      const slots = [...node.querySelectorAll("[data-plugin-block-id]")];
      return (
        !!(
          slots[0].compareDocumentPosition(message) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ) &&
        !!(
          message.compareDocumentPosition(slots[1]) &
          Node.DOCUMENT_POSITION_FOLLOWING
        )
      );
    }),
  ).toBe(true);
  await before.click();
  const context = () =>
    page.evaluate(
      () =>
        (window as any).slotStore.plugins.registry.view(
          "microcrab.fixture",
          "sidebar",
        ).vars.last_action_context,
    );
  await expect.poll(context).toMatchObject({
    session_id: "s1",
    surface: {
      target: "block-slot",
      block_id: blockId,
      slot_id: "fixture-before",
      placement: "before",
    },
  });
  await after.click();
  await expect.poll(context).toMatchObject({
    surface: {
      target: "block-slot",
      block_id: blockId,
      slot_id: "fixture-after",
      placement: "after",
    },
  });
  await publish(true);
  await expect(before).toHaveCount(0);
  await expect(slots.getByTestId("plugin-webview")).toHaveCount(2);
  const frames = slots.getByTestId("plugin-webview");
  await expect(frames.nth(0)).toHaveAttribute("data-status", "ready");
  await expect(frames.nth(1)).toHaveAttribute("data-status", "ready");
  await frames
    .nth(0)
    .contentFrame()
    .getByRole("button", { name: "Fixture HTML", exact: true })
    .click();
  await expect.poll(context).toMatchObject({
    surface: {
      target: "block-slot",
      block_id: blockId,
      slot_id: "fixture-before",
      placement: "before",
    },
  });
  await frames
    .nth(1)
    .contentFrame()
    .getByRole("button", { name: "Fixture HTML", exact: true })
    .click();
  await expect.poll(context).toMatchObject({
    surface: {
      target: "block-slot",
      block_id: blockId,
      slot_id: "fixture-after",
      placement: "after",
    },
  });
  await publish(false);
  await expect(frames).toHaveCount(0);
  await expect(before).toBeVisible();
  await expect(message).toHaveAttribute("data-slot-survivor", "yes");
});
