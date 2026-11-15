import { test, expect, type Page } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

async function setup(page: Page, counts = { one: 4, two: 3 }, broken = true) {
  await nativeBackend(page);
  const state = {
    changed: false,
    effects: [] as string[],
    requests: [] as string[],
  };
  await page.route("https://ergonomics-*.example.test/mcp", async (route) => {
    const rpc = route.request().postDataJSON();
    const server = new URL(route.request().url()).hostname
      .split(".")[0]!
      .replace("ergonomics-", "");
    state.requests.push(`${server}:${rpc.method}`);
    if (server === "broken") {
      await route.fulfill({ status: 503, body: "private upstream detail" });
      return;
    }
    if (rpc.method === "notifications/initialized") {
      await route.fulfill({ status: 202, body: "" });
      return;
    }
    let result: unknown;
    if (rpc.method === "initialize")
      result = {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: server, version: "1" },
      };
    else if (rpc.method === "tools/list")
      result = {
        tools: Array.from(
          { length: counts[server as keyof typeof counts] },
          (_, index) => ({
            name: `${server}-${index}`,
            description: `${state.changed ? "Changed" : "Original"} description`,
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
          }),
        ),
      };
    else if (rpc.method === "tools/call") {
      state.effects.push(`${server}:${rpc.params.name}`);
      result = {
        content: [{ type: "text", text: rpc.params.arguments.query }],
      };
    } else throw Error(`Unexpected RPC ${rpc.method}`);
    await route.fulfill({ json: { jsonrpc: "2.0", id: rpc.id, result } });
  });
  await page.goto("/");
  await page.evaluate(async (broken) => {
    const registryPath = "/src/plugins/registry.ts",
      parserPath = "/src/plugins/tool-hub.ts";
    const { PluginRegistry } = await import(registryPath);
    const { parseToolRequest } = await import(parserPath);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: crypto.randomUUID(),
    });
    const id = "microcrab.mcp-bridge",
      session = "ergonomics";
    await registry.initialize();
    await registry.setSession(session);
    await registry.setEnabled(id, session, true);
    await registry.render(id, "sidebar");
    const configure = async (server: string) => {
      registry.setVariable(id, "id", server);
      registry.setVariable(
        id,
        "endpoint",
        `https://ergonomics-${server}.example.test/mcp`,
      );
      registry.setVariable(id, "enabled", "true");
      await registry.action(id, "save-config");
    };
    for (const server of broken ? ["one", "two", "broken"] : ["one", "two"])
      await configure(server);
    const artifact = registry
      .toolInventory()
      .find((plugin: any) => plugin.id === id)!.artifact;
    const h = {
      registry,
      artifact,
      epoch: 1,
      configure,
      run: async (request: Record<string, unknown>) =>
        registry.executeTool(
          parseToolRequest({ plugin: id, artifact, ...request }),
          {
            invocation_id: crypto.randomUUID(),
            session_id: session,
            parent_session_id: session,
            call_id: crypto.randomUUID(),
            catalog_digest: "catalog",
            epoch: h.epoch,
            turn_id: 1,
            round_id: 1,
            deadline_ms: 0,
          },
          new AbortController().signal,
        ),
    };
    (window as any).ergonomics = h;
  }, broken);
  return state;
}

test.afterEach(async ({ page }) => {
  await page
    .evaluate(() => (window as any).ergonomics?.registry.dispose())
    .catch(() => {});
});

