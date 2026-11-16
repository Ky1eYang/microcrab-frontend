import { expect, test } from "@playwright/test";
import { nativeBackend } from "./native-fixture";
import { maintainedPluginBundle } from "./plugin-bundle-fixture";

test.setTimeout(90_000);

test("a deferred imported completion is not replayed into a newer surface mount", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts",
      { PluginRegistry } = await import(path);
    const delivered: number[] = [];
    let release: ((value: unknown) => void) | undefined,
      notify: (() => void) | undefined,
      firstRequest: number | undefined;
    const admitted = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const snapshot = {
      values: { fresh: "current" },
      metadata: {},
      descriptors: {
        fresh: {
          kind: "framework",
          editable: false,
          owner_editable: false,
          deletable: false,
          reason: "framework fact",
        },
      },
      witness: { runtime_instance_id: "deferred", variables_revision: "0" },
    };
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `completion-${crypto.randomUUID()}`,
      workerFactory: () => {
        const worker = new Worker(
            new URL("/src/plugins/worker.ts", location.origin),
            { type: "module" },
          ),
          post = worker.postMessage.bind(worker);
        let loadedId: string | undefined;
        worker.addEventListener("message", ({ data }) => {
          if (data.type === "loaded") loadedId = data.manifest.id;
        });
        worker.postMessage = ((data: any) => {
          if (
            loadedId === "microcrab.state-viewer" &&
            data.type === "call" &&
            data.method === "onPhase" &&
            data.args[0] === "event-result"
          )
            delivered.push(JSON.parse(data.args[1]).request_id);
          post(data);
        }) as typeof worker.postMessage;
        return worker;
      },
      effectHandler: async (effect: any) => {
        if (effect.kind !== "state-inspection")
          throw new Error(`unexpected effect ${effect.kind}`);
        if (firstRequest === undefined) {
          firstRequest = effect.requestId;
          notify?.();
          return new Promise((resolve) => {
            release = resolve;
          });
        }
        return snapshot;
      },
    });
    const id = "microcrab.state-viewer",
      surface = { surface_id: "deferred", target: "sidebar" as const };
    try {
      // Session-wide reads have their own valid lifetime. This case must hold a
      // mount-owned read so retiring that mount is the event under test.
      registry.setEnvironment({ target_visible: false });
      await registry.initialize();
      await registry.setSession("deferred");
      await registry.render(id, surface.target, false, surface);
      await admitted;
      registry.setSurfaceVisible(id, surface, false);
      registry.setSurfaceVisible(id, surface, true);
      release?.(snapshot);
      await registry.render(id, surface.target, true, surface);
      await registry.action(id, "search", { value: "" }, surface);
      await new Promise<void>((resolve, reject) => {
        let unsubscribe = () => {};
        const timer = setTimeout(() => {
          unsubscribe();
          reject(
            new Error(
              "remounted inspection stayed orphaned instead of reloading",
            ),
          );
        }, 10000);
        const inspect = () => {
          const view = registry.view(id, surface.target, surface);
          if (view.status === "faulted") {
            clearTimeout(timer);
            unsubscribe();
            reject(new Error(view.error));
          } else if (view.vars.values?.fresh === "current") {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        };
        unsubscribe = registry.subscribe(inspect);
        inspect();
      });
      return {
        delivered,
        firstRequest,
        values: registry.view(id, surface.target, surface).vars.values,
        generation: registry.view(id, surface.target, surface).surface
          ?.surface_id,
        status: registry.view(id, surface.target, surface).status,
      };
    } finally {
      release?.(snapshot);
      registry.dispose();
    }
  });
  expect(actual.delivered).not.toContain(actual.firstRequest);
  expect(actual.delivered.length).toBeGreaterThan(0);
  expect(actual.values).toEqual({ fresh: "current" });
  expect(actual.generation).toBe("deferred");
  expect(actual.status).toBe("ready");
});

test("canonical equality-bounded type imports never become host capability grants", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/component.ts";
    const { binaryImports, authorizeKind } = await import(path);
    // Small framing units mirror the parent-built Component import sections.
    // They exercise the scanner only; inspectComponent still delegates the
    // entire graph and type-index identity validation to the real jco compiler.
    const section = (name: string, ref: number[]) => {
      const text = new TextEncoder().encode(name),
        payload = [1, 0, text.length, ...text, ...ref];
      return [10, payload.length, ...payload];
    };
    const header = [0, 97, 115, 109, 13, 0, 1, 0];
    const typeInterface = section(
      "microcrab:client-plugin/view-types@0.4.0",
      [5, 2],
    );
    const types = [
      section("plugin-manifest", [3, 0, 3]),
      section("view-target", [3, 0, 5]),
      section("view-output", [3, 0, 7]),
    ].flat();
    const imports = binaryImports(
      Uint8Array.from([...header, ...typeInterface, ...types]),
    );
    const errors: string[] = [];
    for (const work of [
      () => authorizeKind(imports, "state-inspection"),
      () =>
        binaryImports(
          Uint8Array.from([
            ...header,
            ...section(
              "microcrab:client-plugin/session-state@0.4.0",
              [3, 0, 3],
            ),
          ]),
        ),
      () =>
        binaryImports(
          Uint8Array.from([...header, ...section("plugin-manifest", [1, 3])]),
        ),
      () =>
        binaryImports(
          Uint8Array.from([...header, ...section("plugin-manifest", [3, 1])]),
        ),
      () =>
        binaryImports(
          Uint8Array.from([...header, ...section("plugin-manifest", [3, 0])]),
        ),
    ]) {
      try {
        work();
      } catch (error) {
        errors.push(String(error));
      }
    }
    return { imports, errors };
  });
  expect(actual.imports).toEqual(["microcrab:client-plugin/view-types@0.4.0"]);
  expect(actual.errors).toHaveLength(5);
  expect(actual.errors[0]).toContain("requires actual Component import");
  expect(actual.errors[1]).toContain("unsupported Component type import");
  expect(actual.errors[2]).toContain(
    "expected capability interface instance or canonical view type",
  );
  expect(actual.errors[3]).toContain("equality-bounded");
  expect(actual.errors[4]).toContain("invalid Component import/section LEB");
});

