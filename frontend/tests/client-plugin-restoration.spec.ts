import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";

test.setTimeout(90_000);

// All inspected bytes come from the maintained index; Workers execute the real
// Components. Transport gates below retain genuine replies without fabricating them.
test.beforeEach(async ({ page }) => {
  await nativeBackend(page);
  await page.goto("/");
});

test("explicit restoration survives reload, preserves installed preferences and isolates owners", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const registryPath = "/src/plugins/registry.ts";
    const storePath = "/src/plugins/store.ts";
    const { PluginRegistry } = await import(registryPath);
    const { PluginStore } = await import(storePath);
    const ownerId = `restoration-${crypto.randomUUID()}`;
    const options = { serverOrigin: location.origin, ownerId };
    const store = new PluginStore(JSON.stringify([location.origin, ownerId]));
    let registry = new PluginRegistry(options);
    const other = new PluginRegistry({
      ...options,
      ownerId: `${ownerId}-other`,
    });
    const viewer = "microcrab.state-viewer",
      fixture = "microcrab.fixture";
    try {
      await registry.initialize();
      if (!registry.getSnapshot().some((p: any) => p.manifest.id === fixture))
        throw new Error(
          "parent must build/install the real generic fixture in current.json",
        );
      await registry.setSession("other-session");
      await registry.setEnabled(fixture, "other-session", true);
      await registry.setSession("invoking-session");
      await registry.setEnabled(fixture, "invoking-session", false);
      const original = registry
        .getSnapshot()
        .find((p: any) => p.manifest.id === fixture);
      const customBytes = new Uint8Array(original.bytes.length + 4);
      customBytes.set(original.bytes);
      // A valid Component custom section changes the hash without changing the guest.
      customBytes.set([0, 2, 1, 120], original.bytes.length);
      await registry.importPlugin(customBytes, {
        replace: true,
        expectedId: fixture,
      });
      await registry.setPriority(fixture, -17);
      await store.writeKV(fixture, "preserved", "custom-installed-data");
      const installed = registry
        .getSnapshot()
        .find((p: any) => p.manifest.id === fixture);
      await other.initialize();
      await other.remove(viewer);
      await registry.remove(viewer);
      registry.dispose();
      registry = new PluginRegistry(options);
      await registry.initialize();
      await registry.setSession("invoking-session");
      const skipped = !registry
        .getSnapshot()
        .some((p: any) => p.manifest.id === viewer);
      const count = await registry.restoreBundled();
      const restored = registry
        .getSnapshot()
        .find((p: any) => p.manifest.id === viewer);
      const untouched = registry
        .getSnapshot()
        .find((p: any) => p.manifest.id === fixture);
      const after = await store.preferences();
      const zero = await registry.restoreBundled();
      return {
        skipped,
        count,
        zero,
        enabled: registry.isEnabled(viewer),
        status: restored.status,
        otherViewer: registry.isEnabled(viewer, "other-session"),
        otherFixture: registry.isEnabled(fixture, "other-session"),
        fixtureEnabled: registry.isEnabled(fixture),
        fixtureDefault: untouched.enabledByDefault,
        fixtureUnchanged:
          untouched.priority === installed.priority &&
          untouched.bytes.every(
            (byte: number, i: number) => byte === installed.bytes[i],
          ),
        kv: await store.kv(fixture),
        tombstoned: after.tombstones.includes(viewer),
        otherOwnerMissing: !other
          .getSnapshot()
          .some((p: any) => p.manifest.id === viewer),
      };
    } finally {
      registry.dispose();
      other.dispose();
      store.close();
    }
  });
  expect(result).toEqual({
    skipped: true,
    count: 1,
    zero: 0,
    enabled: true,
    status: "ready",
    otherViewer: false,
    otherFixture: true,
    fixtureEnabled: false,
    fixtureDefault: false,
    fixtureUnchanged: true,
    kv: { preserved: "custom-installed-data" },
    tombstoned: false,
    otherOwnerMissing: true,
  });
});

