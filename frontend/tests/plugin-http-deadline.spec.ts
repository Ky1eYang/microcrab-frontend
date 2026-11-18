import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page) {
  await page.route("**/http-deadline-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><div id="root"></div>',
    }),
  );
  await page.goto("/http-deadline-fixture");
  // Install before constructing the registry or admitting any request.
  await page.clock.install();
  await page.evaluate(async () => {
    const registryPath = "/src/plugins/registry.ts",
      networkPath = "/src/plugins/network.ts",
      resourcesPath = "/src/plugins/resources.ts";
    const [{ PluginRegistry }, { PluginNetwork }, { PluginResources }] =
      await Promise.all([
        import(registryPath),
        import(networkPath),
        import(resourcesPath),
      ]);
    const registry: any = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: crypto.randomUUID(),
    });
    const id = "generic.http.fixture";
    const manifest = {
      id,
      name: "Generic HTTP",
      targets: [],
      network_origins: ["https://deadline.test"],
    };
    registry.plugins.set(id, {
      manifest,
      imports: [
        "microcrab:client-plugin/net@0.4.0",
        "microcrab:client-plugin/resources@0.4.0",
      ],
      priority: 0,
      status: "ready",
      enabledByDefault: true,
    });
    const resources = new PluginResources(
      location.origin,
      registry.options.ownerId,
      id,
      "a".repeat(64),
    );
    const worker: any = { terminate() {} };
    const live: any = {
      worker,
      generation: 1,
      ready: true,
      vars: {},
      trees: new Map(),
      surfaces: new Map(),
      controllers: new Map(),
      effectIds: new Set(),
      effectSequence: 0,
      resources,
      network: new PluginNetwork(manifest, () => {}, resources),
    };
    registry.live.set(id, live);
    const completions: any[] = [],
      signals: AbortSignal[] = [],
      requests: any[] = [];
    registry.completion = (...args: any[]) =>
      completions.push({
        requestId: args[2],
        ok: args[3],
        value: args[4],
        error: args[5],
      });
    const originalFetch = window.fetch;
    window.fetch = (async (url: any, options: any) => {
      if (!String(url).startsWith("https://deadline.test"))
        return originalFetch(url, options);
      requests.push({ url: String(url), method: options.method });
      signals.push(options.signal);
      return await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(new Response("completed after 20 seconds")),
          20_000,
        );
        options.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(options.signal.reason);
          },
          { once: true },
        );
      });
    }) as typeof fetch;
    let next = 0;
    (window as any).deadline = {
      registry,
      id,
      live,
      completions,
      signals,
      requests,
      start(resource = false, context = registry.context(1)) {
        const requestId = ++next;
        let payload: any = {
          url: "https://deadline.test/request",
          method: "GET",
        };
        if (resource) {
          const [grant] = resources.configure(
            {
              id: "configured",
              endpoint: "https://deadline.test/request",
              enabled: true,
            },
            true,
          );
          payload = {
            resource: "configured",
            config_pin: grant.config_pin,
            method: "POST",
            body: "request",
          };
        }
        void registry.effect(
          id,
          live,
          { kind: "http", request_id: requestId, payload },
          context,
        );
      },
      spoof() {
        const context = registry.context(1);
        registry.bind(worker, id);
        registry.pending.set(99, {
          worker,
          generation: 1,
          historyGeneration: 0,
          sessionId: null,
          context,
        });
        worker.onmessage({
          data: {
            type: "effect",
            callId: 99,
            generation: 1,
            context: { ...context, host_http_timeout_ms: 300000 },
            effect: {
              kind: "http",
              request_id: ++next,
              payload: {
                url: "https://deadline.test/request",
                timeout_ms: 300000,
              },
            },
          },
        });
      },
    };
  });
}

test.beforeEach(async ({ page }) => setup(page));

test("default HTTP fails at 10 seconds and reports the concrete duration", async ({
  page,
}) => {
  await page.evaluate(() => (window as any).deadline.start());
  await page.clock.runFor(9999);
  expect(
    await page.evaluate(() => (window as any).deadline.completions),
  ).toEqual([]);
  await page.clock.runFor(1);
  expect(
    await page.evaluate(() => (window as any).deadline.completions),
  ).toEqual([
    {
      requestId: 1,
      ok: false,
      value: undefined,
      error: "plugin host effect exceeded 10000ms deadline",
    },
  ]);
});

for (const resource of [false, true])
  test(`configured 120 seconds permits 20-second ${resource ? "resource POST" : "direct GET"} and freezes in-flight budget`, async ({
    page,
  }) => {
    await page.evaluate(async (resource) => {
      const f = (window as any).deadline;
      await f.registry.setHttpRequestTimeout(f.id, 120000);
      f.start(resource);
      await f.registry.setHttpRequestTimeout(f.id, 10000);
    }, resource);
    await page.clock.runFor(15000);
    expect(
      await page.evaluate(() => (window as any).deadline.completions),
    ).toEqual([]);
    await page.clock.runFor(5000);
    expect(
      await page.evaluate(() => (window as any).deadline.completions[0]),
    ).toMatchObject({
      ok: true,
      value: { status: 200, body: "completed after 20 seconds" },
    });
    await page.evaluate(
      (resource) => (window as any).deadline.start(resource),
      resource,
    );
    await page.clock.runFor(10000);
    expect(
      await page.evaluate(() => (window as any).deadline.completions[1]),
    ).toMatchObject({
      ok: false,
      error: "plugin host effect exceeded 10000ms deadline",
    });
  });