test("settled rollover and history reset release block mounts while retaining active hidden surfaces and the concurrent cap", async ({
  page,
}) => {
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts",
      { PluginRegistry } = await import(path);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `rollover-${crypto.randomUUID()}`,
    });
    const id = "microcrab.fixture",
      hidden = { surface_id: "hidden-sidebar", target: "sidebar" as const },
      active = { surface_id: "active-page", target: "expanded-page" as const };
    const block = (batch: number, index: number) => ({
      surface_id: `block-${batch}-${index}`,
      target: "block-slot" as const,
      block_id: `block-${batch}-${index}`,
      slot_id: "decoration",
    });
    const fill = (batch: number) => {
      registry.observe("settled-blocks", {
        blocks: Array.from({ length: 512 }, (_, index) => ({
          block_id: block(batch, index).block_id,
        })),
      });
      for (let index = 0; index < 510; index++) {
        const surface = block(batch, index);
        registry.setSurfaceVisible(id, surface, true);
        registry.setSurfaceVisible(id, surface, false);
      }
    };
    const rejection = () => {
      try {
        registry.setSurfaceVisible(
          id,
          { surface_id: "over-cap", target: "sidebar" },
          true,
        );
        return "accepted";
      } catch (error) {
        return String(error);
      }
    };
    try {
      await registry.initialize();
      await registry.setSession("rollover");
      await registry.setEnabled(id, "rollover", true);
      registry.setSurfaceVisible(id, hidden, true);
      registry.setSurfaceVisible(id, hidden, false);
      registry.setSurfaceVisible(id, active, true);
      fill(0);
      const initialCap = rejection();
      fill(1);
      // A late React cleanup must not recreate an evicted descriptor.
      registry.setSurfaceVisible(id, block(0, 0), false);
      const rolloverCap = rejection();
      registry.observe("history-reset", {});
      registry.setSurfaceVisible(id, block(1, 0), false);
      fill(2);
      const resetCap = rejection();
      let hiddenAction = "accepted";
      try {
        await registry.action(id, "increment", null, hidden);
      } catch (error) {
        hiddenAction = String(error);
      }
      await registry.action(id, "increment", null, active);
      return {
        initialCap,
        rolloverCap,
        resetCap,
        hiddenAction,
        status: registry.view(id, active.target, active).status,
        count: registry.view(id, active.target, active).vars.count,
      };
    } finally {
      registry.dispose();
    }
  });
  expect(actual.initialCap).toContain("512 surface identities");
  expect(actual.rolloverCap).toContain("512 surface identities");
  expect(actual.resetCap).toContain("512 surface identities");
  expect(actual.hiddenAction).toContain("not mounted/visible");
  expect(actual.status).toBe("ready");
  expect(actual.count).toBe(1);
});

