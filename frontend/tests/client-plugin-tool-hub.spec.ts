import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { maintainedPluginBundle } from "./plugin-bundle-fixture";

test.beforeEach(async ({ page }) => {
  await maintainedPluginBundle(page);
});

test("resource grants bind owner/plugin/artifact/config and revoke in-flight credentials", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/resources.ts";
    const { PluginResources } = await import(path);
    const owner = crypto.randomUUID(),
      artifact = "a".repeat(64),
      changed = "b".repeat(64);
    const vault = new PluginResources(
      location.origin,
      owner,
      "test.plugin",
      artifact,
    );
    const config = {
      id: "one",
      endpoint: "https://example.test/mcp",
      authorization: "Bearer private-secret",
      enabled: true,
    };
    let denied = false;
    try {
      vault.configure(config, false);
    } catch {
      denied = true;
    }
    const list = vault.configure(config, true) as {
      id: string;
      config_pin: string;
    }[];
    const request = vault.network({
      method: "POST",
      resource: "one",
      config_pin: list[0]!.config_pin,
    });
    const saved = new PluginResources(
      location.origin,
      owner,
      "test.plugin",
      artifact,
    );
    const reloaded = saved.network({
      method: "POST",
      resource: "one",
      config_pin: list[0]!.config_pin,
    });
    const replaced = new PluginResources(
      location.origin,
      owner,
      "test.plugin",
      changed,
    );
    let replacementDenied = false;
    try {
      replaced.network({
        method: "POST",
        resource: "one",
        config_pin: list[0]!.config_pin,
      });
    } catch {
      replacementDenied = true;
    }
    const otherOwner = new PluginResources(
      location.origin,
      owner + "other",
      "test.plugin",
      artifact,
    ).list();
    const otherPlugin = new PluginResources(
      location.origin,
      owner,
      "other.plugin",
      artifact,
    ).list();
    let methodDenied = false;
    try {
      vault.network({
        method: "DELETE",
        resource: "one",
        config_pin: list[0]!.config_pin,
      });
    } catch {
      methodDenied = true;
    }
    const updated = vault.configure(
      { ...config, authorization: "", enabled: false },
      true,
    ) as { config_pin: string }[];
    let staleDenied = false;
    try {
      vault.network({
        method: "POST",
        resource: "one",
        config_pin: list[0]!.config_pin,
      });
    } catch {
      staleDenied = true;
    }
    const cleared = vault.configure(
      { ...config, authorization: "", clear_authorization: true },
      true,
    ) as { config_pin: string }[];
    const withoutCredential = vault.network({
      method: "POST",
      resource: "one",
      config_pin: cleared[0]!.config_pin,
    });
    let endpointDenied = false;
    try {
      vault.network({
        method: "POST",
        resource: "one",
        config_pin: cleared[0]!.config_pin,
        url: "https://example.test/steal",
      });
    } catch {
      endpointDenied = true;
    }
    vault.configure({ id: "one", remove: true }, true);
    return {
      denied,
      methodDenied,
      safe: !JSON.stringify(list).includes("private-secret"),
      persistedCredential:
        reloaded.headers.Authorization === "Bearer private-secret",
      replacementDenied,
      replacedList: replaced.list(),
      otherOwner,
      otherPlugin,
      staleDenied,
      aborted: request.signal.aborted,
      changedPin: updated[0]!.config_pin !== list[0]!.config_pin,
      cleared: !withoutCredential.headers.Authorization,
      endpointDenied,
      removed: vault.list(),
      revoked: withoutCredential.signal.aborted,
    };
  });
  expect(actual).toMatchObject({
    denied: true,
    methodDenied: true,
    safe: true,
    persistedCredential: true,
    replacementDenied: true,
    otherOwner: [],
    otherPlugin: [],
    staleDenied: true,
    aborted: true,
    changedPin: true,
    cleared: true,
    endpointDenied: true,
    removed: [],
    revoked: true,
  });
  expect(actual.replacedList[0]).toMatchObject({
    enabled: false,
    requires_reenable: true,
  });
});

