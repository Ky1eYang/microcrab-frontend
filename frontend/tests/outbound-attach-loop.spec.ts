import { expect, test, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

const bridge = "ws://127.0.0.1:8788/host";

/** Keep the real Store, HTTP client and SessionSocket together. Only the native
 * server and loopback signaling peer are fixtures; no lifecycle method is stubbed. */
async function outboundBackend(page: Page, pendingControls = false) {
  const backend = await nativeBackend(page, {
    extraMethods: ["project.host_outbound_start"],
    ...(pendingControls
      ? { permissionRequests: [], roundLimitRequests: [] }
      : {}),
  });
  const phases: string[] = [];
  const offers: unknown[] = [];
  let ready = true;
  let connected = false;
  let transport: "outbound_wss" | "grpc" = "outbound_wss";
  const view = () => ({
    descriptor: {
      protocol_version: 1,
      host_id: "h1",
      workspace_id: "w1",
      bridge_instance_id: "bridge-outbound-fixture",
      workspace_root: "/assigned",
      platform: "test",
      info: {},
      tool_capabilities: ["read", "write"],
      supported_primitives: [],
      descriptor_digest: "fixture-descriptor",
    },
    transport,
    connected: true,
    ready,
    reconciling: !ready,
    connection_generation: "1",
    readiness: {
      connection_generation: "1",
      connected: true,
      ready,
      reconciling: !ready,
      phase: ready ? "ready" : "reconciling",
      cause: null,
    },
  });
  await page.route("**/api/v1/projects/*/host/outbound/*", (route) => {
    const phase = new URL(route.request().url()).pathname.split("/").at(-1)!;
    phases.push(phase);
    // A regression must fail finitely instead of flooding the fixture forever.
    if (phases.filter((item) => item === "start").length > 3)
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: "fixture_attach_loop",
            message: "Repeated Host recovery exceeded the fixture bound",
          },
        },
      });
    if (phase === "cancel")
      return route.fulfill({ json: { cancelled: false } });
    if (phase === "start" && !connected)
      return route.fulfill({
        json: {
          attempt_id: "outbound-fixture-attempt",
          capability: "fixture-ephemeral-offer",
          url: "wss://server.example/api/v1/host/outbound",
          expires_in_ms: 30000,
        },
      });
    // A matching live native route is observed on later start requests.
    connected = true;
    return route.fulfill({ json: view() });
  });
  await page.routeWebSocket(/\/host\/signal$/, (socket) => {
    socket.onMessage((raw) => {
      offers.push(JSON.parse(String(raw)));
      socket.send(JSON.stringify({ status: "connecting" }));
    });
  });
  await page.route("**/api/v1/projects/*/host-state", (route) =>
    route.fulfill({ json: connected ? { ...view(), carrier_mode: transport === "grpc"
      ? "server_direct_grpc" : "server_direct_outbound" } : { connected: false, ready: false,
      reconciling: false, carrier_mode: "detached", connection_generation: null } }),
  );
  await page.route("**/api/v1/projects/*/host/connect", (route) => {
    phases.push("connect");
    return route.fulfill({ json: view() });
  });
  return {
    backend,
    phases,
    offers,
    setReady(value: boolean) {
      ready = value;
    },
    setTransport(value: "outbound_wss" | "grpc") {
      transport = value;
    },
  };
}

async function storeFixturePage(page: Page) {
  await page.route("**/outbound-store-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/outbound-store-fixture");
}

function runtimeOpens(backend: Awaited<ReturnType<typeof nativeBackend>>) {
  return backend.requests.filter(
    (request) => request.method === "PUT" && request.path.endsWith("/runtime"),
  );
}

function turns(backend: Awaited<ReturnType<typeof nativeBackend>>) {
  return backend.commands.filter((command) => command.method === "turn.queue");
}