for (const retirement of [
  "visibility",
  "settled eviction",
  "queued eviction",
] as const)
  test(`a delayed genuine action reply cannot mutate a surface recreated after ${retirement}`, async ({
    page,
  }) => {
    await nativeBackend(page);
    await page.goto("/");
    const actual = await page.evaluate(async (retirement) => {
      const path = "/src/plugins/registry.ts",
        { PluginRegistry } = await import(path);
      let holding = false,
        notify: (() => void) | undefined;
      const held: { worker: Worker; data: unknown }[] = [];
      const registry = new PluginRegistry({
        serverOrigin: location.origin,
        ownerId: `retired-${crypto.randomUUID()}`,
        workerFactory: () => {
          const worker = new Worker(
            new URL("/src/plugins/worker.ts", location.origin),
            { type: "module" },
          );
          worker.addEventListener("message", (event) => {
            if (holding && event.data.type === "result") {
              event.stopImmediatePropagation();
              held.push({ worker, data: event.data });
              notify?.();
            }
          });
          return worker;
        },
      });
      const id = "microcrab.fixture",
        surface =
          retirement === "visibility"
            ? { surface_id: "retired", target: "session-tab" as const }
            : {
                surface_id: "retired",
                target: "block-slot" as const,
                block_id: "retired-block",
                slot_id: "slot",
              };
      try {
        await registry.initialize();
        await registry.setSession("retirement");
        await registry.setEnabled(id, "retirement", true);
        if (retirement !== "visibility")
          registry.observe("settled-block", { block_id: "retired-block" });
        await registry.render(id, surface.target, false, surface);
        holding = true;
        const captured = new Promise<void>((resolve) => {
          notify = resolve;
        });
        const action = registry.action(id, "increment", null, surface).then(
          () => "accepted",
          (e: unknown) => String(e),
        );
        await captured;
        const queuedRender =
          retirement === "queued eviction"
            ? registry.render(id, surface.target, true, surface).then(
                () => "accepted",
                (error: unknown) => String(error),
              )
            : Promise.resolve("not queued");
        if (retirement !== "visibility")
          registry.observe("settled-blocks", {
            blocks: [
              // The real fixture decorates the first 32 input records. Keep
              // those targets in the final window while 512 distinct fillers
              // evict the original block before its same-ID reintroduction.
              ...Array.from({ length: 32 }, () => ({ block_id: "roll-511" })),
              ...Array.from({ length: 512 }, (_, i) => ({
                block_id: `roll-${i}`,
              })),
              { block_id: "retired-block" },
            ],
          });
        else registry.setSurfaceVisible(id, surface, false);
        if (retirement !== "queued eviction")
          registry.setSurfaceVisible(id, surface, true);
        holding = false;
        for (const frame of held.splice(0))
          frame.worker.dispatchEvent(
            new MessageEvent("message", { data: frame.data }),
          );
        const error = await action;
        const renderError = await queuedRender;
        if (retirement === "queued eviction")
          registry.setSurfaceVisible(id, surface, true);
        const count = registry.view(id, surface.target, surface).vars.count;
        await registry.action(id, "increment", null, surface);
        const freshContext = registry.view(id, surface.target, surface).vars
          .last_action_context;
        return {
          error,
          renderError,
          count,
          freshContext,
          status: registry.view(id, surface.target, surface).status,
        };
      } finally {
        holding = false;
        registry.dispose();
      }
    }, retirement);
    expect(actual.error).toContain("stale plugin call result discarded");
    if (retirement === "queued eviction")
      expect(actual.renderError).toContain("render surface was retired");
    expect(actual.count).toBe(0);
    expect(actual.status).toBe("ready");
    expect(actual.freshContext.surface_generation).toBe(
      retirement === "visibility" ? 3 : 2,
    );
  });
test.beforeEach(async ({ page }) => {
  await maintainedPluginBundle(page);
  await nativeBackend(page);
  await page.goto("/");
});

test("real typed fixture isolates simultaneous surfaces, stamps action identity and switches output modes", async ({
  page,
}) => {
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `surfaces-${crypto.randomUUID()}`,
    });
    const id = "microcrab.fixture";
    const a = { surface_id: "surface-a", target: "session-tab" as const };
    const b = { surface_id: "surface-b", target: "session-tab" as const };
    try {
      await registry.initialize();
      await registry.setSession("surfaces");
      await registry.setEnabled(id, "surfaces", true);
      const va = await registry.render(id, a.target, false, a);
      const vb = await registry.render(id, b.target, false, b);
      await registry.action(id, "increment", null, a);
      const ca = registry.view(id, a.target, a).vars.last_action_context;
      await registry.action(id, "increment", null, b);
      const cb = registry.view(id, b.target, b).vars.last_action_context;
      registry.setSurfaceVisible(id, a, false);
      let hidden = "";
      try {
        await registry.action(id, "increment", null, a);
      } catch (error) {
        hidden = String(error);
      }
      await registry.action(id, "html-mode", { value: true }, b);
      const html = await registry.render(id, b.target, true, b);
      const stillNative = registry.view(id, a.target, a);
      await registry.action(id, "html-mode", { value: false }, b);
      const native = await registry.render(id, b.target, true, b);
      return {
        a: ca,
        b: cb,
        cacheDistinct: va.tree !== vb.tree,
        hidden,
        html: {
          mode: html.mode,
          content: html.content,
          state: html.viewState,
          tree: html.tree,
        },
        stillNative: stillNative.mode,
        native: native.mode,
      };
    } finally {
      registry.dispose();
    }
  });
  expect(actual.a.surface_id).toBe("surface-a");
  expect(actual.b.surface_id).toBe("surface-b");
  expect(actual.a.invocation_id).not.toBe(actual.b.invocation_id);
  expect(actual.a.invocation_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(actual.cacheDistinct).toBe(true);
  expect(actual.hidden).toContain("not mounted/visible");
  expect(actual.html.mode).toBe("webview-html");
  expect(actual.html.tree).toBeNull();
  expect(actual.html.content).toContain("Fixture HTML");
  expect(actual.html.state).toEqual({ surface_id: "surface-b", count: 2 });
  expect(actual.stillNative).toBe("native-json");
  expect(actual.native).toBe("native-json");
});