test("incremental SSE matches exact RPC id and cancels a response that never closes", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/http-response.ts";
    const { readHttpResponse } = await import(path);
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of [
          ":keepalive\r",
          '\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
          'data: {"jsonrpc":"2.0","id":"expected","result":{"ok":true}}\r',
          "\n\r\n",
        ])
          c.enqueue(encoder.encode(chunk));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await readHttpResponse(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      "expected",
      new AbortController().signal,
    );
    let bounded = false;
    try {
      await readHttpResponse(
        new Response("x".repeat(2 * 1024 * 1024 + 1)),
        undefined,
        new AbortController().signal,
      );
    } catch {
      bounded = true;
    }
    let wrong = false;
    try {
      await readHttpResponse(
        new Response('data: {"id":2,"result":{}}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
        "2",
        new AbortController().signal,
      );
    } catch {
      wrong = true;
    }
    const delimiters: string[] = [];
    for (const eol of ["\r", "\n", "\r\n"]) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            encoder.encode(
              `data${eol}data: {"id":"expected","result":{}}${eol}${eol}`,
            ),
          );
        },
      });
      delimiters.push(
        await readHttpResponse(
          new Response(stream, {
            headers: { "content-type": "text/event-stream" },
          }),
          "expected",
          new AbortController().signal,
        ),
      );
    }
    return {
      result: JSON.parse(result),
      cancelled,
      bounded,
      wrong,
      delimiters: delimiters.map((d) => JSON.parse(d).id),
    };
  });
  expect(actual).toEqual({
    result: { jsonrpc: "2.0", id: "expected", result: { ok: true } },
    cancelled: true,
    bounded: true,
    wrong: true,
    delimiters: ["expected", "expected", "expected"],
  });
});

test("real MCP tool provider accepts nonpositive deadlines and rejects expired or cancelled dispatch", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: crypto.randomUUID(),
    });
    try {
      await registry.initialize();
      await registry.setSession("hub-session");
      await registry.setEnabled("microcrab.mcp-bridge", "hub-session", true);
      const inventory = registry.toolInventory() as {
        id: string;
        artifact: string;
      }[];
      const plugin = inventory.find((p) => p.id === "microcrab.mcp-bridge");
      if (!plugin)
        throw Error(
          "Build/install the maintained MCP component through the root entry first",
        );
      const invocation = {
        invocation_id: crypto.randomUUID(),
        session_id: "hub-session",
        parent_session_id: "hub-session",
        call_id: "call",
        catalog_digest: "digest",
        deadline_ms: Date.now() + 5000,
      };
      const outputs = [];
      for (const deadline_ms of [0, -1, Date.now() + 5000])
        outputs.push(
          await registry.executeTool(
            { plugin: plugin.id, artifact: plugin.artifact, action: "list" },
            { ...invocation, invocation_id: crypto.randomUUID(), deadline_ms },
            new AbortController().signal,
          ),
        );
      const rejected = [];
      for (const deadline_ms of [Date.now() - 1, Date.now()]) {
        try {
          await registry.executeTool(
            { plugin: plugin.id, artifact: plugin.artifact, action: "list" },
            { ...invocation, invocation_id: crypto.randomUUID(), deadline_ms },
            new AbortController().signal,
          );
        } catch (error) {
          rejected.push(String(error));
        }
      }
      const cancelled = new AbortController();
      cancelled.abort();
      let beforeDispatch = "";
      try {
        await registry.executeTool(
          { plugin: plugin.id, artifact: plugin.artifact, action: "list" },
          { ...invocation, invocation_id: crypto.randomUUID(), deadline_ms: 0 },
          cancelled.signal,
        );
      } catch (error) {
        beforeDispatch = String(error);
      }
      let stale = false;
      try {
        await registry.executeTool(
          { plugin: plugin.id, artifact: "0".repeat(64), action: "list" },
          { ...invocation, invocation_id: crypto.randomUUID() },
          new AbortController().signal,
        );
      } catch {
        stale = true;
      }
      let delegated = false;
      try {
        await registry.executeTool(
          { plugin: plugin.id, artifact: plugin.artifact, action: "list" },
          {
            ...invocation,
            invocation_id: crypto.randomUUID(),
            session_id: "child",
          },
          new AbortController().signal,
        );
      } catch {
        delegated = true;
      }
      await registry.setEnabled(plugin.id, "hub-session", false);
      let disabled = false;
      try {
        await registry.executeTool(
          { plugin: plugin.id, artifact: plugin.artifact, action: "list" },
          { ...invocation, invocation_id: crypto.randomUUID() },
          new AbortController().signal,
        );
      } catch {
        disabled = true;
      }
      return { outputs, rejected, beforeDispatch, stale, delegated, disabled };
    } finally {
      registry.dispose();
    }
  });
  expect(actual).toEqual({
    outputs: [
      { servers: [], next_cursor: null },
      { servers: [], next_cursor: null },
      { servers: [], next_cursor: null },
    ],
    rejected: [
      expect.stringContaining("cancelled or expired before dispatch"),
      expect.stringContaining("cancelled or expired before dispatch"),
    ],
    beforeDispatch: expect.stringContaining(
      "cancelled or expired before dispatch",
    ),
    stale: true,
    delegated: true,
    disabled: true,
  });
});

