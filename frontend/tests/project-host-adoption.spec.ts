import { expect, test, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

const direct = "server_direct_grpc";
const outbound = "server_direct_outbound";
const relay = "browser_relay";
const detached = {
  project_id: "project-1", carrier_mode: "detached", connection_generation: null,
  ready: false, connected: false, reconciling: false, descriptor: null,
};
function routeView(carrier_mode: string, connection_generation = "101", ready = true, reconciling = false) {
  return {
    project_id: "project-1", carrier_mode, connection_generation, ready, connected: true, reconciling,
    descriptor: { host_id: "h1", workspace_id: "w1", workspace_root: "/assigned", platform: "test", tool_capabilities: ["read"], supported_primitives: [] },
    // Native peer reports ready before the Manager's admission gate has opened.
    readiness: { connection_generation, ready: true, connected: true, reconciling: false, phase: "ready", cause: null },
  };
}
async function savedLocator(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(`microcrab.host-endpoint:${location.origin}/project-1`, "http://127.0.0.1:8789");
  });
}
async function guardWrites(page: Page) {
  const writes: string[] = [];
  await page.route(/\/api\/v1\/projects\/[^/]+\/(?:host\/(?:connect|disconnect|outbound\/.*)|host-reconcile)$/, (route) => {
    writes.push(route.request().url());
    return route.fulfill({ status: 409, json: { error: { code: "unexpected_write", message: "Route observation is read-only" } } });
  });
  return writes;
}
function hold() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { release, promise };
}

for (const carrier of [direct, outbound, relay]) {
  test(`${carrier} is adopted by a clean profile without a locator`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
      const page = await context.newPage();
      const backend = await nativeBackend(page);
      const writes = await guardWrites(page);
      const catalog = hold();
      let catalogRequested = false;
      await page.route("**/api/v1/projects/project-1/host-state", (route) => route.fulfill({ json: routeView(carrier) }));
      await page.route("**/api/v1/projects/project-1/agents", async (route) => {
        catalogRequested = true;
        await catalog.promise;
        return route.fallback();
      });
      await page.goto("/");
      await expect.poll(() => catalogRequested).toBe(true);
      const header = page.getByTestId("header-host-connection");
      await expect(header).toHaveAttribute("data-host-state", "loading_catalog");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      catalog.release();
      await expect(header).toHaveAttribute("data-host-state", "ready");
      await expect(header).toHaveAttribute("data-host-carrier", carrier === relay ? "browser_relay_passive" : carrier);
      await header.click();
      await expect(page.getByTestId("host-carrier-mode")).toBeVisible();
      await expect(page.getByRole("button", { name: "断开连接", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "刷新 Host 状态与操作记录", exact: true }).click();
      expect(writes).toEqual([]);
      expect(backend.bridges).toHaveLength(0);
    } finally { await context.close(); }
  });
}

test("passive Session opens only after catalog and activation, observes loss and replacement without replay", async ({ page }) => {
  const backend = await nativeBackend(page);
  const writes = await guardWrites(page);
  await savedLocator(page);
  let view: ReturnType<typeof routeView> | typeof detached | (Omit<typeof detached, "connection_generation"> & { connection_generation: string }) = routeView(relay);
  await page.route("**/api/v1/projects/project-1/host-state", (route) => route.fulfill({ json: view }));
  const runtime = hold();
  let opens = 0;
  await page.route("**/api/v1/sessions/s1/runtime", async (route) => {
    if (++opens === 1) await runtime.promise;
    return route.fulfill({ json: backend.snapshot() });
  });
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect.poll(() => opens).toBe(1);
  const header = page.getByTestId("header-host-connection");
  await expect(header).toHaveAttribute("data-host-state", "loading_catalog");
  runtime.release();
  await expect(header).toHaveAttribute("data-host-state", "ready");
  const composer = page.getByLabel("消息", { exact: true });
  await composer.pressSequentially("Keep this draft across Host changes");
  await expect(composer).toHaveValue("Keep this draft across Host changes");
  view = { ...detached, connection_generation: "101" };
  await expect(header).toHaveAttribute("data-host-state", "detached", { timeout: 10000 });
  view = routeView(outbound, "102");
  await expect(header).toHaveAttribute("data-host-carrier", outbound, { timeout: 10000 });
  await expect(header).toHaveAttribute("data-host-state", "ready");
  await expect(composer).toHaveValue("Keep this draft across Host changes");
  expect(opens).toBe(2);
  expect(writes).toEqual([]);
  expect(backend.commands.filter((command) => ["turn.queue", "turn.retry", "host.relay_attach"].includes(command.method))).toEqual([]);
});

