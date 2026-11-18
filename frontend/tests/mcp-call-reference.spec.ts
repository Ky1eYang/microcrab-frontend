import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("plugin request parser accepts short artifacts and generic legacy calls while rejecting ambiguous shapes", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/tool-hub.ts";
    const { parseToolRequest, PLUGIN_META_TOOL_DEFINITION } = await import(
      path
    );
    const base = { plugin: "example.tools", artifact: "a".repeat(16) };
    const legacy = {
      ...base,
      artifact: "a".repeat(64),
      action: "call",
      server: "default",
      tool: "echo",
      schema_pin: "b".repeat(64),
      config_pin: "unchanged-full-configuration-revision",
    };
    const accepted = [
      { action: "call", pin: "0123456789abcdef", arguments: {} },
      legacy,
      { action: "describe", server: "one", tool: "echo" },
      { action: "describe", server: "one" },
      { action: "list" },
      { action: "list", artifact: "a".repeat(64) },
    ].map((request) => parseToolRequest({ ...base, ...request }).action);
    const rejected = [
      ...[undefined, null, ["list"], ["call"], {}, 0].map((action) => ({
        action,
      })),
      { action: "list", pin: "0123456789abcdef" },
      {
        action: "describe",
        server: "one",
        tool: "echo",
        pin: "0123456789abcdef",
      },
      { action: "describe" },
      { action: "describe", tool: "echo" },
      { action: "call", pin: "ABCDEF0123456789" },
      { action: "call", pin: "a".repeat(64) },
      { action: "call", server: "one", tool: "echo" },
      ...[
        undefined,
        "bad",
        "A".repeat(16),
        "a".repeat(15),
        "a".repeat(17),
        "a".repeat(63),
        "a".repeat(65),
      ].map((artifact) => ({ action: "list", artifact })),
      ...["server", "tool", "config_pin", "schema_pin"].map((field) => ({
        action: "call",
        pin: "0123456789abcdef",
        [field]: "redundant",
      })),
    ].map((request) => {
      try {
        parseToolRequest({ ...base, ...request });
        return false;
      } catch {
        return true;
      }
    });
    return {
      accepted,
      rejected,
      legacy: parseToolRequest(legacy),
      required: PLUGIN_META_TOOL_DEFINITION.parameters.required,
      schema: PLUGIN_META_TOOL_DEFINITION.parameters,
    };
  });
  expect(actual.accepted).toEqual([
    "call",
    "call",
    "describe",
    "describe",
    "list",
    "list",
  ]);
  expect(actual.rejected).toEqual(Array(24).fill(true));
  expect(actual.legacy.artifact).toBe("a".repeat(64));
  expect(actual.legacy.schema_pin).toBe("b".repeat(64));
  expect(actual.legacy.config_pin).toBe(
    "unchanged-full-configuration-revision",
  );
  expect(actual.required).toEqual(["plugin", "action", "artifact"]);
  expect(actual.schema).not.toHaveProperty("oneOf");
  expect(actual.schema.additionalProperties).toBe(false);
  expect(Object.values(actual.schema.properties)).not.toContain(false);
  expect(actual.schema.properties.pin).toEqual({
    type: "string",
    pattern: "^[a-f0-9]{16}$",
  });
});
test("MCP short references bind exact targets and reject stale schemas, config and worker scope", async ({
  page,
}) => {
  await nativeBackend(page);
  let schemaChanged = false;
  const methods: string[] = [];
  await page.route("https://short-mcp.example.test/mcp", async (route) => {
    const rpc = route.request().postDataJSON();
    methods.push(rpc.method);
    if (rpc.method === "notifications/initialized") {
      await route.fulfill({ status: 202, body: "" });
      return;
    }
    let result: unknown;
    if (rpc.method === "initialize") {
      result = {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "short", version: "1" },
      };
    } else if (rpc.method === "tools/list") {
      result = {
        tools: [
          {
            name: "echo",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: schemaChanged ? ["text"] : [],
              additionalProperties: false,
            },
          },
        ],
      };
    } else if (rpc.method === "tools/call") {
      result = { content: [{ type: "text", text: "accepted" }] };
      schemaChanged = true;
    } else throw Error(`Unexpected RPC ${rpc.method}`);
    await route.fulfill({ json: { jsonrpc: "2.0", id: rpc.id, result } });
  });
  // An unrelated enabled service must never be probed to resolve a short reference.
  const unrelated: string[] = [];
  await page.route("https://unrelated-mcp.example.test/mcp", async (route) => {
    unrelated.push(route.request().postData() ?? "");
    await route.abort();
  });
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: crypto.randomUUID(),
    });
    const id = "microcrab.mcp-bridge",
      session = "short-references";
    try {
      await registry.initialize();
      await registry.setSession(session);
      await registry.setEnabled(id, session, true);
      const settings = {
        surface_id: "short-reference-settings",
        target: "setting-page" as const,
      };
      await registry.render(id, "setting-page", false, settings);
      const configure = async (server: string, endpoint: string) => {
        const state = () =>
          registry.view(id, "setting-page", settings).viewState as
            | {
                busy?: boolean;
                error?: string;
                servers?: {
                  id: string;
                  endpoint: string;
                  enabled: boolean;
                  config_pin: string;
                }[];
              }
            | undefined;
        const previousPin = state()?.servers?.find(
          (row) => row.id === server,
        )?.config_pin;
        // Settings actions require the exact mounted surface and an explicit typed
        // payload. Sidebar is observation-only; variable writes cannot configure it.
        await registry.action(
          id,
          "save-config",
          {
            id: server,
            endpoint,
            enabled: true,
            authorization: "",
            clear_authorization: false,
          },
          settings,
        );
        // action() returns before the resource-configure effect completes. Observe
        // its actual settled settings publication rather than racing tool dispatch.
        await new Promise<void>((resolve, reject) => {
          let unsubscribe = () => {};
          const timer = setTimeout(() => {
            unsubscribe();
            reject(
              Error(
                "MCP configuration did not settle for the exact settings surface",
              ),
            );
          }, 5000);
          const check = () => {
            const view = registry.view(id, "setting-page", settings);
            const current = state();
            const row = current?.servers?.find((entry) => entry.id === server);
            const error =
              view.status === "faulted" ? view.error : current?.error;
            if (error) {
              clearTimeout(timer);
              unsubscribe();
              reject(Error(error));
            } else if (
              !current?.busy &&
              row?.enabled &&
              row.endpoint === endpoint &&
              row.config_pin &&
              row.config_pin !== previousPin
            ) {
              clearTimeout(timer);
              unsubscribe();
              resolve();
            }
          };
          unsubscribe = registry.subscribe(check);
          check();
        });
      };
      await configure("one", "https://short-mcp.example.test/mcp");
      await configure("unrelated", "https://unrelated-mcp.example.test/mcp");
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
            epoch: 1,
            turn_id: 1,
            round_id: 1,
            deadline_ms: 0,
          },
          new AbortController().signal,
        );
      const failure = async (request: Record<string, unknown>) => {
        try {
          await run(request);
          return "unexpected success";
        } catch (error) {
          return String(error);
        }
      };
      const described = (await run({
        action: "describe",
        server: "one",
        tool: "echo",
      })) as { call_pin: string; schema_pin: string; config_pin: string };
      const malformed = await failure({ action: "call", pin: "wrong" });
      const unknown = await failure({ action: "call", pin: "0".repeat(16) });
      const conflict = await failure({
        action: "call",
        pin: described.call_pin,
        server: "unrelated",
      });
      const success = await run({
        action: "call",
        pin: described.call_pin,
        arguments: { text: "first" },
      });
      const schema = await failure({
        action: "call",
        pin: described.call_pin,
        arguments: { text: "second" },
      });
      const refreshed = (await run({
        action: "describe",
        server: "one",
        tool: "echo",
      })) as { call_pin: string };
      await configure("one", "https://short-mcp.example.test/mcp");
      const config = await failure({
        action: "call",
        pin: refreshed.call_pin,
        arguments: { text: "third" },
      });
      const current = (await run({
        action: "describe",
        server: "one",
        tool: "echo",
      })) as { call_pin: string };
      await registry.restart(id);
      const restarted = await failure({
        action: "call",
        pin: current.call_pin,
      });
      return {
        described,
        malformed,
        unknown,
        conflict,
        success,
        schema,
        config,
        restarted,
        changed: refreshed.call_pin !== described.call_pin,
      };
    } finally {
      registry.dispose();
    }
  });
  expect(actual.described.call_pin).toMatch(/^[a-f0-9]{16}$/);
  expect(actual.described.schema_pin).toMatch(/^[a-f0-9]{16}$/);
  expect(actual.described.config_pin).toMatch(/^[a-f0-9]{16}$/);
  expect(actual.malformed).toBe("Error: InvalidCallPin");
  expect(actual.unknown).toBe("Error: ExpiredCallPin");
  expect(actual.conflict).toBe("Error: ConflictingCallPinFields");
  expect(actual.success).toEqual({
    content: [{ type: "text", text: "accepted" }],
  });
  expect(actual.schema).toBe("Error: ChangedSchemaOrConfig");
  expect(actual.changed).toBe(true);
  expect(actual.config).toBe("Error: ChangedServerConfig");
  expect(actual.restarted).toBe("Error: ExpiredCallPin");
  expect(methods.filter((method) => method === "tools/call")).toHaveLength(1);
  expect(methods.filter((method) => method === "tools/list")).toHaveLength(5);
  expect(unrelated).toEqual([]);
});