test("zero-deadline MCP list/describe/call preserves handshake, pagination, pins and uncertain outcomes", async ({
  page,
}) => {
  const effects: string[] = [];
  const methods: string[] = [];
  await nativeBackend(page);
  await page.route("https://mcp-*.example.test/mcp", async (route) => {
    const request = route.request();
    const rpc = request.postDataJSON();
    const server = new URL(request.url()).hostname;
    methods.push(`${server}:${rpc.method}`);
    const headers = {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "Mcp-Session-Id",
      "Mcp-Session-Id": `session-${server}`,
      "content-type": "application/json",
    };
    if (rpc.method === "notifications/initialized") {
      await route.fulfill({ status: 202, headers, body: "" });
      return;
    }
    let result: unknown;
    if (rpc.method === "initialize")
      result = {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: server, version: "1" },
      };
    else {
      expect(request.headers()["mcp-protocol-version"]).toBe("2025-06-18");
      expect(request.headers()["mcp-session-id"]).toBe(`session-${server}`);
      if (rpc.method === "tools/list")
        result =
          rpc.params?.cursor === "page-two"
            ? { tools: [{ name: "bad", inputSchema: { type: "object" } }] }
            : {
                tools: [
                  {
                    name: "echo",
                    description: "Echo",
                    inputSchema: {
                      type: "object",
                      properties: { message: { type: "string" } },
                      required: ["message"],
                      additionalProperties: false,
                    },
                  },
                ],
                nextCursor: "page-two",
              };
      else if (rpc.method === "tools/call") {
        effects.push(`${server}:${rpc.params.name}`);
        result = {
          content: [
            {
              type: "text",
              text: `${server}:${rpc.params.arguments.message ?? ""}`,
            },
          ],
        };
      } else throw Error("Unexpected method");
    }
    if (rpc.method === "initialize")
      await new Promise((resolve) => setTimeout(resolve, 30));
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: rpc.params?.name === "bad" ? "wrong-rpc-id" : rpc.id,
      result,
    });
    if (server.startsWith("mcp-two") && rpc.method === "tools/call")
      await route.fulfill({
        status: 200,
        headers: { ...headers, "content-type": "text/event-stream" },
        body: `:keepalive\n\ndata: ${body}\n\n`,
      });
    else await route.fulfill({ status: 200, headers, body });
  });
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const ownerId = crypto.randomUUID();
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId,
    });
    const id = "microcrab.mcp-bridge",
      session = "mcp-integration";
    try {
      await registry.initialize();
      await registry.setSession(session);
      await registry.setEnabled(id, session, true);
      await registry.render(id, "sidebar");
      for (const server of ["one", "two"]) {
        registry.setVariable(id, "id", server);
        registry.setVariable(
          id,
          "endpoint",
          `https://mcp-${server}.example.test/mcp`,
        );
        registry.setVariable(id, "authorization", "Bearer local-only-secret");
        registry.setVariable(id, "enabled", "true");
        await registry.action(id, "save-config");
      }
      const artifact = (
        registry.toolInventory() as { id: string; artifact: string }[]
      ).find((p) => p.id === id)!.artifact;
      const run = (request: Record<string, unknown>) =>
        registry.executeTool(
          { plugin: id, artifact, ...request } as never,
          {
            invocation_id: crypto.randomUUID(),
            session_id: session,
            parent_session_id: session,
            call_id: crypto.randomUUID(),
            catalog_digest: "catalog",
            deadline_ms: 0,
          },
          new AbortController().signal,
        );
      const resourcesPath = "/src/plugins/resources.ts";
      const { PluginResources } = await import(resourcesPath);
      const canonicalArtifact = registry
        .getSnapshot()
        .find((entry: any) => entry.manifest.id === id)!.artifact!;
      const vault = new PluginResources(
        location.origin,
        ownerId,
        id,
        canonicalArtifact,
      );
      const canonical = (value: any): any =>
        Array.isArray(value)
          ? value.map(canonical)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.keys(value)
                  .sort()
                  .map((key) => [key, canonical(value[key])]),
              )
            : value;
      const configs = vault.list() as { id: string; config_pin: string }[];
      vault.close();
      const legacyPins = async (server: string, schema: unknown) => ({
        config_pin: configs.find((entry) => entry.id === server)!.config_pin,
        schema_pin: [
          ...new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(JSON.stringify(canonical(schema))),
            ),
          ),
        ]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      });
      const servers = await run({ action: "list" });
      const first = (await run({
        action: "list",
        server: "one",
        limit: 1,
      })) as Record<string, unknown>;
      const second = await run({
        action: "list",
        server: "one",
        limit: 1,
        cursor: first.next_cursor,
      });
      const outputs = [];
      for (const server of ["one", "two"]) {
        const described = (await run({
          action: "describe",
          server,
          tool: "echo",
        })) as Record<string, unknown>;
        outputs.push(
          await run({
            action: "call",
            ...(server === "one"
              ? { pin: described.call_pin }
              : {
                  server,
                  tool: "echo",
                  ...(await legacyPins(server, described.parameters)),
                }),
            arguments: { message: server },
          }),
        );
      }
      const described = (await run({
        action: "describe",
        server: "one",
        tool: "bad",
      })) as Record<string, unknown>;
      let uncertain = "";
      try {
        await run({
          action: "call",
          pin: described.call_pin,
        });
      } catch (e) {
        uncertain = String(e);
      }
      let stale = "";
      try {
        await run({
          action: "call",
          server: "one",
          tool: "echo",
          schema_pin: "0".repeat(64),
          config_pin: configs.find((entry) => entry.id === "one")!.config_pin,
        });
      } catch (e) {
        stale = String(e);
      }
      const echo = (await run({
        action: "describe",
        server: "one",
        tool: "echo",
      })) as Record<string, unknown>;
      const validationErrors = [];
      for (const args of [
        {},
        { message: 5 },
        { message: "valid", extra: true },
      ]) {
        try {
          await run({
            action: "call",
            pin: echo.call_pin,
            arguments: args,
          });
        } catch (error) {
          validationErrors.push(String(error));
        }
      }
      return {
        servers,
        first,
        second,
        outputs,
        uncertain,
        stale,
        validationErrors,
        safe: !JSON.stringify([
          servers,
          first,
          second,
          outputs,
          registry.view(id, "sidebar").vars,
        ]).includes("local-only-secret"),
      };
    } finally {
      registry.dispose();
    }
  });
  expect(actual.servers).toMatchObject({
    servers: [{ id: "one" }, { id: "two" }],
  });
  expect(actual.first).toMatchObject({ tools: [{ name: "echo" }] });
  expect(actual.second).toMatchObject({
    tools: [{ name: "bad" }],
    next_cursor: null,
  });
  expect(actual.outputs).toEqual([
    { content: [{ type: "text", text: "mcp-one.example.test:one" }] },
    { content: [{ type: "text", text: "mcp-two.example.test:two" }] },
  ]);
  expect(actual.uncertain).toContain("outcome unknown");
  expect(actual.stale).toContain("schema/configuration changed");
  expect(actual.safe).toBe(true);
  expect(actual.validationErrors).toHaveLength(3);
  expect(
    actual.validationErrors.every((e) => e.includes("arguments do not match")),
  ).toBe(true);
  expect(effects).toEqual([
    "mcp-one.example.test:echo",
    "mcp-two.example.test:echo",
    "mcp-one.example.test:bad",
  ]);
  expect(
    methods.filter((m) => m.endsWith(":initialize")).length,
  ).toBeGreaterThan(2);
});