test("real declared targets cache empty output, clear native and HTML content and retain render errors", async ({
  page,
}) => {
  await nativeBackend(page);
  await page.goto("/");
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts";
    const { PluginRegistry } = await import(path);
    const calls: string[] = [];
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `no-view-${crypto.randomUUID()}`,
      workerFactory: () => {
        const worker = new Worker(
          new URL("/src/plugins/worker.ts", location.origin),
          { type: "module" },
        );
        const post = worker.postMessage.bind(worker);
        worker.postMessage = ((message: any) => {
          if (message.type === "call" && message.method === "renderView")
            calls.push(message.args[0]);
          post(message);
        }) as typeof worker.postMessage;
        return worker;
      },
    });
    const id = "microcrab.fixture";
    const surface = { surface_id: "empty-a", target: "sidebar" as const };
    const other = { surface_id: "empty-b", target: "expanded-page" as const };
    try {
      await registry.initialize();
      await registry.setSession("empty");
      await registry.setEnabled(id, "empty", true);
      const native = await registry.render(id, "sidebar", false, surface);
      await registry.render(id, other.target, false, other);
      registry.setVariable(id, "empty_view", true, surface);
      const empty = await registry.render(id, "sidebar", true, surface);
      const callCount = calls.length;
      const cached = await registry.render(id, "sidebar", false, surface);
      const cacheHit = calls.length === callCount;
      const otherKept = registry.view(id, other.target, other).tree !== null;
      registry.setVariable(id, "empty_view", false, surface);
      registry.setVariable(id, "html_mode", true, surface);
      const html = await registry.render(id, "sidebar", true, surface);
      registry.setVariable(id, "empty_view", true, surface);
      const afterHtml = await registry.render(id, "sidebar", true, surface);
      registry.setVariable(id, "empty_view", false, surface);
      registry.setVariable(id, "html_mode", false, surface);
      const recovered = await registry.render(id, "sidebar", true, surface);
      const callsBeforeUndeclared = calls.length;
      let undeclared = "";
      try {
        await registry.render("microcrab.state-viewer", "session-tab");
      } catch (cause) {
        undeclared = String(cause);
      }
      const notCalled = calls.length === callsBeforeUndeclared;
      registry.setVariable(id, "render_error", true, surface);
      let error = "";
      try {
        await registry.render(id, "sidebar", true, surface);
      } catch (cause) {
        error = String(cause);
      }
      const failed = registry.view(id, "sidebar", surface);
      return {
        native: !!native.tree,
        empty: empty.tree,
        patch: empty.vars.last_render_surface,
        cached: cached.tree,
        cacheHit,
        otherKept,
        html: html.mode,
        afterHtml: {
          mode: afterHtml.mode,
          tree: afterHtml.tree,
          content: afterHtml.content,
        },
        recovered: !!recovered.tree,
        undeclared,
        notCalled,
        error,
        failed: {
          tree: failed.tree,
          status: failed.status,
          error: failed.error,
        },
      };
    } finally {
      registry.dispose();
    }
  });
  expect(actual.native).toBe(true);
  expect(actual.empty).toBeNull();
  expect(actual.patch).toBe("empty-a");
  expect(actual.cached).toBeNull();
  expect(actual.cacheHit).toBe(true);
  expect(actual.otherKept).toBe(true);
  expect(actual.html).toBe("webview-html");
  expect(actual.afterHtml).toEqual({
    mode: "native-json",
    tree: null,
    content: "null",
  });
  expect(actual.recovered).toBe(true);
  expect(actual.undeclared).toContain("does not declare target session-tab");
  expect(actual.notCalled).toBe(true);
  expect(actual.error).toContain("Fixture render rejected");
  expect(actual.failed.tree).toBeNull();
  expect(actual.failed.status).toBe("faulted");
  expect(actual.failed.error).toContain("Fixture render rejected");
});