test("configured timeout reports 120000ms, without replay", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const f = (window as any).deadline;
    await f.registry.setHttpRequestTimeout(f.id, 120000);
    window.fetch = (() => new Promise(() => {})) as any;
    f.start();
  });
  await page.clock.runFor(119999);
  expect(
    await page.evaluate(() => (window as any).deadline.completions),
  ).toEqual([]);
  await page.clock.runFor(1);
  expect(
    await page.evaluate(() => (window as any).deadline.completions[0]),
  ).toMatchObject({
    ok: false,
    error: "plugin host effect exceeded 120000ms deadline",
  });
  await page.clock.runFor(180000);
  expect(
    await page.evaluate(() => (window as any).deadline.completions.length),
  ).toBe(1);
});

for (const retirement of ["history", "disable", "abort"])
  test(`${retirement} aborts the original request and suppresses stale completions/replay`, async ({
    page,
  }) => {
    await page.evaluate(async (retirement) => {
      const f = (window as any).deadline;
      await f.registry.setHttpRequestTimeout(f.id, 120000);
      f.start();
      if (retirement === "history") f.registry.observe("history-reset", {});
      else if (retirement === "disable") f.registry.stop(f.id);
      else
        for (const controller of f.live.controllers.keys()) controller.abort();
    }, retirement);
    await page.clock.runFor(130000);
    expect(
      await page.evaluate(() => {
        const f = (window as any).deadline;
        return {
          aborted: f.signals[0].aborted,
          completions: f.completions.length,
          calls: f.requests.length,
        };
      }),
    ).toEqual({ aborted: true, completions: 0, calls: 1 });
  });

test("Worker-returned context and guest timeout payload cannot extend the Host snapshot", async ({
  page,
}) => {
  await page.evaluate(() => (window as any).deadline.spoof());
  await page.clock.runFor(10000);
  expect(
    await page.evaluate(() => (window as any).deadline.completions[0]),
  ).toMatchObject({
    ok: false,
    error: "plugin host effect exceeded 10000ms deadline",
  });
});

test("preferences persist by origin/owner/plugin, survive KV reset, and reject malformed values", async ({
  page,
}) => {
  const actual = await page.evaluate(async () => {
    const storePath = "/src/plugins/store.ts",
      registryPath = "/src/plugins/registry.ts";
    const { PluginStore, normalizePreferences } = await import(storePath);
    const { PluginRegistry } = await import(registryPath);
    const f = (window as any).deadline;
    const owner = f.registry.options.ownerId;
    await f.registry.setHttpRequestTimeout(f.id, 120000);
    await f.registry.store.clearKV(f.id);
    const reloaded: any = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: owner,
    });
    reloaded.plugins.set(f.id, f.registry.plugins.get(f.id));
    reloaded.plugins.set("other", { manifest: { id: "other" } });
    reloaded.preferences = await reloaded.store.preferences();
    const otherOwner = new PluginStore(
      JSON.stringify([location.origin, owner + "other"]),
    );
    const otherOrigin = new PluginStore(
      JSON.stringify(["https://elsewhere.test", owner]),
    );
    let rejected = 0;
    for (const value of [
      null,
      "120000",
      9999,
      300001,
      10000.1,
      Infinity,
      NaN,
    ]) {
      try {
        await f.registry.setHttpRequestTimeout(f.id, value);
      } catch {
        rejected++;
      }
      try {
        normalizePreferences({
          sessions: {},
          tombstones: [],
          request_timeout_ms: { [f.id]: value },
        });
      } catch {
        rejected++;
      }
    }
    return {
      value: reloaded.getHttpRequestTimeout(f.id),
      other: reloaded.getHttpRequestTimeout("other"),
      rejected,
      owner: (await otherOwner.preferences()).request_timeout_ms,
      origin: (await otherOrigin.preferences()).request_timeout_ms,
      historical: normalizePreferences({ sessions: {}, tombstones: [] }),
    };
  });
  expect(actual).toEqual({
    value: 120000,
    other: 10000,
    rejected: 14,
    owner: undefined,
    origin: undefined,
    historical: { sessions: {}, tombstones: [] },
  });
});

