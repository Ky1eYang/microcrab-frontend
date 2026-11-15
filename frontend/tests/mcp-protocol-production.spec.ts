import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { PLUGIN_META_TOOL_DEFINITION } from "../src/plugins/tool-hub";
import type {
  ClientBinding,
  ClientInvocation,
} from "../src/client/client-tool-controller";

test("emitted MCP Worker aggregates and invokes using short artifacts through the executor lease", async ({
  page,
}) => {
  const index = await (await page.request.get("/plugins/current.json")).json();
  const plugin = index.plugins.find(
    (entry: any) => entry.id === "microcrab.mcp-bridge",
  );
  expect(plugin.sha256).toMatch(/^[a-f0-9]{64}$/);
  const artifact = plugin.sha256.slice(0, 16);
  const call = (args: Record<string, unknown>): ClientInvocation => ({
    invocation_id: crypto.randomUUID(),
    parent_session_id: "s1",
    session_id: "s1",
    call_id: crypto.randomUUID(),
    tool: "plugin",
    arguments: { plugin: plugin.id, artifact, ...args },
    epoch: 1,
    turn_id: 1,
    round_id: 1,
    catalog_digest: "mcp-emitted-catalog",
    status: "pending",
    created_at_ms: Date.now(),
    deadline_ms: 0,
  });
  const initial = call({ action: "list", limit: 2 });
  const binding: ClientBinding = {
    role: "executor",
    lease_id: "mcp-emitted-lease",
    catalog_digest: "mcp-emitted-catalog",
    definitions: [PLUGIN_META_TOOL_DEFINITION],
    calls: [],
    pending: [],
  };
  const results: any[] = [];
  const backend = await nativeBackend(page, { clientTools: binding });
  backend.handleSessionCommand((command) => {
    if (command.method === "client_tools.result") results.push(command.params);
    return undefined;
  });
  const effects: string[] = [];
  await page.route("https://emitted-mcp.example.test/mcp", async (route) => {
    const rpc = route.request().postDataJSON();
    if (rpc.method === "notifications/initialized") {
      await route.fulfill({ status: 202, body: "" });
      return;
    }
    let result: unknown;
    if (rpc.method === "initialize")
      result = {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "emitted-peer", version: "1" },
      };
    else if (rpc.method === "tools/list")
      result = {
        tools: [
          {
            name: "search",
            description: "Search fixture",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          },
        ],
      };
    else if (rpc.method === "tools/call") {
      effects.push(rpc.params.name);
      result = {
        content: [{ type: "text", text: rpc.params.arguments.query }],
      };
    } else throw Error(`Unexpected RPC ${rpc.method}`);
    await route.fulfill({ json: { jsonrpc: "2.0", id: rpc.id, result } });
  });
  await page.addInitScript(
    ({ id, hash }) => {
      // A fixture-owned explicit grant; production guest transport must still use
      // this full artifact/config identity while model arguments contain only16.
      localStorage.setItem(
        `microcrab.plugin.resources.v1:${JSON.stringify([location.origin, "u1", id])}`,
        JSON.stringify([
          {
            id: "peer",
            endpoint: "https://emitted-mcp.example.test/mcp",
            enabled: true,
            config_pin: "emitted-full-config-revision",
            grant_artifact: hash,
          },
        ]),
      );
    },
    { id: plugin.id, hash: plugin.sha256 },
  );
  await page.goto("/#/session/s1");
  await expect.poll(() => backend.commands.some((command) => command.method === "client_tools.bind")).toBe(true);
  binding.pending.push(initial);
  binding.calls.push(initial);
  backend.event("client_tool.requested", { call: initial });
  await expect
    .poll(
      () =>
        results.find(
          (result) => result.invocation_id === initial.invocation_id,
        ),
      { timeout: 20000 },
    )
    .toBeTruthy();
  const listed = results.find(
    (result) => result.invocation_id === initial.invocation_id,
  );
  expect(listed.error).toBeUndefined();
  expect(listed.result).toMatchObject({
    servers: [{ id: "peer", tools: [{ name: "search" }] }],
    next_cursor: null,
  });
  const invoke = async (args: Record<string, unknown>) => {
    const invocation = call(args);
    binding.pending.push(invocation);
    binding.calls.push(invocation);
    backend.event("client_tool.requested", { call: invocation });
    await expect
      .poll(() =>
        results.find(
          (result) => result.invocation_id === invocation.invocation_id,
        ),
      )
      .toBeTruthy();
    const receipt = results.find(
      (result) => result.invocation_id === invocation.invocation_id,
    );
    expect(receipt.error).toBeUndefined();
    return receipt.result;
  };
  const described = await invoke({
    action: "describe",
    server: "peer",
    tool: "search",
  });
  for (const key of ["call_pin", "schema_pin", "config_pin"])
    expect(described[key]).toMatch(/^[a-f0-9]{16}$/);
  expect(
    await invoke({
      action: "call",
      pin: described.call_pin,
      arguments: { query: "emitted search result" },
    }),
  ).toEqual({ content: [{ type: "text", text: "emitted search result" }] });
  expect(effects).toEqual(["search"]);
  expect(initial.arguments).toMatchObject({ artifact });
});