for (const cancellation of [
  "zero",
  "negative",
  "positive",
  "deadline",
  "effect-timeout",
] as const) {
  test(`MCP ${cancellation} preserves transport bounds, cleanup identity and no replay`, async ({
    page,
  }) => {
    await nativeBackend(page);
    let calls = 0,
      notifications = 0;
    let dispatchedRpcId: string | undefined;
    let notifyDone: () => void = () => {};
    const notified = new Promise<void>((resolve) => {
      notifyDone = resolve;
    });
    await page.route("https://mcp-cancel.example.test/mcp", async (route) => {
      const rpc = route.request().postDataJSON();
      const headers = {
        "content-type": "application/json",
        "Mcp-Session-Id": "cancel-session",
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "Mcp-Session-Id",
      };
      if (rpc.method === "notifications/cancelled") {
        notifications++;
        expect(rpc.params.requestId).toBe(dispatchedRpcId);
        await route.fulfill({ status: 202, headers, body: "" });
        notifyDone();
        return;
      }
      if (rpc.method === "notifications/initialized") {
        await route.fulfill({ status: 202, headers, body: "" });
        return;
      }
      if (rpc.method === "tools/call") {
        calls++;
        dispatchedRpcId = rpc.id;
        if (cancellation !== "deadline" && cancellation !== "effect-timeout")
          await page.evaluate(() =>
            (globalThis as unknown as { cancelMcp: () => void }).cancelMcp(),
          );
        return;
      }
      const result =
        rpc.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: {} }
          : { tools: [{ name: "slow", inputSchema: { type: "object" } }] };
      await route.fulfill({
        status: 200,
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
      });
    });
    await page.goto("/");
    const actual = await page.evaluate(async (cancellation) => {
      const path = "/src/plugins/registry.ts";
      const { PluginRegistry } = await import(path);
      const registry = new PluginRegistry({
        serverOrigin: location.origin,
        ownerId: crypto.randomUUID(),
      });
      const id = "microcrab.mcp-bridge",
        session = "cancel-session";
      await registry.initialize();
      await registry.setSession(session);
      await registry.setEnabled(id, session, true);
      await registry.render(id, "sidebar");
      registry.setVariable(id, "id", "slow");
      registry.setVariable(
        id,
        "endpoint",
        "https://mcp-cancel.example.test/mcp",
      );
      registry.setVariable(id, "enabled", "true");
      await registry.action(id, "save-config");
      const artifact = (
        registry.toolInventory() as { id: string; artifact: string }[]
      ).find((p) => p.id === id)!.artifact;
      const identity = () => ({
        invocation_id: crypto.randomUUID(),
        session_id: session,
        parent_session_id: session,
        call_id: "c",
        catalog_digest: "d",
        epoch: 1,
        turn_id: 1,
        round_id: 1,
        deadline_ms:
          cancellation === "zero" || cancellation === "effect-timeout"
            ? 0
            : cancellation === "negative"
              ? -1
              : Date.now() + 10000,
      });
      const described = (await registry.executeTool(
        {
          plugin: id,
          artifact,
          action: "describe",
          server: "slow",
          tool: "slow",
        },
        identity(),
        new AbortController().signal,
      )) as { call_pin: string };
      const controller = new AbortController();
      (globalThis as unknown as { cancelMcp: () => void }).cancelMcp = () =>
        controller.abort();
      const invocation = identity();
      if (cancellation === "deadline")
        invocation.deadline_ms = Date.now() + 1500;
      const request = {
        plugin: id,
        artifact,
        action: "call",
        pin: described.call_pin,
      };
      let error = "",
        replay = "";
      const started = performance.now();
      try {
        await registry.executeTool(
          request as never,
          invocation,
          controller.signal,
        );
      } catch (e) {
        error = String(e);
      }
      try {
        await registry.executeTool(
          request as never,
          invocation,
          new AbortController().signal,
        );
      } catch (e) {
        replay = String(e);
      }
      // Keep the registry alive until the host's bounded cleanup notification runs.
      (
        globalThis as unknown as { cancelRegistry: { dispose(): void } }
      ).cancelRegistry = registry;
      return { error, replay, elapsed: performance.now() - started };
    }, cancellation);
    if (cancellation !== "effect-timeout")
      await Promise.race([
        notified,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(Error("MCP cancellation notification was not sent")),
            5000,
          ),
        ),
      ]);
    await page.evaluate(() =>
      (
        globalThis as unknown as { cancelRegistry: { dispose(): void } }
      ).cancelRegistry.dispose(),
    );
    if (cancellation === "effect-timeout") {
      expect(actual.error).toContain("outcome unknown");
      expect(actual.elapsed).toBeGreaterThanOrEqual(9500);
      expect(actual.elapsed).toBeLessThan(15000);
    } else expect(actual.error).toContain("outcome may be unknown");
    expect(actual.replay).toContain(
      cancellation === "deadline" ? "expired before dispatch" : "duplicate",
    );
    expect(calls).toBe(1);
    expect(notifications).toBe(cancellation === "effect-timeout" ? 0 : 1);
  });
}