test("concurrent timeout and enablement saves preserve both plugins and teardown rejects publication", async ({ page }) => {
  const actual = await page.evaluate(async () => {
    const f = (window as any).deadline, registry = f.registry;
    registry.plugins.set("other", { manifest: { id: "other" }, priority: 1 });
    const save = registry.store.savePreferences.bind(registry.store);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let writes = 0;
    registry.store.savePreferences = async (draft: any) => {
      if (++writes === 1) { entered(); await gate; }
      await save(draft);
    };
    const first = registry.setHttpRequestTimeout(f.id, 120000);
    await started;
    const enablement = registry.setEnabled("other", "future-session", true);
    const otherTimeout = registry.setHttpRequestTimeout("other", 300000);
    release();
    await Promise.all([first, enablement, otherTimeout]);
    const prefs = await registry.store.preferences();
    let releaseFinal!: () => void;
    registry.store.savePreferences = async () => await new Promise<void>(resolve => { releaseFinal = resolve; });
    const final = registry.setHttpRequestTimeout(f.id, 300000);
    await Promise.resolve();
    registry.disposed = true;
    releaseFinal();
    let rejected = false;
    try { await final; } catch { rejected = true; }
    return { prefs, rejected, retained: registry.getHttpRequestTimeout(f.id) };
  });
  expect(actual).toEqual({
    prefs: { sessions: { "future-session": { other: true } }, tombstones: [], request_timeout_ms: { "generic.http.fixture": 120000, other: 300000 } },
    rejected: true, retained: 120000,
  });
});

test("non-HTTP effects keep their 10-second budget", async ({ page }) => {
  await page.evaluate(async () => {
    const f = (window as any).deadline;
    await f.registry.setHttpRequestTimeout(f.id, 120000);
    f.live.network.execute = () => new Promise(() => {});
    void f.registry.effect(f.id, f.live, { kind: "ws-open", request_id: 1, payload: { url: "wss://deadline.test" } }, f.registry.context(1));
  });
  await page.clock.runFor(10000);
  expect(await page.evaluate(() => (window as any).deadline.completions[0])).toMatchObject({ ok: false, error: "plugin host effect exceeded 10000ms deadline" });
});

test("native timeout settings validate, explicitly save, and guard unsaved navigation", async ({ page }) => {
  await page.evaluate(async () => {
    const refreshPath = "/@react-refresh";
    const refresh = await import(refreshPath);
    refresh.default.injectIntoGlobalHook(window);
    (window as any).$RefreshReg$ = () => {};
    (window as any).$RefreshSig$ = () => (type: unknown) => type;
    (window as any).__vite_plugin_react_preamble_installed__ = true;
    const reactPath = "/node_modules/.vite/deps/react.js", domPath = "/node_modules/.vite/deps/react-dom_client.js", uiPath = "/src/plugins/PluginHttpSettings.tsx";
    const [{ default: React }, { default: { createRoot } }, { PluginHttpSettings }] = await Promise.all([import(reactPath), import(domPath), import(uiPath)]);
    const f = (window as any).deadline;
    function Fixture() {
      React.useSyncExternalStore(f.registry.subscribe, f.registry.getSnapshot);
      return React.createElement(PluginHttpSettings, { registry: f.registry, pluginId: f.id, disabled: false });
    }
    createRoot(document.getElementById("root")!).render(React.createElement(Fixture));
  });
  const input = page.getByRole("spinbutton");
  const save = page.getByRole("button", { name: /Save timeout|保存超时设置/ });
  await expect(input).toHaveValue("10");
  await input.fill("301");
  await expect(save).toBeDisabled();
  await input.fill("120");
  expect(await page.evaluate(() => (window as any).deadline.registry.getHttpRequestTimeout((window as any).deadline.id))).toBe(10000);
  await page.evaluate(async () => {
    const path = "/src/client/document-leave.ts";
    const { requestDocumentLeave } = await import(path);
    requestDocumentLeave(() => { (window as any).didLeave = true; });
  });
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: /Keep editing|继续编辑/ }).click();
  await save.click();
  await expect(page.getByRole("status")).toBeVisible();
  expect(await page.evaluate(() => (window as any).deadline.registry.getHttpRequestTimeout((window as any).deadline.id))).toBe(120000);
  await input.fill("300");
  await page.evaluate(async () => {
    const path = "/src/client/document-leave.ts";
    const { requestDocumentLeave } = await import(path);
    requestDocumentLeave(() => { (window as any).didLeave = true; });
  });
  await page.getByRole("button", { name: /Discard changes|放弃修改/ }).click();
  expect(await page.evaluate(() => (window as any).didLeave)).toBe(true);
  await expect(input).toHaveValue("120");
});

test("JSON result effects retain the invocation budget when settings change while Worker is pending", async ({ page }) => {
  await page.evaluate(async () => {
    const f = (window as any).deadline;
    await f.registry.setHttpRequestTimeout(f.id, 120000);
    let reply!: (value: any) => void;
    f.registry.send = async () => await new Promise(resolve => { reply = resolve; });
    const pending = f.registry.invoke(f.id, f.live, "init", ["{}"], 5000);
    await f.registry.setHttpRequestTimeout(f.id, 10000);
    reply({ type: "result", result: { schema_version: 1, effects: [{ kind: "http", request_id: 1, payload: { url: "https://deadline.test/request" } }] } });
    const result = await pending;
    f.registry.apply(f.id, f.live, result);
  });
  await page.clock.runFor(15000);
  expect(await page.evaluate(() => (window as any).deadline.completions)).toEqual([]);
  await page.clock.runFor(5000);
  expect(await page.evaluate(() => (window as any).deadline.completions[0])).toMatchObject({ ok: true, value: { body: "completed after 20 seconds" } });
});