test("outbound project creation and first send finish one attach and admit one Turn", async ({
  page,
}) => {
  const { backend, phases, offers } = await outboundBackend(page);
  await page.goto("/");
  await expect(page.getByTitle("选择项目工作区")).toContainText("Assigned");
  await page.getByTitle("选择项目工作区").click();
  await page.getByTestId("picker-create-project").click();
  const dialog = page.getByRole("dialog", {
    name: "新建项目与工作目录",
    exact: true,
  });
  await dialog.getByLabel("项目名称", { exact: true }).fill("Outbound project");
  await dialog
    .getByLabel("工作目录 (Workspace Directory)", { exact: true })
    .fill("/assigned");
  await dialog.getByLabel("Host WebSocket 地址").fill(bridge);
  await dialog.getByRole("button", { name: "创建并连接", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("header-host-connection")).toContainText(
    "已就绪",
  );
  const project = backend.projects.find(
    (item) => item.name === "Outbound project",
  )!;
  expect(project).toBeDefined();
  // The fixture's create endpoint returns its mutable native Session record.
  // Pin it to the newly created Project before exercising the actual UI send.
  backend.snapshot().session.project_id = project.id;
  backend.snapshot().messages = [];
  await page.getByLabel("消息", { exact: true }).fill("First outbound message");
  await page.getByTitle("发送 (Enter)").click();
  await expect.poll(() => turns(backend).length).toBe(1);
  await expect(page).toHaveURL(/#session\/s1$/);
  await expect(page.getByTestId("header-host-connection")).toContainText(
    "已就绪",
  );
  expect(phases).toEqual(["start", "finish"]);
  expect(offers).toHaveLength(1);
  expect(backend.sessionSockets).toHaveLength(1);
  expect(runtimeOpens(backend)).toHaveLength(1);
  expect(backend.bridges).toHaveLength(0);
  expect(
    backend.requests.filter(
      (request) =>
        request.method === "POST" && request.path === "/api/v1/sessions",
    ),
  ).toHaveLength(1);
  expect(turns(backend)[0].params.input.parts[0].text).toBe(
    "First outbound message",
  );
});

test("initial detached outbound Session recovers once and manual reconnect still activates it", async ({
  page,
}) => {
  const { backend, phases } = await outboundBackend(page);
  await page.addInitScript((endpoint) => {
    localStorage.setItem(
      "microcrab.host-endpoint:" + location.origin + "/project-1",
      endpoint,
    );
  }, bridge);
  await page.goto("/#session/s1");
  await expect(page.getByText("历史回答", { exact: true })).toBeVisible();
  await expect(page.getByTestId("header-host-connection")).toContainText(
    "已就绪",
  );
  await expect(page.getByLabel("消息", { exact: true })).toBeEnabled();
  expect(phases).toEqual(["start", "finish"]);
  expect(runtimeOpens(backend)).toHaveLength(1);
  expect(backend.sessionSockets.length).toBeLessThanOrEqual(2);
  expect(turns(backend)).toHaveLength(0);

  const sockets = backend.sessionSockets.length;
  await page.getByTestId("header-host-connection").click();
  await page
    .getByLabel(/一次性配对码|One-time pairing code/)
    .fill("explicit-pair");
  await page
    .getByRole("dialog")
    .getByRole("button", {
      name: /^(配对并连接 Host|Pair and connect Host)$/,
    })
    .click();
  await expect(page.locator(".remote-connect-dialog")).toHaveCount(0);
  await expect(page.getByLabel("消息", { exact: true })).toBeEnabled();
  expect(phases).toEqual(["start", "finish", "start"]);
  expect(runtimeOpens(backend)).toHaveLength(2);
  expect(backend.sessionSockets).toHaveLength(sockets + 1);
  expect(turns(backend)).toHaveLength(0);
});

for (const historyOnly of [false, true]) {
  test(`actual Store detached attach ${historyOnly ? "observes history without recovery effects" : "rejects still-unready recovery without submitting"}`, async ({
    page,
  }) => {
    const fixture = await outboundBackend(page);
    fixture.setReady(false);
    await storeFixturePage(page);
    const before = {
      sockets: fixture.backend.sessionSockets.length,
      opens: runtimeOpens(fixture.backend).length,
      catalogs: fixture.backend.requests.filter((request) =>
        request.path.endsWith("/agents"),
      ).length,
    };
    const result = await page.evaluate(
      async ({ snapshot, historyOnly, endpoint }) => {
        const { AppStore } = await import("/src/state/store.ts");
        const store: any = new AppStore();
        await store.api.request("server.capabilities");
        const projects = await store.api.request("project.list");
        store.update({
          authSession: { authenticated: true, principal: { owner: "u1" } },
          projects: projects.items,
          sessions: [{ ...snapshot.session, projectID: "project-1" }],
          hostConnection: {
            projectId: "project-1",
            state: "detached",
            connected: false,
          },
        });
        localStorage.setItem(
          "microcrab.host-endpoint:" + location.origin + "/project-1",
          endpoint,
        );
        try {
          await store.attach("s1", false, historyOnly, true);
          return { code: null, sessionId: store.getSnapshot().sessionId };
        } catch (error) {
          return {
            code: (error as { code: string }).code,
            sessionId: store.getSnapshot().sessionId,
          };
        }
      },
      { snapshot: fixture.backend.snapshot(), historyOnly, endpoint: bridge },
    );
    expect(result).toEqual({
      code: historyOnly ? null : "host_detached",
      sessionId: "s1",
    });
    expect(fixture.backend.sessionSockets).toHaveLength(before.sockets + 1);
    expect(runtimeOpens(fixture.backend)).toHaveLength(before.opens);
    expect(turns(fixture.backend)).toHaveLength(0);
    expect(fixture.phases).toEqual(historyOnly ? [] : ["start", "finish"]);
    expect(
      fixture.backend.requests.filter((request) =>
        request.path.endsWith("/agents"),
      ),
    ).toHaveLength(before.catalogs);
    expect(
      fixture.backend.requests.filter(
        (request) =>
          request.method === "POST" && request.path === "/api/v1/sessions",
      ),
    ).toHaveLength(0);
  });
}

test("first send retains the draft and never submits when one Host recovery remains unready", async ({
  page,
}) => {
  const fixture = await outboundBackend(page);
  fixture.setReady(false);
  await storeFixturePage(page);
  const result = await page.evaluate(async (endpoint) => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    const capabilities = await store.api.request("server.capabilities");
    const projects = await store.api.request("project.list");
    const catalog = await store.api.request("agent.catalog", {
      project_id: "project-1",
    });
    store.update({
      authSession: { authenticated: true, principal: { owner: "u1" } },
      connection: "ws",
      capabilities,
      projects: projects.items,
      draftWorkspace: {
        kind: "local",
        projectId: "project-1",
        path: "/assigned",
        label: "Assigned",
      },
      agents: catalog.items,
      draftAgent: "coding",
      draftMode: "plan",
      composer: "Keep the unsubmitted outbound draft",
      // The displayed catalog is ready, but the old browser relay is gone.
      hostConnection: {
        projectId: "project-1",
        state: "ready",
        connected: true,
        catalogReady: true,
        transport: "relay",
      },
    });
    localStorage.setItem(
      "microcrab.host-endpoint:" + location.origin + "/project-1",
      endpoint,
    );
    await store.dispatch({ type: "Submit" });
    return {
      sessionId: store.getSnapshot().sessionId,
      composer: store.getSnapshot().composer,
      creating: store.getSnapshot().isCreatingSession,
    };
  }, bridge);
  expect(result).toEqual({
    sessionId: "s1",
    composer: "Keep the unsubmitted outbound draft",
    creating: false,
  });
  expect(fixture.phases).toEqual(["start", "finish"]);
  expect(fixture.backend.sessionSockets).toHaveLength(1);
  expect(runtimeOpens(fixture.backend)).toHaveLength(0);
  expect(turns(fixture.backend)).toHaveLength(0);
  expect(
    fixture.backend.requests.filter(
      (request) =>
        request.method === "POST" && request.path === "/api/v1/sessions",
    ),
  ).toHaveLength(1);
});

for (const scenario of [
  {
    name: "WebSocket locator negotiates outbound",
    endpoint: bridge,
    wire: "outbound_wss",
    effective: "outbound",
    phases: ["start", "finish"],
  },
  {
    name: "WebSocket locator observes existing gRPC",
    endpoint: bridge,
    wire: "grpc",
    effective: "grpc",
    phases: ["start", "finish"],
  },
  {
    name: "gRPC locator observes existing outbound",
    endpoint: "http://127.0.0.1:8789",
    wire: "outbound_wss",
    effective: "outbound",
    phases: ["connect"],
  },
] as const) {
  test(`actual Store readiness: ${scenario.name}`, async ({ page }) => {
    const fixture = await outboundBackend(page);
    fixture.setTransport(scenario.wire);
    await storeFixturePage(page);
    const result = await page.evaluate(
      async ({ endpoint }) => {
        const { AppStore } = await import("/src/state/store.ts");
        const store: any = new AppStore();
        await store.api.request("server.capabilities");
        const projects = await store.api.request("project.list");
        store.update({
          authSession: { authenticated: true, principal: { owner: "u1" } },
          projects: projects.items,
        });
        await store.connectHost("project-1", endpoint);
        const negotiated = {
          ready: store.hostReadyFor("project-1"),
          effective: store.getSnapshot().hostConnection.effectiveTransport,
          api: store.api.currentHostTransport(),
          locator: store.getSnapshot().hostConnection.transport,
        };
        // Refresh and suspension records need not carry a negotiated transport.
        // A same-Project API observation is still authoritative over the locator.
        store.update({
          hostConnection: {
            ...store.getSnapshot().hostConnection,
            effectiveTransport: undefined,
            transport: "relay",
          },
        });
        const sameProject = store.hostReadyFor("project-1");
        store.update({
          hostConnection: {
            projectId: "other-project",
            state: "ready",
            connected: true,
            transport: "relay",
          },
        });
        const otherProject = store.hostReadyFor("other-project");
        return { ...negotiated, sameProject, otherProject };
      },
      { endpoint: scenario.endpoint },
    );
    expect(result).toEqual({
      ready: true,
      effective: scenario.effective,
      api: scenario.effective,
      locator: scenario.endpoint.startsWith("ws:") ? "relay" : "grpc",
      sameProject: true,
      otherProject: false,
    });
    expect(fixture.phases).toEqual([...scenario.phases]);
    expect(fixture.backend.bridges).toHaveLength(0);
    expect(fixture.backend.sessionSockets).toHaveLength(0);
    expect(runtimeOpens(fixture.backend)).toHaveLength(0);
    expect(turns(fixture.backend)).toHaveLength(0);
  });
}

test("a real relay is ready only while its own browser socket remains open", async ({
  page,
}) => {
  const fixture = await outboundBackend(page);
  await storeFixturePage(page);
  const result = await page.evaluate(async () => {
    const { AppStore } = await import("/src/state/store.ts");
    const store: any = new AppStore();
    await store.api.request("server.capabilities");
    const projects = await store.api.request("project.list");
    store.update({
      authSession: { authenticated: true, principal: { owner: "u1" } },
      projects: projects.items,
    });
    await new Promise<void>((resolve) =>
      store.api.connect({ open: () => resolve() }),
    );
    // Non-loopback locators use the actual browser relay path.
    await store.connectHost("project-1", "ws://bridge.example/host");
    const open = store.hostReadyFor("project-1");
    const connection = store.getSnapshot().hostConnection;
    await store.api.releaseHostObservation("connect_error_cleanup");
    store.update({ hostConnection: connection });
    const closed = store.hostReadyFor("project-1");
    store.api.stop();
    return { open, closed };
  });
  expect(result).toEqual({ open: true, closed: false });
  expect(fixture.phases).toEqual([]);
  expect(fixture.backend.bridges).toHaveLength(1);
  expect(
    fixture.backend.commands.filter(
      (command) => command.method === "host.relay_attach",
    ),
  ).toHaveLength(1);
  expect(turns(fixture.backend)).toHaveLength(0);
});

test("attach-owned recovery keeps execution gated until delayed runtime activation completes", async ({
  page,
}) => {
  const fixture = await outboundBackend(page);
  let releaseRuntime: (() => Promise<void>) | undefined;
  let opens = 0;
  await page.route("**/api/v1/sessions/s1/runtime", (route) => {
    opens++;
    releaseRuntime = () => route.fulfill({ json: fixture.backend.snapshot() });
  });
  await storeFixturePage(page);
  await page.evaluate(
    async ({ snapshot, endpoint }) => {
      const { AppStore } = await import("/src/state/store.ts");
      const store: any = new AppStore();
      await store.api.request("server.capabilities");
      const projects = await store.api.request("project.list");
      store.update({
        authSession: { authenticated: true, principal: { owner: "u1" } },
        projects: projects.items,
        sessions: [{ ...snapshot.session, projectID: "project-1" }],
        hostConnection: {
          projectId: "project-1",
          state: "detached",
          connected: false,
        },
      });
      localStorage.setItem(
        "microcrab.host-endpoint:" + location.origin + "/project-1",
        endpoint,
      );
      store.update({
        capabilities: await store.api.request("server.capabilities"),
      });
      (window as any).outboundActivation = { store, done: store.attach("s1") };
    },
    { snapshot: fixture.backend.snapshot(), endpoint: bridge },
  );
  await expect.poll(() => !!releaseRuntime).toBe(true);
  const pending = await page.evaluate(async () => {
    const { hostReadiness } = await import("/src/state/host-readiness.ts");
    const state = (window as any).outboundActivation.store.getSnapshot();
    return {
      ready: hostReadiness(state).ready,
      restoring: state.hostConnection.restoringSession,
      catalog: state.hostConnection.catalogReady,
    };
  });
  expect(pending).toEqual({ ready: false, restoring: true, catalog: true });
  await releaseRuntime!();
  const settled = await page.evaluate(async () => {
    const { store, done } = (window as any).outboundActivation;
    const { hostReadiness } = await import("/src/state/host-readiness.ts");
    await done;
    return {
      ready: hostReadiness(store.getSnapshot()).ready,
      restoring: store.getSnapshot().hostConnection.restoringSession,
    };
  });
  expect(settled).toEqual({ ready: true, restoring: false });
  expect(opens).toBe(1);
  expect(fixture.backend.sessionSockets).toHaveLength(1);
  expect(fixture.phases).toEqual(["start", "finish"]);
  expect(turns(fixture.backend)).toHaveLength(0);
});

test("RefreshHostState activates a formerly reconciling Session and restores new pending controls without Turn replay", async ({
  page,
}) => {
  const fixture = await outboundBackend(page, true);
  fixture.setReady(false);
  await storeFixturePage(page);
  const initial = await page.evaluate(
    async ({ snapshot, endpoint }) => {
      const { AppStore } = await import("/src/state/store.ts");
      const { hostReadiness } = await import("/src/state/host-readiness.ts");
      const store: any = new AppStore();
      await store.api.request("server.capabilities");
      const projects = await store.api.request("project.list");
      store.update({
        authSession: { authenticated: true, principal: { owner: "u1" } },
        projects: projects.items,
        sessions: [{ ...snapshot.session, projectID: "project-1" }],
        hostConnection: {
          projectId: "project-1",
          state: "detached",
          connected: false,
        },
      });
      localStorage.setItem(
        "microcrab.host-endpoint:" + location.origin + "/project-1",
        endpoint,
      );
      store.update({
        capabilities: await store.api.request("server.capabilities"),
      });
      (window as any).outboundRefreshStore = store;
      await store.attach("s1");
      return {
        ready: hostReadiness(store.getSnapshot()).ready,
        restoring: store.getSnapshot().hostConnection.restoringSession,
      };
    },
    { snapshot: fixture.backend.snapshot(), endpoint: bridge },
  );
  expect(initial).toEqual({ ready: false, restoring: true });
  expect(runtimeOpens(fixture.backend)).toHaveLength(0);
  fixture.backend.pendingPermissions.push({
    request_id: "permission-after-reconcile",
    parent_session_id: "s1",
    session_id: "s1",
    call_id: "call-after-reconcile",
    agent: "coding",
    mode: "plan",
    tool: "read",
    arguments: {},
    revision: 1,
    created_at_ms: 1,
    expires_at_ms: 9999999999999,
  });
  fixture.backend.pendingRoundLimits.push({
    request_id: "round-after-reconcile",
    parent_session_id: "s1",
    session_id: "s1",
    epoch: 1,
    turn_id: "turn-before-disconnect",
    kind: "rounds",
    used: 10,
    block: 10,
    created_at_ms: 1,
  });
  fixture.setReady(true);
  const restored = await page.evaluate(async () => {
    const { hostReadiness } = await import("/src/state/host-readiness.ts");
    const store = (window as any).outboundRefreshStore;
    await store.dispatch({ type: "RefreshHostState", projectId: "project-1" });
    const state = store.getSnapshot();
    return {
      ready: hostReadiness(state).ready,
      restoring: state.hostConnection.restoringSession,
      permissions: state.transcript.pendingPermission?.requests.map(
        (item: any) => item.request_id,
      ),
      rounds: state.roundLimitRequests?.map((item: any) => item.request_id),
    };
  });
  expect(restored).toEqual({
    ready: true,
    restoring: false,
    permissions: ["permission-after-reconcile"],
    rounds: ["round-after-reconcile"],
  });
  expect(runtimeOpens(fixture.backend)).toHaveLength(1);
  expect(fixture.backend.sessionSockets).toHaveLength(2);
  expect(fixture.phases).toEqual(["start", "finish"]);
  expect(turns(fixture.backend)).toHaveLength(0);
  expect(
    fixture.backend.commands.filter((command) =>
      ["turn.retry", "permission.reply", "round_limit.reply"].includes(
        command.method,
      ),
    ),
  ).toHaveLength(0);
});
