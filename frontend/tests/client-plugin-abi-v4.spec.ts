import { expect, test } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { maintainedPluginBundle } from "./plugin-bundle-fixture";

test.setTimeout(180_000);

// Retained, immutable hash directories supply actual previously built Components.
// Absence of either old ABI fails this gate instead of substituting synthetic bytes.
const root = resolve(import.meta.dirname, "../public/plugins");
const files = [
  "microcrab.state-viewer",
  "microcrab.mcp-bridge",
  "microcrab.fixture",
].flatMap((id) =>
  readdirSync(resolve(root, id))
    .filter((hash) => /^[a-f0-9]{64}$/.test(hash))
    .map((hash) => `/plugins/${id}/${hash}/plugin.wasm`),
);

test("real retained 0.2/0.3 Components are rejected and maintained 0.4 Components execute typed surfaces", async ({
  page,
}) => {
  const maintained = await maintainedPluginBundle(page);
  const componentPaths = [
    ...new Set([
      ...files,
      ...maintained.plugins.map((plugin) => `/plugins/${plugin.file}`),
    ]),
  ];
  await page.route("**/abi-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Plugin ABI fixture</title>",
    }),
  );
  await page.goto("/abi-fixture");
  const evidence = await page.evaluate(async (paths) => {
    const modulePath = "/src/plugins/component.ts";
    const { binaryImports, inspectComponent, instantiate, authorizeKind } =
      await import(modulePath);
    const selected = new Map<string, { path: string; bytes: Uint8Array }>();
    const pointer = await (await fetch("/plugins/current.json")).json();
    const currents = new Set(
      pointer.plugins.map((p: any) => `/plugins/${p.file}`),
    );
    for (const path of paths) {
      const bytes = new Uint8Array(await (await fetch(path)).arrayBuffer());
      let imports: string[];
      try {
        imports = binaryImports(bytes);
      } catch (error) {
        const version =
          bytes.includes(0) &&
          new TextDecoder()
            .decode(bytes)
            .match(/microcrab:client-plugin\/[a-z-]+@(0\.[23]\.0)/)?.[1];
        if (version) {
          const key = `${version}:${path.split("/")[2]}`;
          if (!selected.has(key)) selected.set(key, { path, bytes });
          continue;
        }
        if (currents.has(path)) throw error;
        continue;
      }
      const version = imports.some((name: string) => name.endsWith("@0.2.0"))
        ? "0.2.0"
        : imports.some((name: string) => name.endsWith("@0.3.0"))
          ? "0.3.0"
          : "0.4.0";
      const id = path.split("/")[2]!;
      // Some local historical experiments reused package versions with changed
      // enum layouts. Original maintained evidence is visual 0.2 / MCP tools 0.3.
      if (version === "0.3.0" && id !== "microcrab.mcp-bridge") continue;
      if (version === "0.2.0" && id === "microcrab.mcp-bridge") continue;
      const key = `${version}:${id}`;
      if ((version !== "0.4.0" && !selected.has(key)) || currents.has(path))
        selected.set(key, { path, bytes });
    }
    const results: any[] = [];
    for (const [key, { path, bytes }] of selected) {
      if (!key.startsWith("0.4.0:")) {
        let error = "";
        try {
          await inspectComponent(bytes);
        } catch (cause) {
          error = String(cause);
        }
        results.push({ key, path, error });
        continue;
      }
      const inspection = await inspectComponent(bytes);
      const effects: string[] = [];
      const host: Record<string, unknown> = {};
      for (const v of ["0.4.0"]) {
        host[`microcrab:client-plugin/view-types@${v}`] = {};
        for (const cap of [
          "session-state",
          "session-state-write",
          "net",
          "conversation",
          "resources",
        ])
          host[`microcrab:client-plugin/${cap}@${v}`] = {
            request: (kind: string) => {
              authorizeKind(inspection.imports, kind);
              effects.push(kind);
              return effects.length;
            },
          };
      }
      const { guest, manifest } = await instantiate(inspection, host);
      const ctx = JSON.stringify({
        schema_version: 1,
        server_origin: location.origin,
        owner_id: "abi-test",
        session_id: null,
        locale: "en",
        instance_generation: 1,
        surface: { surface_id: "abi-settings", target: "setting-page" },
      });
      const init = JSON.parse(guest.init(ctx));
      const vars = JSON.stringify(init.vars_patch ?? {});
      const beforeRender = effects.length;
      const sidebar = guest.renderView("sidebar", vars, ctx) as any;
      const entry: any = {
        key,
        path,
        targets: manifest.targets,
        providesTools: inspection.providesTools,
        sidebar: JSON.parse(sidebar.content),
        imports: inspection.imports,
      };
      if (key.startsWith("0.4.0:")) {
        const setting = guest.renderView("setting-page", vars, ctx) as any;
        entry.setting = JSON.parse(setting.content);
        if (manifest.id === "microcrab.state-viewer") {
          entry.renderEffects = effects.slice(beforeRender);
          const zh = guest.renderView(
            "setting-page",
            vars,
            JSON.stringify({ ...JSON.parse(ctx), locale: "zh-CN" }),
          ) as any;
          entry.zh = JSON.parse(zh.content);
        }
        if (manifest.id === "microcrab.mcp-bridge") {
          entry.expanded = JSON.parse(
            (guest.renderView("expanded-page", vars, ctx) as any).content,
          );
          entry.tab = JSON.parse(
            (guest.renderView("session-tab", vars, ctx) as any).content,
          );
          const identity = {
            invocation_id: "real-abi-tool",
            session_id: "session",
            artifact: "a".repeat(64),
          };
          entry.tool = JSON.parse(
            guest.startTool!(
              JSON.stringify({ action: "list" }),
              JSON.stringify({ tool_invocation: identity }),
            ),
          );
          entry.cancel = JSON.parse(
            guest.cancelTool!(JSON.stringify({ tool_invocation: identity })),
          );
        }
      }
      results.push(entry);
    }
    return results;
  }, componentPaths);
  expect(evidence.some((e) => e.key.startsWith("0.2.0:"))).toBe(true);
  expect(evidence.some((e) => e.key.startsWith("0.3.0:"))).toBe(true);
  for (const old of evidence.filter((e) => !e.key.startsWith("0.4.0:"))) {
    expect(old.error).toContain("unsupported Component import:");
    expect(old.error).toContain("client-plugin@0.4.0 only");
    expect(old.error).toContain(
      "existing installed bytes and preferences are retained",
    );
  }
  const state = evidence.find((e) => e.key === "0.4.0:microcrab.state-viewer");
  expect(state.targets).toEqual(["sidebar", "expanded-page", "setting-page"]);
  expect(state.setting.props.text).toContain("Session required");
  expect(state.zh.props.text).toContain("需要会话");
  expect(state.renderEffects).toEqual([]);
  const mcp = evidence.find((e) => e.key === "0.4.0:microcrab.mcp-bridge");
  expect(mcp.targets).toEqual(["sidebar", "setting-page"]);
  expect(mcp.setting.type).toBe("column");
  expect(mcp.expanded).toBeNull();
  expect(mcp.tab).toBeNull();
  expect(mcp.providesTools).toBe(true);
  expect(mcp.tool.tool_completion.status).toBe("pending");
  const fixture = evidence.find((e) => e.key === "0.4.0:microcrab.fixture");
  expect(fixture.setting.type).toBe("column");
  console.log(
    "Real ABI component evidence",
    evidence.map(({ key, path, targets, providesTools }) => ({
      key,
      path,
      targets,
      providesTools,
    })),
  );
});