test("restoring all missing bundles leaves the default-disabled real fixture disabled", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `all-missing-${crypto.randomUUID()}`,
    });
    try {
      await registry.initialize();
      await registry.setSession("restore-all");
      const ids = registry.getSnapshot().map((p: any) => p.manifest.id);
      if (!ids.includes("microcrab.fixture"))
        throw new Error("real generic fixture missing from current.json");
      for (const id of ids) await registry.remove(id);
      const count = await registry.restoreBundled();
      return {
        count,
        expected: ids.length,
        fixture: registry.view("microcrab.fixture", "sidebar").status,
        enabled: registry.isEnabled("microcrab.fixture"),
        viewer: registry.view("microcrab.state-viewer", "sidebar").status,
      };
    } finally {
      registry.dispose();
    }
  });
  expect(result.count).toBe(result.expected);
  expect(result.fixture).toBe("disabled");
  expect(result.enabled).toBe(false);
  expect(result.viewer).toBe("ready");
});

for (const failure of ["download", "hash", "manifest"] as const) {
  test(`failed ${failure} restoration retains the tombstone across registry reload`, async ({
    page,
  }) => {
    const result = await page.evaluate(async (failure) => {
      const registryPath = "/src/plugins/registry.ts";
      const storePath = "/src/plugins/store.ts";
      const { PluginRegistry } = await import(registryPath);
      const { PluginStore } = await import(storePath);
      const options = {
        serverOrigin: location.origin,
        ownerId: `failure-${crypto.randomUUID()}`,
      };
      const store = new PluginStore(
        JSON.stringify([location.origin, options.ownerId]),
      );
      let registry = new PluginRegistry(options);
      const originalFetch = window.fetch;
      const viewer = "microcrab.state-viewer";
      try {
        await registry.initialize();
        await registry.remove(viewer);
        const index = await (
          await originalFetch("/plugins/current.json")
        ).json();
        const item = index.plugins.find((p: any) => p.id === viewer);
        if (failure === "manifest") {
          const fixture = index.plugins.find(
            (p: any) => p.id === "microcrab.fixture",
          );
          if (!fixture)
            throw new Error("real generic fixture missing from current.json");
          // The payload hash is valid, but its genuine manifest declares another ID.
          item.sha256 = fixture.sha256;
          item.file = `${viewer}/${fixture.sha256}/plugin.wasm`;
          window.fetch = async (input, init) => {
            if (String(input) === "/plugins/current.json")
              return Response.json(index);
            if (String(input) === `/plugins/${item.file}`)
              return originalFetch(`/plugins/${fixture.file}`, init);
            return originalFetch(input, init);
          };
        } else {
          window.fetch = async (input, init) => {
            if (String(input) === "/plugins/current.json")
              return Response.json(index);
            if (String(input) === `/plugins/${item.file}`)
              return failure === "download"
                ? new Response("unavailable", { status: 503 })
                : new Response(new Uint8Array([0, 97, 115, 109, 13, 0, 1, 0]));
            return originalFetch(input, init);
          };
        }
        let error = "";
        try {
          await registry.restoreBundled();
        } catch (cause) {
          error = String(cause);
        }
        window.fetch = originalFetch;
        const tombstone = (await store.preferences()).tombstones.includes(
          viewer,
        );
        registry.dispose();
        registry = new PluginRegistry(options);
        await registry.initialize();
        return {
          error,
          tombstone,
          missing: !registry
            .getSnapshot()
            .some((p: any) => p.manifest.id === viewer),
        };
      } finally {
        window.fetch = originalFetch;
        registry.dispose();
        store.close();
      }
    }, failure);
    expect(result.tombstone).toBe(true);
    expect(result.missing).toBe(true);
    expect(result.error).toContain(
      failure === "download"
        ? "503"
        : failure === "hash"
          ? "SHA-256 mismatch"
          : "manifest declares microcrab.fixture",
    );
  });
}

test("the entire fresh index is validated before any restoration mutation", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `index-validation-${crypto.randomUUID()}`,
    });
    const originalFetch = window.fetch;
    try {
      await registry.initialize();
      await registry.remove("microcrab.state-viewer");
      const source = await (
        await originalFetch("/plugins/current.json")
      ).json();
      const errors: string[] = [];
      let downloads = 0;
      for (const mode of ["duplicate", "boolean", "http"]) {
        const index = structuredClone(source);
        if (mode === "duplicate") index.plugins.push(index.plugins[0]);
        if (mode === "boolean")
          index.plugins.push({
            ...index.plugins[0],
            id: "invalid-bool",
            file: `invalid-bool/${index.plugins[0].sha256}/plugin.wasm`,
            default_enabled: "true",
          });
        window.fetch = async (input, init) => {
          if (String(input) === "/plugins/current.json")
            return mode === "http"
              ? new Response("unavailable", { status: 502 })
              : Response.json(index);
          if (String(input).startsWith("/plugins/")) downloads++;
          return originalFetch(input, init);
        };
        try {
          await registry.restoreBundled();
        } catch (cause) {
          errors.push(String(cause));
        }
      }
      return {
        errors,
        downloads,
        missing: !registry
          .getSnapshot()
          .some((p: any) => p.manifest.id === "microcrab.state-viewer"),
      };
    } finally {
      window.fetch = originalFetch;
      registry.dispose();
    }
  });
  expect(result.downloads).toBe(0);
  expect(result.missing).toBe(true);
  expect(result.errors[0]).toContain("duplicate bundled plugin id");
  expect(result.errors[1]).toContain("default_enabled");
  expect(result.errors[2]).toContain("index fetch failed: 502");
});

