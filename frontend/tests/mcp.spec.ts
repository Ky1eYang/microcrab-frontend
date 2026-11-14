import { test, expect } from "@playwright/test";
import {
  McpHttpClient,
  McpClientError,
  createMcpToolCatalog,
  mcpRegistrationName,
} from "../src/client/mcp";

const config = {
  id: "weather",
  endpoint: "https://mcp.example.test/mcp",
  authorization: "Bearer client-only-secret",
};
const initialized = {
  protocolVersion: "2025-06-18",
  capabilities: { tools: {} },
  serverInfo: { name: "fixture", version: "1" },
};
type Handler = (
  body: any,
  init: RequestInit,
  index: number,
) => Response | Promise<Response>;
function fixture(
  handler?: Handler,
  options: ConstructorParameters<typeof McpHttpClient>[1] = {},
) {
  const requests: { body: any; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body));
    requests.push({ body, init });
    if (body.method === "initialize")
      return json(body.id, initialized, { "Mcp-Session-Id": "session-1" });
    if (body.method.startsWith("notifications/"))
      return new Response(null, { status: 202 });
    return handler
      ? handler(body, init, requests.length)
      : json(body.id, { tools: [] });
  };
  const client = new McpHttpClient(config, { fetch: fetcher, ...options });
  return { client, requests };
}
function json(id: number, result: unknown, headers = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("negotiates protocol, propagates session/auth, paginates tools and invokes server-local names", async () => {
  const { client, requests } = fixture((body) =>
    body.method === "tools/call"
      ? json(body.id, {
          content: [{ type: "text", text: "done" }],
          isError: true,
        })
      : json(
          body.id,
          body.params.cursor
            ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
            : {
                tools: [
                  {
                    name: "forecast",
                    description: "Forecast",
                    inputSchema: {
                      type: "object",
                      properties: { city: { type: "string" } },
                    },
                  },
                ],
                nextCursor: "page2",
              },
        ),
  );
  await client.initialize();
  const tools = await client.listTools();
  const catalog = await createMcpToolCatalog(client, tools);
  expect(client.protocolVersion).toBe("2025-06-18");
  expect(client.sessionId).toBe("session-1");
  expect(catalog.definitions[0]).toEqual({
    name: await mcpRegistrationName("weather", "forecast"),
    description: "Forecast",
    parameters: tools[0].inputSchema,
  });
  expect(JSON.stringify(catalog.definitions)).not.toContain("secret");
  expect(JSON.stringify(catalog.definitions)).not.toContain(config.endpoint);
  expect(catalog.bindings.get(catalog.definitions[0].name)).toBe("forecast");
  expect((await client.callTool("forecast", { city: "London" })).isError).toBe(
    true,
  );
  expect(requests.map((r) => r.body.method)).toEqual([
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/list",
    "tools/call",
  ]);
  const initHeaders = new Headers(requests[0].init.headers);
  expect(initHeaders.has("MCP-Protocol-Version")).toBe(false);
  for (const request of requests.slice(1)) {
    const headers = new Headers(request.init.headers);
    expect(headers.get("Mcp-Session-Id")).toBe("session-1");
    expect(headers.get("MCP-Protocol-Version")).toBe("2025-06-18");
    expect(headers.get("Authorization")).toBe(config.authorization);
    expect(request.init.credentials).toBe("omit");
    expect(request.init.redirect).toBe("error");
  }
  expect(requests.at(-1)?.body.params).toEqual({
    name: "forecast",
    arguments: { city: "London" },
  });
});

test("prefixed registration names distinguish punctuation and server boundaries", async () => {
  const names = await Promise.all([
    mcpRegistrationName("a-b", "c"),
    mcpRegistrationName("a_b", "c"),
    mcpRegistrationName("a", "b_c"),
    mcpRegistrationName("a_b", "c_"),
    mcpRegistrationName("天气", "c"),
    mcpRegistrationName("server".repeat(100), "tool".repeat(1000)),
  ]);
  expect(new Set(names).size).toBe(names.length);
  for (const name of names) {
    expect(name).toMatch(/^mcp_[a-zA-Z0-9_-]{43}$/);
    expect(name.length).toBeLessThanOrEqual(64);
  }
  expect(await mcpRegistrationName("a-b", "c")).toBe(names[0]);
});

test("shared registration registry rejects digest collisions and duplicate local names", async () => {
  const { client } = fixture();
  const tool = { name: "forecast", inputSchema: { type: "object" } };
  const name = await mcpRegistrationName(client.serverId, tool.name);
  const registry = new Map([
    [name, JSON.stringify(["different-server", "other-tool"])],
  ]);
  await expect(
    createMcpToolCatalog(client, [tool], registry),
  ).rejects.toMatchObject({ code: "protocol" });
  await expect(
    createMcpToolCatalog(client, [tool, tool]),
  ).rejects.toMatchObject({ code: "protocol" });
  const shared = new Map<string, string>();
  const catalog = await createMcpToolCatalog(client, [tool], shared);
  expect(shared.get(catalog.definitions[0].name)).toBe(
    JSON.stringify([client.serverId, tool.name]),
  );
});

test("reads chunked POST event streams, multiline data, notifications and CRLF; closes after response", async () => {
  let cancelled = false;
  const { client } = fixture((body) => {
    const text = `: heartbeat\r\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":${body.id},"result":{"tools":[]}}\r\n\r\n`;
    const bytes = new TextEncoder().encode(text);
    let index = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (index < bytes.length)
            controller.enqueue(bytes.slice(index, ++index));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
    );
  });
  await client.initialize();
  expect(await client.listTools()).toEqual([]);
  expect(cancelled).toBe(true);
});