test("streamed model observations never drive Project Host reads", async ({ page }) => {
  // Exclude the independent compatibility observer from this event-driven test.
  await page.addInitScript(() => {
    const schedule = window.setInterval.bind(window);
    window.setInterval = (handler, delay, ...args) =>
      delay === 5000 && String(handler).includes("observeHostChange")
        ? 0
        : schedule(handler, delay, ...args);
  });
  const backend = await nativeBackend(page);
  let reads = 0;
  let view = routeView(direct);
  await page.route("**/api/v1/projects/project-1/host-state", (route) => {
    reads++;
    return route.fulfill({ json: view });
  });
  await page.goto("/#session/s1");
  const header = page.getByTestId("header-host-connection");
  await expect(header).toHaveAttribute("data-host-state", "ready");
  const baseline = reads;
  view = routeView(direct, "101", false, true);
  for (let round = 1; round <= 10; round++) {
    backend.event("model_observation", {
      operation_id: "streaming-turn",
      call_id: `request-${round}`,
      epoch: 0,
      turn: 2,
      round,
      phase: "started",
    });
  }
  // Give unsolicited requests time to complete before the positive control.
  await expect(header).not.toHaveAttribute("data-host-state", "reconciling", { timeout: 250 });
  await expect.poll(() => reads, { timeout: 750 }).toBe(baseline);
  backend.event("host_connection", { state: "reconciling" });
  await expect(header).toHaveAttribute("data-host-state", "reconciling");
  expect(reads).toBe(baseline + 1);
});

test("Project Host watch is independent of Session and suppresses recurring HTTP reads", async ({ page }) => {
  const backend = await nativeBackend(page, {
    extraMethods: ["project.host_watch", "project.host_unwatch"],
    projectHostSummary: () => routeView(direct),
  });
  let reads = 0;
  await page.route("**/api/v1/projects/project-1/host-state", (route) => {
    reads++;
    return route.fulfill({ json: routeView(direct) });
  });
  await page.clock.install();
  await page.goto("/");
  const header = page.getByTestId("header-host-connection");
  await expect(header).toHaveAttribute("data-host-state", "ready");
  await expect.poll(() => backend.commands.filter(c => c.method === "project.host_watch").length).toBe(1);
  const baseline = reads;
  backend.projectHostEvent({ ...detached, connection_generation: "101" });
  await expect(header).toHaveAttribute("data-host-state", "detached");
  backend.projectHostEvent(routeView(outbound, "102"));
  await expect(header).toHaveAttribute("data-host-carrier", outbound);
  await expect(header).toHaveAttribute("data-host-state", "ready");
  await page.clock.fastForward(25_000);
  expect(reads).toBe(baseline);
});

for (const scenario of ["failed", "unready", "reconciling"] as const) {
  test(`a saved locator is not used after ${scenario} observation`, async ({ page }) => {
    const backend = await nativeBackend(page);
    await savedLocator(page);
    const writes = await guardWrites(page);
    await page.route("**/api/v1/projects/project-1/host-state", (route) => scenario === "failed"
      ? route.fulfill({ status: 502, json: { error: { code: "fixture_unavailable", message: "Host observation unavailable" } } })
      : route.fulfill({ json: routeView(direct, "101", false, scenario === "reconciling") }));
    await page.goto("/#session/s1");
    await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
    await expect(page.getByTestId("header-host-connection")).toHaveAttribute("data-host-state", scenario === "failed" ? "suspended" : scenario);
    expect(writes).toEqual([]);
    expect(backend.requests.some(({ path }) => path.endsWith("/agents") || path.endsWith("/runtime"))).toBe(false);
  });
}

test("guarded detached resume losing the race observes the replacement without a second attach", async ({ page }) => {
  await nativeBackend(page);
  await savedLocator(page);
  let connects = 0;
  let observations = 0;
  await page.route("**/api/v1/projects/project-1/host-state", (route) => {
    observations++;
    return route.fulfill({ json: connects ? routeView(outbound) : detached });
  });
  await page.route("**/api/v1/projects/project-1/host/connect", (route) => {
    connects++;
    expect(route.request().postDataJSON()).toMatchObject({ only_if_unattached: true });
    expect(route.request().postDataJSON()).not.toHaveProperty("token");
    return route.fulfill({ status: 409, json: { error: { code: "host_route_observation_changed", message: "Observe the replacement" } } });
  });
  await page.goto("/");
  await expect(page.getByTestId("header-host-connection")).toHaveAttribute("data-host-state", "ready");
  await expect(page.getByTestId("header-host-connection")).toHaveAttribute("data-host-carrier", outbound);
  expect(connects).toBe(1);
  expect(observations).toBeGreaterThanOrEqual(2);
});