test("WebSocket messages retain their opening scope through retirement and recreation", async ({
  page,
}) => {
  const closes: number[] = [];
  await page.routeWebSocket(
    "wss://surface-network.example/socket",
    (socket) => {
      socket.onMessage((data) => socket.send(data));
      socket.onClose((code) => closes.push(code));
    },
  );
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/network.ts",
      { PluginNetwork } = await import(path);
    const events: { origin: string; value: any }[] = [];
    const waiting = new Map<string, () => void>();
    const delivered = (origin: string, value: any) => {
      events.push({ origin, value });
      if (value.type === "ws-message") waiting.get(value.data)?.();
    };
    const network = new PluginNetwork(
      {
        schema_version: 1,
        id: "surface.network",
        name: "Surface network",
        version: "1",
        targets: [],
        network_origins: ["wss://surface-network.example"],
      },
      (_id: number, value: any) => delivered("instance", value),
    );
    const signal = new AbortController().signal;
    let revision = 1;
    const scope = (generation: number) => ({
      isCurrent: () => revision === generation,
      event: (_id: number, value: any) =>
        delivered(`surface-${generation}`, value),
    });
    const open = (requestId: number, origin?: ReturnType<typeof scope>) =>
      network.execute(
        "ws-open",
        { url: "wss://surface-network.example/socket" },
        signal,
        requestId,
        origin,
      );
    const echo = async (handle: number, text: string) => {
      const reply = new Promise<void>((resolve) => waiting.set(text, resolve));
      await network.execute("ws-send", { handle, data: text }, signal, 99);
      await reply;
    };
    try {
      const old = await open(1, scope(1));
      const instance = await open(2);
      await echo(old.handle, "before-retirement");
      // Retain already-dispatched callbacks as well as sending real frames.
      const socket = (network as any).sockets.get(old.handle) as WebSocket;
      const lateMessage = socket.onmessage!.bind(socket);
      const lateClose = socket.onclose!.bind(socket);
      revision++;
      network.retireStale();
      const fresh = await open(3, scope(2));
      lateMessage(
        new MessageEvent("message", { data: "stale-after-recreation" }),
      );
      lateClose(new CloseEvent("close", { code: 1000, reason: "old close" }));
      await echo(instance.handle, "instance-survives");
      await echo(fresh.handle, "fresh-surface");
      return events;
    } finally {
      network.close();
    }
  });
  expect(actual).toEqual([
    {
      origin: "surface-1",
      value: { type: "ws-message", handle: 1, data: "before-retirement" },
    },
    {
      origin: "instance",
      value: { type: "ws-message", handle: 2, data: "instance-survives" },
    },
    {
      origin: "surface-2",
      value: { type: "ws-message", handle: 3, data: "fresh-surface" },
    },
  ]);
  await expect.poll(() => closes.length).toBe(3);
  expect(closes).toEqual([1000, 1000, 1000]);
});

test("retiring CONNECTING sockets settles open requests and removes abort listeners", async ({
  page,
}) => {
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/network.ts",
      { PluginNetwork } = await import(path);
    const OriginalWebSocket = window.WebSocket;
    const sockets: { closes: number }[] = [];
    class ConnectingSocket {
      static OPEN = OriginalWebSocket.OPEN;
      static CONNECTING = OriginalWebSocket.CONNECTING;
      static CLOSING = OriginalWebSocket.CLOSING;
      static CLOSED = OriginalWebSocket.CLOSED;
      onopen = null;
      onerror = null;
      onmessage = null;
      onclose = null;
      closes = 0;
      constructor(url: string | URL, protocols?: string | string[]) {
        if (new URL(url).hostname !== "connecting.example")
          return new OriginalWebSocket(url, protocols) as any;
        sockets.push(this);
      }
      // Deliberately emit no browser events: owner cancellation must settle itself.
      close() {
        this.closes++;
      }
    }
    window.WebSocket = ConnectingSocket as any;
    const outcomes: { mode: string; error: string; listeners: number }[] = [];
    try {
      for (const mode of ["close", "retire", "explicit"]) {
        const network = new PluginNetwork(
          {
            schema_version: 1,
            id: "connecting.network",
            name: "Connecting",
            version: "1",
            targets: [],
            network_origins: ["wss://connecting.example"],
          },
          () => {},
        );
        const controller = new AbortController(),
          listeners = new Set<unknown>();
        const signal = controller.signal,
          add = signal.addEventListener.bind(signal),
          remove = signal.removeEventListener.bind(signal);
        signal.addEventListener = ((
          type: string,
          listener: any,
          options: any,
        ) => {
          if (type === "abort") listeners.add(listener);
          add(type, listener, options);
        }) as typeof signal.addEventListener;
        signal.removeEventListener = ((
          type: string,
          listener: any,
          options: any,
        ) => {
          if (type === "abort") listeners.delete(listener);
          remove(type, listener, options);
        }) as typeof signal.removeEventListener;
        let current = true;
        const opening = network
          .execute(
            "ws-open",
            { url: "wss://connecting.example/socket" },
            signal,
            1,
            { isCurrent: () => current, event: () => {} },
          )
          .then(
            () => "accepted",
            (error: unknown) => String(error),
          );
        if (mode === "close") network.close();
        else if (mode === "retire") {
          current = false;
          network.retireStale();
        } else await network.execute("ws-close", { handle: 1 }, signal, 2);
        const error = await opening;
        outcomes.push({ mode, error, listeners: listeners.size });
        controller.abort();
        network.close();
      }
      return { outcomes, closes: sockets.map((socket) => socket.closes) };
    } finally {
      window.WebSocket = OriginalWebSocket;
    }
  });
  expect(actual.outcomes).toEqual([
    {
      mode: "close",
      error: "Error: WebSocket plugin instance ended",
      listeners: 0,
    },
    {
      mode: "retire",
      error: "Error: WebSocket origin is retired",
      listeners: 0,
    },
    {
      mode: "explicit",
      error: "Error: WebSocket explicitly closed",
      listeners: 0,
    },
  ]);
  expect(actual.closes).toEqual([1, 1, 1]);
});