test("frozen preprocessing caches no-registry input and bounds bypass admissions", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/state/client-plugins.ts";
    const { ClientPlugins } = await import(path);
    const plugins = new ClientPlugins(() => {
      throw Error("No server API should run");
    });
    const original = { parts: [{ type: "text", text: "first" }] };
    const first = await plugins.preprocess(
      original as never,
      "same",
      "s",
      () => true,
    );
    if (first) first.parts[0].text = "mutated outside";
    const restored = await plugins.preprocess(
      { parts: [{ type: "text", text: "different" }] } as never,
      "same",
      "s",
      () => true,
    );
    for (let i = 1; i < 128; i++)
      await plugins.preprocess(original as never, `op-${i}`, "s", () => true);
    plugins.allowBypassOnce();
    let bounded = "";
    try {
      await plugins.preprocess(original as never, "overflow", "s", () => true);
    } catch (error) {
      bounded = String(error);
    }
    plugins.dispose();
    return { restored, bounded };
  });
  expect(actual.restored?.parts[0]).toMatchObject({ text: "first" });
  expect(actual.restored?.variables?.scoped_set).toEqual([
    {
      name: "plugins",
      value: [],
      visibility: "visible",
      persistence: "persisted",
      editors: ["client"],
    },
  ]);
  expect(actual.bounded).toContain("Too many unresolved");
});