test("only the browser pumping the exact relay generation is active", async ({ browser, baseURL }) => {
  const owner = await browser.newContext({ baseURL });
  const peer = await browser.newContext({ baseURL });
  try {
    const primary = await owner.newPage();
    const other = await peer.newPage();
    const primaryBackend = await nativeBackend(primary, { selectProject: false });
    const otherBackend = await nativeBackend(other);
    const releases: unknown[] = [];
    let view: ReturnType<typeof routeView> | typeof detached = detached;
    for (const page of [primary, other]) {
      await page.route("**/api/v1/projects/project-1/host-state", (route) => route.fulfill({ json: view }));
      await page.route("**/api/v1/projects/project-1/host/disconnect", (route) => {
        releases.push(route.request().postDataJSON());
        return route.fulfill({ json: { detached: false } });
      });
    }
    await primary.route("**/relay-pump-fixture", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
    await primary.goto("/relay-pump-fixture");
    const before = await primary.evaluate(async () => {
      const { AppStore } = await import("/src/state/store.ts");
      const store = new AppStore();
      const projects = await store.api.request("project.list");
      const capabilities = await store.api.request("server.capabilities");
      store.update({ authSession: { authenticated: true, principal: { owner: "u1" } }, projects: projects.items, capabilities });
      await new Promise<void>((resolve) => store.api.connect({ open: resolve }));
      await store.connectHost("project-1", "ws://bridge.example/host");
      Object.assign(window, { relayStore: store });
      return store.state.hostConnection;
    });
    expect(before?.connectionGeneration).toBe("1");
    expect(before?.carrierMode).toBe("browser_relay_active");
    view = routeView(relay, "1");
    await other.goto("/");
    await expect(other.getByTestId("header-host-connection")).toHaveAttribute("data-host-carrier", "browser_relay_passive");
    expect(otherBackend.bridges).toHaveLength(0);
    view = routeView(relay, "2");
    const after = await primary.evaluate(async () => {
      const store = (window as any).relayStore;
      await store.dispatch({ type: "RefreshHostState", projectId: "project-1" });
      return { host: store.state.hostConnection, open: store.api.hasOpenRelayFor("project-1", "2") };
    });
    expect(after.host).toMatchObject({ carrierMode: "browser_relay_passive", connectionGeneration: "2", localControl: false, catalogReady: true });
    expect(after.open).toBe(false);
    expect(primaryBackend.bridges).toHaveLength(1);
    expect(releases).toEqual([{ revoke: false, relay_release: { relay_generation: "1", relay_id: expect.any(String) } }]);
  } finally { await Promise.all([owner.close(), peer.close()]); }
});

for (const staleChange of ["owner", "project", "generation"] as const) {
  test(`stale observation is ignored after ${staleChange} changes`, async ({ page }) => {
    await nativeBackend(page);
    const writes = await guardWrites(page);
    await page.route("**/observation-fixture", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
    const stale = hold();
    let inFlight = false;
    let observations = 0;
    await page.route("**/api/v1/projects/project-1/host-state", async (route) => {
      if (++observations === 1) {
        inFlight = true;
        await stale.promise;
        return route.fulfill({ json: routeView(relay, "1") });
      }
      return route.fulfill({ json: routeView(direct, "2") });
    });
    await page.goto("/observation-fixture");
    await page.evaluate(async () => {
      const { AppStore } = await import("/src/state/store.ts");
      const store = new AppStore();
      const projects = await store.api.request("project.list");
      const capabilities = await store.api.request("server.capabilities");
      store.update({ authSession: { authenticated: true, principal: { owner: "u1" } },
        projects: projects.items, capabilities, draftWorkspace: { kind: "local", projectId: "project-1" },
        hostConnection: { state: "ready", projectId: "project-1", connected: true, connectionGeneration: "0" } });
      const first = store.dispatch({ type: "RefreshHostState", projectId: "project-1" });
      Object.assign(window, { staleStore: store, first });
    });
    await expect.poll(() => inFlight).toBe(true);
    await page.evaluate(async (change) => {
      const store = (window as any).staleStore;
      if (change === "generation") await store.dispatch({ type: "RefreshHostState", projectId: "project-1" });
      else if (change === "owner") store.update({ authSession: { authenticated: true, principal: { owner: "u2" } } });
      else store.update({ draftWorkspace: { kind: "local", projectId: "other-project" } });
    }, staleChange);
    stale.release();
    const generation = await page.evaluate(async () => {
      await (window as any).first;
      return (window as any).staleStore.state.hostConnection.connectionGeneration;
    });
    expect(generation).toBe(staleChange === "generation" ? "2" : "0");
    expect(writes).toEqual([]);
  });
}
