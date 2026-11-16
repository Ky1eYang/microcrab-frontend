import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { nativeBackend } from "./native-fixture";

test.setTimeout(90_000);

// Reuse the existing parent-built Rust artifact. This suite never builds Rust or
// substitutes a fabricated Component, guest manifest, or Worker response.
const corePath = new URL(
  "../../../target/root-build/frontend/wasm32-unknown-unknown/release/microcrab_client_plugin_state_viewer.wasm",
  import.meta.url,
);

function withImportModule(bytes: Uint8Array, module: string): Uint8Array {
  let pos = 8;
  const uint = () => {
    let value = 0,
      shift = 0,
      byte: number;
    do {
      if (pos >= bytes.length || shift > 28)
        throw new Error("invalid fixture section LEB");
      byte = bytes[pos++]!;
      value += (byte & 127) * 2 ** shift;
      shift += 7;
    } while (byte & 128);
    return value;
  };
  const leb = (value: number): number[] => {
    const output: number[] = [];
    do {
      const byte = value & 127;
      value = Math.floor(value / 128);
      output.push(byte | (value ? 128 : 0));
    } while (value);
    return output;
  };
  while (pos < bytes.length) {
    const start = pos;
    const section = bytes[pos++]!;
    const size = uint();
    const end = pos + size;
    if (section !== 2) {
      pos = end;
      continue;
    }
    const count = uint();
    const payload: number[] = [...leb(count)];
    const replacement = new TextEncoder().encode(module);
    for (let i = 0; i < count; i++) {
      const moduleLength = uint();
      pos += moduleLength;
      const fieldStart = pos;
      const fieldLength = uint();
      pos += fieldLength;
      const kind = bytes[pos++]!;
      if (kind !== 0)
        throw new Error("expected real fixture imports to be functions");
      uint();
      payload.push(
        ...leb(replacement.length),
        ...replacement,
        ...bytes.subarray(fieldStart, pos),
      );
    }
    if (pos !== end) throw new Error("fixture import section length differs");
    const rebuilt = Uint8Array.from([2, ...leb(payload.length), ...payload]);
    const output = new Uint8Array(start + rebuilt.length + bytes.length - end);
    output.set(bytes.subarray(0, start));
    output.set(rebuilt, start);
    output.set(bytes.subarray(end), start + rebuilt.length);
    return output;
  }
  throw new Error("real fixture is missing its capability imports");
}

test("real Rust core import persists normalized Component and reloads without wrapping again", async ({
  page,
}) => {
  const core = await readFile(corePath);
  expect([...core.subarray(0, 8)]).toEqual([0, 97, 115, 109, 1, 0, 0, 0]);
  await nativeBackend(page);
  await page.route("**/plugins/current.json", (route) =>
    route.fulfill({ json: { version: 1, plugins: [] } }),
  );
  await page.route("**/test-plugin-core.wasm", (route) =>
    route.fulfill({ body: core, contentType: "application/wasm" }),
  );
  await page.goto("/");
  const owner = `core-import-${crypto.randomUUID()}`;
  const installed = await page.evaluate(async (ownerId) => {
    const registryPath = "/src/plugins/registry.ts";
    const storePath = "/src/plugins/store.ts";
    const { PluginRegistry } = await import(registryPath);
    const { PluginStore } = await import(storePath);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId,
    });
    const store = new PluginStore(JSON.stringify([location.origin, ownerId]));
    try {
      await registry.initialize();
      const bytes = new Uint8Array(
        await (await fetch("/test-plugin-core.wasm")).arrayBuffer(),
      );
      const plugin = await registry.importPlugin(bytes);
      const persisted = (await store.plugins()).find(
        (p: { manifest: { id: string } }) =>
          p.manifest.id === plugin.manifest.id,
      );
      await registry.setDefaultEnabled(plugin.manifest.id, true);
      const rendered = await registry.render(plugin.manifest.id, "sidebar");
      return {
        id: plugin.manifest.id,
        sourceKind: plugin.importFormat,
        imports: plugin.imports,
        header: Array.from(persisted.bytes.subarray(0, 8)),
        persistedMatches:
          persisted.bytes.length === plugin.bytes.length &&
          persisted.bytes.every(
            (b: number, i: number) => b === plugin.bytes[i],
          ),
        rendered: rendered.tree !== null,
      };
    } finally {
      registry.dispose();
      store.close();
    }
  }, owner);
  expect(installed.sourceKind).toBe("core");
  expect(installed.header).toEqual([0, 97, 115, 109, 13, 0, 1, 0]);
  expect(installed.imports).toEqual([
    "microcrab:client-plugin/session-state@0.4.0",
    "microcrab:client-plugin/session-state-write@0.4.0",
    "microcrab:client-plugin/view-types@0.4.0",
  ]);
  expect(installed.persistedMatches).toBe(true);
  expect(installed.rendered).toBe(true);

  await page.reload();
  const reloaded = await page.evaluate(
    async ({ ownerId, id }) => {
      const path = "/src/plugins/registry.ts";
      const { PluginRegistry } = await import(path);
      const loads: { sourceKind: string; normalized: boolean }[] = [];
      const registry = new PluginRegistry({
        serverOrigin: location.origin,
        ownerId,
        workerFactory: () => {
          const worker = new Worker(
            new URL("/src/plugins/worker.ts", location.origin),
            { type: "module" },
          );
          worker.addEventListener("message", ({ data }) => {
            if (data.type === "loaded")
              loads.push({
                sourceKind: data.sourceKind,
                normalized: data.normalizedBytes !== undefined,
              });
          });
          return worker;
        },
      });
      try {
        await registry.initialize();
        // Disabling also cancels any startup queued by initialize; re-enabling
        // waits for a fresh genuine Worker using only persisted Component bytes.
        await registry.setDefaultEnabled(id, false);
        await registry.setDefaultEnabled(id, true);
        const view = await registry.render(id, "sidebar");
        return {
          loads,
          rendered: view.tree !== null,
          sourceKind: registry
            .getSnapshot()
            .find((p: { manifest: { id: string } }) => p.manifest.id === id)
            ?.importFormat,
        };
      } finally {
        registry.dispose();
      }
    },
    { ownerId: owner, id: installed.id },
  );
  expect(reloaded.rendered).toBe(true);
  expect(reloaded.sourceKind).toBe("core");
  expect(reloaded.loads.length).toBeGreaterThan(0);
  expect(
    reloaded.loads.every(
      (load) => load.sourceKind === "component" && !load.normalized,
    ),
  ).toBe(true);
});