test("restart preserves KV and preferences while disabled and missing calls stay outside the fault loop", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const registryPath = "/src/plugins/registry.ts";
    const storePath = "/src/plugins/store.ts";
    const { PluginRegistry } = await import(registryPath);
    const { PluginStore } = await import(storePath);
    const options = {
      serverOrigin: location.origin,
      ownerId: `restart-${crypto.randomUUID()}`,
    };
    const registry = new PluginRegistry(options);
    const store = new PluginStore(
      JSON.stringify([location.origin, options.ownerId]),
    );
    const id = "microcrab.fixture";
    try {
      await registry.initialize();
      await registry.setSession("restart-session");
      await registry.setEnabled(id, "restart-session", true);
      await registry.setPriority(id, -23);
      await store.writeKV(id, "persisted", "survives-restart");
      await registry.action(id, "increment");
      const prefs = JSON.stringify(await store.preferences());
      await registry.restart(id);
      const ready = registry.view(id, "sidebar").status;
      const preserved = prefs === JSON.stringify(await store.preferences());
      const kv = await store.kv(id);
      const installed = registry
        .getSnapshot()
        .find((p: any) => p.manifest.id === id);
      await registry.setEnabled(id, "restart-session", false);
      let disabledError = "",
        missingError = "",
        missingRender = "";
      try {
        await registry.restart(id);
      } catch (cause) {
        disabledError = String(cause);
      }
      const disabledView = await registry.render(id, "sidebar");
      await registry.remove(id);
      try {
        await registry.restart(id);
      } catch (cause) {
        missingError = String(cause);
      }
      try {
        await registry.render(id, "sidebar");
      } catch (cause) {
        missingRender = String(cause);
      }
      return {
        ready,
        preserved,
        kv,
        priority: installed.priority,
        defaultEnabled: installed.enabledByDefault,
        disabledError,
        disabled: disabledView.status,
        missingError,
        missingRender,
        absent: !registry.getSnapshot().some((p: any) => p.manifest.id === id),
      };
    } finally {
      registry.dispose();
      store.close();
    }
  });
  expect(result.ready).toBe("ready");
  expect(result.preserved).toBe(true);
  expect(result.kv).toEqual({ persisted: "survives-restart" });
  expect(result.priority).toBe(-23);
  expect(result.defaultEnabled).toBe(false);
  expect(result.disabledError).toContain("disabled in the current Session");
  expect(result.disabled).toBe("disabled");
  expect(result.missingError).toContain("plugin is not installed");
  expect(result.missingRender).toContain("plugin is not installed");
  expect(result.absent).toBe(true);
});