for (const scenario of [
  "duplicate-cursor",
  "duplicate-name",
  "bad-schema",
  "bad-id",
  "wrong-content-type",
  "invalid-json",
  "invalid-envelope",
  "unsupported-request",
  "unterminated-event",
] as const) {
  test(`rejects ${scenario} without replay`, async () => {
    const { client, requests } = fixture((body) => {
      switch (scenario) {
        case "duplicate-cursor":
          return json(body.id, { tools: [], nextCursor: "same" });
        case "duplicate-name":
          return json(body.id, {
            tools: [
              { name: "same", inputSchema: { type: "object" } },
              { name: "same", inputSchema: { type: "object" } },
            ],
          });
        case "bad-schema":
          return json(body.id, { tools: [{ name: "bad", inputSchema: {} }] });
        case "bad-id":
          return json(body.id + 1, { tools: [] });
        case "wrong-content-type":
          return new Response("{}", {
            headers: { "Content-Type": "text/plain" },
          });
        case "invalid-json":
          return new Response("{", {
            headers: { "Content-Type": "application/json" },
          });
        case "invalid-envelope":
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {},
              error: {},
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        case "unsupported-request":
          return new Response(
            'data: {"jsonrpc":"2.0","id":99,"method":"sampling/createMessage"}\n\n',
            { headers: { "Content-Type": "text/event-stream" } },
          );
        case "unterminated-event":
          return new Response(
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })}`,
            { headers: { "Content-Type": "text/event-stream" } },
          );
      }
    });
    await client.initialize();
    await expect(client.listTools()).rejects.toMatchObject({
      code: "protocol",
    });
    expect(requests.length).toBe(scenario === "duplicate-cursor" ? 4 : 3);
  });
}

test("rejects oversized streams and caps aggregate pagination", async () => {
  const sized = fixture(
    () =>
      new Response(" ".repeat(1025), {
        headers: { "Content-Type": "application/json" },
      }),
    { maxResponseBytes: 1024 },
  );
  await sized.client.initialize();
  await expect(sized.client.callTool("effect", {})).rejects.toMatchObject({
    code: "limit",
    outcomeUnknown: true,
  });
  const paged = fixture(
    (body) => json(body.id, { tools: [], nextCursor: String(body.id) }),
    { maxPages: 2 },
  );
  await paged.client.initialize();
  await expect(paged.client.listTools()).rejects.toMatchObject({
    code: "limit",
  });
  expect(
    paged.requests.filter((r) => r.body.method === "tools/list"),
  ).toHaveLength(2);
});

test("request bounds and pre-abort reject before an effect is dispatched", async () => {
  const { client, requests } = fixture(undefined, { maxRequestBytes: 1024 });
  await client.initialize();
  await expect(
    client.callTool("effect", { text: "x".repeat(1024) }),
  ).rejects.toMatchObject({ code: "limit", outcomeUnknown: false });
  const signal = AbortSignal.abort();
  await expect(client.callTool("effect", {}, { signal })).rejects.toMatchObject(
    { code: "aborted", outcomeUnknown: false },
  );
  expect(requests).toHaveLength(2);
});

for (const action of ["timeout", "abort", "close"] as const) {
  test(`${action} aborts in-flight effect and never replays`, async () => {
    let signal: AbortSignal | undefined;
    const { client, requests } = fixture((_body, init) => {
      signal = init.signal!;
      return new Response(new ReadableStream({ start() {} }), {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    await client.initialize();
    const controller = new AbortController();
    const pending = client.callTool(
      "effect",
      {},
      { signal: controller.signal, timeoutMs: 30 },
    );
    if (action === "abort") controller.abort();
    if (action === "close") client.close();
    await expect(pending).rejects.toMatchObject({
      code: action === "timeout" ? "timeout" : "aborted",
      outcomeUnknown: true,
    });
    expect(signal?.aborted).toBe(true);
    expect(requests.filter((r) => r.body.method === "tools/call")).toHaveLength(
      1,
    );
  });
}

test("network and HTTP failures never reinitialize or retry an effect; remote messages are redacted", async () => {
  for (const failure of ["network", "http", "rpc"] as const) {
    const { client, requests } = fixture((body) => {
      if (failure === "network") throw Error("client-only-secret");
      if (failure === "http")
        return new Response("client-only-secret", { status: 404 });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32602, message: "client-only-secret" },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    await client.initialize();
    try {
      await client.callTool("effect", {});
      throw Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(McpClientError);
      expect((error as McpClientError).code).toBe(failure);
      expect((error as McpClientError).outcomeUnknown).toBe(failure !== "rpc");
      expect(String(error)).not.toContain("secret");
    }
    expect(requests).toHaveLength(3);
    if (failure === "http")
      await expect(client.listTools()).rejects.toMatchObject({
        code: "not_initialized",
      });
  }
});

test("unsupported negotiated protocol and changed session fail explicitly", async () => {
  const unsupported = new McpHttpClient(config, {
    fetch: async (_url, init) =>
      json(JSON.parse(String(init?.body)).id, {
        ...initialized,
        protocolVersion: "1900-01-01",
      }),
  });
  await expect(unsupported.initialize()).rejects.toMatchObject({
    code: "protocol",
  });
  expect(unsupported.protocolVersion).toBeUndefined();
  const changed = fixture((body) =>
    json(body.id, { tools: [] }, { "Mcp-Session-Id": "other" }),
  );
  await changed.client.initialize();
  await expect(changed.client.listTools()).rejects.toMatchObject({
    code: "protocol",
  });
});

test("actual browser fetch performs Streamable HTTP and keeps auth out of the catalog", async ({
  page,
}) => {
  const received: any[] = [];
  // Exercise the standalone HTTP client without mounting app startup auth.
  await page.route("**/mcp-client-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>MCP client fixture</title>",
    }),
  );
  await page.route("**/mcp-fixture", async (route) => {
    const body = route.request().postDataJSON();
    received.push({ body, headers: route.request().headers() });
    if (body.method === "notifications/initialized")
      return route.fulfill({ status: 202, body: "" });
    const result =
      body.method === "initialize"
        ? initialized
        : body.method === "tools/list"
          ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: body.params.arguments.text }] };
    await route.fulfill({
      contentType:
        body.method === "tools/call" ? "text/event-stream" : "application/json",
      headers: { "Mcp-Session-Id": "browser-session" },
      body:
        body.method === "tools/call"
          ? `data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`
          : JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
    });
  });
  await page.goto("/mcp-client-fixture");
  const result = await page.evaluate(async () => {
    // @ts-expect-error Vite serves this browser-only module path.
    const { McpHttpClient, createMcpToolCatalog } =
      await import("/src/client/mcp.ts");
    const client = new McpHttpClient({
      id: "browser",
      endpoint: `${location.origin}/mcp-fixture`,
      authorization: "Bearer browser-only",
    });
    await client.initialize();
    const catalog = await createMcpToolCatalog(
      client,
      await client.listTools(),
    );
    const called = await client.callTool(
      catalog.bindings.get(catalog.definitions[0].name),
      { text: "browser fetched" },
    );
    client.close();
    return { definitions: catalog.definitions, called };
  });
  expect(result.called.content[0].text).toBe("browser fetched");
  expect(JSON.stringify(result.definitions)).not.toContain("browser-only");
  expect(received).toHaveLength(4);
  expect(received[3].headers["mcp-protocol-version"]).toBe("2025-06-18");
  expect(received[3].headers["mcp-session-id"]).toBe("browser-session");
  expect(received[3].headers.authorization).toBe("Bearer browser-only");
});

test("expired sessions require explicit initialization with fresh headers", async () => {
  const { client, requests } = fixture(
    () => new Response(null, { status: 404 }),
  );
  await client.initialize();
  await expect(client.callTool("effect", {})).rejects.toMatchObject({
    code: "http",
    outcomeUnknown: true,
  });
  expect(client.sessionId).toBeUndefined();
  expect(client.protocolVersion).toBeUndefined();
  expect(requests).toHaveLength(3);
  await client.initialize();
  const headers = new Headers(requests[3].init.headers);
  expect(headers.has("Mcp-Session-Id")).toBe(false);
  expect(headers.has("MCP-Protocol-Version")).toBe(false);
  expect(requests.filter((r) => r.body.method === "tools/call")).toHaveLength(
    1,
  );
});

test("late responses after initialization deadline cannot reopen the client", async () => {
  let respond: ((response: Response) => void) | undefined;
  const client = new McpHttpClient(config, {
    fetch: () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  });
  await expect(client.initialize({ timeoutMs: 10 })).rejects.toMatchObject({
    code: "timeout",
  });
  respond!(json(1, initialized, { "Mcp-Session-Id": "too-late" }));
  await Promise.resolve();
  await Promise.resolve();
  expect(client.sessionId).toBeUndefined();
  await expect(client.listTools()).rejects.toMatchObject({
    code: "not_initialized",
  });
});

test("malformed Unicode cannot collapse distinct registration identities", async () => {
  await expect(mcpRegistrationName("server", "\ud800")).rejects.toBeInstanceOf(
    McpClientError,
  );
});