test("aggregated discovery pages total tools, retains peer errors, and server describe leads to pin-only call", async ({
  page,
}) => {
  const state = await setup(page);
  const result = await page.evaluate(async () => {
    const h = (window as any).ergonomics;
    const pages = [];
    let cursor: string | undefined;
    do {
      const page = await h.run({
        action: "list",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      pages.push(page);
      cursor = page.next_cursor ?? undefined;
      if (pages.length > 8)
        throw Error("Discovery pagination did not terminate");
    } while (cursor);
    const describedServer = await h.run({
      action: "describe",
      server: "one",
      limit: 2,
    });
    const nextServerPage = await h.run({
      action: "describe",
      server: "one",
      limit: 2,
      cursor: describedServer.next_cursor,
    });
    const described = await h.run({
      action: "describe",
      server: "one",
      tool: "one-0",
    });
    const output = await h.run({
      action: "call",
      pin: described.call_pin,
      arguments: { query: "search result" },
    });
    let redundant = "";
    try {
      await h.run({
        action: "call",
        pin: described.call_pin,
        server: "one",
        tool: "one-0",
      });
    } catch (error) {
      redundant = String(error);
    }
    return {
      artifact: h.artifact,
      pages,
      describedServer,
      nextServerPage,
      described,
      output,
      redundant,
    };
  });
  expect(result.artifact).toMatch(/^[a-f0-9]{16}$/);
  const names: string[] = [];
  for (const page of result.pages) {
    const summaries = page.servers.flatMap((server: any) => {
      expect(server.config_pin).toMatch(/^[a-f0-9]{16}$/);
      return server.tools;
    });
    expect(summaries.length).toBeLessThanOrEqual(2);
    names.push(...summaries.map((tool: any) => tool.name));
    const failure = page.servers.find((server: any) => server.id === "broken");
    if (failure) expect(failure.error).toBeTruthy();
    if (page.next_cursor !== null)
      expect(page.next_cursor).toMatch(/^[a-f0-9]{16}$/);
  }
  expect(names).toEqual([
    "one-0",
    "one-1",
    "one-2",
    "one-3",
    "two-0",
    "two-1",
    "two-2",
  ]);
  expect(
    result.pages
      .flatMap((page: any) => page.servers)
      .filter((server: any) => server.id === "broken"),
  ).toEqual([
    expect.objectContaining({ error: expect.any(String), tools: [] }),
  ]);
  expect(result.pages.at(-1).next_cursor).toBeNull();
  expect(result.describedServer.tools.map((tool: any) => tool.name)).toEqual([
    "one-0",
    "one-1",
  ]);
  expect(result.nextServerPage.tools.map((tool: any) => tool.name)).toEqual([
    "one-2",
    "one-3",
  ]);
  expect(result.describedServer.usage_hint).toContain("describe");
  expect(result.describedServer.catalog_pin).toMatch(/^[a-f0-9]{16}$/);
  for (const key of ["call_pin", "config_pin", "schema_pin"])
    expect(result.described[key]).toMatch(/^[a-f0-9]{16}$/);
  expect(result.output).toEqual({
    content: [{ type: "text", text: "search result" }],
  });
  expect(result.redundant).toBeTruthy();
  expect(JSON.stringify(result.pages)).not.toContain("private upstream detail");
  expect(state.effects).toEqual(["one:one-0"]);
});

test("aggregated cursors reject changed catalogs, config, Context epoch and worker scope", async ({
  page,
}) => {
  const state = await setup(page, { one: 4, two: 3 }, false);
  const first = await page.evaluate(() =>
    (window as any).ergonomics.run({ action: "list", limit: 2 }),
  );
  state.changed = true;
  const catalogError = await page.evaluate(async (cursor) => {
    try {
      await (window as any).ergonomics.run({
        action: "list",
        cursor,
        limit: 2,
      });
      return "unexpected success";
    } catch (error) {
      return String(error);
    }
  }, first.next_cursor);
  expect(catalogError).toMatch(/changed|stale|expired/i);
  const rest = await page.evaluate(async () => {
    const h = (window as any).ergonomics;
    const failure = async (cursor: string) => {
      try {
        await h.run({ action: "list", cursor, limit: 2 });
        return "unexpected success";
      } catch (error) {
        return String(error);
      }
    };
    const current = await h.run({ action: "list", limit: 2 });
    await h.configure("one");
    const config = await failure(current.next_cursor);
    const refreshed = await h.run({ action: "list", limit: 2 });
    h.epoch++;
    const epoch = await failure(refreshed.next_cursor);
    const latest = await h.run({ action: "list", limit: 2 });
    await h.registry.restart("microcrab.mcp-bridge");
    const restart = await failure(latest.next_cursor);
    return { config, epoch, restart };
  });
  for (const error of Object.values(rest))
    expect(error).toMatch(/changed|stale|expired/i);
  expect(state.effects).toEqual([]);
});

test("aggregated default limit is twenty total and explicit pages can span server boundaries", async ({
  page,
}) => {
  await setup(page, { one: 18, two: 9 }, false);
  const result = await page.evaluate(async () => {
    const h = (window as any).ergonomics;
    const first = await h.run({ action: "list" });
    const second = await h.run({ action: "list", cursor: first.next_cursor });
    const larger = await h.run({ action: "list", limit: 32 });
    return { first, second, larger };
  });
  const names = (page: any) =>
    page.servers.flatMap((server: any) =>
      server.tools.map((tool: any) => tool.name),
    );
  expect(names(result.first)).toHaveLength(20);
  expect(names(result.second)).toHaveLength(7);
  expect(new Set([...names(result.first), ...names(result.second)]).size).toBe(
    27,
  );
  expect(names(result.larger)).toHaveLength(27);
  expect(result.second.next_cursor).toBeNull();
  expect(result.larger.next_cursor).toBeNull();
});