test("restart awaits a held genuine init reply and cannot restart a replacement Session", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    let holding = false;
    let notify: (() => void) | undefined;
    const held: { worker: Worker; data: any }[] = [];
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `slow-restart-${crypto.randomUUID()}`,
      workerFactory: () => {
        const worker = new Worker(
          new URL("/src/plugins/worker.ts", location.origin),
          { type: "module" },
        );
        const initCalls = new Set<number>();
        const post = worker.postMessage.bind(worker);
        worker.postMessage = ((data: any) => {
          if (data.type === "call" && data.method === "init")
            initCalls.add(data.callId);
          post(data);
        }) as typeof worker.postMessage;
        worker.addEventListener("message", (event) => {
          if (
            !holding ||
            event.data.type !== "result" ||
            !initCalls.has(event.data.callId)
          )
            return;
          event.stopImmediatePropagation();
          held.push({ worker, data: event.data });
          notify?.();
        });
        return worker;
      },
    });
    const release = () => {
      holding = false;
      for (const { worker, data } of held.splice(0))
        worker.dispatchEvent(new MessageEvent("message", { data }));
    };
    try {
      await registry.initialize();
      await registry.setSession("first");
      await registry.setEnabled("microcrab.fixture", "first", true);
      holding = true;
      const captured = new Promise<void>((resolve) => {
        notify = resolve;
      });
      let settled = false;
      const restarted = registry.restart("microcrab.fixture").finally(() => {
        settled = true;
      });
      await captured;
      const pending = !settled;
      const loading = registry.view("microcrab.fixture", "sidebar").status;
      release();
      await restarted;
      const ready = registry.view("microcrab.fixture", "sidebar").status;
      holding = true;
      const secondCaptured = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const switched = registry.restart("microcrab.fixture").then(
        () => "",
        (error: unknown) => String(error),
      );
      await secondCaptured;
      holding = false;
      await registry.setSession("replacement-disabled");
      release();
      const switchedError = await switched;
      return {
        pending,
        loading,
        ready,
        switchedError,
        replacementEnabled: registry.isEnabled("microcrab.fixture"),
        replacementStatus: registry.view("microcrab.fixture", "sidebar").status,
      };
    } finally {
      release();
      registry.dispose();
    }
  });
  expect(result.pending).toBe(true);
  expect(result.loading).toBe("loading");
  expect(result.ready).toBe("ready");
  expect(result.switchedError).toContain("plugin instance ended");
  expect(result.replacementEnabled).toBe(false);
  expect(result.replacementStatus).toBe("disabled");
});

test("restoration captures its Session and disposal cancels a held real inspection before commit", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const registryPath = "/src/plugins/registry.ts";
    const storePath = "/src/plugins/store.ts";
    const { PluginRegistry } = await import(registryPath);
    const { PluginStore } = await import(storePath);
    const viewer = "microcrab.state-viewer";
    let holding = false;
    let notify: (() => void) | undefined;
    const held: { worker: Worker; data: any }[] = [];
    const options = {
      serverOrigin: location.origin,
      ownerId: `restore-fence-${crypto.randomUUID()}`,
      workerFactory: () => {
        const worker = new Worker(
          new URL("/src/plugins/worker.ts", location.origin),
          { type: "module" },
        );
        worker.addEventListener("message", (event) => {
          if (!holding || event.data.type !== "loaded") return;
          event.stopImmediatePropagation();
          held.push({ worker, data: event.data });
          notify?.();
        });
        return worker;
      },
    };
    const registry = new PluginRegistry(options);
    const store = new PluginStore(
      JSON.stringify([location.origin, options.ownerId]),
    );
    const release = () => {
      holding = false;
      for (const { worker, data } of held.splice(0))
        worker.dispatchEvent(new MessageEvent("message", { data }));
    };
    try {
      await registry.initialize();
      await registry.setSession("invoking");
      await registry.remove(viewer);
      holding = true;
      const captured = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const restore = registry.restoreBundled();
      await captured;
      await registry.setSession("replacement");
      release();
      const count = await restore;
      const capturedEnabled = registry.isEnabled(viewer, "invoking");
      const replacementEnabled = registry.isEnabled(viewer);
      const replacementStatus = registry.view(viewer, "sidebar").status;
      await registry.remove(viewer);
      holding = true;
      const disposedCaptured = new Promise<void>((resolve) => {
        notify = resolve;
      });
      const disposedRestore = registry.restoreBundled().then(
        () => "",
        (cause: unknown) => String(cause),
      );
      await disposedCaptured;
      registry.dispose();
      release();
      const disposedError = await disposedRestore;
      return {
        count,
        capturedEnabled,
        replacementEnabled,
        replacementStatus,
        disposedError,
        tombstoned: (await store.preferences()).tombstones.includes(viewer),
        persisted: (await store.plugins()).some(
          (p: any) => p.manifest.id === viewer,
        ),
      };
    } finally {
      release();
      registry.dispose();
      store.close();
    }
  });
  expect(result.count).toBe(1);
  expect(result.capturedEnabled).toBe(true);
  expect(result.replacementEnabled).toBe(false);
  expect(result.replacementStatus).toBe("disabled");
  expect(result.disposedError).toContain("plugin registry disposed");
  expect(result.tombstoned).toBe(true);
  expect(result.persisted).toBe(false);
});