test("core framing and missing metadata fail clearly before loading the wrapper compiler", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const failures = await page.evaluate(async () => {
    const path = "/src/plugins/component.ts";
    const { inspectComponent } = await import(path);
    const header = [0, 97, 115, 109, 1, 0, 0, 0];
    const cases = [
      header,
      [0, 97, 115, 109, 2, 0, 0, 0],
      [...header, 0, 4, 1, 120],
      [...header, 0, 0x80, 0x80, 0x80, 0x80, 0x10],
    ];
    const failures: { code: string; message: string }[] = [];
    for (const bytes of cases) {
      try {
        await inspectComponent(new Uint8Array(bytes));
        throw new Error("invalid core unexpectedly accepted");
      } catch (error) {
        const failure = error as Error & { code: string };
        failures.push({ code: failure.code, message: failure.message });
      }
    }
    return failures;
  });
  expect(failures.map((failure) => failure.code)).toEqual([
    "missing-component-type",
    "unsupported-wasm-version",
    "invalid-core-module",
    "invalid-core-module",
  ]);
  expect(failures[0]!.message).toContain("component-type metadata");
  expect(failures[2]!.message).toContain("truncated");
  expect(failures[3]!.message).toContain("u32");
});

for (const module of ["unsupported-native-host", "wasi_snapshot_preview1"]) {
  test(`real core with unsupported ${module} imports preserves the concrete compiler diagnostic`, async ({
    page,
  }) => {
    const bytes = withImportModule(await readFile(corePath), module);
    await nativeBackend(page);
    await page.route("**/plugins/current.json", (route) =>
      route.fulfill({ json: { version: 1, plugins: [] } }),
    );
    await page.route("**/test-plugin-core.wasm", (route) =>
      route.fulfill({
        body: Buffer.from(bytes),
        contentType: "application/wasm",
      }),
    );
    await page.goto("/");
    const failure = await page.evaluate(async () => {
      const path = "/src/plugins/registry.ts";
      const { PluginRegistry } = await import(path);
      const registry = new PluginRegistry({
        serverOrigin: location.origin,
        ownerId: `unsupported-core-${crypto.randomUUID()}`,
      });
      try {
        await registry.initialize();
        const bytes = new Uint8Array(
          await (await fetch("/test-plugin-core.wasm")).arrayBuffer(),
        );
        await registry.importPlugin(bytes);
        return { code: "accepted", message: "" };
      } catch (error) {
        const failure = error as Error & { code: string };
        return { code: failure.code, message: failure.message };
      } finally {
        registry.dispose();
      }
    });
    expect(failure.code).toBe("core-componentization-failed");
    expect(failure.message).toContain(module);
    expect(failure.message).toContain("no automatic WASI adapters");
  });
}