test("registry WebSocket effects retain captured context and reject retired socket callbacks", async ({
  page,
}) => {
  const actual = await page.evaluate(async () => {
    const path = "/src/plugins/registry.ts",
      { PluginRegistry } = await import(path);
    const OriginalWebSocket = window.WebSocket;
    const sockets: TestSocket[] = [];
    class TestSocket {
      static OPEN = OriginalWebSocket.OPEN;
      static CONNECTING = OriginalWebSocket.CONNECTING;
      static CLOSING = OriginalWebSocket.CLOSING;
      static CLOSED = OriginalWebSocket.CLOSED;
      onopen: ((event: Event) => void) | null = null;
      onerror = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      closes = 0;
      constructor(url: string | URL, protocols?: string | string[]) {
        if (new URL(url).hostname !== "registry-socket.example")
          return new OriginalWebSocket(url, protocols) as any;
        sockets.push(this);
        queueMicrotask(() => this.onopen?.(new Event("open")));
      }
      close() {
        this.closes++;
      }
      message(data: string) {
        this.onmessage?.(new MessageEvent("message", { data }));
      }
    }
    window.WebSocket = TestSocket as any;
    const id = "test.socket-lifecycle",
      calls: any[] = [];
    const opens = new Map<number, () => void>();
    let requestId = 0;
    const manifest = {
      schema_version: 1,
      id,
      name: "Socket lifecycle",
      version: "1",
      targets: ["sidebar"],
      network_origins: ["wss://registry-socket.example"],
    };
    // Controlled Worker replies exercise the real registry dispatch/effect/queue path.
    // Component compilation remains covered by the genuine fixture cases above.
    const registry = new PluginRegistry({
      serverOrigin: location.origin,
      ownerId: `socket-registry-${crypto.randomUUID()}`,
      workerFactory: () => {
        let ended = false;
        const worker = {
          onmessage: null as ((event: { data: any }) => void) | null,
          terminate() {
            ended = true;
          },
          postMessage(data: any) {
            queueMicrotask(() => {
              if (ended) return;
              const reply = (payload: any) =>
                worker.onmessage?.({
                  data: {
                    generation: data.generation,
                    callId: data.callId,
                    ...payload,
                  },
                });
              if (data.type === "load") {
                reply({
                  type: "loaded",
                  manifest,
                  imports: ["microcrab:client-plugin/net@0.4.0"],
                  sourceKind: "component",
                });
                return;
              }
              if (data.type !== "call") return;
              if (
                (data.method === "onAction" &&
                  data.args[0] === "open-socket") ||
                (data.method === "onPhase" && data.args[0] === "open-instance")
              )
                reply({
                  type: "effect",
                  context: data.context,
                  effect: {
                    kind: "ws-open",
                    request_id: ++requestId,
                    payload: { url: "wss://registry-socket.example/socket" },
                  },
                });
              let vars_patch;
              if (
                data.method === "onPhase" &&
                data.args[0] === "event-result"
              ) {
                const payload = JSON.parse(data.args[1]);
                calls.push({ payload, context: data.context });
                if (payload.value?.handle && !payload.value.type)
                  opens.get(payload.value.handle)?.();
                if (payload.value?.type === "ws-message")
                  vars_patch = { last_message: payload.value.data };
              }
              reply({
                type: "result",
                result: {
                  schema_version: 1,
                  ...(vars_patch ? { vars_patch } : {}),
                },
              });
            });
          },
        };
        return worker as unknown as Worker;
      },
    });
    const surface = {
      surface_id: "socket-surface",
      target: "sidebar" as const,
    };
    const open = async (handle: number, work: () => unknown) => {
      const opened = new Promise<void>((resolve) => opens.set(handle, resolve));
      await work();
      await opened;
    };
    const barrier = () => registry.action(id, "barrier", null, surface);
    try {
      await registry.importPlugin(
        new Uint8Array([0, 97, 115, 109, 13, 0, 1, 0]),
      );
      await registry.setSession("socket-session");
      await registry.setEnabled(id, "socket-session", true);
      registry.setSurfaceVisible(id, surface, true);
      await open(1, () => registry.action(id, "open-socket", null, surface));
      await open(2, () => registry.observe("open-instance", {}));
      sockets[0].message("before-hide");
      await barrier();
      const oldMessage = sockets[0].onmessage!.bind(sockets[0]),
        oldClose = sockets[0].onclose!.bind(sockets[0]);
      registry.setSurfaceVisible(id, surface, false);
      registry.setSurfaceVisible(id, surface, true);
      oldMessage(new MessageEvent("message", { data: "stale-hidden-message" }));
      oldClose(new CloseEvent("close", { code: 1000 }));
      sockets[1].message("instance-survives-hide");
      await barrier();
      await open(3, () => registry.action(id, "open-socket", null, surface));
      sockets[2].message("fresh-surface");
      await barrier();
      const previousInstanceMessage = sockets[1].onmessage!.bind(sockets[1]),
        previousSurfaceMessage = sockets[2].onmessage!.bind(sockets[2]);
      registry.observe("history-reset", {});
      previousInstanceMessage(
        new MessageEvent("message", { data: "stale-history-instance" }),
      );
      previousSurfaceMessage(
        new MessageEvent("message", { data: "stale-history-surface" }),
      );
      await barrier();
      return {
        messages: calls
          .filter((call) => call.payload.value?.type === "ws-message")
          .map((call) => ({
            data: call.payload.value.data,
            surface: call.context.surface_id ?? null,
            revision: call.context.surface_generation ?? null,
          })),
        closes: sockets.map((socket) => socket.closes),
        lastMessage: registry.view(id, "sidebar", surface).vars.last_message,
        status: registry.view(id, "sidebar", surface).status,
      };
    } finally {
      registry.dispose();
      window.WebSocket = OriginalWebSocket;
    }
  });
  expect(actual.messages).toEqual([
    { data: "before-hide", surface: "socket-surface", revision: 1 },
    { data: "instance-survives-hide", surface: null, revision: null },
    { data: "fresh-surface", surface: "socket-surface", revision: 3 },
  ]);
  expect(actual.closes).toEqual([1, 1, 1]);
  expect(actual.lastMessage).toBe("fresh-surface");
  expect(actual.status).toBe("ready");
});