test("persisted inventory refreshes new operations while exact admitted input stays frozen", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/state/client-plugins.ts";
    const { ClientPlugins } = await import(path);
    const plugins = new ClientPlugins(() => {
      throw Error("No server API should run");
    });
    const summary = {
      id: "example.tools",
      name: "Example tools",
      version: "1",
      artifact: "a".repeat(16),
      description: "Discover tools on demand",
    };
    let inventory = [summary];
    // Exercise the canonical preprocess owner without a worker or server mock
    // manufacturing variables. This registry stub supplies only live discovery.
    plugins.registry = {
      toolInventory: () => inventory,
      beforeSubmit: async (input: string) => ({
        input,
        variables: {
          scoped_set: [
            {
              name: "plugins",
              value: "forged",
              visibility: "invisible",
              persistence: "ephemeral",
            },
          ],
        },
      }),
      dispose() {},
    } as never;
    const input = { parts: [{ type: "text", text: "original" }] };
    const first = await plugins.preprocess(
      input as never,
      "admitted",
      "s",
      () => true,
    );
    inventory = [];
    const frozen = await plugins.preprocess(
      { parts: [{ type: "text", text: "changed" }] } as never,
      "admitted",
      "s",
      () => true,
    );
    const refreshed = await plugins.preprocess(
      input as never,
      "new-operation",
      "s",
      () => true,
    );
    plugins.allowBypassOnce();
    const bypassed = await plugins.preprocess(
      input as never,
      "bypass-operation",
      "s",
      () => true,
    );
    plugins.dispose();
    return { first, frozen, refreshed, bypassed, summary };
  });
  const write = (value: unknown) => ({
    name: "plugins",
    value,
    visibility: "visible",
    persistence: "persisted",
    editors: ["client"],
  });
  expect(actual.first).toEqual(actual.frozen);
  expect(actual.first?.variables?.scoped_set).toEqual([
    write([actual.summary]),
  ]);
  expect(actual.refreshed?.variables?.scoped_set).toEqual([write([])]);
  expect(actual.bypassed?.variables?.scoped_set).toEqual([write([])]);
  expect(JSON.stringify(actual)).not.toContain("forged");
  expect(JSON.stringify(actual)).not.toContain("authorization");
  expect(JSON.stringify(actual)).not.toContain("endpoint");
});
