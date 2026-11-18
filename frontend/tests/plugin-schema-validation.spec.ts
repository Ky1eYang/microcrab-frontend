import { test, expect } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test("plugin invalid null and conditional shapes fail before registry effects without repairing input", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const hubPath = "/src/plugins/tool-hub.ts";
    const bridgePath = "/src/state/client-plugins.ts";
    const { parseToolRequest } = await import(hubPath);
    const { ClientPlugins } = await import(bridgePath);
    const bridge = new ClientPlugins(() => {
      throw Error("No API calls expected");
    });
    let effects = 0;
    bridge.registry = {
      executeTool: async (request: unknown) => {
        effects++;
        return request;
      },
      dispose() {},
    };
    const base = { plugin: "example.tools", artifact: "a".repeat(16) };
    const requests = [
      { arguments: {}, artifact: null, pin: null, plugin: null },
      { action: null, artifact: null, plugin: null, server: null, tool: null },
      ...["plugin", "artifact", "action"].map((key) => ({
        ...base,
        action: "list",
        [key]: null,
      })),
      ...[
        "server",
        "tool",
        "cursor",
        "config_pin",
        "schema_pin",
        "limit",
        "pin",
        "arguments",
      ].map((key) => ({ ...base, action: "list", [key]: null })),
      ...["plugin", "artifact", "action"].map((key) =>
        Object.fromEntries(
          Object.entries({ ...base, action: "list" }).filter(
            ([field]) => field !== key,
          ),
        ),
      ),
      { ...base, action: "describe" },
      { ...base, action: "call", server: "one", tool: "echo" },
      ...["server", "tool", "config_pin", "schema_pin"].map((key) => ({
        ...base,
        action: "call",
        pin: "0123456789abcdef",
        [key]: "conflict",
      })),
      { ...base, action: "list", unexpected: "PRIVATE_SENTINEL" },
      { ...base, action: "list", server: "PRIVATE_SENTINEL".repeat(20) },
      ...[0, 33, 1.5, "1"].map((limit) => ({ ...base, action: "list", limit })),
      { ...base, action: "call", pin: "0123456789abcdef", arguments: [] },
    ];
    const before = JSON.stringify(requests);
    const failures: string[] = [];
    for (const request of requests) {
      try {
        // Invalid arguments must fail before invocation metadata is even read.
        await bridge.execute(
          "plugin",
          request,
          new AbortController().signal,
          {},
        );
        failures.push("ACCEPTED");
      } catch (error) {
        failures.push(String(error));
      }
    }
    const invalidEffects = effects;
    const valid = {
      ...base,
      action: "call",
      pin: "0123456789abcdef",
      arguments: { nullable: null, nested: { value: null } },
    };
    const sameObject = parseToolRequest(valid) === valid;
    const corrected = await bridge.execute(
      "plugin",
      valid,
      new AbortController().signal,
      {},
    );
    bridge.dispose();
    return {
      failures,
      count: requests.length,
      invalidEffects,
      effects,
      unchanged: JSON.stringify(requests) === before,
      sameObject,
      corrected,
    };
  });
  expect(actual.failures).toHaveLength(actual.count);
  expect(actual.failures.every((message) => message !== "ACCEPTED")).toBe(true);
  expect(actual.failures.join("\n")).not.toContain("PRIVATE_SENTINEL");
  expect(
    actual.failures.some((message) => message.includes("Required artifact")),
  ).toBe(true);
  expect(
    actual.failures.some((message) =>
      message.includes("omit it when unused, never send null"),
    ),
  ).toBe(true);
  expect(actual.invalidEffects).toBe(0);
  expect(actual.effects).toBe(1);
  expect(actual.unchanged).toBe(true);
  expect(actual.sameObject).toBe(true);
  expect(actual.corrected.arguments).toEqual({
    nullable: null,
    nested: { value: null },
  });
});