test("typed normalization rejects legacy strings, separates state write grants and preserves action effects", async ({
  page,
}) => {
  const actual = await page.evaluate(async () => {
    const schemaPath = "/src/plugins/schema.ts",
      componentPath = "/src/plugins/component.ts";
    const { manifest, renderOutput, result, validateTree, variables } =
      await import(schemaPath);
    const { authorizeKind } = await import(componentPath);
    const errors: string[] = [];
    for (const invoke of [
      () => manifest('{"id":"legacy"}'),
      () =>
        authorizeKind(
          ["microcrab:client-plugin/session-state@0.4.0"],
          "state-change",
        ),
      () =>
        renderOutput({
          schemaVersion: 1,
          mode: "webview-html",
          content: JSON.stringify({ html: "ok", vars: { secret: true } }),
          rerender: false,
        }),
      () =>
        variables({
          scoped_set: [
            {
              name: "x",
              value: 1,
              visibility: "visible",
              persistence: "persisted",
              owner: "runtime",
            },
          ],
        }),
    ]) {
      try {
        invoke();
      } catch (error) {
        errors.push(String(error));
      }
    }
    authorizeKind(
      ["microcrab:client-plugin/session-state-write@0.4.0"],
      "state-change",
    );
    validateTree({
      type: "textarea",
      props: {
        bind: "draft",
        rows: 8,
        action_payload: { $ref: "checked" },
        disabled: { $ref: "read_only" },
      },
    });
    const phase = result(
      JSON.stringify({
        schema_version: 1,
        effects: [
          { kind: "state-change", payload: { operation_id: "explicit" } },
        ],
        turn_variables: { set: { ordinary: 1 } },
        block_slots: [
          {
            slot_id: "a",
            block_id: "b",
            mode: "webview-html",
            placement: "before",
            content: "<p>slot</p>",
            view_state: { safe: 1 },
          },
        ],
      }),
    );
    const output = renderOutput({
      schemaVersion: 1,
      mode: "native-json",
      content: '{"type":"text","props":{"text":"typed"}}',
      varsPatch: '{"count":1}',
      rerender: false,
    });
    const empty = renderOutput({
      schemaVersion: 1,
      mode: "native-json",
      content: "null",
      varsPatch: '{"empty":true}',
      rerender: false,
    });
    const invalid: string[] = [];
    for (const value of [
      undefined,
      { schemaVersion: 1, mode: "native-json", content: "", rerender: false },
      { schemaVersion: 1, mode: "native-json", content: "{}", rerender: false },
      {
        schemaVersion: 1,
        mode: "native-json",
        content: "null",
        rerender: false,
        error: "specific render failure",
      },
    ]) {
      try {
        renderOutput(value);
      } catch (error) {
        invalid.push(String(error));
      }
    }
    return { errors, phase, output, empty, invalid };
  });
  expect(actual.empty.view_output.tree).toBeNull();
  expect(actual.empty.vars_patch).toEqual({ empty: true });
  expect(actual.invalid).toHaveLength(4);
  expect(actual.invalid[3]).toContain("specific render failure");
  expect(actual.errors).toHaveLength(4);
  expect(actual.errors[0]).toContain("typed record");
  expect(actual.errors[1]).toContain("session-state-write@0.4.0");
  expect(actual.errors[2]).toContain("content envelope");
  expect(actual.errors[3]).toContain("invalid scoped variable write");
  expect(actual.phase.effects[0].kind).toBe("state-change");
  expect(actual.phase.turn_variables).toEqual({ set: { ordinary: 1 } });
  expect(actual.phase.block_slots[0].placement).toBe("before");
  expect(actual.output.view_output.mode).toBe("native-json");
  expect(actual.output.vars_patch).toEqual({ count: 1 });
});

