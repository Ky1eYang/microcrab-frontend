import { test, expect } from "@playwright/test";
import {
  nativeBackend,
  nativeSnapshot,
  sendSubscribed,
} from "./native-fixture";

// These probes exercise transports, not app startup. Use an empty same-origin
// document so the new unauthenticated-entry redirect cannot race the transport.
test.beforeEach(async ({ page }) => {
  await page.route("**/transport-client-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Transport test fixture</title>",
    }),
  );
});

test("timed-out WS mutations are unknown and reconnect never resends them", async ({
  page,
}) => {
  const received: any[] = [],
    globalReceived: any[] = [],
    sessionUrls: string[] = [];
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: "unauthenticated" } },
    }),
  );
  await page.routeWebSocket("**/api/v1/ws", (socket) =>
    socket.onMessage((raw) => globalReceived.push(JSON.parse(String(raw)))),
  );
  await page.routeWebSocket(
    /\/api\/v1\/sessions\/s1\/ws(?:\?.*)?$/,
    (socket) => {
      sessionUrls.push(socket.url());
      socket.onMessage((raw) => received.push(JSON.parse(String(raw))));
      sendSubscribed(
        socket,
        nativeSnapshot,
        `sub-${sessionUrls.length}`,
        `g-${sessionUrls.length}`,
      );
    },
  );
  await page.goto("/transport-client-fixture");
  const result = await page.evaluate(async () => {
    const { ApiClient } = await import("/src/client/api.ts");
    const { SessionSocket } = await import("/src/client/socket/session.ts");
    const client = new ApiClient(location.origin);
    const session = new SessionSocket((path) => client.url(path));
    client.setSessionTransport(() => session);
    const operation_id = crypto.randomUUID();
    let resubscribed!: () => void;
    const reconnected = new Promise<void>((resolve) => {
      resubscribed = resolve;
    });
    try {
      await new Promise<void>((resolve) => client.connect({ open: resolve }));
      await session.open(
        "s1",
        { display_watermark: 0 },
        { event: () => {}, resubscribed },
      );
      let errorResult;
      try {
        await client.request(
          "turn.submit",
          {
            input: { parts: [{ type: "text", text: "once" }] },
            operation_id,
          },
          "s1",
          20,
        );
      } catch (error: any) {
        errorResult = {
          outcomeUnknown: error.outcomeUnknown,
          code: error.code,
        };
      }
      session.reconnect();
      await reconnected;
      return { operation_id, errorResult };
    } finally {
      session.stop();
      client.stop();
    }
  });
  expect(result.errorResult).toEqual({
    outcomeUnknown: true,
    code: "timed_out",
  });
  expect(sessionUrls).toHaveLength(2);
  for (const url of sessionUrls) {
    expect(new URL(url).searchParams.get("display_watermark")).toBe("0");
  }
  expect(globalReceived).toEqual([]);
  expect(received).toEqual([
    {
      v: 1,
      type: "command",
      request_id: expect.any(String),
      method: "turn.submit",
      params: {
        input: { parts: [{ type: "text", text: "once" }] },
        operation_id: result.operation_id,
      },
    },
  ]);
});

for (const scenario of [
  "timeout",
  "network",
  "invalid-json",
  "invalid-dto",
  "revision-conflict",
  "unauthenticated",
  "server-unknown",
] as const) {
  test(`HTTP mutation ${scenario} has explicit outcome and no retry or WS fallback`, async ({
    page,
  }) => {
    const received: any[] = [],
      requests: any[] = [];
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        status: 401,
        json: { error: { code: "unauthenticated" } },
      }),
    );
    await page.route("**/api/v1/sessions", (route) => {
      requests.push({
        method: route.request().method(),
        body: route.request().postDataJSON(),
      });
      switch (scenario) {
        case "timeout":
          return;
        case "network":
          return route.abort("connectionreset");
        case "invalid-json":
          return route.fulfill({ contentType: "application/json", body: "{" });
        case "invalid-dto":
          return route.fulfill({ json: {} });
        case "revision-conflict":
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: "revision_conflict",
                message: "Revision changed",
                retryable: true,
              },
            },
          });
        case "unauthenticated":
          return route.fulfill({
            status: 401,
            json: { error: { code: "unauthenticated", message: "Sign in" } },
          });
        case "server-unknown":
          return route.fulfill({
            status: 401,
            json: {
              error: {
                code: "outcome_unknown",
                message: "Authentication revoked after admission",
              },
            },
          });
      }
    });
    await page.routeWebSocket("**/api/v1/ws", (socket) =>
      socket.onMessage((raw) => received.push(JSON.parse(String(raw)))),
    );
    await page.goto("/transport-client-fixture");
    const result = await page.evaluate(async () => {
      const { ApiClient } = await import("/src/client/api.ts");
      const client = new ApiClient(location.origin);
      await new Promise<void>((resolve) => client.connect({ open: resolve }));
      const operation_id = crypto.randomUUID();
      let errorResult;
      try {
        await client.request(
          "session.create",
          {
            project_id: "project-1",
            component: "component-sha256",
            operation_id,
          },
          undefined,
          250,
        );
      } catch (error: any) {
        errorResult = {
          code: error.code,
          outcomeUnknown: error.outcomeUnknown,
        };
      }
      client.stop();
      await new Promise<void>((resolve) => client.connect({ open: resolve }));
      client.stop();
      return { operation_id, errorResult };
    });
    const codes = {
      timeout: "timed_out",
      network: "disconnected",
      "invalid-json": "invalid_result",
      "invalid-dto": "invalid_result",
      "revision-conflict": "revision_conflict",
      unauthenticated: "unauthenticated",
      "server-unknown": "outcome_unknown",
    };
    expect(result.errorResult).toEqual({
      code: codes[scenario],
      outcomeUnknown: !["revision-conflict", "unauthenticated"].includes(
        scenario,
      ),
    });
    expect(requests).toEqual([
      {
        method: "POST",
        body: {
          project_id: "project-1",
          component: "component-sha256",
          operation_id: result.operation_id,
        },
      },
    ]);
    expect(received).toEqual([]);
  });
}