for (const version of ["0.2.0", "0.3.0"]) {
  test(`installed ${version} bytes and choices survive rejection even when bundled supersedes matches`, async ({
    page,
  }) => {
    const oldPath = files.find((path) =>
      readFileSync(resolve(root, path.replace("/plugins/", ""))).includes(
        Buffer.from(`microcrab:client-plugin/view-types@${version}`),
      ),
    );
    expect(
      oldPath,
      `Retained real ${version} Component is required`,
    ).toBeTruthy();
    const id = oldPath!.split("/")[2]!;
    const hash = oldPath!.split("/")[3]!;
    const index = await maintainedPluginBundle(page);
    const replacement = index.plugins.find((plugin) => plugin.id === id)!;
    await page.route("**/plugins/current.json", (route) =>
      route.fulfill({
        json: { version: 1, plugins: [{ ...replacement, supersedes: [hash] }] },
      }),
    );
    await page.route("**/abi-fixture", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Retained ABI</title>",
      }),
    );
    await page.goto("/abi-fixture");
    const actual = await page.evaluate(
      async ({ id, oldPath }) => {
        const registryPath = "/src/plugins/registry.ts";
        const storePath = "/src/plugins/store.ts";
        const { PluginRegistry } = await import(registryPath);
        const { PluginStore } = await import(storePath);
        const ownerId = `retained-abi-${crypto.randomUUID()}`;
        const store = new PluginStore(
          JSON.stringify([location.origin, ownerId]),
        );
        const bytes = new Uint8Array(
          await (await fetch(oldPath)).arrayBuffer(),
        );
        const preferences = {
          sessions: { preserved: { [id]: false } },
          tombstones: [],
        };
        await store.put({
          manifest: {
            schema_version: 1,
            id,
            name: "Retained guest",
            version: "old",
            targets: ["sidebar"],
          },
          imports: [],
          bytes,
          enabledByDefault: true,
          priority: 7,
          status: "disabled",
        });
        await store.savePreferences(preferences);
        await store.writeKV(id, "retained", "owner-value");
        let effects = 0;
        const registry = new PluginRegistry({
          serverOrigin: location.origin,
          ownerId,
          effectHandler: async () => {
            effects++;
            return null;
          },
        });
        try {
          await registry.initialize();
          const installed = registry
            .getSnapshot()
            .find((plugin: any) => plugin.manifest.id === id);
          let error = "";
          try {
            await registry.render(id, "sidebar");
          } catch (cause) {
            error = String(cause);
          }
          const persisted = (await store.plugins()).find(
            (plugin: any) => plugin.manifest.id === id,
          );
          return {
            error:
              error ||
              registry
                .getSnapshot()
                .find((plugin: any) => plugin.manifest.id === id)?.error,
            unchanged:
              installed.bytes.length === bytes.length &&
              installed.bytes.every(
                (byte: number, i: number) => byte === bytes[i],
              ) &&
              persisted.bytes.length === bytes.length &&
              persisted.bytes.every(
                (byte: number, i: number) => byte === bytes[i],
              ),
            preferences: await store.preferences(),
            kv: await store.kv(id),
            enabledByDefault: persisted.enabledByDefault,
            priority: persisted.priority,
            effects,
          };
        } finally {
          registry.dispose();
          store.close();
        }
      },
      { id, oldPath: oldPath! },
    );
    expect(actual.error).toContain("client-plugin@0.4.0 only");
    expect(actual.unchanged).toBe(true);
    expect(actual.preferences).toEqual({
      sessions: { preserved: { [id]: false } },
      tombstones: [],
    });
    expect(actual.kv).toEqual({ retained: "owner-value" });
    expect(actual.enabledByDefault).toBe(true);
    expect(actual.priority).toBe(7);
    expect(actual.effects).toBe(0);
  });
}