test("exact bundled predecessor replacement preserves KV choices priority and unrelated tombstones", async ({
  page,
}) => {
  const actual = await page.evaluate(async () => {
    const registryPath = "/src/plugins/registry.ts",
      storePath = "/src/plugins/store.ts";
    const { PluginRegistry } = await import(registryPath),
      { PluginStore } = await import(storePath);
    const ownerId = `upgrade-${crypto.randomUUID()}`,
      options = { serverOrigin: location.origin, ownerId },
      id = "microcrab.fixture";
    const store = new PluginStore(JSON.stringify([location.origin, ownerId]));
    let registry = new PluginRegistry(options);
    const originalFetch = window.fetch;
    try {
      await registry.initialize();
      await registry.setSession("kept");
      await registry.setEnabled(id, "kept", false);
      await registry.setPriority(id, -31);
      const p = registry.getSnapshot().find((p: any) => p.manifest.id === id);
      const previous = new Uint8Array(p.bytes.length + 4);
      previous.set(p.bytes);
      previous.set([0, 2, 1, 120], p.bytes.length);
      await registry.importPlugin(previous, { replace: true });
      await store.writeKV(id, "kept", "data");
      await registry.remove("microcrab.state-viewer");
      registry.dispose();
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", previous)),
      ]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      const index = await (await originalFetch("/plugins/current.json")).json();
      const entry = index.plugins.find((p: any) => p.id === id);
      entry.supersedes = [hash];
      window.fetch = async (input, init) =>
        String(input) === "/plugins/current.json"
          ? Response.json(index)
          : originalFetch(input, init);
      registry = new PluginRegistry(options);
      await registry.initialize();
      await registry.setSession("kept");
      const upgraded = registry
          .getSnapshot()
          .find((p: any) => p.manifest.id === id),
        prefs = await store.preferences();
      return {
        current:
          upgraded.bytes.length === p.bytes.length &&
          upgraded.bytes.every((x: number, i: number) => x === p.bytes[i]),
        priority: upgraded.priority,
        enabled: registry.isEnabled(id),
        kv: await store.kv(id),
        tombstones: prefs.tombstones,
      };
    } finally {
      window.fetch = originalFetch;
      registry.dispose();
      store.close();
    }
  });
  expect(actual.current).toBe(true);
  expect(actual.priority).toBe(-31);
  expect(actual.enabled).toBe(false);
  expect(actual.kv).toEqual({ kept: "data" });
  expect(actual.tombstones).toContain("microcrab.state-viewer");
});

test("an incompatible installed custom binary retains exact bytes KV and enablement without automatic replacement", async ({
  page,
}) => {
  const actual = await page.evaluate(async () => {
    const rp = "/src/plugins/registry.ts",
      sp = "/src/plugins/store.ts",
      { PluginRegistry } = await import(rp),
      { PluginStore } = await import(sp);
    const options = {
        serverOrigin: location.origin,
        ownerId: `incompatible-${crypto.randomUUID()}`,
      },
      id = "microcrab.state-viewer";
    const store = new PluginStore(
      JSON.stringify([location.origin, options.ownerId]),
    );
    let registry = new PluginRegistry(options);
    try {
      await registry.initialize();
      await registry.setSession("keep");
      await registry.setEnabled(id, "keep", false);
      const original = registry
          .getSnapshot()
          .find((p: any) => p.manifest.id === id),
        bytes = original.bytes.slice();
      const from = new TextEncoder().encode(
        "microcrab:client-plugin/session-state@0.4.0",
      );
      let changed = false;
      for (let i = 0; i <= bytes.length - from.length; i++)
        if (from.every((b, j) => bytes[i + j] === b)) {
          bytes[i + from.length - 3] = 49;
          changed = true;
        }
      if (!changed)
        throw new Error("real component lacks imported State interface");
      await store.put({
        ...original,
        bytes,
        imports: original.imports.map((name: string) =>
          name.replace("session-state@0.4.0", "session-state@0.1.0"),
        ),
      });
      await store.writeKV(id, "retained", "custom-data");
      const preferences = JSON.stringify(await store.preferences());
      registry.dispose();
      registry = new PluginRegistry(options);
      await registry.initialize();
      await registry.setSession("keep");
      let error = "";
      try {
        await registry.setEnabled(id, "keep", true);
      } catch (cause) {
        error = String(cause);
      }
      const persisted = (await store.plugins()).find(
        (p: any) => p.manifest.id === id,
      );
      return {
        error,
        bytesRetained:
          persisted.bytes.every((b: number, i: number) => b === bytes[i]) &&
          persisted.bytes.length === bytes.length,
        kv: await store.kv(id),
        defaultEnabled: persisted.enabledByDefault,
        previousPreferences: JSON.parse(preferences),
        preferences: await store.preferences(),
      };
    } finally {
      registry.dispose();
      store.close();
    }
  });
  expect(actual.error).toContain(
    "unsupported Component import: microcrab:client-plugin/session-state@0.1.0",
  );
  expect(actual.error).toContain("retained");
  expect(actual.bytesRetained).toBe(true);
  expect(actual.kv).toEqual({ retained: "custom-data" });
  expect(actual.preferences.sessions.keep["microcrab.state-viewer"]).toBe(true);
  expect(
    actual.previousPreferences.sessions.keep["microcrab.state-viewer"],
  ).toBe(false);
});