test("fixed HTTP resources preserve revisions, query cursors, operation identity and execution routing", async ({
  page,
}) => {
  const backend = await nativeBackend(page);
  await page.goto("/");
  await expect(page.getByTitle("选择项目工作区")).toContainText("Assigned");
  const start = backend.requests.length;
  const routed = await page.evaluate(async () => {
    const { ApiClient } = await import("/src/client/api.ts");
    const client = new ApiClient(location.origin);
    // Session methods have no HTTP resource: the selected socket is their only route.
    const session = {
      sessionId: "s1",
      commands: [] as { method: string; params: Record<string, unknown> }[],
      command(method: string, params: Record<string, unknown>) {
        this.commands.push({ method, params });
        return Promise.resolve({ routed: "session" });
      },
    };
    client.setSessionTransport(() => session);
    await new Promise<void>((resolve) => client.connect({ open: resolve }));
    await client.request(
      "session.blocks",
      { before_cursor: 32, limit: 16 },
      "s1",
    );
    await client.request("session.open", {}, "s1");
    await client.request(
      "session.rename",
      { title: "Renamed", expected_revision: 1 },
      "s1",
    );
    await client.request("session.set_mode", { mode: "build" }, "s1");
    await client.request("permission.get", {}, "s1");
    await client.request(
      "permission.set",
      { expected_revision: 3, overrides: [], review: false },
      "s1",
    );
    await client.request(
      "session.compact",
      { instruction: "retain decisions" },
      "s1",
    );
    await client.request("history.travel", { direction: "undo" }, "s1");
    await client.request("checkpoint.create", {}, "s1");
    await client.request("turn.get", { operation_id: "op/a b" }, "s1");
    await client.request(
      "executions.read",
      { execution_id: 23, cursor: 8, max_bytes: 4096 },
      "s1",
    );
    await client.request("executions.cancel", { execution_id: 23 }, "s1");
    await client.request("session.interrupt", {}, "s1");
    await client.request("session.close", {}, "s1");
    await client.request("session.archive", { expected_revision: 2 }, "s1");
    client.stop();
    return session.commands;
  });
  expect(
    backend.requests.slice(start).filter(({ path }) => !path.endsWith("/host-state")).map(({ method, path, query, body }) => ({
      method,
      path: path.replace("/api/v1/sessions/s1", ""),
      query,
      body,
    })),
  ).toEqual([
    { method: "PUT", path: "/runtime", query: {}, body: {} },
    {
      method: "PATCH",
      path: "",
      query: {},
      body: { title: "Renamed", expected_revision: 1 },
    },
    { method: "PUT", path: "/mode", query: {}, body: { mode: "build" } },
    { method: "GET", path: "/permission", query: {}, body: undefined },
    {
      method: "PUT",
      path: "/permission",
      query: {},
      body: { expected_revision: 3, overrides: [], review: false },
    },
    {
      method: "POST",
      path: "/compact",
      query: {},
      body: { instruction: "retain decisions" },
    },
    {
      method: "POST",
      path: "/history/travel",
      query: {},
      body: { direction: "undo" },
    },
    { method: "POST", path: "/checkpoints", query: {}, body: {} },
    {
      method: "GET",
      path: "/operations/op%2Fa%20b",
      query: {},
      body: undefined,
    },
    { method: "DELETE", path: "/runtime", query: {}, body: {} },
    {
      method: "POST",
      path: "/archive",
      query: {},
      body: { expected_revision: 2 },
    },
  ]);
  // The selected Session transport receives history pages and execution commands.
  expect(
    routed.filter((command) => command.method === "session.blocks"),
  ).toEqual([
    { method: "session.blocks", params: { before_cursor: 32, limit: 16 } },
  ]);
  expect(backend.snapshot().session.archived).toBe(true);
  expect(backend.snapshot().messages).toHaveLength(2);
  // Reading, cancelling and interrupting have no HTTP resource: only the
  // selected Session socket carries them, and it carries nothing else here.
  expect(routed).toEqual([
    { method: "session.blocks", params: { before_cursor: 32, limit: 16 } },
    {
      method: "executions.read",
      params: { execution_id: 23, cursor: 8, max_bytes: 4096 },
    },
    { method: "executions.cancel", params: { execution_id: 23 } },
    { method: "session.interrupt", params: {} },
  ]);
  expect(
    backend.commands.some((command) =>
      [
        "executions.read",
        "executions.cancel",
        "session.interrupt",
        "session.rename",
        "session.archive",
        "session.open",
        "session.close",
        "session.compact",
        "history.travel",
        "checkpoint.create",
      ].includes(command.method),
    ),
  ).toBe(false);
});

test("HTTP query loss is known non-mutating and never falls back to WS", async ({
  page,
}) => {
  const sent: string[] = [];
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({ status: 401, json: {} }),
  );
  await page.route("**/api/v1/sessions", (route) => {
    sent.push(route.request().method());
    return route.abort("connectionreset");
  });
  await page.goto("/transport-client-fixture");
  const outcome = await page.evaluate(async () => {
    const { ApiClient } = await import("/src/client/api.ts");
    const client = new ApiClient(location.origin);
    try {
      await client.request("session.list");
    } catch (error: any) {
      return { code: error.code, unknown: error.outcomeUnknown };
    }
  });
  expect(outcome).toEqual({ code: "disconnected", unknown: false });
  expect(sent).toEqual(["GET"]);
});
